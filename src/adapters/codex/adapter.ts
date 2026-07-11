import { CodexClient } from "@happycatlabs/codex-client";
import type {
  ApprovalPolicy,
  CodexProcessInfo,
  SandboxMode,
  Thread,
} from "@happycatlabs/codex-client";

import { AdapterError, ContinuityError, adapterRegistry } from "../../lane/adapter.js";
import type {
  AdapterRegistry,
  AgentAdapter,
  DispatchRequest,
  ResumeOptions,
} from "../../lane/adapter.js";
import { LaneStore } from "../../lane/store.js";
import type {
  AgentManifest,
  DispatchOutcome,
  InspectSnapshot,
  LaneEventInput,
  LaneRecord,
} from "../../types/lane.js";
import {
  awaitWithin,
  DEFAULT_CLEANUP_GRACE_MS,
  startDeadline,
  swallowLateRejection,
} from "./deadline.js";
import { buildCodexManifest } from "./manifest.js";
import { resolveSessionPolicy } from "./sandbox.js";
import { runLaneTurn } from "./turn-runner.js";

/**
 * Codex-specific dispatch extension. DispatchRequest has no sandbox slot in
 * v0, so the read-only flag rides on a structural extension the CLI may pass.
 */
export interface CodexDispatchRequest extends DispatchRequest {
  /** Run the lane with a read-only sandbox instead of workspace-write. */
  readOnly?: boolean;
}

/** Options resolved per verb and handed to the client factory. */
export interface CodexClientLaunchOptions {
  cwd: string;
  model?: string;
  sandbox: SandboxMode;
  approvalPolicy: ApprovalPolicy;
  detached: boolean;
}

export interface CodexAdapterOptions {
  /**
   * Lane store used only for parked-question answer reads: answer.txt text
   * paired with the lane's answerGeneration under one lane lease. The CLI
   * owns all event persistence and lane status/session transitions.
   */
  store?: Pick<LaneStore, "readAnswerWithGeneration">;
  /** Path to the codex binary used to spawn `codex app-server`. */
  codexPath?: string;
  /** Poll interval for parked-question answer.txt checks (default 500ms). */
  answerPollMs?: number;
  /**
   * Budget for post-deadline cleanup: turn interrupt and transport
   * disconnect each get this bound instead of hanging on a wedged server.
   */
  cleanupGraceMs?: number;
  /** Test seam: builds the client (e.g. over a fake transport). */
  clientFactory?: (options: CodexClientLaunchOptions) => CodexClient;
  /**
   * developerInstructions injected on thread start AND resume, steering the
   * model to raise mid-task questions through the request-user-input tool
   * instead of parking them in result prose (which would settle the lane as
   * completed rather than blocked). Defaults to
   * CODEX_DEVELOPER_INSTRUCTIONS; pass a replacement to override, or an
   * empty string to disable injection entirely. Best-effort: the model can
   * still answer in prose (manifest caveat "questions_best_effort").
   */
  developerInstructions?: string;
}

const DEFAULT_ANSWER_POLL_MS = 500;

/**
 * Default developerInstructions (see CodexAdapterOptions.developerInstructions).
 * Without this steer, natural "ask the user" prompts produce the question as
 * result prose and the lane completes instead of blocking.
 */
export const CODEX_DEVELOPER_INSTRUCTIONS =
  "When you need input or a decision from the user mid-task, call the " +
  "request-user-input tool and wait for the answer. Never write the question " +
  "as your final message.";

/**
 * AgentAdapter for codex over the app-server protocol. Spawns one app-server
 * per verb invocation via CodexClient, binds a native thread, streams protocol
 * events through the caller-owned hook, and reports nativeStatus from protocol
 * evidence only — never from prose.
 *
 * Deadline model (finding 16): dispatch/resume compute ONE absolute deadline
 * from timeoutMs at entry. Connect, thread start/resume, and the turn all
 * draw from its remaining budget; interrupt and disconnect are separately
 * bounded by cleanupGraceMs so cleanup cannot hang either.
 */
