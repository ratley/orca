import crypto from "node:crypto";

import { z } from "zod";

import { AdapterError, ContinuityError } from "../../lane/adapter.js";
import type { AgentAdapter, DispatchRequest, ResumeOptions } from "../../lane/adapter.js";
import type {
  AgentCaveat,
  AgentManifest,
  ContinuityMethod,
  DispatchOutcome,
  InspectSnapshot,
  LaneEventInput,
  LaneRecord,
  TimingInfo,
  UsageInfo,
} from "../../types/lane.js";
import {
  getSessionDir,
  readSessionMeta,
  resolveCursorHome,
  resolveWorkspaceRealpath,
} from "./chats.js";
import type { SessionMeta } from "./chats.js";
import { ExecUnavailableError, spawnExec } from "./exec.js";
import type { ExecFn, ExecHandle, ExecResult } from "./exec.js";

export const CURSOR_AGENT_NAME = "cursor";

/** The headless Cursor CLI binary; also installed on PATH as "cursor-agent". */
export const DEFAULT_CURSOR_BIN = "agent";

/** stderr always carries one benign tracing line; it is never a failure. */
const BENIGN_STDERR_PATTERN = /^cursor-retrieval: tracing to /;

/** Pre-flight refusal when the workspace is untrusted (empty stdout, exit 1). */
const TRUST_REQUIRED_PATTERN = /Workspace Trust Required/;

/** Pre-flight refusal for an unknown --model (empty stdout, exit 1). */
const UNKNOWN_MODEL_PATTERN = /Cannot use this model:/;

const MAX_ERROR_MESSAGE_LENGTH = 500;

/**
 * Final stdout line of `agent -p --output-format json` (recorded 2026-07-11
 * against cursor-agent 2026.07.09-a3815c0):
 *
 *   {"type":"result","subtype":"success","is_error":false,"duration_ms":6751,
 *    "duration_api_ms":6751,"result":"pong","session_id":"be4a...","request_id":
 *    "beee...","usage":{"inputTokens":24312,"outputTokens":61,
 *    "cacheReadTokens":0,"cacheWriteTokens":0}}
 *
 * A "Using worktree: ..." banner can precede it, so callers must parse the
 * LAST non-empty stdout line. duration_ms EXCLUDES the 30-100s (cold) client
 * startup, which is why timing.wallMs is measured by the adapter itself.
 *
 * Validation is STRICT: `type` must be the literal "result", `is_error` a
 * boolean, and `session_id` a string. Unrelated trailing JSON (e.g. tool
 * output that happens to be the last stdout line) must never classify as
 * confirmed/completed.
 */
const CursorResultLineSchema = z.object({
  type: z.literal("result"),
  subtype: z.string().optional(),
  is_error: z.boolean(),
  duration_ms: z.number().optional(),
  duration_api_ms: z.number().optional(),
  result: z.string().optional(),
  session_id: z.string().min(1),
  request_id: z.string().optional(),
  usage: z
    .object({
      inputTokens: z.number().optional(),
      outputTokens: z.number().optional(),
      cacheReadTokens: z.number().optional(),
      cacheWriteTokens: z.number().optional(),
    })
    .optional(),
});
type CursorResultLine = z.infer<typeof CursorResultLineSchema>;

export interface CursorAdapterOptions {
  /** Cursor CLI binary to spawn. Defaults to "agent" on PATH. */
  bin?: string | undefined;
  /** Process-execution layer; tests inject a fake replaying fixtures. */
  exec?: ExecFn | undefined;
  /** Native store root; defaults to ~/.cursor. Tests point at a temp dir. */
  cursorHome?: string | undefined;
  /**
   * Strict continuity for resume(): additionally require the model to echo a
   * random nonce at the start of its reply (method "nonce-echo"). Costs
   * output tokens on every resume; default off (method "session-id-match").
   */
  strictNonce?: boolean | undefined;
}

/** @deprecated Use AgentCaveat from the lane contract; kept as an alias. */
export type CursorAdapterCaveat = AgentCaveat;

