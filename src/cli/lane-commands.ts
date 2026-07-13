import path from "node:path";
import { watch } from "node:fs";
import type { FSWatcher } from "node:fs";

import { Command, CommanderError, InvalidArgumentError, Option } from "commander";

import {
  AdapterError,
  adapterRegistry,
  buildContractPayload,
  ContinuityError,
  errorEnvelope,
  EXIT_CODES,
  getContractSchema,
  InvalidLaneIdError,
  isValidLaneId,
  LaneNotFoundError,
  LaneStore,
  okEnvelope,
  printEnvelope,
  printHandle,
  TransitionConflictError,
} from "../lane/index.js";
import type {
  AdapterRegistry,
  AgentAdapter,
  ConsumeAnswerOptions,
  ContractSchemaName,
  LaneMetadataPatch,
} from "../lane/index.js";
import {
  BlockedInfoSchema,
  DeliverySchema,
  ErrorCodeSchema,
  LANE_CONTRACT_VERSION,
  LaneProcessInfoSchema,
  LaneSurfaceSchema,
  NativeStatusSchema,
  ResultInfoSchema,
} from "../types/lane.js";
import type {
  BlockedInfo,
  Delivery,
  DispatchOutcome,
  Envelope,
  ErrorCode,
  LaneEvent,
  LaneEventInput,
  LaneEventKind,
  LaneProcessInfo,
  LaneRecord,
  LaneStatus,
  LaneSurface,
  NativeStatus,
  ResultInfo,
} from "../types/lane.js";

/**
 * orca/v1 lane verbs: dispatch, inspect, answer, resume, lanes, kill, agents,
 * contract. Every verb routes its final stdout line through printEnvelope,
 * which is the single exit-code enforcement point.
 *
 * The verbs run on a dedicated commander program (not the legacy one) because
 * "answer" and "resume" collide with legacy command names: lane handling
 * engages only when the first positional starts with "lane_" (all lane ids
 * do), so legacy invocations are untouched.
 */

const LANE_VERBS = new Set([
  "dispatch",
  "inspect",
  "answer",
  "resume",
  "lanes",
  "kill",
  "agents",
  "contract",
]);

/** Verb names shared with the legacy CLI; routed by lane_-prefixed ids. */
const LEGACY_SHARED_VERBS = new Set(["answer", "resume"]);

/** Adapter packages expected at src/adapters/<agent>; loaded lazily. */
const BUILTIN_AGENTS: readonly string[] = ["claude", "codex", "cursor"];

const DEFAULT_WAIT_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 150;

const TERMINAL_LANE_STATUSES: ReadonlySet<LaneStatus> = new Set([
  "completed",
  "failed",
  "killed",
  "lost",
]);

/**
 * Warning appended when a lane settles completed with an empty/whitespace
 * result text: nativeStatus "completed" only proves the protocol turn ended,
 * and with no result text there is nothing for the caller to act on.
 */
const EMPTY_RESULT_WARNING =
  "agent returned an empty result; semanticOutcome is unknown and the " +
  "response may not have addressed the prompt";

const EXIT_CODE_HELP =
  "Exit codes: 0 ok (blocked is ok), 2 usage (malformed command line), " +
  "3 adapter/agent failure, 4 not-found/continuity/invalid-state, 5 timeout.";

const LANE_ROUTING_HELP =
  'Lane vs legacy routing: "orca answer"/"orca resume" run against the LANE contract when the' +
  ' first argument starts with "lane_" (all lane ids do); any other first argument routes to the' +
  " legacy answer/resume commands.";

export interface LaneCliWriter {
  write(chunk: string): unknown;
}

/** Injection points for tests; every field falls back to the real thing. */
export interface LaneCliDeps {
  registry?: AdapterRegistry;
  store?: LaneStore;
  /** Loads and explicitly registers a built-in adapter module. */
  loadAdapterModule?: (agent: string, registry: AdapterRegistry, store: LaneStore) => Promise<void>;
  builtinAgents?: readonly string[];
  stdout?: LaneCliWriter;
  stderr?: LaneCliWriter;
  pollIntervalMs?: number;
  /** Test seams for process-group termination used by `orca kill`. */
  signalProcessGroup?: (pgid: number, signal: NodeJS.Signals) => void;
  isProcessGroupAlive?: (pgid: number) => boolean;
  killGraceMs?: number;
  /** Test seam for the stale-running inspect warning's pid liveness probe. */
  isPidAlive?: (pid: number) => boolean;
}

interface LaneCliContext {
  registry: AdapterRegistry;
  store: LaneStore;
  loadAdapterModule: (agent: string, registry: AdapterRegistry, store: LaneStore) => Promise<void>;
  builtinAgents: readonly string[];
  stdout: LaneCliWriter;
  stderr: LaneCliWriter;
  pollIntervalMs: number;
  signalProcessGroup: (pgid: number, signal: NodeJS.Signals) => void;
  isProcessGroupAlive: (pgid: number) => boolean;
  killGraceMs: number;
  isPidAlive: (pid: number) => boolean;
}

function resolveContext(deps: LaneCliDeps): LaneCliContext {
  return {
    registry: deps.registry ?? adapterRegistry,
    store: deps.store ?? new LaneStore(),
    loadAdapterModule: deps.loadAdapterModule ?? importBuiltinAdapter,
    builtinAgents: deps.builtinAgents ?? BUILTIN_AGENTS,
    stdout: deps.stdout ?? process.stdout,
    stderr: deps.stderr ?? process.stderr,
    pollIntervalMs: deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    signalProcessGroup: deps.signalProcessGroup ?? signalProcessGroup,
    isProcessGroupAlive: deps.isProcessGroupAlive ?? isProcessGroupAlive,
    killGraceMs: deps.killGraceMs ?? 5_000,
    isPidAlive: deps.isPidAlive ?? isPidAlive,
  };
}

async function importBuiltinAdapter(
  agent: string,
  registry: AdapterRegistry,
  store: LaneStore,
): Promise<void> {
  if (registry.get(agent) !== undefined) {
    return;
  }

  // Registration is explicit and adapter-specific so constructor options are
  // reachable and Codex receives the dispatching process's shared LaneStore.
  switch (agent) {
    case "claude": {
      const { registerClaudeAdapter } = await import("../adapters/claude/index.js");
      registerClaudeAdapter(registry);
      return;
    }
    case "codex": {
      const { registerCodexAdapter } = await import("../adapters/codex/index.js");
      registerCodexAdapter({ store }, registry);
      return;
    }
    case "cursor": {
      const { registerCursorAdapter } = await import("../adapters/cursor/index.js");
      registerCursorAdapter(registry);
      return;
    }
    default:
      throw new Error(`Unknown built-in adapter: ${agent}`);
  }
}

/**
 * True when argv (already stripped of the node/script prefix) targets a lane
 * verb. "answer"/"resume" belong to the legacy CLI unless the first
 * positional is a lane id.
 */
export function isLaneCliInvocation(args: readonly string[]): boolean {
  const verb = args[0];
  if (verb === undefined || !LANE_VERBS.has(verb)) {
    return false;
  }

  if (!LEGACY_SHARED_VERBS.has(verb)) {
    return true;
  }

  const target = args[1];
  return target === "--help" || target === "-h" || target?.startsWith("lane_") === true;
}