export class CodexAdapter implements AgentAdapter {
  private readonly answerReader: Pick<LaneStore, "readAnswerWithGeneration">;
  private readonly answerPollMs: number;
  private readonly cleanupGraceMs: number;
  private readonly clientFactory: (options: CodexClientLaunchOptions) => CodexClient;
  /** Injected on thread start/resume; undefined when disabled ("" option). */
  private readonly developerInstructions: string | undefined;

  constructor(options: CodexAdapterOptions = {}) {
    this.answerReader = options.store ?? new LaneStore();
    this.answerPollMs = options.answerPollMs ?? DEFAULT_ANSWER_POLL_MS;
    this.cleanupGraceMs = options.cleanupGraceMs ?? DEFAULT_CLEANUP_GRACE_MS;
    const developerInstructions = options.developerInstructions ?? CODEX_DEVELOPER_INSTRUCTIONS;
    this.developerInstructions = developerInstructions === "" ? undefined : developerInstructions;

    const codexPath = options.codexPath;
    this.clientFactory =
      options.clientFactory ??
      ((launch) =>
        new CodexClient({
          clientName: "orca",
          clientTitle: "Orca",
          cwd: launch.cwd,
          // No model default: omitting model uses the server config default.
          ...(launch.model !== undefined ? { model: launch.model } : {}),
          approvalPolicy: launch.approvalPolicy,
          sandbox: launch.sandbox,
          detached: launch.detached,
          // request_user_input is feature-gated off in Default mode (verified
          // live 2026-07-11: the tool call is rejected with "unavailable in
          // Default mode" and the model falls back to asking in prose, which
          // defeats question parking). Enable the under-development flag so
          // parked questions can actually occur; see manifest caveat
          // questions_best_effort.
          spawnArgs: ["-c", "features.default_mode_request_user_input=true"],
          ...(codexPath !== undefined ? { codexPath } : {}),
        }));
  }

  capabilities(): AgentManifest {
    return buildCodexManifest();
  }

  async dispatch(req: DispatchRequest): Promise<DispatchOutcome> {
    const startedAt = Date.now();
    const deadline = startDeadline(req.timeoutMs);
    const policy = resolveSessionPolicy({ readOnly: isReadOnlyRequest(req) });
    const client = this.clientFactory({
      cwd: req.cwd,
      ...(req.model !== undefined ? { model: req.model } : {}),
      detached: true,
      ...policy,
    });

    return this.runWithClient(client, req.onEvent, async () => {
      // connect() spawns the transport synchronously before awaiting the
      // initialize handshake, so process identity exists as soon as the call
      // is made. Emit agent_started immediately (finding 15): the app-server
      // must be killable even when its protocol never comes up.
      const connecting = this.startConnect(client);
      await emitLaneEvent(req.onEvent, {
        event: "agent_started",
        data: {
          ...processIdentityEventData(client),
          startedAt: new Date(startedAt).toISOString(),
          ...(req.model !== undefined ? { model: req.model } : {}),
        },
      });

      const connected = await awaitWithin(connecting, deadline);
      if (connected.timedOut) {
        return setupTimeoutOutcome(
          "codex app-server connect (initialize) did not complete",
          req.timeoutMs,
          startedAt,
        );
      }

      const started = await awaitWithin(this.startThread(client), deadline);
      if (started.timedOut) {
        return setupTimeoutOutcome("codex thread/start did not complete", req.timeoutMs, startedAt);
      }
      const thread = started.value;
      const startupMs = Date.now() - startedAt;

      // Session metadata is protocol evidence and only exists post-connect;
      // it travels separately from the spawn-time identity above.
      await emitLaneEvent(req.onEvent, {
        event: "progress",
        data: { type: "thread_bound", threadId: thread.id },
      });

      const outcome = await runLaneTurn({
        client,
        answerReader: this.answerReader,
        laneId: req.laneId,
        threadId: thread.id,
        prompt: req.prompt,
        answerPollMs: this.answerPollMs,
        timeoutMs: deadline.remainingMs(),
        cleanupGraceMs: this.cleanupGraceMs,
        onEvent: req.onEvent,
      });

      return {
        ...outcome,
        agentSessionId: thread.id,
        // wallMs/startupMs are harness-measured; apiMs is protocol-reported
        // (turn.durationMs) and travels through the turn outcome when present.
        timing: {
          wallMs: Date.now() - startedAt,
          startupMs,
          ...(outcome.timing?.apiMs !== undefined ? { apiMs: outcome.timing.apiMs } : {}),
        },
      };
    });
  }

