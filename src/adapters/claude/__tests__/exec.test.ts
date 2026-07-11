import { describe, expect, test } from "bun:test";

import {
  createProcessClaudeExec,
  KILL_GRACE_MS,
  MAX_STDERR_BYTES,
  MAX_STDOUT_LINE_BYTES,
} from "../exec";
import type { ClaudeExecHandle } from "../exec";

const cwd = process.cwd();

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (!processExists(pid)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`process ${pid} remained alive after process-group kill`);
}

describe("createProcessClaudeExec", () => {
  test("reports detached process identity and streams complete stdout lines", async () => {
    const exec = createProcessClaudeExec(process.execPath);
    const lines: string[] = [];
    let processInfo: ClaudeExecHandle | undefined;

    const result = await exec({
      args: ["-e", `process.stdout.write("first\\nsecond\\n")`],
      cwd,
      stdin: "",
      onSpawn: (info) => {
        processInfo = info;
      },
      onStdoutLine: (line) => lines.push(line),
    });

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.overflowed).toBe(false);
    expect(result.termination).toBe("verified_gone");
    expect(lines).toEqual(["first", "second"]);
    expect(processInfo?.pid).toBeGreaterThan(0);
    expect(processInfo?.pgid).toBe(processInfo?.pid);
    expect(processInfo?.kill).toBeFunction();
  });

  test("keeps only the bounded stderr tail", async () => {
    const exec = createProcessClaudeExec(process.execPath, { maxStderrBytes: 16 });

    const result = await exec({
      args: ["-e", `process.stderr.write("x".repeat(100) + "TAIL")`],
      cwd,
      stdin: "",
    });

    expect(Buffer.byteLength(result.stderr, "utf8")).toBeLessThanOrEqual(16);
    expect(result.stderr).toEndWith("TAIL");
  });

  test("tree-kills on stdout line overflow and reports the cap breach", async () => {
    const exec = createProcessClaudeExec(process.execPath, {
      maxStdoutLineBytes: 64,
      killGraceMs: 25,
    });

    const result = await exec({
      args: [
        "-e",
        `process.on("SIGTERM", () => {}); process.stdout.write("x".repeat(1024)); setInterval(() => {}, 1000)`,
      ],
      cwd,
      stdin: "",
    });

    expect(result.exitCode).toBeNull();
    expect(result.timedOut).toBe(false);
    expect(result.overflowed).toBe(true);
    expect(result.termination).toBe("verified_gone");
  });

  test("tree-kills the detached process group on timeout and verifies descendants exit", async () => {
    expect(KILL_GRACE_MS).toBe(5_000);
    const exec = createProcessClaudeExec(process.execPath, { killGraceMs: 25 });
    const lines: string[] = [];

    const result = await exec({
      args: [
        "-e",
        `
          const { spawn } = require("node:child_process");
          const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
          console.log(child.pid);
          process.on("SIGTERM", () => {});
          setInterval(() => {}, 1000);
        `,
      ],
      cwd,
      stdin: "",
      // Wide enough that the child always prints the descendant pid before
      // the deadline fires (a 25ms deadline raced interpreter startup and
      // occasionally killed the child before its console.log).
      timeoutMs: 150,
      onStdoutLine: (line) => lines.push(line),
    });

    const descendantPid = Number(lines[0]);
    expect(descendantPid).toBeGreaterThan(0);
    expect(result.exitCode).toBeNull();
    expect(result.timedOut).toBe(true);
    expect(result.termination).toBe("verified_gone");
    await waitForProcessExit(descendantPid);
  });

  test("keeps escalation alive when the leader exits but a descendant ignores SIGTERM", async () => {
    const exec = createProcessClaudeExec(process.execPath, { killGraceMs: 50 });
    const lines: string[] = [];
    let handle: ClaudeExecHandle | undefined;
    let descendantPid: number | undefined;

    try {
      const result = await exec({
        args: [
          "-e",
          `
            const { spawn } = require("node:child_process");
            const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
            console.log(child.pid);
            setInterval(() => {}, 1000);
          `,
        ],
        cwd,
        stdin: "",
        // Same startup-race margin as the tree-kill test above: the pid line
        // must reliably beat the deadline.
        timeoutMs: 150,
        onSpawn: (spawned) => {
          handle = spawned;
        },
        onStdoutLine: (line) => lines.push(line),
      });

      descendantPid = Number(lines[0]);
      expect(descendantPid).toBeGreaterThan(0);
      expect(result.exitCode).toBeNull();
      expect(result.timedOut).toBe(true);
      expect(result.termination).toBe("verified_gone");
      await waitForProcessExit(descendantPid);
    } finally {
      if (handle !== undefined) {
        try {
          process.kill(-handle.pgid, "SIGKILL");
        } catch {
          // Expected once verified group termination has completed.
        }
      } else if (descendantPid !== undefined && processExists(descendantPid)) {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch {
          // Best-effort cleanup for a failed spawn assertion.
        }
      }
    }
  });

  test("an exited child is not reclassified as timed out while stdio closes", async () => {
    const exec = createProcessClaudeExec(process.execPath, { killGraceMs: 10 });
    const startedAt = Date.now();

    const result = await exec({
      args: [
        "-e",
        `
          const { spawn } = require("node:child_process");
          const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "inherit", "inherit"] });
          child.unref();
          process.exit(0);
        `,
      ],
      cwd,
      stdin: "",
      // Leave enough startup margin that the leader exits first. Its
      // descendant intentionally holds inherited stdio forever; the deadline
      // must clean up that group without reclassifying the leader.
      timeoutMs: 250,
    });

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.termination).toBe("verified_gone");
  });

  test("production caps stay pinned to the contract limits", () => {
    expect(MAX_STDOUT_LINE_BYTES).toBe(4 * 1024 * 1024);
    expect(MAX_STDERR_BYTES).toBe(256 * 1024);
  });

  test("a natural exit that beat the deadline is never reclassified as timed out (finding 18)", async () => {
    const exec = createProcessClaudeExec(process.execPath, { killGraceMs: 20 });

    const result = await exec({
      args: ["-e", "process.exit(0)"],
      cwd,
      stdin: "",
      timeoutMs: 30,
      onSpawn: () => {
        // Deliberately block the event loop past both the child's exit and
        // the deadline, so the timer and the exit event are delivered late
        // and their JS-visible order is unreliable. The timer must see the
        // already-available exit evidence and record no deadline-kill
        // intent: a natural exit beats a timer that never fired its kill.
        const blockUntil = Date.now() + 400;
        while (Date.now() < blockUntil) {
          // busy-wait
        }
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  test("post-deadline SIGTERM-trapped exit 0 stays timed out (finding 18 residual)", async () => {
    // Grace long enough that the trap handler always beats SIGKILL.
    const exec = createProcessClaudeExec(process.execPath, { killGraceMs: 2_000 });
    const lines: string[] = [];

    const result = await exec({
      args: [
        "-e",
        `
          process.on("SIGTERM", () => {
            process.stdout.write('{"type":"result","subtype":"success","is_error":false}\\n');
            process.exit(0);
          });
          setInterval(() => {}, 1000);
        `,
      ],
      cwd,
      stdin: "",
      // Wide margin: the handler is installed milliseconds after spawn, long
      // before the deadline can fire, so the trap-then-exit-0 path is the
      // only way this child ever ends.
      timeoutMs: 250,
      onStdoutLine: (line) => lines.push(line),
    });

    // The child trapped Orca's deadline SIGTERM, wrote a "successful" result
    // line, and exited 0 — none of which may launder the expired run into
    // success: the deadline fired and a kill was attempted, so it timed out.
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(true);
    expect(lines).toContain('{"type":"result","subtype":"success","is_error":false}');
    expect(result.termination).toBe("verified_gone");
  });

  test("natural close with a surviving descendant reports not_attempted; post-close kill verifies cleanup", async () => {
    const exec = createProcessClaudeExec(process.execPath, { killGraceMs: 25 });
    const lines: string[] = [];
    let handle: ClaudeExecHandle | undefined;
    let descendantPid: number | undefined;

    try {
      const result = await exec({
        args: [
          "-e",
          `
            const { spawn } = require("node:child_process");
            const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
            child.unref();
            console.log(child.pid);
          `,
        ],
        cwd,
        stdin: "",
        onSpawn: (spawned) => {
          handle = spawned;
        },
        onStdoutLine: (line) => lines.push(line),
      });

      descendantPid = Number(lines[0]);
      expect(descendantPid).toBeGreaterThan(0);
      expect(result.exitCode).toBe(0);
      expect(result.timedOut).toBe(false);
      // Finding 20: the leader's natural close is NOT proof the tree is gone.
      expect(result.termination).toBe("not_attempted");
      expect(processExists(descendantPid)).toBe(true);

      // Finding 17/20: the handle stays group-aware after leader close and
      // still delivers verified cleanup.
      expect(await handle?.kill()).toBe(true);
      await waitForProcessExit(descendantPid);
      descendantPid = undefined;
    } finally {
      if (descendantPid !== undefined && processExists(descendantPid)) {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch {
          // Best-effort cleanup for a failed assertion.
        }
      }
    }
  });

  test("abort tree-kills the detached group with verified termination", async () => {
    const exec = createProcessClaudeExec(process.execPath, { killGraceMs: 25 });
    const controller = new AbortController();
    const lines: string[] = [];

    const result = await exec({
      args: [
        "-e",
        `
          const { spawn } = require("node:child_process");
          const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
          console.log(child.pid);
          setInterval(() => {}, 1000);
        `,
      ],
      cwd,
      stdin: "",
      signal: controller.signal,
      onStdoutLine: (line) => {
        lines.push(line);
        controller.abort();
      },
    });

    const descendantPid = Number(lines[0]);
    expect(descendantPid).toBeGreaterThan(0);
    expect(result.aborted).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(result.timedOut).toBe(false);
    expect(result.termination).toBe("verified_gone");
    await waitForProcessExit(descendantPid);
  });

  test("an already-aborted signal rejects before anything is spawned", async () => {
    const exec = createProcessClaudeExec(process.execPath);
    const controller = new AbortController();
    controller.abort(new Error("cancelled before dispatch"));

    await expect(
      exec({
        args: ["-e", "setInterval(() => {}, 1000)"],
        cwd,
        stdin: "",
        signal: controller.signal,
      }),
    ).rejects.toThrow("cancelled before dispatch");
  });
});