/**
 * Runs a lane verb and returns its process exit code, or null when argv is
 * not a lane invocation (the caller should fall through to the legacy CLI).
 */
export async function runLaneCli(
  args: readonly string[],
  deps: LaneCliDeps = {},
): Promise<number | null> {
  if (!isLaneCliInvocation(args)) {
    return null;
  }

  const ctx = resolveContext(deps);
  let exitCode: number = EXIT_CODES.ok;
  const program = createLaneProgram(ctx, (code) => {
    exitCode = code;
  });

  try {
    await program.parseAsync([...args], { from: "user" });
    return exitCode;
  } catch (error) {
    return laneCliErrorExit(ctx, error);
  }
}

/** Adds the orca-for-agents pitch and lane verb summary to the root help. */
export function attachLaneHelp(program: Command): void {
  program.addHelpText(
    "beforeAll",
    "orca runs coding agents in observable lanes that always reply with one" +
      ' machine-readable JSON envelope — run "orca contract" for the full agent contract.\n' +
      `${LANE_ROUTING_HELP}\n`,
  );

  program.addHelpText(
    "after",
    [
      "",
      "Lane verbs (orca/v1 agent contract):",
      "  dispatch --agent <agent> [--surface lane|task] [--model <model>] [--cwd <dir>] [--label <label>] [--timeout <ms>] <prompt>",
      "  inspect <laneId> [--follow] [--since <seq>] [--wait-for blocked|done] [--timeout <ms>]",
      "  answer <laneId> <text>",
      "  resume <laneId> [--timeout <ms>] <prompt>",
      "  lanes | kill <laneId> | agents | contract [--schema envelope|event|manifest]",
      "",
      `  ${LANE_ROUTING_HELP}`,
      '  Add --help to any lane verb (e.g. "orca dispatch --help") for details.',
      "",
      "AGENTS:",
      "  Every lane verb prints exactly one JSON envelope as the final stdout line;",
      "  dispatch prints a handle line first.",
      `  ${EXIT_CODE_HELP}`,
      '  Example: orca dispatch --agent codex --cwd . "Fix the flaky store test"',
      "",
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------------
// Program wiring
// ---------------------------------------------------------------------------

interface DispatchCommandOptions {
  agent: string;
  surface?: LaneSurface;
  model?: string;
  cwd?: string;
  label?: string;
  detach?: boolean;
  timeout?: number;
}

interface ResumeCommandOptions {
  timeout?: number;
}

interface InspectCommandOptions {
  follow?: boolean;
  since?: number;
  waitFor?: "blocked" | "done";
  timeout?: number;
}

interface ContractCommandOptions {
  schema?: ContractSchemaName;
}

function agentsHelp(promise: string, example: string): string {
  return ["", "AGENTS:", `  ${promise}`, `  ${EXIT_CODE_HELP}`, `  Example: ${example}`, ""].join(
    "\n",
  );
}

function createLaneProgram(ctx: LaneCliContext, setExit: (code: number) => void): Command {
  const program = new Command();

  program
    .name("orca")
    .description(
      "orca runs coding agents in observable lanes that always reply with one" +
        ' machine-readable JSON envelope. Run "orca contract" for the full agent contract.',
    )
    .exitOverride()
    .configureOutput({
      writeOut: (str: string) => void ctx.stdout.write(str),
      writeErr: (str: string) => void ctx.stderr.write(str),
    });

  program
    .command("dispatch")
    .description("Create a lane and hand the prompt to the agent (synchronous in v0).")
    .argument("<prompt>", "prompt handed to the agent")
    .requiredOption("--agent <agent>", 'agent adapter to use (see "orca agents")')
    .addOption(
      new Option(
        "--surface <surface>",
        "dispatch ownership: lane is an internal worker; task is a user-owned Codex thread",
      )
        .choices(LaneSurfaceSchema.options)
        .default("lane"),
    )
    .option("--model <model>", "model override passed to the adapter")
    .option("--cwd <dir>", "working directory for the lane (default: current directory)")
    .option("--label <label>", "human-friendly lane label")
    .option("--timeout <ms>", "maximum adapter run time in milliseconds", parseTimeout)
    .option("--detach", "not available in v0; dispatch always runs synchronously")
    .addHelpText(
      "after",
      agentsHelp(
        'Prints a handle line ({"v":1,"kind":"handle",...}) immediately after lane creation,' +
          " then exactly one JSON envelope as the final stdout line.",
        'orca dispatch --agent codex --cwd . "Fix the flaky store test"',
      ),
    )
    .action(async (prompt: string, options: DispatchCommandOptions) => {
      setExit(await dispatchVerb(ctx, prompt, options));
    });

  program
    .command("inspect")
    .description("Report lane state: matching events as NDJSON lines, then one final envelope.")
    .argument("<laneId>", 'lane id (matches "lane_" plus 8 hex digits)', parseLaneId)
    .option("--follow", "stream new events as NDJSON lines until the lane is blocked or terminal")
    .option("--since <seq>", "only emit events with seq greater than this value", parseSeq)
    .addOption(
      new Option(
        "--wait-for <state>",
        "wait until the lane is blocked or done (terminal) before printing the envelope; " +
          "terminal states also satisfy --wait-for blocked, so it never hangs on a lane " +
          "that finishes without blocking",
      ).choices(["blocked", "done"]),
    )
    .option(
      "--timeout <ms>",
      `max wait for --follow/--wait-for in milliseconds (default ${DEFAULT_WAIT_TIMEOUT_MS})`,
      parseTimeout,
    )
    .addHelpText(
      "after",
      agentsHelp(
        "Event lines (if any) come first; the final stdout line is always exactly one JSON" +
          " envelope. On --wait-for/--follow timeout the envelope carries code:timeout (exit 5).",
        "orca inspect lane_a3f81c02 --since 7",
      ),
    )
    .action(async (laneId: string, options: InspectCommandOptions) => {
      setExit(await inspectVerb(ctx, laneId, options));
    });

  program
    .command("answer")
    .description(
      "Deliver an answer to a blocked lane's pending question. " + `${LANE_ROUTING_HELP}`,
    )
    .argument("<laneId>", 'lane id (matches "lane_" plus 8 hex digits)', parseLaneId)
    .argument("<text>", "answer text; stored until the live or resumed agent consumes it")
    .addHelpText(
      "after",
      agentsHelp(
        "Writes answer.txt, appends an answered event, and prints one JSON envelope; next[]" +
          " says whether to inspect a live turn or resume a parked blocked lane. Answering a" +
          " non-blocked lane fails with code:invalid_state (exit 4).",
        'orca answer lane_a3f81c02 "Use the staging database"',
      ),
    )
    .action(async (laneId: string, text: string) => {
      setExit(await answerVerb(ctx, laneId, text));
    });

  program
    .command("resume")
    .description(
      "Continue a blocked (non-live) or completed lane with a follow-up prompt " +
        "(continuity-verified). " +
        `${LANE_ROUTING_HELP}`,
    )
    .argument("<laneId>", 'lane id (matches "lane_" plus 8 hex digits)', parseLaneId)
    .argument("<prompt>", "follow-up prompt for the agent")
    .option("--timeout <ms>", "maximum adapter run time in milliseconds", parseTimeout)
    .addHelpText(
      "after",
      agentsHelp(
        "Prints exactly one JSON envelope; continuity is verified or the envelope carries" +
          " code:continuity_unverified (exit 4) and the lane is left unchanged. Resuming a" +
          " completed lane starts a new turn (the documented terminal carve-out); resuming a" +
          " failed/killed/lost or live-blocked lane fails with code:invalid_state (exit 4).",
        'orca resume lane_a3f81c02 "Now add tests for the edge cases"',
      ),
    )
    .action(async (laneId: string, prompt: string, options: ResumeCommandOptions) => {
      setExit(await resumeVerb(ctx, laneId, prompt, options));
    });

  program
    .command("lanes")
    .description("List known lanes, newest first.")
    .addHelpText(
      "after",
      agentsHelp(
        'Prints exactly one kind:"list" JSON envelope with the full lane records in "lanes".',
        "orca lanes",
      ),
    )
    .action(async () => {
      setExit(await lanesVerb(ctx));
    });

  program
    .command("kill")
    .description("Kill a queued, running, or blocked lane and its recorded process group.")
    .argument("<laneId>", 'lane id (matches "lane_" plus 8 hex digits)', parseLaneId)
    .addHelpText(
      "after",
      agentsHelp(
        "Prints exactly one JSON envelope; killing an already-killed lane is idempotent (exit 0)," +
          " killing a completed/failed/lost lane fails with code:invalid_state (exit 4).",
        "orca kill lane_a3f81c02",
      ),
    )
    .action(async (laneId: string) => {
      setExit(await killVerb(ctx, laneId));
    });

  program
    .command("agents")
    .description("Print static agent manifests from the adapter registry.")
    .addHelpText(
      "after",
      agentsHelp(
        'Prints exactly one kind:"agents" JSON envelope; adapters that fail to load are' +
          " reported on stderr and as a result.text caveat, and never fail the command.",
        "orca agents",
      ),
    )
    .action(async () => {
      setExit(await agentsVerb(ctx));
    });

  program
    .command("contract")
    .description("Print the machine-readable orca/v1 contract (schemas, exit codes, verbs).")
    .addOption(
      new Option("--schema <name>", "print only the named JSON Schema subset").choices([
        "envelope",
        "event",
        "manifest",
      ]),
    )
    .addHelpText(
      "after",
      agentsHelp(
        'Prints exactly one kind:"contract" JSON envelope whose "contract" field carries the' +
          " payload; pipe it to a JSON parser.",
        "orca contract --schema envelope",
      ),
    )
    .action(async (options: ContractCommandOptions) => {
      setExit(await contractVerb(ctx, options));
    });

  return program;
}

function laneCliErrorExit(ctx: LaneCliContext, error: unknown): number {
  if (error instanceof CommanderError) {
    if (error.exitCode === 0) {
      // --help and friends: help text already written, not an envelope case.
      return EXIT_CODES.ok;
    }

    return printEnvelope(
      ctx.stdout,
      errorEnvelope({
        code: "usage_error",
        message: stripErrorPrefix(error.message),
        remediation:
          'Add --help to the verb for usage, or run "orca contract" for the machine-readable contract.',
      }),
    );
  }

  const failure = classifyError(error);
  return printEnvelope(
    ctx.stdout,
    errorEnvelope({
      code: failure.code,
      message: failure.message,
      ...(failure.remediation !== undefined ? { remediation: failure.remediation } : {}),
    }),
  );
}

function stripErrorPrefix(message: string): string {
  return message.replace(/^error:\s*/i, "");
}

function parseSeq(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || String(parsed) !== value.trim()) {
    throw new InvalidArgumentError("--since must be a non-negative integer");
  }

  return parsed;
}

function parseTimeout(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || String(parsed) !== value.trim()) {
    throw new InvalidArgumentError("--timeout must be a positive integer (milliseconds)");
  }

  return parsed;
}

function parseLaneId(value: string): string {
  if (!isValidLaneId(value)) {
    throw new InvalidArgumentError(
      'lane id must match /^lane_[0-9a-f]{8}$/ (example: "lane_a3f81c02")',
    );
  }

  return value;
}

// ---------------------------------------------------------------------------
// Verb handlers
// ---------------------------------------------------------------------------

interface LaneEventSink {
  onEvent: (event: LaneEventInput) => Promise<void>;
  emittedKinds: Set<LaneEventKind>;
}

const TERMINAL_EVENT_KINDS: ReadonlySet<LaneEventKind> = new Set(["result", "failed", "killed"]);

function createLaneEventSink(ctx: LaneCliContext, laneId: string): LaneEventSink {
  const emittedKinds = new Set<LaneEventKind>();

  return {
    emittedKinds,
    onEvent: async (event) => {
      // Terminal evidence is committed together with the status CAS after
      // the adapter returns. Buffering the kind here prevents any durable
      // terminal event/status split and lets settlement reject mismatches.
      if (TERMINAL_EVENT_KINDS.has(event.event)) {
        emittedKinds.add(event.event);
        return;
      }

      if (event.event === "agent_started") {
        const processInfo = processInfoFromEvent(event);
        if (processInfo !== undefined) {
          await recordSpawnIdentity(ctx, laneId, event, processInfo);
          emittedKinds.add("agent_started");
          return;
        }
      }

      let recorded: LaneEvent;
      if (event.event === "question") {
        recorded = (
          await ctx.store.transitionLaneWithEvent(
            laneId,
            { from: ["running", "blocked"], to: "blocked" },
            event,
          )
        ).event;
      } else if (event.event === "answered") {
        recorded = (await ctx.store.consumeAnswerWithEvent(laneId, event, consumeOptionsFor(event)))
          .event;
      } else {
        recorded = await ctx.store.appendEvent(laneId, event);
      }
      emittedKinds.add(recorded.event);
    },
  };
}

/**
 * The consumed generation an adapter echoes in its answered event (from the
 * submission event data). Adapters that do not echo one yet fall back to the
 * legacy behavior: consume the current answer unconditionally.
 */
function consumeOptionsFor(event: LaneEventInput): ConsumeAnswerOptions {
  const generation = event.data?.generation;
  return typeof generation === "number" && Number.isInteger(generation) && generation >= 0
    ? { generation }
    : {};
}

/** Event data keys owned by the store's identity event; the rest is metadata. */
const IDENTITY_EVENT_KEYS: ReadonlySet<string> = new Set(["pid", "pgid", "startedAt"]);

/**
 * Persists adapter-reported process identity immediately through the
 * dedicated store operation (finding 15). When the lane already settled
 * terminally (kill-before-spawn), nothing is persisted: the just-reported
 * process group is terminated (POSIX process-group kill, per the v0
 * contract) and the sink fails loud so the adapter run settles against the
 * stored terminal lane instead of overwriting it.
 */
async function recordSpawnIdentity(
  ctx: LaneCliContext,
  laneId: string,
  event: LaneEventInput,
  processInfo: LaneProcessInfo,
): Promise<void> {
  const identity = await ctx.store.recordProcessIdentity(laneId, processInfo);
  if (identity.laneKilled) {
    const cleanup =
      processInfo.pgid !== undefined
        ? await terminateProcessGroup(ctx, processInfo.pgid)
        : {
            terminated: false,
            forced: false,
            detail: `Process ${processInfo.pid} reported no process group and was not signalled.`,
          };
    throw new AdapterError(
      "adapter_error",
      `Lane ${laneId} was already ${identity.lane.status} when the agent process was reported. ${cleanup.detail}`,
    );
  }

  // The store's agent_started evidence carries identity only. Session/model
  // metadata bundled into the same adapter event stays durable as a
  // follow-up observability record.
  const metadata = Object.fromEntries(
    Object.entries(event.data ?? {}).filter(([key]) => !IDENTITY_EVENT_KEYS.has(key)),
  );
  if (Object.keys(metadata).length > 0) {
    await ctx.store.appendEvent(laneId, {
      event: "progress",
      data: { type: "agent_metadata", ...metadata },
    });
  }
}

function processInfoFromEvent(event: LaneEventInput): LaneProcessInfo | undefined {
  const data = event.data ?? {};
  if (data.pid === undefined && data.pgid === undefined) {
    return undefined;
  }

  const parsed = LaneProcessInfoSchema.safeParse({
    pid: data.pid,
    ...(data.pgid !== undefined ? { pgid: data.pgid } : {}),
    startedAt: typeof data.startedAt === "string" ? data.startedAt : new Date().toISOString(),
  });
  if (!parsed.success) {
    throw new AdapterError(
      "adapter_error",
      `Adapter emitted invalid process identity: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
    );
  }
  if (parsed.data.pgid !== undefined && parsed.data.pgid !== parsed.data.pid) {
    throw new AdapterError(
      "adapter_error",
      `Adapter emitted unsafe process identity: detached pgid ${parsed.data.pgid} does not match pid ${parsed.data.pid}.`,
    );
  }

  return parsed.data;
}

async function dispatchVerb(
  ctx: LaneCliContext,
  prompt: string,
  options: DispatchCommandOptions,
): Promise<number> {
  if (options.detach === true) {
    return printEnvelope(
      ctx.stdout,
      errorEnvelope({
        code: "usage_error",
        message:
          "--detach is not available in v0; dispatch runs synchronously to a terminal or blocked state.",
        remediation:
          'Drop --detach and dispatch synchronously, or run dispatch in the background and use "orca inspect <laneId> --follow" from another process.',
      }),
    );
  }

  const surface = options.surface ?? "lane";
  const label = options.label?.trim();
  if (surface === "task" && options.agent !== "codex") {
    return printEnvelope(
      ctx.stdout,
      errorEnvelope({
        code: "usage_error",
        message: "--surface task is supported only with --agent codex.",
        remediation:
          'Use "--agent codex --surface task --label <title>", or omit --surface for an internal lane.',
      }),
    );
  }
  if (surface === "task" && !label) {
    return printEnvelope(
      ctx.stdout,
      errorEnvelope({
        code: "usage_error",
        message: "--surface task requires a non-empty --label for the user-facing task title.",
        remediation: 'Add --label "<concise task title>".',
      }),
    );
  }

  const resolution = await resolveAdapter(ctx, options.agent);
  if (!resolution.ok) {
    return printEnvelope(ctx.stdout, resolution.envelope);
  }

  const { store } = ctx;
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const lane = await store.createLane({
    agent: options.agent,
    surface,
    cwd,
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(label !== undefined && label !== "" ? { label } : {}),
  });
  printHandle(ctx.stdout, { laneId: lane.id, agent: lane.agent });

  try {
    await store.transitionLane(lane.id, { from: ["queued"], to: "running" });
  } catch (error) {
    if (error instanceof TransitionConflictError) {
      return printStoredLane(ctx, lane.id);
    }
    throw error;
  }

  const startedAt = Date.now();
  const eventSink = createLaneEventSink(ctx, lane.id);
  let outcome: DispatchOutcome;
  try {
    outcome = await resolution.adapter.dispatch({
      laneId: lane.id,
      prompt,
      cwd,
      surface,
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(label !== undefined && label !== "" ? { label } : {}),
      ...(options.timeout !== undefined ? { timeoutMs: options.timeout } : {}),
      onEvent: eventSink.onEvent,
    });
  } catch (error) {
    return settleThrown(ctx, lane.id, error, startedAt);
  }

  return settleOutcome(ctx, lane.id, outcome, startedAt, eventSink.emittedKinds);
}

async function inspectVerb(
  ctx: LaneCliContext,
  laneId: string,
  options: InspectCommandOptions,
): Promise<number> {
  const { store } = ctx;
  let lane = await store.loadLane(laneId);
  if (!lane) {
    return printLaneNotFound(ctx, laneId);
  }

  const waiting = options.follow === true || options.waitFor !== undefined;
  // Plain inspect prints stored events; --follow streams them; --wait-for
  // alone stays quiet (it is a synchronization primitive).
  const streaming = options.follow === true || !waiting;
  const timeoutMs = options.timeout ?? DEFAULT_WAIT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let cursor = options.since ?? 0;

  for (;;) {
    const fresh = await store.readEvents(laneId, { sinceSeq: cursor });
    for (const event of fresh) {
      cursor = event.seq;
      if (streaming) {
        ctx.stdout.write(`${JSON.stringify(event)}\n`);
      }
    }

    lane = (await store.loadLane(laneId)) ?? lane;
    if (!waiting || isStopStatus(lane.status, options.waitFor)) {
      break;
    }

    if (Date.now() >= deadline) {
      return printEnvelope(
        ctx.stdout,
        errorEnvelope({
          kind: "lane",
          status: lane.status,
          code: "timeout",
          message:
            `Timed out after ${timeoutMs}ms waiting for lane ${laneId} to reach ` +
            `${options.waitFor ?? "a blocked or terminal"} state (status: ${lane.status}).`,
          remediation: `Re-run "orca inspect ${laneId} --wait-for ${options.waitFor ?? "done"} --timeout <ms>" with a larger timeout.`,
          lane,
          delivery: lane.status === "queued" ? "not_sent" : "unknown",
          nativeStatus: "unknown",
          semanticOutcome: "unknown",
        }),
      );
    }

    const remaining = Math.max(deadline - Date.now(), 1);
    await waitForLaneChange(store.getLaneDir(laneId), Math.min(ctx.pollIntervalMs, remaining));
  }

  const events = await store.readEvents(laneId);
  return printEnvelope(ctx.stdout, envelopeForLaneState(lane, events, ctx.isPidAlive));
}

async function answerVerb(ctx: LaneCliContext, laneId: string, text: string): Promise<number> {
  const { store } = ctx;
  const lane = await store.loadLane(laneId);
  if (!lane) {
    return printLaneNotFound(ctx, laneId);
  }

  if (lane.status !== "blocked") {
    return printEnvelope(
      ctx.stdout,
      errorEnvelope({
        kind: "lane",
        status: lane.status,
        code: "invalid_state",
        message: `Lane ${laneId} is not blocked (status: ${lane.status}); there is no pending question to answer.`,
        remediation: TERMINAL_LANE_STATUSES.has(lane.status)
          ? `The lane already settled; run "orca inspect ${laneId}" for its outcome, or dispatch a new lane.`
          : `Run "orca inspect ${laneId} --wait-for blocked --timeout <ms>" to wait for a question.`,
        lane,
        delivery: "not_sent",
        nativeStatus: "unknown",
        semanticOutcome: "unknown",
      }),
    );
  }

  let updated: LaneRecord;
  let generation: number;
  try {
    const submitted = await store.submitAnswer(laneId, text);
    updated = submitted.lane;
    generation = submitted.generation;
  } catch (error) {
    if (error instanceof TransitionConflictError) {
      const current = (await store.loadLane(laneId)) ?? lane;
      return printEnvelope(
        ctx.stdout,
        errorEnvelope({
          kind: "lane",
          status: current.status,
          code: "invalid_state",
          message: `Lane ${laneId} stopped being blocked before the answer could be submitted (status: ${current.status}).`,
          remediation: `Run "orca inspect ${laneId}" to see the lane state.`,
          lane: current,
          delivery: "not_sent",
          nativeStatus: "unknown",
          semanticOutcome: "unknown",
        }),
      );
    }
    throw error;
  }
  const events = await store.readEvents(laneId);

  return printEnvelope(
    ctx.stdout,
    okEnvelope({
      kind: "lane",
      status: updated.status,
      lane: updated,
      delivery: "not_sent",
      nativeStatus: "unknown",
      semanticOutcome: "unknown",
      // The submission generation is durable in the answered event and in
      // lane.answerGeneration; surface it here so callers can correlate the
      // eventual consumption event without re-reading the log.
      result: { text: `Answer recorded (generation ${generation}).` },
      next: nextAfterAnswer(laneId, events),
    }),
  );
}

async function resumeVerb(
  ctx: LaneCliContext,
  laneId: string,
  prompt: string,
  options: ResumeCommandOptions,
): Promise<number> {
  const { store } = ctx;
  const lane = await store.loadLane(laneId);
  if (!lane) {
    return printLaneNotFound(ctx, laneId);
  }

  const resolution = await resolveAdapter(ctx, lane.agent);
  if (!resolution.ok) {
    return printEnvelope(ctx.stdout, resolution.envelope);
  }

  const startedAt = Date.now();
  try {
    // Locked CAS (finding 14): resumable states are blocked (non-live
    // question, or live question whose recorded poller is dead), completed
    // (the documented terminal carve-out — a resume is a new user turn), and
    // running whose recorded resumer pid is dead (ownerless-lane reclaim).
    await store.beginResume(laneId);
  } catch (error) {
    if (error instanceof TransitionConflictError) {
      return printResumeRejected(ctx, laneId, lane, error);
    }
    throw error;
  }

  const eventSink = createLaneEventSink(ctx, laneId);
  let outcome: DispatchOutcome;
  try {
    outcome = await resolution.adapter.resume(lane, prompt, {
      onEvent: eventSink.onEvent,
      ...(options.timeout !== undefined ? { timeoutMs: options.timeout } : {}),
    });
  } catch (error) {
    if (error instanceof ContinuityError) {
      // Continuity failures leave the lane untouched: restore its prior state.
      let restored: LaneRecord;
      try {
        restored = await store.transitionLane(laneId, {
          from: ["running", "blocked"],
          to: lane.status,
        });
      } catch (transitionError) {
        if (transitionError instanceof TransitionConflictError) {
          return printStoredLane(ctx, laneId);
        }
        throw transitionError;
      }
      return printEnvelope(
        ctx.stdout,
        errorEnvelope({
          kind: "lane",
          status: restored.status,
          code: "continuity_unverified",
          message:
            error.detail !== undefined ? `${error.message} (${error.detail})` : error.message,
          ...(error.remediation !== undefined ? { remediation: error.remediation } : {}),
          lane: restored,
          delivery: "not_sent",
          nativeStatus: "unknown",
          semanticOutcome: "unknown",
          timing: { wallMs: Date.now() - startedAt },
        }),
      );
    }

    return settleThrown(ctx, laneId, error, startedAt);
  }

  return settleOutcome(ctx, laneId, outcome, startedAt, eventSink.emittedKinds);
}

/**
 * State-precondition failures from beginResume are invalid_state (exit 4):
 * the command line was well-formed, the lane is simply not resumable right
 * now. Remediations stay precise per rejection cause.
 */
async function printResumeRejected(
  ctx: LaneCliContext,
  laneId: string,
  lane: LaneRecord,
  error: TransitionConflictError,
): Promise<number> {
  const current = (await ctx.store.loadLane(laneId)) ?? lane;

  let message: string;
  let remediation: string;
  if (error.actualStatus === "blocked") {
    // beginResume rejects a still-blocked lane only when its latest question
    // is live AND the recorded dispatch process is alive: it is polling
    // answer.txt, so a concurrent resume would double-drive the agent.
    message =
      `Lane ${laneId} cannot be resumed: its latest question is live, ` +
      "so the original dispatch is still attached and polling for the answer.";
    remediation =
      `Deliver the answer with "orca answer ${laneId} <text>", then wait with ` +
      `"orca inspect ${laneId} --wait-for done --timeout ${DEFAULT_WAIT_TIMEOUT_MS}".`;
  } else if (error.actualStatus === "running") {
    message =
      `Lane ${laneId} is already running and its owner appears alive; ` +
      "a concurrent resume would double-drive the agent.";
    remediation = `Wait with "orca inspect ${laneId} --wait-for done --timeout ${DEFAULT_WAIT_TIMEOUT_MS}".`;
  } else if (TERMINAL_LANE_STATUSES.has(error.actualStatus)) {
    message =
      `Lane ${laneId} is ${error.actualStatus} and cannot be resumed; ` +
      "only blocked and completed lanes are resumable.";
    remediation = `Dispatch a new lane instead: orca dispatch --agent ${lane.agent} --cwd ${lane.cwd} "<prompt>".`;
  } else {
    message = `Lane ${laneId} is ${error.actualStatus} and cannot be resumed yet.`;
    remediation = `Run "orca inspect ${laneId}" to see the lane state.`;
  }

  return printEnvelope(
    ctx.stdout,
    errorEnvelope({
      kind: "lane",
      status: current.status,
      code: "invalid_state",
      message,
      remediation,
      lane: current,
      delivery: "not_sent",
      nativeStatus: "unknown",
      semanticOutcome: "unknown",
    }),
  );
}

async function lanesVerb(ctx: LaneCliContext): Promise<number> {
  const lanes = await ctx.store.listLanes();
  return printEnvelope(ctx.stdout, okEnvelope({ kind: "list", lanes }));
}

async function killVerb(ctx: LaneCliContext, laneId: string): Promise<number> {
  const { store } = ctx;
  const lane = await store.loadLane(laneId);
  if (!lane) {
    return printLaneNotFound(ctx, laneId);
  }

  if (lane.status === "killed") {
    const events = await store.readEvents(laneId);
    const evidence = terminalEvidence(events, lane.status);
    return printEnvelope(
      ctx.stdout,
      okEnvelope({
        kind: "lane",
        status: "killed",
        lane,
        delivery: evidence.delivery ?? "unknown",
        nativeStatus: evidence.nativeStatus ?? "unknown",
        semanticOutcome: "unknown",
      }),
    );
  }

  if (TERMINAL_LANE_STATUSES.has(lane.status)) {
    return printEnvelope(
      ctx.stdout,
      errorEnvelope({
        kind: "lane",
        status: lane.status,
        code: "invalid_state",
        message: `Lane ${laneId} is already ${lane.status} and cannot be killed.`,
        remediation: `Run "orca inspect ${laneId}" to see the lane state.`,
        lane,
        delivery: "unknown",
        nativeStatus: "unknown",
        semanticOutcome: "unknown",
      }),
    );
  }

  let termination: ProcessTerminationResult = {
    terminated: false,
    forced: false,
    detail: "Lane had no recorded process group; only the durable lane state was killed.",
  };
  let delivery: Delivery = lane.status === "queued" ? "not_sent" : "unknown";
  let updated: LaneRecord;
  try {
    // The evidence factory runs under the lane lock: settlement cannot win
    // while process-group termination is pending, and readers never observe a
    // killed status before its evidence event exists.
    updated = (
      await store.transitionLaneWithEvent(
        laneId,
        { from: ["queued", "running", "blocked"], to: "killed" },
        async (current) => {
          delivery = current.status === "queued" ? "not_sent" : "unknown";
          if (current.process?.pgid !== undefined) {
            termination = await terminateProcessGroup(ctx, current.process.pgid);
          }
          const nativeStatus: NativeStatus = termination.terminated ? "interrupted" : "unknown";
          return {
            event: "killed",
            data: {
              reason: "orca kill",
              delivery,
              nativeStatus,
              forced: termination.forced,
              detail: termination.detail,
            },
          };
        },
      )
    ).lane;
  } catch (error) {
    if (error instanceof TransitionConflictError) {
      return printStoredLane(ctx, laneId);
    }
    throw error;
  }

  const nativeStatus: NativeStatus = termination.terminated ? "interrupted" : "unknown";

  return printEnvelope(
    ctx.stdout,
    okEnvelope({
      kind: "lane",
      status: "killed",
      lane: updated,
      delivery,
      nativeStatus,
      semanticOutcome: "unknown",
      result: { text: termination.detail },
    }),
  );
}

async function agentsVerb(ctx: LaneCliContext): Promise<number> {
  const failures: string[] = [];
  for (const agent of ctx.builtinAgents) {
    if (ctx.registry.get(agent) !== undefined) {
      continue;
    }

    try {
      await ctx.loadAdapterModule(agent, ctx.registry, ctx.store);
    } catch (error) {
      failures.push(`${agent}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (const failure of failures) {
    ctx.stderr.write(`adapter unavailable — ${failure}\n`);
  }

  return printEnvelope(
    ctx.stdout,
    okEnvelope({
      kind: "agents",
      agents: ctx.registry.list(),
      ...(failures.length > 0
        ? { result: { text: `Unavailable adapters: ${failures.join("; ")}` } }
        : {}),
    }),
  );
}

async function contractVerb(ctx: LaneCliContext, options: ContractCommandOptions): Promise<number> {
  const contract: Record<string, unknown> =
    options.schema !== undefined
      ? {
          contractVersion: LANE_CONTRACT_VERSION,
          schemas: { [options.schema]: getContractSchema(options.schema) },
        }
      : { ...buildContractPayload() };

  return printEnvelope(ctx.stdout, okEnvelope({ kind: "contract", contract }));
}

// ---------------------------------------------------------------------------
// Adapter resolution and outcome settlement
// ---------------------------------------------------------------------------

type AdapterResolution = { ok: true; adapter: AgentAdapter } | { ok: false; envelope: Envelope };

async function resolveAdapter(ctx: LaneCliContext, agent: string): Promise<AdapterResolution> {
  let loadError: string | undefined;
  if (ctx.registry.get(agent) === undefined && ctx.builtinAgents.includes(agent)) {
    try {
      await ctx.loadAdapterModule(agent, ctx.registry, ctx.store);
    } catch (error) {
      loadError = error instanceof Error ? error.message : String(error);
    }
  }

  const adapter = ctx.registry.get(agent);
  if (adapter !== undefined) {
    return { ok: true, adapter };
  }

  const known = [
    ...new Set([...ctx.builtinAgents, ...ctx.registry.list().map((manifest) => manifest.agent)]),
  ].sort();
  return {
    ok: false,
    envelope: errorEnvelope({
      code: "agent_unavailable",
      message:
        loadError !== undefined
          ? `Adapter for agent "${agent}" failed to load: ${loadError}`
          : `No adapter registered for agent: ${agent}`,
      remediation:
        known.length > 0
          ? `Known agents: ${known.join(", ")}. Run "orca agents" for manifests.`
          : 'Run "orca agents" for manifests.',
    }),
  };
}

async function settleOutcome(
  ctx: LaneCliContext,
  laneId: string,
  outcome: DispatchOutcome,
  startedAt: number,
  emittedKinds: ReadonlySet<LaneEventKind>,
): Promise<number> {
  const { store } = ctx;
  const outcomeEvent = eventForOutcome(outcome);
  const mismatchedTerminalKinds = [...TERMINAL_EVENT_KINDS].filter(
    (kind) => emittedKinds.has(kind) && kind !== outcomeEvent.event,
  );
  if (mismatchedTerminalKinds.length > 0) {
    return settleThrown(
      ctx,
      laneId,
      new AdapterError(
        "adapter_error",
        `Adapter emitted terminal event ${mismatchedTerminalKinds.join(", ")} but returned status ${outcome.status}.`,
      ),
      startedAt,
    );
  }
  const transition = {
    from: ["queued", "running", "blocked"] as LaneStatus[],
    to: outcome.status,
  };
  const questionAlreadyPersisted =
    outcomeEvent.event === "question" && emittedKinds.has("question");

  let lane: LaneRecord;
  try {
    lane = questionAlreadyPersisted
      ? await store.transitionLane(laneId, transition)
      : (await store.transitionLaneWithEvent(laneId, transition, outcomeEvent)).lane;
  } catch (error) {
    if (error instanceof TransitionConflictError) {
      return printStoredLane(ctx, laneId);
    }
    throw error;
  }

  const timing = outcome.timing ?? { wallMs: Date.now() - startedAt };

  // Persist usage/timing onto lane.json at terminal settlement so a later
  // inspect of the settled lane can still report them; the settling process
  // (the only holder of the adapter outcome) is long gone by then.
  const settlementPatch: LaneMetadataPatch = {
    ...(outcome.agentSessionId !== undefined ? { agentSessionId: outcome.agentSessionId } : {}),
    ...(TERMINAL_LANE_STATUSES.has(lane.status)
      ? { timing, ...(outcome.usage !== undefined ? { usage: outcome.usage } : {}) }
      : {}),
  };
  if (Object.keys(settlementPatch).length > 0) {
    lane = await store.updateLane(laneId, settlementPatch);
  } else {
    lane = (await store.loadLane(laneId)) ?? lane;
  }

  if (outcome.status === "failed") {
    const code = outcome.code ?? "agent_failed";
    return printEnvelope(
      ctx.stdout,
      errorEnvelope({
        kind: "lane",
        status: "failed",
        code,
        message: outcome.error?.message ?? `Agent run failed (${code}).`,
        ...(outcome.error?.remediation !== undefined
          ? { remediation: outcome.error.remediation }
          : {}),
        lane,
        delivery: outcome.delivery,
        nativeStatus: outcome.nativeStatus,
        semanticOutcome: "unknown",
        timing,
        ...(outcome.usage !== undefined ? { usage: outcome.usage } : {}),
        ...(outcome.continuity !== undefined ? { continuity: outcome.continuity } : {}),
        next: [`orca inspect ${laneId}`],
      }),
    );
  }

  const next = nextForLane(lane, lane.status === "blocked" ? await store.readEvents(laneId) : []);
  // An empty completed result is settled honestly but flagged: the turn ended
  // per protocol evidence, yet there is no response text to act on.
  const warnings =
    lane.status === "completed" && (outcome.result?.text ?? "").trim() === ""
      ? [EMPTY_RESULT_WARNING]
      : undefined;
  return printEnvelope(
    ctx.stdout,
    okEnvelope({
      kind: "lane",
      status: lane.status,
      lane,
      delivery: outcome.delivery,
      nativeStatus: outcome.nativeStatus,
      semanticOutcome: "unknown",
      timing,
      ...(outcome.blocked !== undefined ? { blocked: outcome.blocked } : {}),
      ...(outcome.result !== undefined ? { result: outcome.result } : {}),
      ...(outcome.usage !== undefined ? { usage: outcome.usage } : {}),
      ...(outcome.continuity !== undefined ? { continuity: outcome.continuity } : {}),
      ...(next !== undefined ? { next } : {}),
      ...(warnings !== undefined ? { warnings } : {}),
    }),
  );
}

function eventForOutcome(outcome: DispatchOutcome): LaneEventInput {
  const evidence = { delivery: outcome.delivery, nativeStatus: outcome.nativeStatus };

  if (outcome.status === "blocked") {
    return {
      event: "question",
      data: { questions: outcome.blocked?.questions ?? [], ...evidence },
    };
  }
  if (outcome.status === "completed") {
    return {
      event: "result",
      data: {
        ...(outcome.result !== undefined
          ? {
              text: outcome.result.text,
              ...(outcome.result.artifacts !== undefined
                ? { artifacts: outcome.result.artifacts }
                : {}),
            }
          : {}),
        ...evidence,
      },
    };
  }
  if (outcome.status === "failed") {
    return {
      event: "failed",
      data: {
        code: outcome.code ?? "agent_failed",
        ...(outcome.error !== undefined ? { message: outcome.error.message } : {}),
        ...evidence,
      },
    };
  }
  return { event: "killed", data: evidence };
}

/** Settles a lane after the adapter threw: mark failed, print the envelope. */
async function settleThrown(
  ctx: LaneCliContext,
  laneId: string,
  error: unknown,
  startedAt: number,
): Promise<number> {
  const { store } = ctx;
  const failure = classifyError(error);
  const failureEvent: LaneEventInput = {
    event: "failed",
    data: {
      code: failure.code,
      message: failure.message,
      delivery: "unknown",
      nativeStatus: "unknown",
    },
  };
  const transition = {
    from: ["queued", "running", "blocked"] as LaneStatus[],
    to: "failed" as const,
  };

  let lane: LaneRecord;
  try {
    lane = (await store.transitionLaneWithEvent(laneId, transition, failureEvent)).lane;
  } catch (transitionError) {
    if (transitionError instanceof TransitionConflictError) {
      return printStoredLane(ctx, laneId);
    }
    throw transitionError;
  }

  const timing = { wallMs: Date.now() - startedAt };
  lane = await store.updateLane(laneId, { timing });

  return printEnvelope(
    ctx.stdout,
    errorEnvelope({
      kind: "lane",
      status: "failed",
      code: failure.code,
      message: failure.message,
      ...(failure.remediation !== undefined ? { remediation: failure.remediation } : {}),
      lane,
      delivery: "unknown",
      nativeStatus: "unknown",
      semanticOutcome: "unknown",
      timing,
    }),
  );
}

function classifyError(error: unknown): {
  code: ErrorCode;
  message: string;
  remediation?: string;
} {
  if (error instanceof ContinuityError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.remediation !== undefined ? { remediation: error.remediation } : {}),
    };
  }

  if (error instanceof AdapterError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.remediation !== undefined ? { remediation: error.remediation } : {}),
    };
  }

  if (error instanceof InvalidLaneIdError) {
    return {
      code: "usage_error",
      message: error.message,
      remediation: 'Use a lane id matching "lane_" plus exactly 8 lowercase hex digits.',
    };
  }

  if (error instanceof LaneNotFoundError) {
    return {
      code: "lane_not_found",
      message: error.message,
      remediation: 'Run "orca lanes" to list known lanes.',
    };
  }

  return {
    code: "adapter_error",
    message: error instanceof Error ? error.message : String(error),
  };
}