/**
 * AgentManifestSchema carries `worktrees` and `caveats` as first-class
 * (optional) slots; this adapter always populates them, so the narrowed type
 * makes them required. They survive envelope parsing and appear in the
 * `orca agents` envelope.
 */
export type CursorAgentManifest = AgentManifest & {
  worktrees: boolean;
  caveats: AgentCaveat[];
  declared: Record<string, unknown>;
};

interface RunArgs {
  laneId: string;
  prompt: string;
  cwd: string;
  model?: string | undefined;
  timeoutMs?: number | undefined;
  resumeSessionId?: string | undefined;
  onEvent?: DispatchRequest["onEvent"] | undefined;
}

/**
 * Adapter for the headless Cursor CLI (binary "agent", aka "cursor-agent").
 *
 * Dispatch shape: `agent -p --output-format json --trust --force
 * --workspace <cwd> [--model <model>] [--resume <sessionId>] <prompt>`.
 *
 * nativeStatus is derived from exit-code/JSON-envelope evidence only; prose
 * is never interpreted as success. semanticOutcome is always "unknown" (no
 * validator in v0).
 */
export class CursorAdapter implements AgentAdapter {
  private readonly bin: string;
  private readonly exec: ExecFn;
  private readonly cursorHome: string;
  private readonly strictNonce: boolean;
  private readonly running = new Map<string, ExecHandle>();

  constructor(options: CursorAdapterOptions = {}) {
    this.bin = options.bin ?? DEFAULT_CURSOR_BIN;
    this.exec = options.exec ?? spawnExec;
    this.cursorHome = options.cursorHome ?? resolveCursorHome();
    this.strictNonce = options.strictNonce ?? false;
  }

  async dispatch(req: DispatchRequest): Promise<DispatchOutcome> {
    return this.run({
      laneId: req.laneId,
      prompt: req.prompt,
      cwd: req.cwd,
      model: req.model,
      timeoutMs: req.timeoutMs,
      onEvent: req.onEvent,
    });
  }

  /**
   * Resumes the lane's native session, verifying continuity before AND after
   * the run. `agent --resume <id>` with an unknown id SILENTLY creates a new
   * session (exit 0) and echoes the bogus id back, so the response alone is
   * not evidence: the session must already exist in the native chats store
   * beforehand, and its meta.json updatedAtMs must advance afterwards.
   */
  async resume(
    lane: LaneRecord,
    prompt: string,
    opts: ResumeOptions = {},
  ): Promise<DispatchOutcome> {
    const sessionId = lane.agentSessionId;
    if (sessionId === undefined || sessionId === "") {
      throw new ContinuityError(`Lane ${lane.id} has no native Cursor session id`, {
        remediation:
          "Only lanes whose dispatch bound a session_id can be resumed. Dispatch a new lane instead.",
      });
    }

    // Cursor keys its chats store by md5 of the REALPATH of the workspace.
    const nativeCwd = await resolveWorkspaceRealpath(lane.cwd);
    const pre = await this.verifyResumePreconditions(lane, sessionId, nativeCwd);

    const nonce = this.strictNonce ? generateNonce() : undefined;
    const fullPrompt =
      nonce === undefined
        ? prompt
        : `(continuity check: begin your reply with the exact token "${nonce}" before anything else)\n\n${prompt}`;

    const outcome = await this.run({
      laneId: lane.id,
      prompt: fullPrompt,
      cwd: lane.cwd,
      model: lane.model,
      resumeSessionId: sessionId,
      timeoutMs: opts.timeoutMs,
      onEvent: opts.onEvent,
    });

    if (outcome.status !== "completed") {
      // The run itself failed; report that honestly without claiming
      // anything about continuity.
      return outcome;
    }

    return this.verifyResumeContinuity(nativeCwd, sessionId, pre, outcome, nonce);
  }