  async resume(
    lane: LaneRecord,
    prompt: string,
    opts: ResumeOptions = {},
  ): Promise<DispatchOutcome> {
    const startedAt = Date.now();
    const deadline = startDeadline(opts.timeoutMs);
    const expectedThreadId = lane.agentSessionId;
    if (expectedThreadId === undefined || expectedThreadId === "") {
      throw new ContinuityError(`lane ${lane.id} has no bound codex thread`, {
        detail: "lane.agentSessionId is empty; dispatch never bound a native session",
        remediation: "Dispatch a new lane instead of resuming this one.",
      });
    }

    const client = this.clientFactory({
      cwd: lane.cwd,
      ...(lane.model !== undefined ? { model: lane.model } : {}),
      detached: true,
      ...resolveSessionPolicy(),
    });

    return this.runWithClient(client, opts.onEvent, async () => {
      // Same spawn-time identity rule as dispatch (finding 15).
      const connecting = this.startConnect(client);
      await emitLaneEvent(opts.onEvent, {
        event: "agent_started",
        data: {
          resumed: true,
          ...processIdentityEventData(client),
          startedAt: new Date(startedAt).toISOString(),
        },
      });

      const connected = await awaitWithin(connecting, deadline);
      if (connected.timedOut) {
        return setupTimeoutOutcome(
          "codex app-server connect (initialize) did not complete",
          opts.timeoutMs,
          startedAt,
        );
      }

      const resumed = await awaitWithin(
        this.resumeThread(client, expectedThreadId, lane.cwd),
        deadline,
      );
      if (resumed.timedOut) {
        return setupTimeoutOutcome(
          "codex thread/resume did not complete",
          opts.timeoutMs,
          startedAt,
        );
      }
      const thread = resumed.value;

      if (thread.id !== expectedThreadId) {
        throw new ContinuityError("resumed codex thread does not match the lane's bound session", {
          detail: `expected thread ${expectedThreadId}, app-server returned ${thread.id}`,
          remediation: "Dispatch a new lane; do not trust this resume.",
        });
      }

      const startupMs = Date.now() - startedAt;

      await emitLaneEvent(opts.onEvent, {
        event: "progress",
        data: { type: "thread_bound", threadId: thread.id, resumed: true },
      });

      const outcome = await runLaneTurn({
        client,
        answerReader: this.answerReader,
        laneId: lane.id,
        threadId: thread.id,
        prompt,
        answerPollMs: this.answerPollMs,
        timeoutMs: deadline.remainingMs(),
        cleanupGraceMs: this.cleanupGraceMs,
        onEvent: opts.onEvent,
      });

      return {
        ...outcome,
        agentSessionId: thread.id,
        continuity: {
          verified: true,
          method: "thread-id-match",
          detail: `thread/resume returned ${thread.id}`,
        },
        timing: {
          wallMs: Date.now() - startedAt,
          startupMs,
          ...(outcome.timing?.apiMs !== undefined ? { apiMs: outcome.timing.apiMs } : {}),
        },
      };
    });
  }