function printLaneNotFound(ctx: LaneCliContext, laneId: string): number {
  return printEnvelope(
    ctx.stdout,
    errorEnvelope({
      code: "lane_not_found",
      message: `Lane not found: ${laneId}`,
      remediation: 'Run "orca lanes" to list known lanes.',
    }),
  );
}

async function printStoredLane(ctx: LaneCliContext, laneId: string): Promise<number> {
  const lane = await ctx.store.loadLane(laneId);
  if (!lane) {
    return printLaneNotFound(ctx, laneId);
  }

  const events = await ctx.store.readEvents(laneId);
  return printEnvelope(ctx.stdout, envelopeForLaneState(lane, events, ctx.isPidAlive));
}

// ---------------------------------------------------------------------------
// Lane-state reconstruction (inspect)
// ---------------------------------------------------------------------------

const EVIDENCE_EVENT_KINDS = new Set(["question", "result", "failed", "killed"]);

function isStopStatus(status: LaneStatus, waitFor: "blocked" | "done" | undefined): boolean {
  if (TERMINAL_LANE_STATUSES.has(status)) {
    return true;
  }

  return status === "blocked" && waitFor !== "done";
}

function envelopeForLaneState(
  lane: LaneRecord,
  events: LaneEvent[],
  isAlive: (pid: number) => boolean = isPidAlive,
): Envelope {
  const evidence = terminalEvidence(events, lane.status);
  const delivery = evidence.delivery ?? (lane.status === "queued" ? "not_sent" : "unknown");
  const nativeStatus =
    evidence.nativeStatus ?? (lane.status === "completed" ? "completed" : "unknown");

  // Usage/timing persisted onto lane.json at settlement survive the settling
  // process; surface them on later inspects of terminal lanes.
  const usage = TERMINAL_LANE_STATUSES.has(lane.status) ? lane.usage : undefined;
  const timing = TERMINAL_LANE_STATUSES.has(lane.status) ? lane.timing : undefined;
  const warnings = staleRunningWarnings(lane, isAlive);

  if (lane.status === "failed" || lane.status === "lost") {
    const failure =
      lane.status === "lost"
        ? {
            code: "adapter_error" as ErrorCode,
            message: `Lane ${lane.id} is lost: its state can no longer be tracked.`,
          }
        : failureFromEvents(events);
    return errorEnvelope({
      kind: "lane",
      status: lane.status,
      code: failure.code,
      message: failure.message,
      lane,
      delivery,
      nativeStatus,
      semanticOutcome: "unknown",
      ...(usage !== undefined ? { usage } : {}),
      ...(timing !== undefined ? { timing } : {}),
    });
  }

  const blocked = lane.status === "blocked" ? blockedFromEvents(events) : undefined;
  const result = lane.status === "completed" ? resultFromEvents(events) : undefined;
  const next = nextForLane(lane, events);

  return okEnvelope({
    kind: "lane",
    status: lane.status,
    lane,
    delivery,
    nativeStatus,
    semanticOutcome: "unknown",
    ...(blocked !== undefined ? { blocked } : {}),
    ...(result !== undefined ? { result } : {}),
    ...(usage !== undefined ? { usage } : {}),
    ...(timing !== undefined ? { timing } : {}),
    ...(next !== undefined ? { next } : {}),
    ...(warnings !== undefined ? { warnings } : {}),
  });
}