  async inspect(lane: LaneRecord): Promise<InspectSnapshot> {
    const handle = this.running.get(lane.id);
    if (handle !== undefined) {
      return {
        nativeStatus: "running",
        agentSessionId: lane.agentSessionId,
        detail: `cursor-agent process is running (pid ${handle.pid}, pgid ${handle.pgid})`,
      };
    }

    if (lane.agentSessionId === undefined) {
      return { nativeStatus: "unknown", detail: "no native session bound to this lane" };
    }

    const nativeCwd = await resolveWorkspaceRealpath(lane.cwd);
    const meta = await readSessionMeta(this.cursorHome, nativeCwd, lane.agentSessionId);
    if (meta === null) {
      return {
        nativeStatus: "unknown",
        agentSessionId: lane.agentSessionId,
        detail: "no session found in the native Cursor chats store",
      };
    }

    return {
      nativeStatus: "unknown",
      agentSessionId: lane.agentSessionId,
      lastActivityAt:
        meta.updatedAtMs !== undefined ? new Date(meta.updatedAtMs).toISOString() : undefined,
      detail: "session exists in the native Cursor chats store; Cursor records no terminal status",
    };
  }

  /**
   * Kills the in-process cursor-agent child for a lane while it is running,
   * resolving only after group termination has been verified (or
   * verification failed). Resolves false when no process is tracked (already
   * exited or never started). Not part of the v0 AgentAdapter interface.
   */
  kill(laneId: string, signal: NodeJS.Signals = "SIGTERM"): Promise<boolean> {
    const handle = this.running.get(laneId);
    if (handle === undefined) {
      return Promise.resolve(false);
    }

    return handle.kill(signal);
  }

  capabilities(): CursorAgentManifest {
    return buildCursorManifest();
  }

  private async run(args: RunArgs): Promise<DispatchOutcome> {
    const argv = buildArgv(args);
    const startedAt = Date.now();
    let eventChain = Promise.resolve();
    let eventSinkError: unknown;
    // The handle is retained through final event-chain settlement (finding
    // 17): a sink failure discovered AFTER the leader exited must still be
    // able to run verified group cleanup for surviving descendants.
    let processHandle: ExecHandle | undefined;
    let sinkTermination: Promise<boolean> | undefined;

    const terminateAfterSinkFailure = (): void => {
      if (sinkTermination !== undefined || processHandle === undefined) {
        return;
      }

      // The event log is the lane's source of truth. If persistence fails,
      // stop the process tree — even after leader exit, descendants may
      // survive — and retain the verification promise to await below.
      sinkTermination = processHandle.kill().catch(() => false);
    };

    const emit = (event: LaneEventInput): void => {
      const onEvent = args.onEvent;
      if (onEvent === undefined) {
        return;
      }

      eventChain = eventChain
        .then(async () => {
          if (eventSinkError === undefined) {
            await onEvent(event);
          }
        })
        .catch((error: unknown) => {
          eventSinkError ??= error;
          terminateAfterSinkFailure();
        });
    };

    let exec: ExecResult;
    try {
      exec = await this.exec({
        bin: this.bin,
        args: argv,
        cwd: args.cwd,
        timeoutMs: args.timeoutMs,
        onSpawn: (handle) => {
          processHandle = handle;
          this.running.set(args.laneId, handle);
          // Finding 15: process identity is reported immediately at spawn,
          // before any native protocol output, so a pre-protocol hang can
          // still be killed from the persisted {pid, pgid}.
          emit({
            event: "agent_started",
            data: { pid: handle.pid, pgid: handle.pgid, startedAt: new Date().toISOString() },
          });
        },
      });
    } catch (error) {
      if (error instanceof ExecUnavailableError) {
        throw new AdapterError("agent_unavailable", `Cursor CLI not found: "${this.bin}"`, {
          remediation:
            'Install the Cursor CLI (binary "agent", also on PATH as "cursor-agent") or point CursorAdapterOptions.bin at it.',
          cause: error,
        });
      }

      throw new AdapterError(
        "adapter_error",
        `Failed to spawn Cursor CLI: ${errorMessage(error)}`,
        {
          cause: error,
        },
      );
    } finally {
      this.running.delete(args.laneId);
    }

    emit({
      event: "progress",
      data: {
        phase: "process_exited",
        exitCode: exec.exitCode,
        timedOut: exec.timedOut,
        killed: exec.killed,
        aborted: exec.aborted,
        overCap: exec.overCap,
        termination: exec.termination,
      },
    });

    // Event delivery is ordered and load-bearing: process evidence is always
    // persisted before the process-exited progress record.
    await eventChain;
    if (eventSinkError !== undefined) {
      terminateAfterSinkFailure();
      // Safety-sensitive path (finding 20): only a verified kill or a
      // verified-gone group counts as termination proof here. A natural
      // leader close ("not_attempted") may leave descendants running.
      const terminationVerified =
        sinkTermination !== undefined
          ? await sinkTermination
          : exec.termination === "verified_gone";
      throw new AdapterError(
        "adapter_error",
        terminationVerified
          ? "Cursor lane event persistence failed; native process-group termination was verified"
          : "Cursor lane event persistence failed and native process-group termination could not be confirmed",
        {
          remediation:
            "Repair the lane store before retrying; do not trust this run's incomplete event history.",
          cause: eventSinkError,
        },
      );
    }
    const wallMs = Date.now() - startedAt;
    return this.classify(exec, wallMs, args);
  }

