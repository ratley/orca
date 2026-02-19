import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

import type { Task } from "../types/index";
import { RunStore } from "../state/store";
import { runPlanner, setPlanSpecForTests } from "./planner";

describe("runPlanner task graph validation", () => {
  let tempDir: string;
  let specPath: string;
  let store: RunStore;
  const runId = "planner-1000-abcd";

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "orca-planner-test-"));
    specPath = path.join(tempDir, "spec.md");
    await fs.writeFile(specPath, "# test spec\n", "utf8");
    store = new RunStore(path.join(tempDir, "runs"));
    await store.createRun(runId, specPath);
  });

  afterEach(async () => {
    setPlanSpecForTests(null);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test("rejects duplicate IDs", async () => {
    const tasks: Task[] = [
      {
        id: "t1",
        name: "Task 1",
        description: "desc",
        dependencies: [],
        acceptance_criteria: ["a"],
        status: "pending",
        retries: 0,
        maxRetries: 3
      },
      {
        id: "t1",
        name: "Task 2",
        description: "desc",
        dependencies: [],
        acceptance_criteria: ["b"],
        status: "pending",
        retries: 0,
        maxRetries: 3
      }
    ];

    setPlanSpecForTests(async () => ({ tasks, rawResponse: JSON.stringify(tasks) }));

    await expect(runPlanner(specPath, store, runId)).rejects.toThrow("Duplicate task id");
  });

  test("rejects missing dependency IDs", async () => {
    const tasks: Task[] = [
      {
        id: "t1",
        name: "Task 1",
        description: "desc",
        dependencies: ["missing"],
        acceptance_criteria: ["a"],
        status: "pending",
        retries: 0,
        maxRetries: 3
      }
    ];

    setPlanSpecForTests(async () => ({ tasks, rawResponse: JSON.stringify(tasks) }));

    await expect(runPlanner(specPath, store, runId)).rejects.toThrow("missing dependency");
  });

  test("rejects cycles", async () => {
    const tasks: Task[] = [
      {
        id: "t1",
        name: "Task 1",
        description: "desc",
        dependencies: ["t2"],
        acceptance_criteria: ["a"],
        status: "pending",
        retries: 0,
        maxRetries: 3
      },
      {
        id: "t2",
        name: "Task 2",
        description: "desc",
        dependencies: ["t1"],
        acceptance_criteria: ["b"],
        status: "pending",
        retries: 0,
        maxRetries: 3
      }
    ];

    setPlanSpecForTests(async () => ({ tasks, rawResponse: JSON.stringify(tasks) }));

    await expect(runPlanner(specPath, store, runId)).rejects.toThrow("cycle");
  });
});