/**
 * A lane that claims "running" while its recorded process is dead almost
 * certainly lost its dispatch process mid-run. Inspect reports the evidence
 * as a warning detail only — it never auto-transitions the status, because a
 * dead leader pid does not prove the whole tree (or a reattached resumer) is
 * gone.
 */
function staleRunningWarnings(
  lane: LaneRecord,
  isAlive: (pid: number) => boolean,
): string[] | undefined {
  if (lane.status !== "running" || lane.process === undefined || isAlive(lane.process.pid)) {
    return undefined;
  }

  return [
    `Stale running: recorded lane process (pid ${lane.process.pid}) is gone, so the dispatch ` +
      "process that owned this run has likely exited without settling the lane. The status was " +
      `NOT changed automatically; "orca resume ${lane.id} <prompt>" may reclaim it if its ` +
      `recorded resumer is dead, or "orca kill ${lane.id}" settles it as killed.`,
  ];
}

interface TerminalEvidence {
  delivery?: Delivery;
  nativeStatus?: NativeStatus;
}

function terminalEvidence(events: LaneEvent[], status: LaneStatus): TerminalEvidence {
  const expectedKind = terminalEventKindForStatus(status);
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (
      event === undefined ||
      !EVIDENCE_EVENT_KINDS.has(event.event) ||
      (expectedKind !== undefined && event.event !== expectedKind)
    ) {
      continue;
    }

    const delivery = DeliverySchema.safeParse(event.data.delivery);
    const nativeStatus = NativeStatusSchema.safeParse(event.data.nativeStatus);
    return {
      ...(delivery.success ? { delivery: delivery.data } : {}),
      ...(nativeStatus.success ? { nativeStatus: nativeStatus.data } : {}),
    };
  }

  return {};
}

