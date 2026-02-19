import { describe, expect, test } from "bun:test";

import type { Task } from "../types/index";
import { shouldRetry } from "./retry-policy";

const baseTask: Task = {
  id: "t1",
  name: "Task 1",
  description: "desc",
  dependencies: [],
  acceptance_criteria: ["ok"],
  status: "pending",
  retries: 0,
  maxRetries: 3
};

describe("shouldRetry", () => {
  test("retries transient errors when attempts remain", () => {
    expect(shouldRetry(baseTask, new Error("network timeout while calling API"))).toBe(true);
    expect(shouldRetry(baseTask, new Error("rate limit reached (429)"))).toBe(true);
  });

  test("does not retry permanent validation/cancellation errors", () => {
    expect(shouldRetry(baseTask, new Error("schema validation failed"))).toBe(false);
    expect(shouldRetry(baseTask, new TypeError("invalid type"))).toBe(false);
    expect(shouldRetry(baseTask, new Error("task cancelled by user"))).toBe(false);
  });

  test("does not retry after max retries", () => {
    const exhaustedTask: Task = {
      ...baseTask,
      retries: 3,
      maxRetries: 3
    };

    expect(shouldRetry(exhaustedTask, new Error("network timeout"))).toBe(false);
  });
});
