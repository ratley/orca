import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { HookEvent, RunId, Task } from "../../src/types/index.js";

async function loadActualModules() {
  const nonce = Math.random();
  const [{ runCompletedTaskReview, getTaskReviewConfig }, { runTaskRunner }, { RunStore }] = await Promise.all([
    import(`../../src/core/review-cycle.ts?integration=${nonce}`),
    import(`../../src/core/task-runner.ts?integration=${nonce}`),
    import(`../../src/state/store.ts?integration=${nonce}`)
  ]);

  return { runCompletedTaskReview, getTaskReviewConfig, runTaskRunner, RunStore };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    name: "Write final marker",
    description: "Create output.txt containing exactly final-from-review.",
    dependencies: [],
    acceptance_criteria: ["output.txt contains exactly final-from-review"],
    status: "pending",
    retries: 0,
    maxRetries: 3,
    ...overrides
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

describe("per-task spec review integration", () => {
  let tempDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "orca-task-review-smoke-"));
    process.chdir(tempDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test("executes a task, lets the per-task reviewer fix drift, then marks the task done", async () => {
    const { runCompletedTaskReview, getTaskReviewConfig, runTaskRunner, RunStore } = await loadActualModules();
    const specPath = path.join(tempDir, "spec.md");
    const outputPath = path.join(tempDir, "output.txt");
    await fs.writeFile(
      specPath,
      "# Marker feature\n\nThe completed implementation must leave output.txt with exactly final-from-review.\n",
      "utf8"
    );

    const store = new RunStore(path.join(tempDir, "runs"));
    const runId = "task-review-1000-abcd" as RunId;
    await store.createRun(runId, specPath);
    await store.updateRun(runId, {
      mode: "run",
      overallStatus: "running",
      tasks: [makeTask()]
    });

    const hookEvents: HookEvent[] = [];
    const reviewPrompts: string[] = [];
    let executionContext = "";

    await runTaskRunner({
      runId,
      store,
      emitHook: async (event) => {
        hookEvents.push(event);
      },
      executeTask: async (_task, _runId, _config, systemContext) => {
        executionContext = systemContext ?? "";
        await fs.writeFile(outputPath, "draft\n", "utf8");
        return { outcome: "done", rawResponse: '{"outcome":"done"}' };
      },
      reviewCompletedTask: async ({ task, run, spec }) =>
        runCompletedTaskReview({
          task,
          run,
          spec,
          config: getTaskReviewConfig({
            review: {
              task: {
                enabled: true,
                maxCycles: 2,
                onFindings: "auto_fix"
              }
            }
          }),
          runPrompt: async (prompt) => {
            reviewPrompts.push(prompt);
            const current = await fs.readFile(outputPath, "utf8");
            if (current.trim() !== "final-from-review") {
              await fs.writeFile(outputPath, "final-from-review\n", "utf8");
              return '{"summary":"fixed output drift","findings":["output.txt did not match spec"],"fixed":true}';
            }

            return '{"summary":"task matches spec","findings":[],"fixed":false}';
          },
          emitFindings: async ({ task, reviewResult, cycleIndex }) => {
            hookEvents.push({
              runId,
              hook: "onFindings",
              message: reviewResult.summary,
              timestamp: new Date().toISOString(),
              taskId: task.id,
              taskName: task.name,
              metadata: {
                findingsCount: reviewResult.findings.length,
                cycleIndex,
                taskReview: true
              }
            });
          }
        })
    });

    const run = await store.getRun(runId);
    expect(run?.overallStatus).toBe("completed");
    expect(run?.tasks[0]?.status).toBe("done");
    expect(await fs.readFile(outputPath, "utf8")).toBe("final-from-review\n");
    expect(executionContext).toContain("## Original Spec");
    expect(executionContext).toContain("final-from-review");
    expect(reviewPrompts).toHaveLength(2);
    expect(reviewPrompts[0]).toContain("Original spec:");
    expect(reviewPrompts[0]).toContain("output.txt contains exactly final-from-review");
    expect(hookEvents.some((event) => event.hook === "onFindings" && event.taskId === "task-1")).toBe(true);
    expect(hookEvents.some((event) => event.hook === "onTaskComplete" && event.taskId === "task-1")).toBe(true);
  });

  test("keeps the run failed when per-task review cannot resolve spec drift", async () => {
    const { runCompletedTaskReview, getTaskReviewConfig, runTaskRunner, RunStore } = await loadActualModules();
    const specPath = path.join(tempDir, "spec.md");
    await fs.writeFile(specPath, "# Marker feature\n\nThe task must converge before it is done.\n", "utf8");

    const store = new RunStore(path.join(tempDir, "runs"));
    const runId = "task-review-fail-1000-abcd" as RunId;
    await store.createRun(runId, specPath);
    await store.updateRun(runId, {
      mode: "run",
      overallStatus: "running",
      tasks: [makeTask()]
    });

    const hookEvents: HookEvent[] = [];

    await runTaskRunner({
      runId,
      store,
      emitHook: async (event) => {
        hookEvents.push(event);
      },
      executeTask: async () => ({ outcome: "done", rawResponse: '{"outcome":"done"}' }),
      reviewCompletedTask: async ({ task, run, spec }) =>
        runCompletedTaskReview({
          task,
          run,
          spec,
          config: getTaskReviewConfig({
            review: {
              task: {
                maxCycles: 1,
                onFindings: "auto_fix"
              }
            }
          }),
          runPrompt: async () => '{"summary":"still drifting","findings":["missing required behavior"],"fixed":false}',
          emitFindings: async ({ task, reviewResult, cycleIndex }) => {
            hookEvents.push({
              runId,
              hook: "onFindings",
              message: reviewResult.summary,
              timestamp: new Date().toISOString(),
              taskId: task.id,
              taskName: task.name,
              metadata: {
                findingsCount: reviewResult.findings.length,
                cycleIndex,
                taskReview: true
              }
            });
          }
        })
    });

    const run = await store.getRun(runId);
    expect(run?.overallStatus).toBe("failed");
    expect(run?.tasks[0]?.status).toBe("failed");
    expect(run?.errors[0]?.message).toContain("Per-task review found unresolved findings");
    expect(hookEvents.some((event) => event.hook === "onTaskFail" && event.taskId === "task-1")).toBe(true);
  });

  test("keeps independent task execution parallel before serialized reviews unlock dependencies", async () => {
    const { runCompletedTaskReview, getTaskReviewConfig, runTaskRunner, RunStore } = await loadActualModules();
    const specPath = path.join(tempDir, "spec.md");
    await fs.writeFile(
      specPath,
      [
        "# Parallel marker feature",
        "",
        "Task A writes a.txt.",
        "Task B writes b.txt.",
        "Task C combines both markers after A and B are reviewed clean."
      ].join("\n"),
      "utf8"
    );

    const store = new RunStore(path.join(tempDir, "runs"));
    const runId = "task-review-parallel-1000-abcd" as RunId;
    await store.createRun(runId, specPath);
    await store.updateRun(runId, {
      mode: "run",
      overallStatus: "running",
      tasks: [
        makeTask({
          id: "task-a",
          name: "Write A",
          description: "Write a.txt.",
          acceptance_criteria: ["a.txt exists"]
        }),
        makeTask({
          id: "task-b",
          name: "Write B",
          description: "Write b.txt.",
          acceptance_criteria: ["b.txt exists"]
        }),
        makeTask({
          id: "task-c",
          name: "Combine markers",
          description: "Write combined.txt after A and B are done.",
          dependencies: ["task-a", "task-b"],
          acceptance_criteria: ["combined.txt includes A and B"]
        })
      ]
    });

    const firstWaveBothExecuting = deferred();
    const taskAReviewStarted = deferred();
    const releaseTaskAReview = deferred();
    const executing: string[] = [];
    const reviewing: string[] = [];
    const hookEvents: HookEvent[] = [];
    let activeReviews = 0;
    let maxActiveReviews = 0;

    const runner = runTaskRunner({
      runId,
      store,
      config: {
        codex: { multiAgent: true },
        review: { task: { enabled: true, onFindings: "fail" } }
      },
      emitHook: async (event) => {
        hookEvents.push(event);
      },
      executeTask: async (task) => {
        executing.push(task.id);

        if (task.id === "task-a" || task.id === "task-b") {
          if (executing.includes("task-a") && executing.includes("task-b")) {
            firstWaveBothExecuting.resolve();
          }
        }

        if (task.id === "task-a") {
          await fs.writeFile(path.join(tempDir, "a.txt"), "A\n", "utf8");
        } else if (task.id === "task-b") {
          await fs.writeFile(path.join(tempDir, "b.txt"), "B\n", "utf8");
        } else {
          const a = await fs.readFile(path.join(tempDir, "a.txt"), "utf8");
          const b = await fs.readFile(path.join(tempDir, "b.txt"), "utf8");
          await fs.writeFile(path.join(tempDir, "combined.txt"), `${a.trim()}${b.trim()}\n`, "utf8");
        }

        return { outcome: "done", rawResponse: '{"outcome":"done"}' };
      },
      reviewCompletedTask: async ({ task, run, spec }) => {
        reviewing.push(task.id);
        activeReviews += 1;
        maxActiveReviews = Math.max(maxActiveReviews, activeReviews);

        try {
          if (task.id === "task-a") {
            expect(executing).toContain("task-b");
            taskAReviewStarted.resolve();
            await Promise.race([
              releaseTaskAReview.promise,
              timeout(500, "task A review was not released")
            ]);
          }

          return await runCompletedTaskReview({
            task,
            run,
            spec,
            config: getTaskReviewConfig({
              review: {
                task: {
                  enabled: true,
                  maxCycles: 1,
                  onFindings: "fail"
                }
              }
            }),
            runPrompt: async () => '{"summary":"clean","findings":[],"fixed":false}'
          });
        } finally {
          activeReviews -= 1;
        }
      }
    });

    await Promise.race([
      firstWaveBothExecuting.promise,
      timeout(500, "independent tasks did not start together")
    ]);

    await Promise.race([
      taskAReviewStarted.promise,
      timeout(500, "task A review did not start after the parallel execution wave")
    ]);
    expect(reviewing).toEqual(["task-a"]);
    releaseTaskAReview.resolve();

    await runner;

    const run = await store.getRun(runId);
    expect(run?.overallStatus).toBe("completed");
    expect(executing.slice(0, 2).sort()).toEqual(["task-a", "task-b"]);
    expect(reviewing).toContain("task-a");
    expect(reviewing).toContain("task-b");
    expect(maxActiveReviews).toBe(1);
    expect(executing.at(-1)).toBe("task-c");
    expect(await fs.readFile(path.join(tempDir, "combined.txt"), "utf8")).toBe("AB\n");
    expect(hookEvents.filter((event) => event.hook === "onTaskComplete")).toHaveLength(3);
  });
});