  async inspect(lane: LaneRecord): Promise<InspectSnapshot> {
    const threadId = lane.agentSessionId;
    if (threadId === undefined || threadId === "") {
      return { nativeStatus: "unknown", detail: "lane has no bound codex thread" };
    }

    const client = this.clientFactory({
      cwd: lane.cwd,
      detached: true,
      ...resolveSessionPolicy({ readOnly: true }),
    });

    try {
      await this.startConnect(client);

      let thread: Thread;
      try {
        thread = await client.readThread(threadId, true);
      } catch (error) {
        return {
          nativeStatus: "unknown",
          agentSessionId: threadId,
          detail: `thread/read failed: ${messageOf(error)}`,
        };
      }

      return snapshotFromThread(thread);
    } finally {
      await this.disconnectBounded(client);
    }
  }

  /**
   * Initiates the connect (spawning the transport synchronously) and maps
   * failures onto AdapterError. The returned promise is pre-marked so that a
   * failure before it is awaited never becomes an unhandled rejection.
   */
  private startConnect(client: CodexClient): Promise<void> {
    const connecting = client.connect().catch((error: unknown) => {
      throw new AdapterError(
        "agent_unavailable",
        `unable to start codex app-server: ${messageOf(error)}`,
        {
          remediation: "Ensure the codex CLI (0.144+) is installed and on PATH.",
          cause: error,
        },
      );
    });
    swallowLateRejection(connecting);
    return connecting;
  }

  private async startThread(client: CodexClient): Promise<Thread> {
    try {
      return await client.startThread(
        this.developerInstructions !== undefined
          ? { developerInstructions: this.developerInstructions }
          : {},
      );
    } catch (error) {
      throw new AdapterError("adapter_error", `codex thread/start failed: ${messageOf(error)}`, {
        cause: error,
      });
    }
  }

  private async resumeThread(client: CodexClient, threadId: string, cwd: string): Promise<Thread> {
    try {
      return await client.resumeThread(threadId, {
        cwd,
        ...(this.developerInstructions !== undefined
          ? { developerInstructions: this.developerInstructions }
          : {}),
      });
    } catch (error) {
      throw new ContinuityError(`unable to resume codex thread ${threadId}: ${messageOf(error)}`, {
        detail: "thread/resume failed, so native-session continuity cannot be verified",
        remediation: "Dispatch a new lane if the native thread is gone.",
        cause: error,
      });
    }
  }

  /**
   * Runs one verb body against a spawned client and guarantees the
   * app-server is gone afterwards: a clean bounded disconnect when the
   * server cooperates, otherwise force-termination via the spawn-time
   * process identity (finding 16, residual closed). When force-termination
   * ran, its honest outcome is emitted as best-effort progress evidence and
   * appended to a failed outcome's error message (termination verified vs
   * unverified) so the failure envelope never hides a possibly-live process.
   */
  private async runWithClient(
    client: CodexClient,
    hook: ((event: LaneEventInput) => void | Promise<void>) | undefined,
    run: () => Promise<DispatchOutcome>,
  ): Promise<DispatchOutcome> {
    let outcome: DispatchOutcome;
    try {
      outcome = await run();
    } catch (error) {
      await this.disconnectBounded(client, hook);
      throw error;
    }

    const termination = await this.disconnectBounded(client, hook);
    return termination === undefined ? outcome : withTerminationDetail(outcome, termination);
  }

