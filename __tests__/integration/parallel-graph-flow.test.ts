import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { RunId, Task } from "../../src/types/index.js";

async function loadActualModules() {
  const nonce = Math.random();
  const [{ runTaskRunner }, { RunStore }] = await Promise.all([
    import(`../../src/core/task-runner.ts?integration=${nonce}`),
    import(`../../src/state/store.ts?integration=${nonce}`)
  ]);

  return { runTaskRunner, RunStore };
}

function makeTask(id: string, dependencies: string[] = []): Task {
  return {
    id,
    name: id,
    description: `${id} description`,
    dependencies,
    acceptance_criteria: ["ok"],
    status: "pending",
    retries: 0,
    maxRetries: 3
  };
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return { promise, resolve, reject };
}

function timeout(ms: number, message: string): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(message)), ms);
  });
}

describe("parallel task graph integration", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "orca-parallel-graph-smoke-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test("executes independent runnable tasks in parallel and serializes their reviews", async () => {
    const { runTaskRunner, RunStore } = await loadActualModules();
    const specPath = path.join(tempDir, "spec.md");
    await fs.writeFile(specPath, "# Parallel graph\n\nRun t1 and t2 before t3.\n", "utf8");

    const store = new RunStore(path.join(tempDir, "runs"));
    const runId = "parallel-graph-1000-abcd" as RunId;
    await store.createRun(runId, specPath);
    await store.updateRun(runId, {
      mode: "run",
      overallStatus: "running",
      tasks: [makeTask("t1"), makeTask("t2"), makeTask("t3", ["t1", "t2"])]
    });

    const firstWaveBothStarted = deferred();
    const releaseFirstWave = deferred();
    const started: string[] = [];
    const completed: string[] = [];
    const reviewed: string[] = [];
    let activeReviews = 0;
    let maxActiveReviews = 0;

    const runner = runTaskRunner({
      runId,
      store,
      config: {
        codex: { multiAgent: true },
        review: { task: { onFindings: "fail" } }
      },
      emitHook: async () => {},
      executeTask: async (task) => {
        started.push(task.id);

        if (task.id === "t1" || task.id === "t2") {
          if (started.includes("t1") && started.includes("t2")) {
            firstWaveBothStarted.resolve();
          }

          await Promise.race([
            releaseFirstWave.promise,
            timeout(500, "parallel task wave did not release")
          ]);
        }

        completed.push(task.id);
        return { outcome: "done", rawResponse: '{"outcome":"done"}' };
      },
      reviewCompletedTask: async ({ task }) => {
        activeReviews += 1;
        maxActiveReviews = Math.max(maxActiveReviews, activeReviews);
        await new Promise((resolve) => setTimeout(resolve, 5));
        reviewed.push(task.id);
        activeReviews -= 1;
        return { outcome: "accepted", summary: "clean" };
      }
    });

    await Promise.race([
      firstWaveBothStarted.promise,
      timeout(500, "multi-agent runner did not start independent tasks concurrently")
    ]);
    expect(started.slice(0, 2).sort()).toEqual(["t1", "t2"]);
    expect(started).not.toContain("t3");

    releaseFirstWave.resolve();
    await runner;

    const run = await store.getRun(runId);
    expect(run?.overallStatus).toBe("completed");
    expect(run?.tasks.map((task) => task.status)).toEqual(["done", "done", "done"]);
    expect(completed.slice(0, 2).sort()).toEqual(["t1", "t2"]);
    expect(started.at(-1)).toBe("t3");
    expect(maxActiveReviews).toBe(1);
    expect(reviewed).toEqual(["t1", "t2", "t3"]);
  });
});
