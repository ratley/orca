import { AdapterError, ContinuityError } from "../../lane/adapter.js";
import type { AgentAdapter, DispatchRequest, ResumeOptions } from "../../lane/adapter.js";
import type {
  AgentCaveat,
  AgentManifest,
  DispatchOutcome,
  InspectSnapshot,
  LaneEventInput,
  LaneRecord,
  TimingInfo,
  UsageInfo,
} from "../../types/lane.js";
import { parseClaudeLine } from "./cli-output.js";
import type { ClaudeInitLine, ClaudeResultLine } from "./cli-output.js";
import { createProcessClaudeExec } from "./exec.js";
import type { ClaudeExec, ClaudeExecHandle, ClaudeExecResult } from "./exec.js";
import {
  resolveClaudeConfigDir,
  resolveProjectCwd,
  statTranscript,
  transcriptPath,
} from "./transcript.js";

/**
 * Claude Code adapter: shells out to `claude -p --output-format stream-json
 * --verbose`, prompt on stdin, run in the lane cwd.
 *
 * All behavior below was probed live against Claude Code 2.1.207 on
 * 2026-07-11 (not assumed):
 *
 * - Result line: `is_error` is the authoritative failure signal; `subtype`
 *   stays "success" even for API failures (bogus model -> exit 1,
 *   is_error:true, terminal_reason:"api_error").
 * - Resume: `--resume <sessionId>` keeps the SAME session id and appends to
 *   the existing transcript (probed: 20916 -> 26009 bytes). An unknown
 *   session id fails hard: exit 1, empty stdout, stderr
 *   "No conversation found with session ID: <id>" — it never silently starts
 *   a fresh session. Continuity is verified via method "session-id-match":
 *   the transcript for the bound session id must exist under the cwd's
 *   project key before resume, the result line must echo the same session
 *   id, and on success the transcript must have advanced (size/mtime).
 * - Permission semantics: a default `-p` run DENIES file writes — the probe's
 *   Write call landed in `permission_denials` and the agent finished with
 *   prose instead ("I need permission..."). Pass `permissionMode`
 *   ("acceptEdits" | "auto" | "bypassPermissions" | "manual" | "dontAsk" |
 *   "plan") and/or `allowedTools` for lanes that must edit files.
 * - Questions: AskUserQuestion is NOT in the headless tool set (probed via
 *   the init tool list, and the model itself reported it unavailable). A
 *   headless run never parks a question — it completes normally with the
 *   question as prose in the result text. Hence capabilities.questions:false
 *   and no "blocked" outcomes from this adapter; nativeStatus is never
 *   "interrupted" for questions.
 * - Overhead: measured wall 3.36s vs CLI-reported duration_ms 1800 on the
 *   probe machine -> ~1.6s CLI startup/teardown p50.
 */

export const CLAUDE_PERMISSION_MODES = [
  "acceptEdits",
  "auto",
  "bypassPermissions",
  "manual",
  "dontAsk",
  "plan",
] as const;
export type ClaudePermissionMode = (typeof CLAUDE_PERMISSION_MODES)[number];

export interface ClaudeAdapterOptions {
  /** Process layer; tests inject a fake that replays probe fixtures. */
  exec?: ClaudeExec;
  /** Binary name/path for the real exec layer (default "claude"). */
  claudeBinary?: string;
  /** Claude config dir override; defaults to CLAUDE_CONFIG_DIR or ~/.claude. */
  claudeConfigDir?: string;
  /** --permission-mode value; omitted -> Claude's default (file writes denied). */
  permissionMode?: ClaudePermissionMode;
  /** --allowedTools entries, e.g. ["Bash(git *)", "Edit"]. */
  allowedTools?: string[];
}

const AGENT_NAME = "claude";
const PROGRESS_PREVIEW_CHARS = 200;
const FAILURE_DETAIL_CHARS = 500;
const RESUME_NOT_FOUND_MARKER = "No conversation found with session ID";