  private classify(exec: ExecResult, wallMs: number, args: RunArgs): DispatchOutcome {
    const timing: TimingInfo = { wallMs };

    if (exec.termination === "unverified") {
      throw new AdapterError(
        "adapter_error",
        "Cursor CLI process-group termination could not be confirmed; refusing to report the lane as stopped",
        {
          remediation:
            "Inspect the recorded pid/pgid and terminate the native process group before retrying.",
        },
      );
    }

    if (exec.overCap) {
      const source = exec.overCapSource ?? "output";
      const tail = source === "stderr" ? exec.stderr : exec.stdout;
      throw new AdapterError(
        "adapter_error",
        `Cursor CLI exceeded the ${source} buffer cap; its process tree was terminated. Tail: ${truncate(tail.trim(), MAX_ERROR_MESSAGE_LENGTH)}`,
        { remediation: "Split the task or reduce native CLI output before retrying." },
      );
    }

    if (exec.timedOut) {
      return {
        status: "failed",
        code: "timeout",
        delivery: "unknown",
        nativeStatus: "interrupted",
        semanticOutcome: "unknown",
        timing,
        error: {
          message: `Cursor CLI timed out after ${args.timeoutMs ?? 0}ms and was killed`,
          remediation:
            "Cold-start overhead alone can take 30-100s; raise timeoutMs if the budget was tight.",
        },
      };
    }

    // Aborts and kills keep final-evidence arbitration (unlike deadline
    // timeouts, which are final once a post-deadline kill was attempted): an
    // abort that lost the race against a real exit code defers to that
    // exit's own evidence.
    if (exec.aborted && exec.exitCode === null) {
      return {
        status: "killed",
        delivery: "unknown",
        nativeStatus: "interrupted",
        semanticOutcome: "unknown",
        timing,
        error: {
          message:
            "Cursor CLI run was aborted; its process group was killed with verified termination",
        },
      };
    }

    if (exec.killed) {
      return {
        status: "killed",
        delivery: "unknown",
        nativeStatus: "interrupted",
        semanticOutcome: "unknown",
        timing,
        error: { message: "Cursor CLI process was killed" },
      };
    }

    const terminal = parseTerminalResult(exec.stdout);
    if (terminal.kind === "malformed") {
      throw new AdapterError(
        "adapter_error",
        `Cursor CLI terminal output was not a valid type:"result" envelope with a session_id; refusing to guess. Tail: ${terminal.rawTail}`,
      );
    }
    if (terminal.kind === "result") {
      return classifyResultLine(terminal.line, exec, wallMs);
    }

    // No JSON envelope on stdout. Branch on exit code first: pre-flight
    // failures exit nonzero with EMPTY stdout and the diagnostic on stderr.
    const stderrText = meaningfulStderr(exec.stderr);

    if (exec.exitCode === 0) {
      throw new AdapterError("adapter_error", "Cursor CLI exited 0 without a JSON result line", {
        remediation:
          "The adapter always passes --output-format json; an envelope-free zero exit is a protocol violation.",
      });
    }

    if (TRUST_REQUIRED_PATTERN.test(stderrText)) {
      return {
        status: "failed",
        code: "adapter_error",
        delivery: "not_sent",
        nativeStatus: "failed",
        semanticOutcome: "unknown",
        timing,
        error: {
          message: "Cursor refused to run: Workspace Trust Required (prompt was never sent)",
          remediation:
            "The adapter passes --trust and --force; the workspace path may be unreadable or otherwise rejected by Cursor.",
        },
      };
    }

    // A rejected --model is the AGENT refusing a well-formed request, not a
    // malformed orca command line: usage_error (exit 2) is reserved for the
    // latter, so this is agent_failed (exit 3). The prompt was never sent.
    if (UNKNOWN_MODEL_PATTERN.test(stderrText)) {
      return {
        status: "failed",
        code: "agent_failed",
        delivery: "not_sent",
        nativeStatus: "failed",
        semanticOutcome: "unknown",
        timing,
        error: {
          message: truncate(firstLine(stderrText), MAX_ERROR_MESSAGE_LENGTH),
          remediation:
            'Run "orca agents" and check the cursor manifest\'s declared.models for known-good model ids.',
        },
      };
    }

    return {
      status: "failed",
      code: "agent_failed",
      delivery: "unknown",
      nativeStatus: "failed",
      semanticOutcome: "unknown",
      timing,
      error: {
        message:
          stderrText !== ""
            ? truncate(stderrText, MAX_ERROR_MESSAGE_LENGTH)
            : `Cursor CLI exited ${exec.exitCode ?? "on a signal"} with no output`,
      },
    };
  }