function terminalEventKindForStatus(status: LaneStatus): LaneEventKind | undefined {
  switch (status) {
    case "completed":
      return "result";
    case "failed":
      return "failed";
    case "killed":
      return "killed";
    default:
      return undefined;
  }
}

function blockedFromEvents(events: LaneEvent[]): BlockedInfo | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event === undefined || event.event !== "question") {
      continue;
    }

    const parsed = BlockedInfoSchema.safeParse({ questions: event.data.questions });
    return parsed.success ? parsed.data : undefined;
  }

  return undefined;
}

function resultFromEvents(events: LaneEvent[]): ResultInfo | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event === undefined || event.event !== "result") {
      continue;
    }

    const parsed = ResultInfoSchema.safeParse(event.data);
    return parsed.success ? parsed.data : undefined;
  }

  return undefined;
}

function failureFromEvents(events: LaneEvent[]): { code: ErrorCode; message: string } {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event === undefined || event.event !== "failed") {
      continue;
    }

    const code = ErrorCodeSchema.safeParse(event.data.code);
    return {
      code: code.success ? code.data : "agent_failed",
      message: typeof event.data.message === "string" ? event.data.message : "Lane failed.",
    };
  }

  return { code: "agent_failed", message: "Lane failed." };
}

function nextForLane(lane: LaneRecord, events: LaneEvent[]): string[] | undefined {
  switch (lane.status) {
    case "blocked":
      return [
        `orca answer ${lane.id} "<your answer>"`,
        latestQuestionIsLive(events)
          ? `orca inspect ${lane.id} --wait-for done --timeout ${DEFAULT_WAIT_TIMEOUT_MS}`
          : `orca resume ${lane.id} "continue"`,
      ];
    case "queued":
    case "running":
      return [
        `orca inspect ${lane.id} --wait-for done --timeout ${DEFAULT_WAIT_TIMEOUT_MS}`,
        `orca inspect ${lane.id} --since ${lane.seq}`,
      ];
    default:
      return undefined;
  }
}

