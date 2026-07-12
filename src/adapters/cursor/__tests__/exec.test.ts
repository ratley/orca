import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { MAX_STDERR_BYTES, MAX_STDOUT_BYTES, spawnExec } from "../exec";
import type { ExecHandle } from "../exec";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("cursor spawnExec process boundary", () => {
  test("reports the detached pid/pgid and confirms natural termination", async () => {
    let handle: ExecHandle | undefined;
    const result = await spawnExec({
      bin: process.execPath,
      args: ["-e", 'process.stdout.write("ok")'],
      cwd: process.cwd(),
      timeoutMs: 2_000,
      onSpawn: (spawned) => {
        handle = spawned;
      },
    });

    expect(handle?.pid).toBeGreaterThan(0);
    expect(handle?.pgid).toBe(handle?.pid);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ok");
    expect(result.timedOut).toBe(false);
    expect(result.termination).toBe("verified_gone");
  });

  test("onFirstOutput fires exactly once, on the earliest stream, across many chunks", async () => {
    // Mirrors cursor: an early stderr line (its retrieval tracing) precedes the
    // final stdout result. onFirstOutput must fire once, naming stderr.
    const script = [
      'process.stderr.write("trace-1\\n");',
      'process.stderr.write("trace-2\\n");',
      'process.stdout.write("result-line\\n");',
    ].join("\n");
    const firstOutputs: Array<"stdout" | "stderr"> = [];

    const result = await spawnExec({
      bin: process.execPath,
      args: ["-e", script],
      cwd: process.cwd(),
      timeoutMs: 2_000,
      onFirstOutput: (source) => {
        firstOutputs.push(source);
      },
    });

    expect(result.exitCode).toBe(0);
    expect(firstOutputs).toEqual(["stderr"]);
  });

  test("direct-child exit beats a timeout while inherited stdout is still draining", async () => {
    const descendant = "setInterval(() => {}, 1000)";
    const parent = [
      'const { spawn } = require("node:child_process");',
      `const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: ["ignore", "inherit", "inherit"] });`,
      "child.unref();",
    ].join("\n");
    const startedAt = Date.now();

    const result = await spawnExec({
      bin: process.execPath,
      args: ["-e", parent],
      cwd: process.cwd(),
      timeoutMs: 250,
    });

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.killed).toBe(false);
    expect(result.termination).toBe("verified_gone");
  });

  test("stdout overflow keeps only the tail, tree-kills, and confirms termination", async () => {
    const script = [
      'process.on("SIGTERM", () => {});',
      'process.stdout.write("x".repeat(4096));',
      "setInterval(() => {}, 1000);",
    ].join("\n");

    const result = await spawnExec({
      bin: process.execPath,
      args: ["-e", script],
      cwd: process.cwd(),
      maxStdoutBytes: 128,
      killGraceMs: 20,
    });

    expect(MAX_STDOUT_BYTES).toBe(4 * 1024 * 1024);
    expect(result.overCap).toBe(true);
    expect(result.overCapSource).toBe("stdout");
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(128);
    expect(result.termination).toBe("verified_gone");
    expect(result.exitCode).toBeNull();
  });

  test("stderr overflow keeps only the tail and terminates the process tree", async () => {
    const script = [
      'process.on("SIGTERM", () => {});',
      'process.stderr.write("e".repeat(4096));',
      "setInterval(() => {}, 1000);",
    ].join("\n");

    const result = await spawnExec({
      bin: process.execPath,
      args: ["-e", script],
      cwd: process.cwd(),
      maxStderrBytes: 96,
      killGraceMs: 20,
    });

    expect(MAX_STDERR_BYTES).toBe(256 * 1024);
    expect(result.overCap).toBe(true);
    expect(result.overCapSource).toBe("stderr");
    expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(96);
    expect(result.termination).toBe("verified_gone");
  });

  test("timeout kills descendants in the detached group before resolving", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orca-cursor-tree-kill-"));
    tempDirs.push(dir);
    const marker = path.join(dir, "descendant-survived");
    const descendant = [
      'const fs = require("node:fs");',
      'process.on("SIGTERM", () => {});',
      `setTimeout(() => fs.writeFileSync(${JSON.stringify(marker)}, "alive"), 200);`,
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const parent = [
      'const { spawn } = require("node:child_process");',
      `const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: "ignore" });`,
      "child.unref();",
      'process.on("SIGTERM", () => {});',
      "setInterval(() => {}, 1000);",
    ].join("\n");

    const result = await spawnExec({
      bin: process.execPath,
      args: ["-e", parent],
      cwd: process.cwd(),
      timeoutMs: 25,
      killGraceMs: 20,
    });

    expect(result.timedOut).toBe(true);
    expect(result.termination).toBe("verified_gone");
    await Bun.sleep(250);
    expect(await fs.exists(marker)).toBe(false);
  });

  test("handle kill resolves only after verified group termination", async () => {
    const script = ['process.on("SIGTERM", () => {});', "setInterval(() => {}, 1000);"].join("\n");
    let handle: ExecHandle | undefined;
    let killVerified: Promise<boolean> | undefined;

    const result = await spawnExec({
      bin: process.execPath,
      args: ["-e", script],
      cwd: process.cwd(),
      killGraceMs: 20,
      onSpawn: (spawned) => {
        handle = spawned;
        killVerified = spawned.kill();
      },
    });

    expect(handle?.pid).toBeGreaterThan(0);
    expect(await killVerified).toBe(true);
    expect(result.killed).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(result.timedOut).toBe(false);
    expect(result.termination).toBe("verified_gone");
  });

  test("a natural exit that beat the deadline is never reclassified as timed out (finding 18)", async () => {
    const result = await spawnExec({
      bin: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: process.cwd(),
      timeoutMs: 30,
      killGraceMs: 20,
      onSpawn: () => {
        // Deliberately block the event loop past both the child's exit and
        // the deadline, so the timer and exit callbacks are delivered late
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
    const script = [
      'process.on("SIGTERM", () => {',
      '  process.stdout.write(\'{"type":"result","ok":true}\\n\');',
      "  process.exit(0);",
      "});",
      "setInterval(() => {}, 1000);",
    ].join("\n");

    const result = await spawnExec({
      bin: process.execPath,
      args: ["-e", script],
      cwd: process.cwd(),
      // Wide margin: the handler is installed milliseconds after spawn, long
      // before the deadline can fire; the grace keeps SIGKILL from racing
      // the trap handler.
      timeoutMs: 250,
      killGraceMs: 2_000,
    });

    // The child trapped Orca's deadline SIGTERM, wrote a "successful" result
    // line, and exited 0 — none of which may launder the expired run into
    // success: the deadline fired and a kill was attempted, so it timed out.
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(true);
    expect(result.stdout).toContain('"ok":true');
    expect(result.termination).toBe("verified_gone");
  });

  test("natural close with a surviving ignored-stdio descendant reports not_attempted; post-close kill verifies cleanup (finding 17/20)", async () => {
    const parent = [
      'const { spawn } = require("node:child_process");',
      'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
      "child.unref();",
      "console.log(child.pid);",
    ].join("\n");
    let handle: ExecHandle | undefined;
    let descendantPid: number | undefined;

    try {
      const result = await spawnExec({
        bin: process.execPath,
        args: ["-e", parent],
        cwd: process.cwd(),
        killGraceMs: 25,
        onSpawn: (spawned) => {
          handle = spawned;
        },
      });

      descendantPid = Number(result.stdout.trim());
      expect(descendantPid).toBeGreaterThan(0);
      expect(result.exitCode).toBe(0);
      expect(result.killed).toBe(false);
      // Finding 20: the leader's natural close is NOT proof the tree is gone.
      expect(result.termination).toBe("not_attempted");
      expect(processAlive(descendantPid)).toBe(true);

      // Finding 17: the handle stays group-aware after leader exit/close and
      // still delivers verified cleanup.
      expect(await handle?.kill()).toBe(true);
      await waitForExit(descendantPid);
      descendantPid = undefined;
    } finally {
      if (descendantPid !== undefined && processAlive(descendantPid)) {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch {
          // Best-effort cleanup for a failed assertion.
        }
      }
    }
  });

  test("abort tree-kills the detached group with verified termination", async () => {
    const controller = new AbortController();
    const script = ['console.log("running");', "setInterval(() => {}, 1000);"].join("\n");
    let pgid: number | undefined;

    const result = await spawnExec({
      bin: process.execPath,
      args: ["-e", script],
      cwd: process.cwd(),
      killGraceMs: 20,
      signal: controller.signal,
      onSpawn: (spawned) => {
        pgid = spawned.pgid;
        controller.abort();
      },
    });

    expect(pgid).toBeGreaterThan(0);
    expect(result.aborted).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(result.timedOut).toBe(false);
    expect(result.killed).toBe(false);
    expect(result.termination).toBe("verified_gone");
  });

  test("an already-aborted signal rejects before anything is spawned", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled before dispatch"));

    await expect(
      spawnExec({
        bin: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
        cwd: process.cwd(),
        signal: controller.signal,
      }),
    ).rejects.toThrow("cancelled before dispatch");
  });
});

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitForExit(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) {
      return;
    }
    await Bun.sleep(10);
  }

  throw new Error(`process ${pid} remained alive after process-group kill`);
}