  /**
   * Bounded disconnect (finding 16): transport close waits for app-server
   * exit, which a wedged server can withhold forever. Cleanup gets its own
   * small budget; when that budget expires the app-server is force-killed
   * via its recorded process identity (SIGTERM the group, grace, SIGKILL,
   * verify) instead of being abandoned alive, and the termination report is
   * returned so callers can surface it. Returns undefined on a clean close.
   */
  private async disconnectBounded(
    client: CodexClient,
    hook?: ((event: LaneEventInput) => void | Promise<void>) | undefined,
  ): Promise<AppServerTermination | undefined> {
    // disconnect() drops the transport reference (and with it processInfo)
    // before awaiting process exit; capture the identity first.
    const processInfo = client.processInfo;
    const closing = client.disconnect().catch(() => undefined);
    const closed = await awaitWithin(closing, startDeadline(this.cleanupGraceMs));
    if (!closed.timedOut) {
      return undefined;
    }

    const termination = await terminateAppServer(processInfo, this.cleanupGraceMs);
    if (hook !== undefined) {
      // Best-effort durable evidence for every outcome path; a hook failure
      // here must not replace the outcome already in hand.
      try {
        await hook({
          event: "progress",
          data: {
            type: "app_server_termination",
            verified: termination.verified,
            detail: termination.detail,
          },
        });
      } catch {
        // The termination report still travels via the returned outcome.
      }
    }

    return termination;
  }
}

/** Constructs a CodexAdapter and registers it (default: shared registry). */
export function registerCodexAdapter(
  options: CodexAdapterOptions = {},
  registry: AdapterRegistry = adapterRegistry,
): CodexAdapter {
  const adapter = new CodexAdapter(options);
  registry.register(adapter);
  return adapter;
}

function isReadOnlyRequest(req: DispatchRequest): boolean {
  return (req as CodexDispatchRequest).readOnly === true;
}

/**
 * Delivers one adapter-emitted event to the caller-owned hook, mapping hook
 * failures onto the same AdapterError shape the in-turn event chain uses.
 */
async function emitLaneEvent(
  hook: ((event: LaneEventInput) => void | Promise<void>) | undefined,
  event: LaneEventInput,
): Promise<void> {
  if (hook === undefined) {
    return;
  }

  try {
    await hook(event);
  } catch (cause) {
    throw new AdapterError(
      "adapter_error",
      `codex lane event hook failed for "${event.event}": ${messageOf(cause)}`,
      { cause },
    );
  }
}

/**
 * Timeout outcome for a deadline that fired before the turn could start
 * (connect / thread setup). Per the finding 16 pinned decision, delivery is
 * "unknown": the prompt was never submitted, but a real app-server process
 * was spawned and its state at the deadline is unverifiable, so no stronger
 * claim (and no interrupt claim — there is no turn) is invented.
 */
function setupTimeoutOutcome(
  stage: string,
  timeoutMs: number | undefined,
  startedAt: number,
): DispatchOutcome {
  return {
    status: "failed",
    delivery: "unknown",
    nativeStatus: "unknown",
    semanticOutcome: "unknown",
    code: "timeout",
    error: {
      message: `${stage} within ${timeoutMs}ms`,
      remediation: "Retry with a larger --timeout.",
    },
    timing: { wallMs: Date.now() - startedAt },
  };
}

/** Honest report of a post-disconnect force-termination attempt. */
interface AppServerTermination {
  /** True only when the app-server pid was confirmed dead after signalling. */
  verified: boolean;
  detail: string;
}

/** Poll cadence while verifying that a signalled process actually exited. */
const KILL_VERIFY_POLL_MS = 15;

/**
 * Force-terminates an abandoned app-server (finding 16, residual closed):
 * SIGTERM to the process group (or pid when no group was recorded), a grace
 * wait, SIGKILL, then verification. Never throws; always reports what it
 * verified — a deadline-expired lane must never silently leave a live
 * app-server process.
 */
async function terminateAppServer(
  processInfo: CodexProcessInfo | undefined,
  graceMs: number,
): Promise<AppServerTermination> {
  if (processInfo === undefined) {
    return {
      verified: false,
      detail:
        "app-server disconnect abandoned; termination unverified: " +
        "no process identity was recorded, the app-server may still be running",
    };
  }

  const target = processInfo.pgid !== undefined ? -processInfo.pgid : processInfo.pid;
  const label =
    processInfo.pgid !== undefined ? `process group ${processInfo.pgid}` : `pid ${processInfo.pid}`;

  sendSignal(target, "SIGTERM");
  if (await waitForProcessExit(processInfo.pid, graceMs)) {
    return {
      verified: true,
      detail: `app-server disconnect abandoned; termination verified: ${label} exited after SIGTERM`,
    };
  }

  sendSignal(target, "SIGKILL");
  if (await waitForProcessExit(processInfo.pid, graceMs)) {
    return {
      verified: true,
      detail: `app-server disconnect abandoned; termination verified: ${label} exited after SIGKILL`,
    };
  }

  return {
    verified: false,
    detail:
      "app-server disconnect abandoned; termination unverified: " +
      `${label} is still alive after SIGKILL`,
  };
}

