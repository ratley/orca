import { spawn } from "node:child_process";

/**
 * Thin process-execution layer for the cursor adapter. Production uses
 * `spawnExec`; unit tests replace `ExecFn` with a fake that replays recorded
 * Cursor CLI fixtures.
 *
 * Process identity: children are spawned detached so they lead their own
 * process group (pgid === pid). All kills signal the NEGATIVE pgid so the
 * whole tree dies (SIGTERM, then SIGKILL after a grace period); kill outcomes
 * resolve only after group-liveness verification.
 *
 * NOTE: process-group signalling (negative-pgid kill) is POSIX-only in v0;
 * the adapter manifest reports kill capability platform-aware.
 */

/** Stdout window (bytes). Only the TAIL is kept: the result is the LAST line. */
export const MAX_STDOUT_BYTES = 4 * 1024 * 1024;

/** Stderr tail window (bytes). Exceeding it terminates the runaway process. */
export const MAX_STDERR_BYTES = 256 * 1024;

/** Grace between the SIGTERM and SIGKILL of a tree-kill. */
export const KILL_GRACE_MS = 5_000;

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

export interface ExecHandle {
  pid: number;
  /** Process-group id; equals pid because the child is spawned detached. */
  pgid: number;
  /**
   * Initiates a tree-kill of the child's process group: `signal` (default
   * SIGTERM) to -pgid, then SIGKILL after the grace period. Resolves only
   * after the group's disappearance has been verified (true) or verification
   * failed (false). Remains usable AFTER the leader has exited/closed: a
   * natural leader close is not proof its descendants are gone, so late
   * callers (e.g. an event-sink failure discovered during settlement) can
   * still run verified group cleanup (finding 17).
   */
  kill(signal?: NodeJS.Signals): Promise<boolean>;
}

export interface ExecRequest {
  bin: string;
  args: string[];
  cwd: string;
  timeoutMs?: number | undefined;
  /**
   * Cancellation: an abort triggers verified group termination (SIGTERM,
   * SIGKILL after grace) and the result reports aborted:true. A signal that
   * is already aborted rejects before anything is spawned.
   */
  signal?: AbortSignal | undefined;
  /** Called once the child process has spawned, with a live kill handle. */
  onSpawn?: ((handle: ExecHandle) => void) | undefined;
  /**
   * Called at most once, when the FIRST byte arrives on either stream. This is
   * a liveness signal only: it proves the child moved past bare spawn into
   * producing output, NOT that the prompt was received or understood. The
   * cursor CLI emits a `cursor-retrieval: tracing` stderr line within ~1s of
   * spawn (verified 2026-07-11), so this fires early even during a long cold
   * start and lets a driver distinguish "initializing" from a pre-output hang.
   */
  onFirstOutput?: ((source: "stdout" | "stderr") => void) | undefined;
  /** Stdout tail-window override (tests use tiny caps). Default 4MB. */
  maxStdoutBytes?: number | undefined;
  /** Stderr tail-window override. Default 256KB. */
  maxStderrBytes?: number | undefined;
  /** SIGTERM->SIGKILL escalation grace override. Default 5000ms. */
  killGraceMs?: number | undefined;
}

export interface ExecResult {
  /** Process exit code; null when the process was terminated by a signal. */
  exitCode: number | null;
  /** Tail window of stdout (at most maxStdoutBytes). */
  stdout: string;
  /** Tail window of stderr (at most maxStderrBytes). */
  stderr: string;
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
  /**
   * True when a kill was requested through the ExecHandle AND the final close
   * evidence shows a signal death; a leader that still produced a real exit
   * code is reported by that code, not as killed.
   */
  killed: boolean;
  /** True when req.signal aborted the run and the group was tree-killed. */
  aborted: boolean;
  /**
   * True when stdout or stderr exceeded its cap: the process was tree-killed
   * and only that stream's tail was kept.
   */
  overCap: boolean;
  /** Which bounded stream exceeded its cap, when overCap is true. */
  overCapSource?: "stdout" | "stderr" | undefined;
  /**
   * Termination proof level. Kill paths report verified_gone/unverified only
   * after group-liveness verification; a natural close probes the group once
   * and reports not_attempted when descendants survive it (finding 20).
   */
  termination: TerminationProof;
}

export type ExecFn = (req: ExecRequest) => Promise<ExecResult>;

/** Thrown when the binary itself cannot be spawned (ENOENT). */
export class ExecUnavailableError extends Error {
  constructor(bin: string, options: { cause?: unknown } = {}) {
    super(
      `Executable not found: ${bin}`,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "ExecUnavailableError";
  }
}

/** Bounded tail buffer: keeps at most `max` bytes, discarding from the head. */
class TailBuffer {
  private chunks: Buffer[] = [];
  private bytes = 0;
  /** Cumulative bytes ever written, including discarded head bytes. */
  total = 0;

  constructor(private readonly max: number) {}

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.bytes += chunk.length;
    this.total += chunk.length;

    while (this.bytes > this.max) {
      const head = this.chunks[0] as Buffer;
      const excess = this.bytes - this.max;
      if (head.length <= excess) {
        this.chunks.shift();
        this.bytes -= head.length;
      } else {
        this.chunks[0] = head.subarray(excess);
        this.bytes -= excess;
      }
    }
  }