  private async verifyResumePreconditions(
    lane: LaneRecord,
    sessionId: string,
    nativeCwd: string,
  ): Promise<SessionMeta> {
    const meta = await readSessionMeta(this.cursorHome, nativeCwd, sessionId);
    if (meta === null) {
      throw new ContinuityError(`No native Cursor session found for ${sessionId}`, {
        detail: `expected ${getSessionDir(this.cursorHome, nativeCwd, sessionId)}/meta.json`,
        remediation:
          'Refusing to run: "agent --resume" with an unknown session id silently creates a NEW session and echoes the id back.',
      });
    }

    if (meta.hasConversation !== true) {
      throw new ContinuityError(`Native Cursor session ${sessionId} has no recorded conversation`, {
        detail: "meta.json hasConversation is not true",
      });
    }

    if (meta.cwd !== undefined && meta.cwd !== nativeCwd) {
      throw new ContinuityError(
        `Native Cursor session ${sessionId} belongs to a different workspace`,
        {
          detail: `meta.json cwd "${meta.cwd}" != lane cwd "${nativeCwd}" (realpath of ${lane.cwd})`,
        },
      );
    }

    if (meta.updatedAtMs === undefined) {
      throw new ContinuityError(
        `Native Cursor session ${sessionId} has no updatedAtMs; continuity cannot be verified`,
      );
    }

    return meta;
  }

  private async verifyResumeContinuity(
    nativeCwd: string,
    sessionId: string,
    pre: SessionMeta,
    outcome: DispatchOutcome,
    nonce: string | undefined,
  ): Promise<DispatchOutcome> {
    if (outcome.agentSessionId !== sessionId) {
      throw new ContinuityError("Cursor bound the resume to a different session", {
        detail: `expected session_id ${sessionId}, got ${outcome.agentSessionId ?? "none"}`,
      });
    }

    const post = await readSessionMeta(this.cursorHome, nativeCwd, sessionId);
    const preUpdatedAtMs = pre.updatedAtMs ?? 0;
    if (post === null || post.updatedAtMs === undefined || post.updatedAtMs <= preUpdatedAtMs) {
      throw new ContinuityError("Native Cursor session did not advance after resume", {
        detail: `meta.json updatedAtMs ${post?.updatedAtMs ?? "missing"} did not advance past ${preUpdatedAtMs}; "agent --resume" silently creates a new session for unknown ids`,
      });
    }

    let result = outcome.result;
    let method: ContinuityMethod = "session-id-match";
    if (nonce !== undefined) {
      const text = result?.text ?? "";
      if (!text.trimStart().startsWith(nonce)) {
        throw new ContinuityError("Resume reply did not echo the continuity nonce", {
          detail: `expected the reply to begin with "${nonce}"`,
        });
      }

      method = "nonce-echo";
      result = { ...result, text: stripNoncePrefix(text, nonce) };
    }

    return {
      ...outcome,
      result,
      continuity: {
        verified: true,
        method,
        detail: `session ${sessionId} updatedAtMs advanced ${preUpdatedAtMs} -> ${post.updatedAtMs}`,
      },
    };
  }
}

