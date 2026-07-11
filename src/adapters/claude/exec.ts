import { spawn } from "node:child_process";

/**
 * Thin process layer under the claude adapter so tests can substitute a fake
 * exec that replays fixture stdout lines captured from live probes.
 */

/** Child-process identity reported right after spawn (decision 4). */
export interface ClaudeProcessInfo {
  pid: number;
  /** With detached spawn the child leads its own group, so pgid === pid. */
  pgid?: number;
}

/** Live process-group handle exposed to the adapter as soon as spawn succeeds. */
export interface ClaudeExecHandle extends ClaudeProcessInfo {
  pgid: number;
  /**
   * Tree-kills the detached process group and resolves only after its
   * disappearance has been verified (or verification has failed). Remains
   * usable AFTER the leader has exited/closed: a natural leader close is not
   * proof its descendants are gone, so late callers (e.g. an event-sink
   * failure discovered during settlement) can still run verified group
   * cleanup.
   */
  kill(signal?: NodeJS.Signals): Promise<boolean>;
}

/**
 * Proof level for process-tree termination (finding 20). A natural leader
 * close never claims tree-termination: "not_attempted" means no kill ran and
 * the detached group was still alive when the leader closed.
 */
export type TerminationProof =
  /** Group liveness was checked and no process in the detached group remains. */
  | "verified_gone"
  /** No kill ran; the leader closed naturally but its group was still alive. */
  | "not_attempted"
  /** A kill began but group disappearance could not be confirmed. */
  | "unverified";

export interface ClaudeExecRequest {
  /** argv after the binary, e.g. ["-p", "--output-format", "stream-json", ...]. */
  args: string[];
  cwd: string;
  /** Prompt text, delivered on stdin (probed: `echo prompt | claude -p` works). */
  stdin: string;
  timeoutMs?: number | undefined;
  /**
   * Cancellation: an abort triggers verified group termination (SIGTERM,
   * SIGKILL after grace) and the result reports aborted:true. A signal that
   * is already aborted rejects before anything is spawned.
   */
  signal?: AbortSignal | undefined;
  /** Called once per complete stdout line (without the trailing newline). */
  onStdoutLine?: ((line: string) => void) | undefined;
  /** Called once spawn succeeds, with process identity and a live kill seam. */
  onSpawn?: ((handle: ClaudeExecHandle) => void) | undefined;
}

export interface ClaudeExecResult {
  /** Process exit code; null when the process died from a signal. */
  exitCode: number | null;
  /**
   * True when the deadline elapsed before any JS-visible leader exit and the
   * exec layer attempted group termination. Once that kill was attempted, the
   * run is timed out REGARDLESS of the exit code the child manages to produce
   * afterward: a SIGTERM handler exiting 0 must not launder an expired run
   * into success (finding 18 residual). Close-time arbitration still protects
   * runs where NO kill intent was recorded — a natural exit that beat the
   * deadline is never reclassified as a timeout.
   */
  timedOut: boolean;
  /** True when req.signal aborted the run and the group was tree-killed. */
  aborted: boolean;
  /**
   * True when the stdout line buffer exceeded its cap and the process tree
   * was killed; the adapter maps this onto a machine-readable adapter_error.
   */
  overflowed?: boolean;
  /** Captured stderr tail, capped to avoid unbounded buffering. */
  stderr: string;
  /**
   * Termination proof level. Kill paths report verified_gone/unverified only
   * after group-liveness verification; a natural close probes the group once
   * and reports not_attempted when descendants survive it (finding 20).
   */
  termination: TerminationProof;
}

export type ClaudeExec = (req: ClaudeExecRequest) => Promise<ClaudeExecResult>;

/** Decision 9: 256KB stderr window, keeping the tail. */
export const MAX_STDERR_BYTES = 256 * 1024;
/**
 * Decision 9: stdout is consumed line-by-line, so only the current line needs
 * buffering. A line beyond this 4MB cap cannot be trusted as protocol
 * evidence; kill the process tree and fail loud instead of buffering forever.
 */
export const MAX_STDOUT_LINE_BYTES = 4 * 1024 * 1024;
/** Decision 4: SIGTERM the process group, escalate to SIGKILL after grace. */
export const KILL_GRACE_MS = 5000;