  toString(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

export const spawnExec: ExecFn = (req) =>
  new Promise((resolve, reject) => {
    if (req.signal?.aborted === true) {
      reject(abortError(req.signal));
      return;
    }

    // detached: the child leads its own process group, so pgid === pid and
    // signalling -pgid reaches the whole tree (decision: process identity).
    const child = spawn(req.bin, req.args, {
      cwd: req.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });

    const stdout = new TailBuffer(req.maxStdoutBytes ?? MAX_STDOUT_BYTES);
    const stderr = new TailBuffer(req.maxStderrBytes ?? MAX_STDERR_BYTES);
    const killGraceMs = req.killGraceMs ?? KILL_GRACE_MS;

    // Deadline intent is final (finding 18 residual): once the deadline
    // fired against a live leader and a kill was attempted, the run is timed
    // out whatever the child exits with afterward. The killed classification
    // still arbitrates at close from final exit/signal evidence.
    let deadlineKillRequested = false;
    let handleKillRequested = false;
    let aborted = false;
    let overCap = false;
    let overCapSource: "stdout" | "stderr" | undefined;
    let exited = false;
    let closed = false;
    let firstOutputSeen = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let terminationPromise: Promise<boolean> | undefined;

    const noteFirstOutput = (source: "stdout" | "stderr"): void => {
      if (firstOutputSeen) {
        return;
      }
      firstOutputSeen = true;
      req.onFirstOutput?.(source);
    };

    const clearTimers = () => {
      if (timeoutTimer !== undefined) {
        clearTimeout(timeoutTimer);
      }
    };

    /** Signals the whole process group; falls back to the direct child. */
    const signalTree = (signal: NodeJS.Signals): boolean => {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, signal);
          return true;
        } catch {
          // Group already gone (ESRCH) or not signallable; try the child.
        }
      }

      return child.kill(signal);
    };

    /**
     * SIGTERM (or the given signal) now; SIGKILL after the grace period.
     * Resolves after group-liveness verification. Deliberately NOT gated on
     * `closed`: a natural leader close is no proof its descendants are gone,
     * so post-close callers still get verified group cleanup (finding 17/20).
     */
    const beginTreeKill = (signal: NodeJS.Signals = "SIGTERM"): Promise<boolean> => {
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
      void beginTreeKill();
    };
    req.signal?.addEventListener("abort", onAbort, { once: true });

    if (req.timeoutMs !== undefined) {
      timeoutTimer = setTimeout(() => {
        setImmediate(() => {
          if (closed) {
            return;
          }
          const leaderExited = exited || child.exitCode !== null || child.signalCode !== null;
          if (!leaderExited) {
            // The deadline fired against a live leader and the kill below is
            // attempted: this run IS timed out, whatever exit code the child
            // manages to produce after our SIGTERM (finding 18 residual: no
            // post-deadline exit laundering).
            deadlineKillRequested = true;
          }
          // A clean leader exit does not cancel the wall-clock bound: a
          // descendant may still own stdout/stderr forever. Clean up that
          // detached group without classifying the leader as timed out.
          void beginTreeKill();
        });
      }, req.timeoutMs);
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      noteFirstOutput("stdout");
      stdout.push(chunk);
      if (!overCap && stdout.total > (req.maxStdoutBytes ?? MAX_STDOUT_BYTES)) {
        overCap = true;
        overCapSource = "stdout";
        void beginTreeKill();
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      noteFirstOutput("stderr");
      stderr.push(chunk);
      if (!overCap && stderr.total > (req.maxStderrBytes ?? MAX_STDERR_BYTES)) {
        overCap = true;
        overCapSource = "stderr";
        void beginTreeKill();
      }
    });

    child.once("exit", () => {
      exited = true;
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimers();
      req.signal?.removeEventListener("abort", onAbort);
      reject(error.code === "ENOENT" ? new ExecUnavailableError(req.bin, { cause: error }) : error);
    });

    // "close" fires after exit AND stdio drain; it carries the final
    // exit/signal evidence that arbitrates killed and resolves the promise
    // (after any pending tree-kill verification). timedOut is already final:
    // deadline kill intent is never re-arbitrated by the exit code.
    child.on("close", async (exitCode) => {
      closed = true;
      clearTimers();
      req.signal?.removeEventListener("abort", onAbort);
      // A direct-child exit is not proof its descendants are gone. If a kill
      // began, wait through group-liveness verification; without one, probe
      // the group once so a natural close never overstates tree-termination
      // (finding 20).
      let termination: TerminationProof;
      if (terminationPromise !== undefined) {
        termination = (await terminationPromise) ? "verified_gone" : "unverified";
      } else if (child.pid !== undefined && !isProcessGroupAlive(child.pid)) {
        termination = "verified_gone";
      } else {
        termination = "not_attempted";
      }
      resolve({
        exitCode,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        // Finding 18 residual: once the deadline fired against a live leader
        // and a group kill was attempted, the run is timed out regardless of
        // the exit code produced afterward — a SIGTERM handler exiting 0 must
        // not turn an expired run into success. killed keeps final-evidence
        // arbitration: only a signal death counts as a kill.
        timedOut: deadlineKillRequested,
        killed: handleKillRequested && exitCode === null,
        aborted,
        overCap,
        ...(overCapSource !== undefined ? { overCapSource } : {}),
        termination,
      });
    });

    child.once("spawn", () => {
      const pid = child.pid;
      if (pid === undefined) {
        return;
      }

      req.onSpawn?.({
        pid,
        pgid: pid,
        kill: (signal = "SIGTERM") => {
          handleKillRequested = true;
          return beginTreeKill(signal);
        },
      });
    });
  });

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("cursor exec aborted before spawn");
}

/**
 * Waits for the detached process group to disappear. If it survives the
 * SIGTERM grace, sends SIGKILL and verifies disappearance before returning.
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