/**
 * Known-good model ids for the manifest's declared.models slot. Snapshot
 * recorded 2026-07-11 from the real CLI's unknown-model stderr diagnostic
 * (cursor-agent 2026.07.09-a3815c0); the live (much larger) list comes from
 * `agent --list-models`.
 */
export const CURSOR_KNOWN_MODELS: readonly string[] = [
  "auto",
  "gpt-5.3-codex",
  "gpt-5.2",
  "composer-2.5",
  "claude-fable-5-high",
  "gemini-3.1-pro",
  "gpt-5-mini",
  "glm-5.2-max",
];

const CURSOR_BASE_CAVEATS: AgentCaveat[] = [
  {
    code: "cold_start",
    note: "Client startup adds 30-100s cold (~5s warm). duration_ms in the result JSON excludes it; timing.startupMs = wallMs - apiMs.",
  },
  {
    code: "silent_resume_rebind",
    note: "agent --resume with an unknown session id silently creates a NEW session (exit 0) and echoes the bogus id back. The adapter verifies the native chats store (md5(cwd) dir, meta.json hasConversation, updatedAtMs advance) before trusting a resume.",
  },
  {
    code: "no_question_protocol",
    note: "Headless mode has no native blocking-question protocol; blocked/questions are unsupported.",
  },
  {
    code: "benign_stderr_tracing",
    note: "stderr always carries one 'cursor-retrieval: tracing to ...' line; it is never a failure signal.",
  },
  {
    code: "empty_stdout_on_preflight_failure",
    note: "Pre-flight failures (unknown model, untrusted workspace) exit nonzero with EMPTY stdout and the diagnostic on stderr only.",
  },
];

/** Accompanies capabilities.kill:true on POSIX platforms (decision P-POSIX). */
const POSIX_ONLY_KILL_CAVEAT: AgentCaveat = {
  code: "posix_only",
  note: "v0 kill tree-kills by signalling the negative process-group id, which requires POSIX signal semantics; on non-POSIX platforms the manifest reports kill:false at runtime.",
};

/**
 * Builds the manifest for the runtime platform. v0 process-group kill is
 * explicitly POSIX-only (decision P-POSIX): POSIX platforms report kill:true
 * with a posix_only caveat, everything else reports kill:false.
 */
export function buildCursorManifest(
  platform: NodeJS.Platform = process.platform,
): CursorAgentManifest {
  const posixKill = platform !== "win32";
  return {
    v: 1,
    agent: CURSOR_AGENT_NAME,
    displayName: "Cursor CLI (cursor-agent)",
    adapterVersion: "0.1.0",
    capabilities: {
      resume: true,
      kill: posixKill,
      // Headless cursor has no native question protocol; lanes never
      // report status "blocked".
      questions: false,
      continuityMethods: ["session-id-match", "nonce-echo"],
    },
    overhead: {
      // duration_ms in the result JSON excludes client startup; measured
      // ~3.5-10s warm, 30-100s cold (cursor-agent 2026.07.09).
      startupMsP50: 5_000,
      startupMsP95: 100_000,
      measuredAt: "2026-07-11",
    },
    worktrees: true,
    caveats: posixKill
      ? [...CURSOR_BASE_CAVEATS, POSIX_ONLY_KILL_CAVEAT]
      : [...CURSOR_BASE_CAVEATS],
    declared: {
      measuredOn: "cursor-agent 2026.07.09-a3815c0",
      outputFormat: "json",
      promptDelivery: "argv",
      nativeSessionStore: "~/.cursor/chats/<md5(realpath(cwd))>/<session_id>",
      // Snapshot of known-good model ids, verified 2026-07-11 from the CLI's
      // own unknown-model diagnostic ("Cannot use this model: ... Available
      // models: ..."). NOT exhaustive: the live list comes from
      // `agent --list-models` and is much larger.
      models: CURSOR_KNOWN_MODELS,
      modelsNote:
        "snapshot verified 2026-07-11 against cursor-agent 2026.07.09-a3815c0; " +
        'not exhaustive — the live list comes from "agent --list-models"',
    },
  };
}

