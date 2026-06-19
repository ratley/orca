import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

import { RunStore } from "../state/store";
import type { HookEvent, Task } from "../types/index";
import { runTaskRunner, setExecuteTaskForTests } from "./task-runner";

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

describe("task-runner", () => {
  let tempDir: string;
  let store: RunStore;
  let runId: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "orca-task-runner-test-"));
    store = new RunStore(path.join(tempDir, "runs"));
    runId = "run-1000-abcd";
    await store.createRun(runId, "/tmp/spec.md");
  });

  afterEach(async () => {
    setExecuteTaskForTests(null);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test("executes runnable tasks sequentially and marks run completed", async () => {
    const tasks = [makeTask("t1"), makeTask("t2", ["t1"])];
    await store.updateRun(runId, {
      mode: "run",
      overallStatus: "running",
      tasks
    });

    const calls: string[] = [];
    const hookEvents: HookEvent[] = [];

    setExecuteTaskForTests(async (task) => {
      calls.push(task.id);
      return { outcome: "done", rawResponse: '{"outcome":"done"}' };
    });

    await runTaskRunner({
      runId,
      store,
      emitHook: async (event) => {
        hookEvents.push(event);
      }
    });

    const run = await store.getRun(runId);
    if (!run) {
      throw new Error("Run missing after task runner");
    }

    expect(calls).toEqual(["t1", "t2"]);
    expect(run.overallStatus).toBe("completed");
    expect(run.tasks.map((task) => task.status)).toEqual(["done", "done"]);
    expect(hookEvents.some((event) => event.hook === "onTaskComplete" && event.taskId === "t1")).toBe(true);
    expect(hookEvents.some((event) => event.hook === "onTaskComplete" && event.taskId === "t2")).toBe(true);
    expect(hookEvents.some((event) => event.hook === "onMilestone" && event.message === "execution-started")).toBe(true);
    expect(hookEvents.some((event) => event.hook === "onMilestone" && event.message === "execution-completed")).toBe(true);
    expect(hookEvents.some((event) => event.hook === "onComplete" && event.message === "run-completed")).toBe(true);
  });

  test("runs independent tasks concurrently when multi-agent parallelism is enabled", async () => {
    const tasks = [makeTask("t1"), makeTask("t2"), makeTask("t3", ["t1", "t2"])];
    await store.updateRun(runId, {
      mode: "run",
      overallStatus: "running",
      tasks
    });

    const calls: string[] = [];
    let activeTasks = 0;
    let maxActiveTasks = 0;

    setExecuteTaskForTests(async (task) => {
      calls.push(task.id);
      activeTasks += 1;
      maxActiveTasks = Math.max(maxActiveTasks, activeTasks);
      await sleep(10);
      activeTasks -= 1;
      return { outcome: "done", rawResponse: '{"outcome":"done"}' };
    });

    await runTaskRunner({
      runId,
      store,
      config: { codex: { multiAgent: true, maxParallelTasks: 2 } },
      emitHook: async () => {}
    });

    const run = await store.getRun(runId);
    expect(run?.overallStatus).toBe("completed");
    expect(maxActiveTasks).toBe(2);
    expect(calls.slice(0, 2).sort()).toEqual(["t1", "t2"]);
    expect(calls[2]).toBe("t3");
  });

  test("honors maxParallelTasks of 1 in multi-agent mode", async () => {
    const tasks = [makeTask("t1"), makeTask("t2")];
    await store.updateRun(runId, {
      mode: "run",
      overallStatus: "running",
      tasks
    });

    let activeTasks = 0;
    let maxActiveTasks = 0;

    setExecuteTaskForTests(async () => {
      activeTasks += 1;
      maxActiveTasks = Math.max(maxActiveTasks, activeTasks);
      await sleep(10);
      activeTasks -= 1;
      return { outcome: "done", rawResponse: '{"outcome":"done"}' };
    });

    await runTaskRunner({
      runId,
      store,
      config: { codex: { multiAgent: true, maxParallelTasks: 1 } },
      emitHook: async () => {}
    });

    expect(maxActiveTasks).toBe(1);
  });

  test("passes original spec and task graph into execution context", async () => {
    const specPath = path.join(tempDir, "spec.md");
    await fs.writeFile(specPath, "# Build the thing\n\nKeep the blue button.\n", "utf8");
    await store.createRun("context-run-1000-abcd", specPath);
    await store.updateRun("context-run-1000-abcd", {
      mode: "run",
      overallStatus: "running",
      tasks: [makeTask("t1")]
    });

    let receivedContext = "";

    setExecuteTaskForTests(async (_task, _runId, _config, systemContext) => {
      receivedContext = systemContext ?? "";
      return { outcome: "done", rawResponse: '{"outcome":"done"}' };
    });

    await runTaskRunner({
      runId: "context-run-1000-abcd",
      store,
      emitHook: async () => {}
    });

    expect(receivedContext).toContain("## Original Spec");
    expect(receivedContext).toContain("Keep the blue button.");
    expect(receivedContext).toContain("## Current Task Graph");
    expect(receivedContext).toContain('"id": "t1"');
  });

  test("passes configured flow context into execution context", async () => {
    const tasks = [makeTask("t1")];
    await store.updateRun(runId, {
      mode: "run",
      flowName: "custom-review",
      overallStatus: "running",
      tasks
    });

    let receivedContext = "";
    setExecuteTaskForTests(async (_task, _runId, _config, systemContext) => {
      receivedContext = systemContext ?? "";
      return { outcome: "done", rawResponse: '{"outcome":"done"}' };
    });

    await runTaskRunner({
      runId,
      store,
      systemContextSections: ["## Orca Flow\n\nSelected flow: custom-review"],
      emitHook: async () => {}
    });

    expect(receivedContext).toContain("## Orca Flow");
    expect(receivedContext).toContain("Selected flow: custom-review");
  });

  test("runs completed-task review before marking task done", async () => {
    const tasks = [makeTask("t1")];
    await store.updateRun(runId, {
      mode: "run",
      overallStatus: "running",
      tasks
    });

    const events: string[] = [];

    setExecuteTaskForTests(async () => {
      events.push("execute");
      return { outcome: "done", rawResponse: '{"outcome":"done"}' };
    });

    await runTaskRunner({
      runId,
      store,
      emitHook: async (event) => {
        if (event.hook === "onTaskComplete") {
          events.push("complete-hook");
        }
      },
      reviewCompletedTask: async ({ task, run }) => {
        events.push(`review:${task.id}:${run.tasks[0]?.status ?? "missing"}`);
        return { outcome: "accepted", summary: "clean" };
      }
    });

    const run = await store.getRun(runId);
    expect(run?.tasks[0]?.status).toBe("done");
    expect(events).toEqual(["execute", "review:t1:in_progress", "complete-hook"]);
  });

  test("runs independent runnable tasks in parallel when multi-agent mode is enabled", async () => {
    const tasks = [makeTask("t1"), makeTask("t2"), makeTask("t3", ["t1", "t2"])];
    await store.updateRun(runId, {
      mode: "run",
      overallStatus: "running",
      tasks
    });

    const firstWaveBothStarted = deferred();
    const releaseFirstWave = deferred();
    const started: string[] = [];
    const completed: string[] = [];

    setExecuteTaskForTests(async (task) => {
      started.push(task.id);

      if (task.id === "t1" || task.id === "t2") {
        if (started.includes("t1") && started.includes("t2")) {
          firstWaveBothStarted.resolve();
        }

        await Promise.race([
          releaseFirstWave.promise,
          timeout(500, "parallel task wave did not start both independent tasks")
        ]);
      }

      completed.push(task.id);
      return { outcome: "done", rawResponse: '{"outcome":"done"}' };
    });

    const runner = runTaskRunner({
      runId,
      store,
      config: { codex: { multiAgent: true } },
      emitHook: async () => {}
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
    expect(completed.slice(0, 2).sort()).toEqual(["t1", "t2"]);
    expect(started.at(-1)).toBe("t3");
  });

  test("serializes completed-task reviews after a parallel execution wave", async () => {
    const tasks = [makeTask("t1"), makeTask("t2"), makeTask("t3", ["t1", "t2"])];
    await store.updateRun(runId, {
      mode: "run",
      overallStatus: "running",
      tasks
    });

    const firstWaveBothStarted = deferred();
    const releaseFirstWave = deferred();
    const started: string[] = [];
    const completed: string[] = [];
    const reviewed: string[] = [];
    let activeTasks = 0;
    let maxActiveTasks = 0;
    let activeReviews = 0;
    let maxActiveReviews = 0;

    setExecuteTaskForTests(async (task) => {
      started.push(task.id);
      activeTasks += 1;
      maxActiveTasks = Math.max(maxActiveTasks, activeTasks);

      try {
        if (task.id === "t1" || task.id === "t2") {
          if (started.includes("t1") && started.includes("t2")) {
            firstWaveBothStarted.resolve();
          }

          await Promise.race([
            releaseFirstWave.promise,
            timeout(500, "parallel task wave did not start both independent tasks")
          ]);
        }

        completed.push(task.id);
        return { outcome: "done", rawResponse: '{"outcome":"done"}' };
      } finally {
        activeTasks -= 1;
      }
    });

    const runner = runTaskRunner({
      runId,
      store,
      config: {
        codex: { multiAgent: true, maxParallelTasks: 2 },
        review: { task: { onFindings: "fail" } }
      },
      emitHook: async () => {},
      reviewCompletedTask: async ({ task }) => {
        if (task.id === "t1" || task.id === "t2") {
          expect(completed.slice(0, 2).sort()).toEqual(["t1", "t2"]);
        } else {
          expect(reviewed.slice(0, 2).sort()).toEqual(["t1", "t2"]);
        }

        activeReviews += 1;
        maxActiveReviews = Math.max(maxActiveReviews, activeReviews);
        await sleep(10);
        reviewed.push(task.id);
        activeReviews -= 1;

        return { outcome: "accepted", summary: "clean" };
      }
    });

    await Promise.race([
      firstWaveBothStarted.promise,
      timeout(500, "multi-agent runner did not start independent tasks concurrently")
    ]);

    releaseFirstWave.resolve();
    await runner;

    const run = await store.getRun(runId);
    expect(run?.overallStatus).toBe("completed");
    expect(maxActiveTasks).toBe(2);
    expect(maxActiveReviews).toBe(1);
    expect(reviewed.slice(0, 2)).toEqual(["t1", "t2"]);
    expect(started.at(-1)).toBe("t3");
  });

  test("serializes task execution when per-task auto-fix review is enabled", async () => {
    const tasks = [makeTask("t1"), makeTask("t2")];
    await store.updateRun(runId, {
      mode: "run",
      overallStatus: "running",
      tasks
    });

    let activeTasks = 0;
    let maxActiveTasks = 0;

    setExecuteTaskForTests(async () => {
      activeTasks += 1;
      maxActiveTasks = Math.max(maxActiveTasks, activeTasks);
      await sleep(10);
      activeTasks -= 1;
      return { outcome: "done", rawResponse: '{"outcome":"done"}' };
    });

    await runTaskRunner({
      runId,
      store,
      config: {
        codex: { multiAgent: true, maxParallelTasks: 2 },
        review: { task: { enabled: true, onFindings: "auto_fix" } }
      },
      emitHook: async () => {},
      reviewCompletedTask: async () => ({ outcome: "accepted", summary: "clean" })
    });

    const run = await store.getRun(runId);
    expect(run?.overallStatus).toBe("completed");
    expect(maxActiveTasks).toBe(1);
  });

  test("does not retry per-task review failures even when they look transient", async () => {
    const tasks = [makeTask("t1")];
    await store.updateRun(runId, {
      mode: "run",
      overallStatus: "running",
      tasks
    });

    let executions = 0;
    let reviews = 0;

    setExecuteTaskForTests(async () => {
      executions += 1;
      return { outcome: "done", rawResponse: '{"outcome":"done"}' };
    });

    await runTaskRunner({
      runId,
      store,
      emitHook: async () => {},
      reviewCompletedTask: async () => {
        reviews += 1;
        return {
          outcome: "failed",
          summary: "review timed out",
          error: "per-task review timeout"
        };
      }
    });

    const run = await store.getRun(runId);
    expect(run?.overallStatus).toBe("failed");
    expect(run?.tasks[0]?.status).toBe("failed");
    expect(run?.tasks[0]?.retries).toBe(0);
    expect(run?.milestones).not.toContain("retry:t1:1");
    expect(executions).toBe(1);
    expect(reviews).toBe(1);
  });

  test("retries transient task failure and then succeeds", async () => {
    const tasks = [makeTask("t1")];
    await store.updateRun(runId, {
      mode: "run",
      overallStatus: "running",
      tasks
    });

    let attempts = 0;

    setExecuteTaskForTests(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("network timeout");
      }

      return { outcome: "done", rawResponse: '{"outcome":"done"}' };
    });

    await runTaskRunner({ runId, store, emitHook: async () => {} });

    const run = await store.getRun(runId);
    if (!run) {
      throw new Error("Run missing after retry");
    }

    expect(attempts).toBe(2);
    expect(run.overallStatus).toBe("completed");
    expect(run.tasks[0]?.status).toBe("done");
    expect(run.tasks[0]?.retries).toBe(1);
  });

  test("retries one failed parallel task without losing completed sibling state", async () => {
    const tasks = [makeTask("t1"), makeTask("t2")];
    await store.updateRun(runId, {
      mode: "run",
      overallStatus: "running",
      tasks
    });

    const attempts = new Map<string, number>();

    setExecuteTaskForTests(async (task) => {
      const nextAttempt = (attempts.get(task.id) ?? 0) + 1;
      attempts.set(task.id, nextAttempt);
      await sleep(5);

      if (task.id === "t1" && nextAttempt === 1) {
        throw new Error("network timeout");
      }

      return { outcome: "done", rawResponse: '{"outcome":"done"}' };
    });

    await runTaskRunner({
      runId,
      store,
      config: { codex: { multiAgent: true, maxParallelTasks: 2 } },
      emitHook: async () => {}
    });

    const run = await store.getRun(runId);
    expect(run?.overallStatus).toBe("completed");
    expect(run?.tasks.find((task) => task.id === "t1")?.retries).toBe(1);
    expect(run?.tasks.map((task) => task.status)).toEqual(["done", "done"]);
    expect(attempts.get("t1")).toBe(2);
    expect(attempts.get("t2")).toBe(1);
  });

  test("stops after a mixed parallel wave fails even when a sibling is retryable", async () => {
    const tasks = [makeTask("t1"), makeTask("t2")];
    await store.updateRun(runId, {
      mode: "run",
      overallStatus: "running",
      tasks
    });

    const attempts = new Map<string, number>();

    setExecuteTaskForTests(async (task) => {
      const nextAttempt = (attempts.get(task.id) ?? 0) + 1;
      attempts.set(task.id, nextAttempt);
      await sleep(5);

      if (task.id === "t1") {
        throw new Error("network timeout");
      }

      throw new Error("schema validation failed");
    });

    await runTaskRunner({
      runId,
      store,
      config: { codex: { multiAgent: true, maxParallelTasks: 2 } },
      emitHook: async () => {}
    });

    const run = await store.getRun(runId);
    expect(run?.overallStatus).toBe("failed");
    expect(run?.tasks.find((task) => task.id === "t1")?.status).toBe("failed");
    expect(run?.tasks.find((task) => task.id === "t1")?.retries).toBe(0);
    expect(run?.tasks.find((task) => task.id === "t1")?.lastError).toContain("Retry suppressed");
    expect(run?.tasks.find((task) => task.id === "t2")?.status).toBe("failed");
    expect(run?.milestones).not.toContain("retry:t1:1");
    expect(attempts.get("t1")).toBe(1);
    expect(attempts.get("t2")).toBe(1);
  });

  test("preserves errors appended while a task wave is executing", async () => {
    const tasks = [makeTask("t1")];
    await store.updateRun(runId, {
      mode: "run",
      overallStatus: "running",
      tasks
    });

    setExecuteTaskForTests(async () => {
      const current = await store.getRun(runId);
      if (!current) {
        throw new Error("Run missing during test");
      }

      await store.updateRun(runId, {
        errors: [
          ...current.errors,
          {
            at: new Date().toISOString(),
            message: "invalid-answer: answer payload is empty",
            taskId: "t1"
          }
        ]
      });

      return { outcome: "done", rawResponse: '{"outcome":"done"}' };
    });

    await runTaskRunner({ runId, store, emitHook: async () => {} });

    const run = await store.getRun(runId);
    expect(run?.overallStatus).toBe("completed");
    expect(run?.tasks[0]?.status).toBe("done");
    expect(run?.errors.map((error) => error.message)).toContain("invalid-answer: answer payload is empty");
  });

  test("does not overwrite cancellation that happens while a task wave is executing", async () => {
    const tasks = [makeTask("t1")];
    await store.updateRun(runId, {
      mode: "run",
      overallStatus: "running",
      tasks
    });

    setExecuteTaskForTests(async () => {
      const current = await store.getRun(runId);
      if (!current) {
        throw new Error("Run missing during test");
      }

      await store.updateRun(runId, {
        overallStatus: "cancelled",
        tasks: current.tasks.map((task) => ({
          ...task,
          status: "cancelled" as const,
          lastError: "Run cancelled"
        }))
      });

      return { outcome: "done", rawResponse: '{"outcome":"done"}' };
    });

    await runTaskRunner({ runId, store, emitHook: async () => {} });

    const run = await store.getRun(runId);
    expect(run?.overallStatus).toBe("cancelled");
    expect(run?.tasks[0]?.status).toBe("cancelled");
    expect(run?.tasks[0]?.lastError).toBe("Run cancelled");
  });

  test("does not overwrite cancellation before marking a wave in progress", async () => {
    class CancellingBeforeStartStore extends RunStore {
      private cancelled = false;

      override async updateRunIfActive(testRunId: string, patch: Parameters<RunStore["updateRun"]>[1]) {
        const hasInProgressTask = Array.isArray(patch.tasks)
          && patch.tasks.some((task) => task.status === "in_progress");

        if (!this.cancelled && patch.overallStatus === "running" && hasInProgressTask) {
          this.cancelled = true;
          const current = await super.getRun(testRunId);
          if (!current) {
            throw new Error("Run missing during test");
          }

          await super.updateRun(testRunId, {
            overallStatus: "cancelled",
            tasks: current.tasks.map((task) => ({
              ...task,
              status: "cancelled" as const,
              lastError: "Run cancelled before task start"
            }))
          });
        }

        return super.updateRunIfActive(testRunId, patch);
      }
    }

    const raceStore = new CancellingBeforeStartStore(path.join(tempDir, "race-runs"));
    const raceRunId = "race-1000-abcd";
    await raceStore.createRun(raceRunId, "/tmp/spec.md");
    await raceStore.updateRun(raceRunId, {
      mode: "run",
      overallStatus: "running",
      tasks: [makeTask("t1")]
    });

    let executions = 0;
    setExecuteTaskForTests(async () => {
      executions += 1;
      return { outcome: "done", rawResponse: '{"outcome":"done"}' };
    });

    await runTaskRunner({ runId: raceRunId, store: raceStore, emitHook: async () => {} });

    const run = await raceStore.getRun(raceRunId);
    expect(executions).toBe(0);
    expect(run?.overallStatus).toBe("cancelled");
    expect(run?.tasks[0]?.status).toBe("cancelled");
    expect(run?.tasks[0]?.lastError).toBe("Run cancelled before task start");
  });

  test("fails fast on permanent error", async () => {
    const tasks = [makeTask("t1")];
    await store.updateRun(runId, {
      mode: "run",
      overallStatus: "running",
      tasks
    });

    const hookEvents: HookEvent[] = [];

    setExecuteTaskForTests(async () => {
      throw new Error("schema validation failed");
    });

    await runTaskRunner({
      runId,
      store,
      emitHook: async (event) => {
        hookEvents.push(event);
      }
    });

    const run = await store.getRun(runId);
    if (!run) {
      throw new Error("Run missing after failure");
    }

    expect(run.overallStatus).toBe("failed");
    expect(run.tasks[0]?.status).toBe("failed");
    expect(run.tasks[0]?.retries).toBe(0);
    expect(hookEvents.some((event) => event.hook === "onTaskFail" && event.taskId === "t1")).toBe(true);
    expect(hookEvents.some((event) => event.hook === "onError" && event.message.startsWith("run-failed:"))).toBe(true);
  });

  test("persists failed overallStatus when runner throws from outer path", async () => {
    const cyclicTask = makeTask("t1", ["t1"]);
    await store.updateRun(runId, {
      mode: "run",
      overallStatus: "running",
      tasks: [cyclicTask]
    });

    const hookEvents: HookEvent[] = [];

    setExecuteTaskForTests(async () => ({
      outcome: "done",
      rawResponse: '{"outcome":"done"}'
    }));

    await expect(
      runTaskRunner({
        runId,
        store,
        emitHook: async (event) => {
          hookEvents.push(event);
        }
      })
    ).rejects.toThrow("Task graph has cycle");

    const run = await store.getRun(runId);
    if (!run) {
      throw new Error("Run missing after outer failure");
    }

    expect(run.overallStatus).toBe("failed");
    expect(hookEvents.some((event) => event.hook === "onError")).toBe(true);
  });

  test("writes session summary markdown when config.sessionLogs is set", async () => {
    const tasks = [makeTask("t1")];
    const sessionLogsDir = path.join(tempDir, "session-logs");
    await store.updateRun(runId, {
      mode: "run",
      overallStatus: "running",
      tasks
    });

    setExecuteTaskForTests(async () => ({
      outcome: "done",
      rawResponse: '{"outcome":"done"}'
    }));

    await runTaskRunner({
      runId,
      store,
      config: { sessionLogs: sessionLogsDir },
      emitHook: async () => {}
    });

    const summaryPath = path.join(sessionLogsDir, `${runId}.md`);
    const summary = await fs.readFile(summaryPath, "utf8");

    expect(summary).toContain(`# Run ${runId}`);
    expect(summary).toContain("- Spec Path: `/tmp/spec.md`");
    expect(summary).toContain("- Status: `completed`");
    expect(summary).toContain("| t1 | t1 | done |");
  });

  test("does not fail run when session summary write fails", async () => {
    const tasks = [makeTask("t1")];
    const sessionLogsPath = path.join(tempDir, "session-logs-file");
    await fs.writeFile(sessionLogsPath, "not-a-directory\n", "utf8");
    await store.updateRun(runId, {
      mode: "run",
      overallStatus: "running",
      tasks
    });

    setExecuteTaskForTests(async () => ({
      outcome: "done",
      rawResponse: '{"outcome":"done"}'
    }));

    await runTaskRunner({
      runId,
      store,
      config: { sessionLogs: sessionLogsPath },
      emitHook: async () => {}
    });

    const run = await store.getRun(runId);
    expect(run?.overallStatus).toBe("completed");
    expect(run?.tasks[0]?.status).toBe("done");
  });
});