const BASE_CAVEATS: AgentCaveat[] = [
  {
    code: "default_permissions_deny_writes",
    note: "A default `claude -p` run denies file writes (probed: Write landed in permission_denials); construct the adapter with permissionMode and/or allowedTools for lanes that must edit files.",
  },
  {
    code: "questions_never_park",
    note: "AskUserQuestion is not in the headless tool set; runs never block on questions — unanswered questions surface as prose in the result text.",
  },
  {
    code: "no_native_liveness",
    note: "claude -p runs are one-shot processes with no native liveness store; inspect() can only report transcript mtime.",
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
export function buildClaudeManifest(platform: NodeJS.Platform = process.platform): AgentManifest {
  const posixKill = platform !== "win32";
  return {
    v: 1,
    agent: AGENT_NAME,
    displayName: "Claude Code",
    adapterVersion: "0.1.0",
    capabilities: {
      resume: true,
      // The adapter spawns `claude -p` detached (its own process group) and
      // reports {pid, pgid} in agent_started, so the CLI can tree-kill the
      // run by signalling the negative pgid (decision 4) — POSIX only.
      kill: posixKill,
      // Probed: AskUserQuestion is absent headless; runs never park questions.
      questions: false,
      continuityMethods: ["session-id-match"],
      // Aliases documented by `claude --help`; "haiku" verified by live probe.
      models: ["fable", "opus", "sonnet", "haiku"],
    },
    overhead: {
      // Wall 3360ms - duration_ms 1800 on the 2026-07-11 probe (n=1).
      startupMsP50: 1600,
      measuredAt: "2026-07-11",
    },
    caveats: posixKill ? [...BASE_CAVEATS, POSIX_ONLY_KILL_CAVEAT] : [...BASE_CAVEATS],
    declared: {
      permissionModes: [...CLAUDE_PERMISSION_MODES],
      promptDelivery: "stdin",
      outputFormat: "stream-json",
    },
  };
}

/**
 * The last terminal-record candidate seen on stdout. Precedence is positional:
 * the LAST `type:"result"` line wins, valid or not. A malformed LAST result
 * after a valid earlier one means the run's terminal evidence is corrupt, and
 * the adapter fails loud instead of trusting the stale earlier success.
 */
type ClaudeTerminalCandidate =
  | { kind: "result"; line: ClaudeResultLine }
  | { kind: "malformed"; raw: string };

interface ClaudeRun {
  wallMs: number;
  exitCode: number | null;
  stderr: string;
  init: ClaudeInitLine | undefined;
  terminal: ClaudeTerminalCandidate | undefined;
}

/** The last valid result line, unless a later malformed result superseded it. */
function terminalResult(run: ClaudeRun): ClaudeResultLine | undefined {
  return run.terminal?.kind === "result" ? run.terminal.line : undefined;
}

export class ClaudeAdapter implements AgentAdapter {
  private readonly exec: ClaudeExec;
  private readonly options: ClaudeAdapterOptions;

  constructor(options: ClaudeAdapterOptions = {}) {
    this.options = options;
    this.exec = options.exec ?? createProcessClaudeExec(options.claudeBinary ?? "claude");
  }

  async dispatch(req: DispatchRequest): Promise<DispatchOutcome> {
    const run = await this.runClaude({
      args: this.buildArgs(req.model),
      cwd: req.cwd,
      stdin: req.prompt,
      timeoutMs: req.timeoutMs,
      onEvent: req.onEvent,
    });

    return this.outcomeFromRun(run);
  }

  async resume(
    lane: LaneRecord,
    prompt: string,
    opts: ResumeOptions = {},
  ): Promise<DispatchOutcome> {
    const sessionId = lane.agentSessionId;
    if (sessionId === undefined || sessionId === "") {
      throw new ContinuityError("lane has no bound claude session id; cannot verify continuity", {
        remediation: "Dispatch a new lane instead of resuming.",
      });
    }

    // Claude keys the native store by the realpath of its cwd (probed).
    const transcript = transcriptPath(
      this.configDir(),
      await resolveProjectCwd(lane.cwd),
      sessionId,
    );
    const before = await statTranscript(transcript);
    if (!before.exists) {
      throw new ContinuityError(
        `no claude transcript exists for session ${sessionId} under the lane cwd's project key`,
        {
          detail: `expected transcript at ${transcript}`,
          remediation: "The native session is gone (or the cwd changed); dispatch a new lane.",
        },
      );
    }

    const run = await this.runClaude({
      args: this.buildArgs(lane.model, sessionId),
      cwd: lane.cwd,
      stdin: prompt,
      timeoutMs: opts.timeoutMs,
      onEvent: opts.onEvent,
    });
    const result = terminalResult(run);

    // Probed behavior for unknown session ids: exit 1, empty stdout, this
    // stderr line. Claude never silently rebinds, but we refuse to guess.
    if (run.terminal === undefined && run.stderr.includes(RESUME_NOT_FOUND_MARKER)) {
      throw new ContinuityError(`claude no longer knows session ${sessionId}`, {
        detail: run.stderr.trim(),
        remediation: "The native session store lost this conversation; dispatch a new lane.",
      });
    }

    if (result !== undefined && result.session_id !== sessionId) {
      throw new ContinuityError(
        "claude answered from a different session than the lane's bound session",
        {
          detail: `expected session ${sessionId}, result echoed ${result.session_id}`,
          remediation: "Refusing to silently rebind; dispatch a new lane.",
        },
      );
    }

    const outcome = this.outcomeFromRun(run);

    if (outcome.status === "completed") {
      const after = await statTranscript(transcript);
      const advanced = after.exists && (after.size > before.size || after.mtimeMs > before.mtimeMs);
      if (!advanced) {
        throw new ContinuityError(
          "claude reported success but the session transcript did not advance",
          {
            detail: `${transcript}: size ${before.size} -> ${after.exists ? after.size : "missing"}`,
            remediation:
              "Continuity evidence is inconsistent; inspect the transcript and dispatch a new lane if needed.",
          },
        );
      }

      return {
        ...outcome,
        continuity: {
          verified: true,
          method: "session-id-match",
          detail: `result echoed session ${sessionId}; transcript grew ${before.size} -> ${after.size} bytes`,
        },
      };
    }

    if (result !== undefined) {
      // Failed run whose result line still echoed the bound session id.
      return {
        ...outcome,
        continuity: {
          verified: true,
          method: "session-id-match",
          detail: `result echoed session ${sessionId}`,
        },
      };
    }

    return outcome;
  }

  async inspect(lane: LaneRecord): Promise<InspectSnapshot> {
    const sessionId = lane.agentSessionId;
    if (sessionId === undefined || sessionId === "") {
      return { nativeStatus: "unknown", detail: "no claude session bound to this lane yet" };
    }

    const transcript = transcriptPath(
      this.configDir(),
      await resolveProjectCwd(lane.cwd),
      sessionId,
    );
    const stat = await statTranscript(transcript);
    if (!stat.exists) {
      return {
        nativeStatus: "unknown",
        agentSessionId: sessionId,
        detail: `transcript not found at ${transcript}`,
      };
    }

    // One-shot `claude -p` processes expose no native liveness signal; the
    // transcript mtime is the only protocol evidence available.
    return {
      nativeStatus: "unknown",
      agentSessionId: sessionId,
      lastActivityAt: new Date(stat.mtimeMs).toISOString(),
      detail: `transcript ${transcript} (${stat.size} bytes); claude -p runs are one-shot processes with no native liveness store`,
    };
  }

  capabilities(): AgentManifest {
    return buildClaudeManifest();
  }

  private configDir(): string {
    return this.options.claudeConfigDir ?? resolveClaudeConfigDir();
  }

  private buildArgs(model: string | undefined, resumeSessionId?: string): string[] {
    const args = ["-p", "--output-format", "stream-json", "--verbose"];
    if (resumeSessionId !== undefined) {
      args.push("--resume", resumeSessionId);
    }
    if (model !== undefined) {
      args.push("--model", model);
    }
    if (this.options.permissionMode !== undefined) {
      args.push("--permission-mode", this.options.permissionMode);
    }
    if (this.options.allowedTools !== undefined && this.options.allowedTools.length > 0) {
      args.push("--allowedTools", this.options.allowedTools.join(","));
    }

    return args;
  }

  private async runClaude(params: {
    args: string[];
    cwd: string;
    stdin: string;
    timeoutMs: number | undefined;
    onEvent: DispatchRequest["onEvent"];
  }): Promise<ClaudeRun> {
    const startedAt = Date.now();
    let init: ClaudeInitLine | undefined;
    let terminal: ClaudeTerminalCandidate | undefined;
    let processHandle: ClaudeExecHandle | undefined;
    let sinkFailed = false;
    let sinkError: unknown;
    let sinkTermination: Promise<boolean> | undefined;
    let eventChain: Promise<void> = Promise.resolve();

    const terminateAfterSinkFailure = (): void => {
      if (sinkTermination !== undefined || processHandle === undefined) {
        return;
      }

      // The event sink is load-bearing: once persistence fails, no native
      // work may continue without durable lane evidence. Kill immediately and
      // retain the verification promise for runClaude to await below.
      sinkTermination = processHandle.kill().catch(() => false);
    };

    const emit = (event: LaneEventInput): void => {
      const onEvent = params.onEvent;
      if (onEvent === undefined) {
        return;
      }

      eventChain = eventChain
        .then(async () => {
          // Events already queued behind the first failed delivery are stale;
          // suppress them instead of repeatedly invoking a broken sink.
          if (!sinkFailed) {
            await onEvent(event);
          }
        })
        .catch((error: unknown) => {
          if (!sinkFailed) {
            sinkFailed = true;
            sinkError = error;
            terminateAfterSinkFailure();
          }
        });
    };

    const onStdoutLine = (raw: string): void => {
      const parsed = parseClaudeLine(raw);
      switch (parsed.kind) {
        case "init": {
          init = parsed.line;
          // Session/model metadata arrives only after protocol init and is
          // deliberately SEPARATE from the spawn-time agent_started identity
          // event (finding 15): a pre-protocol hang must not delay pid/pgid.
          emit({
            event: "progress",
            data: {
              phase: "session_init",
              agentSessionId: parsed.line.session_id,
              ...(parsed.line.model !== undefined ? { model: parsed.line.model } : {}),
              ...(parsed.line.permissionMode !== undefined
                ? { permissionMode: parsed.line.permissionMode }
                : {}),
            },
          });
          break;
        }
        case "assistant": {
          const text = parsed.line.message.content
            .filter((piece) => piece.type === "text" && piece.text !== undefined)
            .map((piece) => piece.text)
            .join("\n")
            .trim();
          if (text !== "") {
            emit({ event: "progress", data: { text: text.slice(0, PROGRESS_PREVIEW_CHARS) } });
          }
          break;
        }
        case "result": {
          terminal = { kind: "result", line: parsed.line };
          const denials = parsed.line.permission_denials;
          if (denials !== undefined && denials.length > 0) {
            emit({
              event: "progress",
              data: { permissionDenials: denials.map((denial) => denial.tool_name) },
            });
          }
          break;
        }
        case "malformed-result": {
          terminal = { kind: "malformed", raw: parsed.raw };
          break;
        }
        case "other":
          break;
      }
    };

    let execResult: ClaudeExecResult | undefined;
    let execError: unknown;
    try {
      execResult = await this.exec({
        args: params.args,
        cwd: params.cwd,
        stdin: params.stdin,
        timeoutMs: params.timeoutMs,
        onStdoutLine,
        onSpawn: (handle) => {
          processHandle = handle;
          // Finding 15: report process identity IMMEDIATELY at spawn (before
          // protocol init) so the CLI can persist {pid, pgid} even when the
          // native CLI hangs before emitting its structured init line.
          emit({
            event: "agent_started",
            data: {
              pid: handle.pid,
              pgid: handle.pgid,
              startedAt: new Date().toISOString(),
            },
          });
          if (sinkFailed) {
            terminateAfterSinkFailure();
          }
        },
      });
    } catch (error) {
      execError = error;
    }

    await eventChain;
    if (sinkFailed) {
      terminateAfterSinkFailure();
      // Safety-sensitive path (finding 20): only a verified kill or a
      // verified-gone group counts as proof here. A natural leader close
      // ("not_attempted") never claims tree-termination for a lane whose
      // event history is broken.
      const terminationConfirmed =
        sinkTermination !== undefined
          ? await sinkTermination
          : execResult?.termination === "verified_gone";
      throw new AdapterError(
        "adapter_error",
        terminationConfirmed
          ? "lane event sink failed while streaming events; the claude process group was terminated"
          : "lane event sink failed while streaming events; claude process-group termination could not be confirmed",
        {
          cause: sinkError,
          ...(!terminationConfirmed
            ? {
                remediation:
                  "Inspect the recorded pid/pgid and stop any surviving Claude descendants before retrying.",
              }
            : {}),
        },
      );
    }

    if (execError !== undefined) {
      if ((execError as NodeJS.ErrnoException).code === "ENOENT") {
        throw new AdapterError("agent_unavailable", "claude CLI not found (spawn ENOENT)", {
          remediation: "Install Claude Code and ensure `claude` is on PATH.",
          cause: execError,
        });
      }

      throw new AdapterError(
        "adapter_error",
        `failed to run claude: ${(execError as Error).message}`,
        { cause: execError },
      );
    }

    if (execResult === undefined) {
      throw new AdapterError("adapter_error", "claude exec returned no result");
    }

    if (execResult.termination === "unverified") {
      throw new AdapterError(
        "adapter_error",
        "claude process-group termination could not be confirmed; refusing to classify the run",
        {
          remediation:
            "Inspect the recorded pid/pgid and stop any surviving Claude descendants before retrying.",
        },
      );
    }

    if (execResult.overflowed === true) {
      throw new AdapterError(
        "adapter_error",
        "claude stdout exceeded the bounded protocol line buffer; process-group termination was verified",
        {
          remediation:
            "Reduce the task output or inspect the Claude CLI for a malformed oversized result record.",
        },
      );
    }

    if (execResult.timedOut) {
      throw new AdapterError(
        "timeout",
        `claude did not finish within ${params.timeoutMs}ms; process-group termination was verified`,
        { remediation: "Increase the timeout or split the task into smaller lanes." },
      );
    }

    // Aborts keep final-evidence arbitration (unlike deadline timeouts,
    // which are final once a post-deadline kill was attempted): an abort
    // that lost the race against a real exit code defers to that exit's
    // own evidence.
    if (execResult.aborted && execResult.exitCode === null) {
      // Abort implies a tree-kill ran; the unverified check above already
      // rejected any kill whose verification failed.
      throw new AdapterError(
        "adapter_error",
        "claude run was aborted before completion; process-group termination was verified",
        {
          remediation: "The caller cancelled this run; dispatch again if the work is still wanted.",
        },
      );
    }

    return {
      wallMs: Date.now() - startedAt,
      exitCode: execResult.exitCode,
      stderr: execResult.stderr,
      init,
      terminal,
    };
  }

  /**
   * Maps a finished run onto a DispatchOutcome from protocol evidence only:
   * the parsed result line plus the process exit code. Never interprets
   * prose; fails loud (adapter_error) instead of guessing when the result
   * line is missing or malformed on an otherwise clean exit.
   */
  private outcomeFromRun(run: ClaudeRun): DispatchOutcome {
    const result = terminalResult(run);

    if (result === undefined) {
      if (run.terminal?.kind === "malformed") {
        throw new AdapterError(
          "adapter_error",
          `claude printed a result line that does not match the pinned result shape; refusing to guess. Line: ${truncate(run.terminal.raw, FAILURE_DETAIL_CHARS)}`,
        );
      }

      if (run.exitCode === 0) {
        throw new AdapterError(
          "adapter_error",
          "claude exited 0 without emitting a result JSON line; refusing to guess the outcome",
        );
      }

      const stderrTail = run.stderr.trim();
      return {
        status: "failed",
        delivery: "unknown",
        nativeStatus: "failed",
        semanticOutcome: "unknown",
        code: "agent_failed",
        ...(run.init !== undefined ? { agentSessionId: run.init.session_id } : {}),
        timing: { wallMs: run.wallMs },
        error: {
          message:
            stderrTail === ""
              ? `claude exited ${run.exitCode ?? "on a signal"} with no result output`
              : `claude exited ${run.exitCode ?? "on a signal"}: ${truncate(stderrTail, FAILURE_DETAIL_CHARS)}`,
        },
      };
    }

    const usage = usageFromResult(result);
    const timing = timingFromResult(result, run.wallMs);
    const failed = result.is_error || run.exitCode !== 0;

    if (!failed) {
      if (result.result === undefined) {
        throw new AdapterError(
          "adapter_error",
          "claude reported success but the result line carried no result text; refusing to guess",
        );
      }

      return {
        status: "completed",
        delivery: "confirmed",
        nativeStatus: "completed",
        semanticOutcome: "unknown",
        agentSessionId: result.session_id,
        result: { text: result.result },
        ...(usage !== undefined ? { usage } : {}),
        timing,
      };
    }

    return {
      status: "failed",
      delivery: "confirmed",
      nativeStatus: "failed",
      semanticOutcome: "unknown",
      code: "agent_failed",
      agentSessionId: result.session_id,
      error: { message: failureMessage(result, run.exitCode) },
      ...(usage !== undefined ? { usage } : {}),
      timing,
    };
  }
}

function usageFromResult(result: ClaudeResultLine): UsageInfo | undefined {
  const inputTokens = result.usage?.input_tokens;
  const outputTokens = result.usage?.output_tokens;
  const costUsd = result.total_cost_usd;
  if (inputTokens === undefined && outputTokens === undefined && costUsd === undefined) {
    return undefined;
  }

  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
}

function timingFromResult(result: ClaudeResultLine, wallMs: number): TimingInfo {
  const apiMs = result.duration_api_ms;
  // duration_ms is the CLI-reported run duration; wall minus that is the
  // process startup/teardown overhead we actually paid.
  const startupMs =
    result.duration_ms !== undefined ? Math.max(0, wallMs - result.duration_ms) : undefined;

  return {
    wallMs,
    ...(apiMs !== undefined ? { apiMs } : {}),
    ...(startupMs !== undefined ? { startupMs } : {}),
  };
}

function failureMessage(result: ClaudeResultLine, exitCode: number | null): string {
  const detail = result.result ?? `terminal_reason: ${result.terminal_reason ?? "unknown"}`;
  return `claude run failed (exit ${exitCode ?? "signal"}, is_error ${result.is_error}): ${truncate(detail, FAILURE_DETAIL_CHARS)}`;
}

function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`;
}