function nextAfterAnswer(laneId: string, events: LaneEvent[]): string[] {
  return [
    latestQuestionIsLive(events)
      ? `orca inspect ${laneId} --wait-for done --timeout ${DEFAULT_WAIT_TIMEOUT_MS}`
      : `orca resume ${laneId} "continue"`,
  ];
}

function latestQuestionIsLive(events: LaneEvent[]): boolean {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.event === "question") {
      return event.data.live === true;
    }
  }
  return false;
}

interface ProcessTerminationResult {
  terminated: boolean;
  forced: boolean;
  detail: string;
}

async function terminateProcessGroup(
  ctx: LaneCliContext,
  pgid: number,
): Promise<ProcessTerminationResult> {
  if (pgid <= 1 || pgid === process.pid || pgid === process.ppid) {
    return {
      terminated: false,
      forced: false,
      detail: `Refused to signal unsafe process group ${pgid}; lane state was killed only.`,
    };
  }

  if (!ctx.isProcessGroupAlive(pgid)) {
    return {
      terminated: false,
      forced: false,
      detail: `Process group ${pgid} had already exited; lane state was marked killed.`,
    };
  }

  try {
    ctx.signalProcessGroup(pgid, "SIGTERM");
  } catch (error) {
    return {
      terminated: false,
      forced: false,
      detail: `Could not signal process group ${pgid}: ${messageOf(error)}. Lane state was killed only.`,
    };
  }

  if (await waitForProcessGroupExit(ctx, pgid, ctx.killGraceMs)) {
    return {
      terminated: true,
      forced: false,
      detail: `Process group ${pgid} terminated after SIGTERM.`,
    };
  }

  try {
    ctx.signalProcessGroup(pgid, "SIGKILL");
  } catch (error) {
    return {
      terminated: false,
      forced: true,
      detail: `SIGTERM did not stop process group ${pgid}, and SIGKILL failed: ${messageOf(error)}.`,
    };
  }

  const verified = await waitForProcessGroupExit(ctx, pgid, Math.max(ctx.killGraceMs, 250));
  return {
    terminated: verified,
    forced: true,
    detail: verified
      ? `Process group ${pgid} required SIGKILL and termination was verified.`
      : `Process group ${pgid} still appeared alive after SIGKILL; lane state was killed but native interruption is unverified.`,
  };
}