function sendSignal(target: number, signal: NodeJS.Signals): void {
  try {
    process.kill(target, signal);
  } catch {
    // ESRCH (already gone) is success; anything else is caught by the
    // verification poll, which decides verified vs unverified honestly.
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but is not signalable by us.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitForProcessExit(pid: number, graceMs: number): Promise<boolean> {
  const deadline = Date.now() + Math.max(graceMs, KILL_VERIFY_POLL_MS);
  for (;;) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }

    await new Promise((resolve) => setTimeout(resolve, KILL_VERIFY_POLL_MS));
  }
}

/**
 * Surfaces a force-termination report on the outcome. Failure envelopes get
 * the report appended to error.message (the envelope's only failure-detail
 * slot); non-failure outcomes carry it via the progress event instead.
 */
function withTerminationDetail(
  outcome: DispatchOutcome,
  termination: AppServerTermination,
): DispatchOutcome {
  if (outcome.error === undefined) {
    return outcome;
  }

  return {
    ...outcome,
    error: { ...outcome.error, message: `${outcome.error.message} [${termination.detail}]` },
  };
}

function processIdentityEventData(client: CodexClient): Record<string, number> {
  const processInfo = client.processInfo;
  if (processInfo === undefined) {
    return {};
  }

  return {
    pid: processInfo.pid,
    ...(processInfo.pgid !== undefined ? { pgid: processInfo.pgid } : {}),
  };
}

/** Maps a native thread snapshot onto InspectSnapshot from protocol evidence. */
function snapshotFromThread(thread: Thread): InspectSnapshot {
  const lastActivityAt = toIsoTimestamp(thread.updatedAt);
  const base = {
    agentSessionId: thread.id,
    ...(lastActivityAt !== undefined ? { lastActivityAt } : {}),
  };

  const status = thread.status;
  if (status?.type === "active") {
    return {
      ...base,
      nativeStatus: "running",
      detail: status.activeFlags.length > 0 ? `active: ${status.activeFlags.join(", ")}` : "active",
    };
  }

  if (status?.type === "systemError") {
    return { ...base, nativeStatus: "failed", detail: "thread status systemError" };
  }

  const turns = thread.turns ?? [];
  const lastTurn = turns.length > 0 ? turns[turns.length - 1] : undefined;
  if (!lastTurn) {
    return {
      ...base,
      nativeStatus: "unknown",
      detail: `thread ${status?.type ?? "status unknown"}; no turns recorded`,
    };
  }

  switch (lastTurn.status) {
    case "completed":
      return { ...base, nativeStatus: "completed", detail: "last turn completed" };
    case "failed":
      return {
        ...base,
        nativeStatus: "failed",
        detail: lastTurn.error?.message ?? "last turn failed",
      };
    case "interrupted":
      return { ...base, nativeStatus: "interrupted", detail: "last turn interrupted" };
    case "inProgress":
      return {
        ...base,
        nativeStatus: "unknown",
        detail: "thread is not active but its last turn is recorded inProgress",
      };
    default:
      return {
        ...base,
        nativeStatus: "unknown",
        detail: `unrecognized turn status: ${String(lastTurn.status)}`,
      };
  }
}

function toIsoTimestamp(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }

  // Codex thread timestamps may be unix seconds or milliseconds; normalize.
  const ms = value > 1e12 ? value : value * 1000;
  return new Date(ms).toISOString();
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
