import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

import { LaneStore } from "../store";

const WORKERS = 3;
const APPENDS_PER_WRITER = 12;

/** Path of the real store module; workers import it directly. */
const STORE_MODULE = path.resolve(import.meta.dir, "../store.ts");

function workerSource(): string {
  return [
    `import { LaneStore } from ${JSON.stringify(STORE_MODULE)};`,
    "",
    "const [orcaHome, laneId, countRaw] = process.argv.slice(2);",
    "if (orcaHome === undefined || laneId === undefined || countRaw === undefined) {",
    '  throw new Error("usage: append-worker <orcaHome> <laneId> <count>");',
    "}",
    "",
    "const store = new LaneStore(orcaHome);",
    "const count = Number(countRaw);",
    "for (let index = 0; index < count; index += 1) {",
    '  await store.appendEvent(laneId, { event: "progress", data: { pid: process.pid, index } });',
    "}",
    "",
  ].join("\n");
}

function runWorker(
  workerPath: string,
  args: string[],
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerPath, ...args], {
      stdio: ["ignore", "ignore", "pipe"],
    });

    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

describe("LaneStore interprocess appends", () => {
  let orcaHome: string;

  beforeEach(async () => {
    orcaHome = await fs.mkdtemp(path.join(os.tmpdir(), "orca-lane-ipc-test-"));
  });

  afterEach(async () => {
    await fs.rm(orcaHome, { recursive: true, force: true });
  });

  test("concurrent appends from real subprocesses stay gap-free and monotonic", async () => {
    const store = new LaneStore(orcaHome);
    const lane = await store.createLane({ agent: "codex", cwd: "/tmp/project" });

    const workerPath = path.join(orcaHome, "append-worker.ts");
    await fs.writeFile(workerPath, workerSource(), "utf8");

    // WORKERS bun subprocesses plus this process, all appending at once.
    const workerRuns = Array.from({ length: WORKERS }, () =>
      runWorker(workerPath, [orcaHome, lane.id, String(APPENDS_PER_WRITER)]),
    );
    const localRun = (async () => {
      for (let index = 0; index < APPENDS_PER_WRITER; index += 1) {
        await store.appendEvent(lane.id, {
          event: "progress",
          data: { pid: process.pid, index, local: true },
        });
      }
    })();

    const [results] = await Promise.all([Promise.all(workerRuns), localRun]);
    for (const result of results) {
      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
    }

    const total = 1 + (WORKERS + 1) * APPENDS_PER_WRITER; // +1 for "created"

    // File order equals seq order: unique, gap-free, monotonic across
    // processes — duplicated or skipped seqs would break this equality.
    const events = await store.readEvents(lane.id);
    expect(events.map((event) => event.seq)).toEqual(
      Array.from({ length: total }, (_, index) => index + 1),
    );

    // Every writer's events all landed.
    const writers = new Map<string, number>();
    for (const event of events.slice(1)) {
      const key = `${String(event.data.pid)}:${String(event.data.local === true)}`;
      writers.set(key, (writers.get(key) ?? 0) + 1);
    }
    expect([...writers.values()]).toEqual(
      Array.from({ length: WORKERS + 1 }, () => APPENDS_PER_WRITER),
    );

    // lane.json mirrors the final seq, and the lock is released.
    expect((await store.loadLane(lane.id))?.seq).toBe(total);
    await expect(fs.access(path.join(store.getLaneDir(lane.id), "lane.lock"))).rejects.toThrow();
  }, 60_000);
});