async function waitForProcessGroupExit(
  ctx: LaneCliContext,
  pgid: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (ctx.isProcessGroupAlive(pgid)) {
    if (Date.now() >= deadline) {
      return false;
    }
    await sleep(Math.min(50, Math.max(deadline - Date.now(), 1)));
  }
  return true;
}

function signalProcessGroup(pgid: number, signal: NodeJS.Signals): void {
  if (process.platform === "win32") {
    throw new Error("process-group signalling is unavailable on Windows");
  }
  process.kill(-pgid, signal);
}

/** Signal-0 liveness probe; EPERM (exists but unsignalable) counts as alive. */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isProcessGroupAlive(pgid: number): boolean {
  if (process.platform === "win32") {
    return false;
  }

  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") {
      return false;
    }
    if (code === "EPERM") {
      return true;
    }
    throw error;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Waits for lane-dir activity via fs.watch, with the timer as poll fallback. */
function waitForLaneChange(laneDir: string, maxWaitMs: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    let watcher: FSWatcher | undefined;

    const finish = (): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      watcher?.close();
      resolve();
    };

    const timer = setTimeout(finish, maxWaitMs);

    try {
      watcher = watch(laneDir, finish);
      watcher.on("error", () => {
        // Ignore watcher errors; the polling timer still resolves.
      });
    } catch {
      // fs.watch unavailable on this platform/path; polling timer resolves.
    }
  });
}