export interface ClaudeProcessExecOptions {
  /** Test seam; production default is MAX_STDOUT_LINE_BYTES. */
  maxStdoutLineBytes?: number;
  /** Test seam; production default is MAX_STDERR_BYTES. */
  maxStderrBytes?: number;
  /** Test seam; production default is the required five-second grace. */
  killGraceMs?: number;
}

/**
 * Real implementation: spawns the claude binary detached (so it owns a
 * process group) in the lane cwd, reports {pid, pgid} via onSpawn, writes the
 * prompt to stdin, streams stdout lines, and tree-kills (SIGTERM the negative
 * pgid, SIGKILL after a 5s grace) on timeout, abort, or buffer overflow.
 * Spawn failures (e.g. ENOENT when the binary is missing) reject with the
 * raw error; the adapter maps them onto AdapterError codes.
 *
 * NOTE: process-group signalling (negative-pgid kill) is POSIX-only in v0;
 * the adapter manifest reports kill capability platform-aware.
 */
export function createProcessClaudeExec(
  binary = "claude",
  options: ClaudeProcessExecOptions = {},
): ClaudeExec {
  return (req) =>
    new Promise<ClaudeExecResult>((resolve, reject) => {
      if (req.signal?.aborted === true) {
        reject(abortError(req.signal));
        return;
      }

      // detached:true makes the child a process-group leader so a signal to
      // -pid reaches every descendant (decision 4).
      const child = spawn(binary, req.args, {
        cwd: req.cwd,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdoutBuffer = "";
      let stderr = Buffer.alloc(0);
      // Deadline intent (finding 18): set only when the deadline elapsed
      // while the leader had no JS-visible exit evidence and a group kill was
      // attempted. That intent IS the timedOut classification; close-time
      // arbitration only protects runs whose leader exited before any kill.
      let deadlineKillRequested = false;
      let aborted = false;
      let overflowed = false;
      let exited = false;
      let closed = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let terminationPromise: Promise<boolean> | undefined;
      const maxStdoutLineBytes = options.maxStdoutLineBytes ?? MAX_STDOUT_LINE_BYTES;
      const maxStderrBytes = options.maxStderrBytes ?? MAX_STDERR_BYTES;
      const killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;

      const signalTree = (signal: NodeJS.Signals): boolean => {
        const pid = child.pid;
        if (pid === undefined) {
          return false;
        }
        try {
          // Negative pid = the whole process group (the detached child leads it).
          process.kill(-pid, signal);
          return true;
        } catch {
          try {
            return child.kill(signal);
          } catch {
            return false;
          }
        }
      };

      // Begins (or joins) verified group termination. Deliberately NOT gated
      // on `closed`: a natural leader close is no proof its descendants are
      // gone, so post-close callers still get verified group cleanup
      // (finding 17/20).
      const treeKill = (signal: NodeJS.Signals = "SIGTERM"): Promise<boolean> => {
        if (terminationPromise !== undefined) {
          return terminationPromise;
        }

        const pgid = child.pid;
        signalTree(signal);
        terminationPromise = confirmTreeTermination(
          pgid,
          signal === "SIGKILL" ? 0 : killGraceMs,
          () => signalTree("SIGKILL"),
        );
        void terminationPromise.then(
          () => destroyChildPipes(child),
          () => destroyChildPipes(child),
        );
        return terminationPromise;
      };

      const onAbort = (): void => {
        aborted = true;
        void treeKill();
      };
      req.signal?.addEventListener("abort", onAbort, { once: true });

      const overflow = (): void => {
        if (overflowed) {
          return;
        }
        overflowed = true;
        stdoutBuffer = "";
        void treeKill();
      };

      if (req.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          // Give libuv one poll turn to deliver an already-pending child exit
          // before recording deadline intent. This closes the common race in
          // which the timer callback runs first even though the leader has
          // exited and only descendant-owned stdio is still open.
          setImmediate(() => {
            if (closed) {
              return;
            }
            const leaderExited = exited || child.exitCode !== null || child.signalCode !== null;
            if (!leaderExited) {
              // The deadline fired against a live leader and the kill below
              // is attempted: this run IS timed out, whatever exit code the
              // child manages to produce after our SIGTERM (finding 18
              // residual: no post-deadline exit laundering).
              deadlineKillRequested = true;
            }
            // Even after a clean leader exit, the deadline remains a bound on
            // descendant-owned stdio. Terminate the detached group so close
            // cannot hang forever, without laundering that cleanup into a
            // native timeout for the already-exited leader.
            void treeKill();
          });
        }, req.timeoutMs);
      }

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (overflowed) {
          return;
        }
        stdoutBuffer += chunk;
        let newlineIndex = stdoutBuffer.indexOf("\n");
        while (newlineIndex !== -1) {
          const line = stdoutBuffer.slice(0, newlineIndex);
          stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
          if (Buffer.byteLength(line, "utf8") > maxStdoutLineBytes) {
            overflow();
            return;
          }
          if (line.trim() !== "") {
            req.onStdoutLine?.(line);
          }
          newlineIndex = stdoutBuffer.indexOf("\n");
        }
        if (Buffer.byteLength(stdoutBuffer, "utf8") > maxStdoutLineBytes) {
          overflow();
        }
      });

      child.stderr.on("data", (chunk: Buffer) => {
        const combined = Buffer.concat([stderr, chunk]);
        // Keep the tail: the last lines carry the actual failure reason.
        stderr =
          combined.length <= maxStderrBytes
            ? combined
            : combined.subarray(combined.length - maxStderrBytes);
      });

      child.on("error", (error) => {
        exited = true;
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        req.signal?.removeEventListener("abort", onAbort);
        reject(error);
      });

      child.once("exit", () => {
        // Exit wins a timeout race even if stdio is still draining and close
        // has not fired yet. Keep the deadline armed: descendants may still
        // own the pipes and must not make the exec promise unbounded.
        exited = true;
      });

      child.on("close", async (code) => {
        closed = true;
        exited = true;
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        req.signal?.removeEventListener("abort", onAbort);
        if (!overflowed && stdoutBuffer.trim() !== "") {
          if (Buffer.byteLength(stdoutBuffer, "utf8") > maxStdoutLineBytes) {
            overflowed = true;
          } else {
            req.onStdoutLine?.(stdoutBuffer);
          }
        }
        // A direct-child exit is not proof that its descendants are gone.
        // If any kill path began, wait through group-liveness verification
        // even though the leader and its stdio have already closed. Without a
        // kill, probe the group once: alive descendants mean the natural
        // close proves nothing about the tree (finding 20).
        let termination: TerminationProof;
        if (terminationPromise !== undefined) {
          termination = (await terminationPromise) ? "verified_gone" : "unverified";
        } else if (child.pid !== undefined && !isProcessGroupAlive(child.pid)) {
          termination = "verified_gone";
        } else {
          termination = "not_attempted";
        }
        resolve({
          exitCode: code,
          // Finding 18 residual: once the deadline fired against a live
          // leader and a group kill was attempted, the run is timed out
          // regardless of the exit code produced afterward — a SIGTERM
          // handler exiting 0 must not turn an expired run into success.
          // A leader that exited BEFORE any kill intent (deadlineKillRequested
          // false) keeps its own natural-exit evidence.
          timedOut: deadlineKillRequested,
          aborted,
          overflowed,
          stderr: stderr.toString("utf8"),
          termination,
        });
      });

      child.once("spawn", () => {
        const pid = child.pid;
        if (pid === undefined) {
          return;
        }

        req.onSpawn?.({ pid, pgid: pid, kill: treeKill });
      });

      // The process can exit before consuming stdin (probed: unknown --resume
      // ids exit 1 immediately); swallow the resulting EPIPE — the close
      // handler reports the real outcome.
      child.stdin.on("error", () => {});
      child.stdin.end(req.stdin);
    });
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("claude exec aborted before spawn");
}

/**
 * Waits for the detached process group to disappear. A leader exit does not
 * shorten the grace: descendants get the configured SIGTERM window, then the
 * surviving group receives SIGKILL and is checked again.
 */
async function confirmTreeTermination(
  pgid: number | undefined,
  graceMs: number,
  forceKill: () => boolean,
): Promise<boolean> {
  if (pgid === undefined) {
    return false;
  }

  if (await waitForGroupExit(pgid, graceMs)) {
    return true;
  }

  forceKill();
  return waitForGroupExit(pgid, 1_000);
}

async function waitForGroupExit(pgid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (!isProcessGroupAlive(pgid)) {
      return true;
    }
    await delay(Math.min(25, Math.max(1, deadline - Date.now())));
  } while (Date.now() < deadline);

  return !isProcessGroupAlive(pgid);
}

function isProcessGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function destroyChildPipes(child: ReturnType<typeof spawn>): void {
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();
}
