import { describe, expect, test } from "bun:test";

import type { Task } from "../types/index";
import { getRunnable, validateDAG } from "./dependency-graph";

function makeTask(id: string, dependencies: string[] = []): Task {
  return {
    id,
    name: id,
    description: `${id} description`,
    dependencies,
    acceptance_criteria: ["ok"],
    status: "pending",
    retries: 0,
    maxRetries: 3,
  };
}

describe("dependency-graph", () => {
  test("getRunnable returns pending tasks whose deps are done", () => {
    const tasks: Task[] = [
      { ...makeTask("t1"), status: "done" },
      { ...makeTask("t2", ["t1"]), status: "pending" },
      { ...makeTask("t3", ["t2"]), status: "pending" },
      { ...makeTask("t4"), status: "in_progress" },
    ];

    const runnable = getRunnable(tasks);

    expect(runnable.map((task) => task.id)).toEqual(["t2"]);
  });

  test("validateDAG rejects duplicate IDs", () => {
    const tasks: Task[] = [makeTask("t1"), makeTask("t1")];

    expect(() => validateDAG(tasks)).toThrow("Duplicate task id");
  });

  test("validateDAG rejects missing dependencies", () => {
    const tasks: Task[] = [makeTask("t1", ["missing"])];

    expect(() => validateDAG(tasks)).toThrow("missing dependency");
  });

  test("validateDAG rejects cycles", () => {
    const tasks: Task[] = [makeTask("t1", ["t2"]), makeTask("t2", ["t1"])];

    expect(() => validateDAG(tasks)).toThrow("cycle");
  });
});