function buildArgv(args: RunArgs): string[] {
  const argv = ["-p", "--output-format", "json", "--trust", "--force", "--workspace", args.cwd];

  if (args.model !== undefined) {
    argv.push("--model", args.model);
  }

  if (args.resumeSessionId !== undefined) {
    argv.push("--resume", args.resumeSessionId);
  }

  argv.push(args.prompt);
  return argv;
}

function classifyResultLine(
  line: CursorResultLine,
  exec: ExecResult,
  wallMs: number,
): DispatchOutcome {
  const timing = buildTiming(wallMs, line);
  const usage = buildUsage(line);

  // A parsed JSON result line is protocol evidence the prompt was delivered.
  if (exec.exitCode === 0 && !line.is_error) {
    return {
      status: "completed",
      delivery: "confirmed",
      nativeStatus: "completed",
      semanticOutcome: "unknown",
      agentSessionId: line.session_id,
      result: { text: line.result ?? "" },
      usage,
      timing,
    };
  }

  return {
    status: "failed",
    code: "agent_failed",
    delivery: "confirmed",
    nativeStatus: "failed",
    semanticOutcome: "unknown",
    agentSessionId: line.session_id,
    usage,
    timing,
    error: {
      message:
        line.result !== undefined && line.result !== ""
          ? truncate(line.result, MAX_ERROR_MESSAGE_LENGTH)
          : `Cursor CLI reported an error (exit ${exec.exitCode ?? "signal"})`,
    },
  };
}

/**
 * Parses the LAST non-empty stdout line as the JSON result envelope; a
 * "Using worktree: ..." banner can precede it. Invalid terminal output is
 * preserved as a bounded diagnostic instead of being confused with absence.
 */
function parseTerminalResult(
  stdout: string,
):
  | { kind: "absent" }
  | { kind: "result"; line: CursorResultLine }
  | { kind: "malformed"; rawTail: string } {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

  const last = lines[lines.length - 1];
  if (last === undefined) {
    return { kind: "absent" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(last);
  } catch {
    return { kind: "malformed", rawTail: truncate(last, MAX_ERROR_MESSAGE_LENGTH) };
  }

  const result = CursorResultLineSchema.safeParse(parsed);
  return result.success
    ? { kind: "result", line: result.data }
    : { kind: "malformed", rawTail: truncate(last, MAX_ERROR_MESSAGE_LENGTH) };
}

function buildTiming(wallMs: number, line: CursorResultLine): TimingInfo {
  const apiMs = line.duration_api_ms ?? line.duration_ms;
  if (apiMs === undefined) {
    return { wallMs };
  }

  // duration_ms excludes client startup (30-100s cold, ~5s warm), so startup
  // is derived from the adapter's own wall-clock measurement.
  return { wallMs, apiMs, startupMs: Math.max(0, wallMs - apiMs) };
}

function buildUsage(line: CursorResultLine): UsageInfo | undefined {
  if (line.usage === undefined) {
    return undefined;
  }

  // cacheReadTokens/cacheWriteTokens have no UsageInfo slot in v0 and are
  // intentionally dropped rather than folded into inputTokens.
  return { inputTokens: line.usage.inputTokens, outputTokens: line.usage.outputTokens };
}

function meaningfulStderr(stderr: string): string {
  return stderr
    .split("\n")
    .filter((line) => line.trim() !== "" && !BENIGN_STDERR_PATTERN.test(line.trim()))
    .join("\n")
    .trim();
}

function generateNonce(): string {
  return `nonce-${crypto.randomBytes(6).toString("hex")}`;
}

function stripNoncePrefix(text: string, nonce: string): string {
  return text
    .trimStart()
    .slice(nonce.length)
    .replace(/^[\s:,.-]+/, "");
}

function firstLine(text: string): string {
  return text.split("\n", 1)[0] ?? text;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
