import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

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
