import { describe, expect, it } from "bun:test";

import { parseTaskArray, parseTaskExecution } from "./session.js";

// ---------------------------------------------------------------------------
// parseTaskArray
// ---------------------------------------------------------------------------

describe("parseTaskArray", () => {
  it("coerces numeric IDs to strings", () => {
    const raw = JSON.stringify([
      { id: 1, name: "Task A", description: "Do A", dependencies: [], acceptance_criteria: ["A done"], status: "pending", retries: 0, maxRetries: 3 },
    ]);
    const tasks = parseTaskArray(raw);
    expect(tasks[0]?.id).toBe("1");
  });

  it("defaults missing dependencies to []", () => {
    const raw = JSON.stringify([
      { id: "1", name: "Task A", description: "Do A", acceptance_criteria: ["A done"], status: "pending", retries: 0, maxRetries: 3 },
    ]);
    const tasks = parseTaskArray(raw);
    expect(tasks[0]?.dependencies).toEqual([]);
  });

  it("coerces numeric dependency refs to strings", () => {
    const raw = JSON.stringify([
      { id: "2", name: "Task B", description: "Do B", dependencies: [1], acceptance_criteria: [], status: "pending", retries: 0, maxRetries: 3 },
    ]);
    const tasks = parseTaskArray(raw);
    expect(tasks[0]?.dependencies).toEqual(["1"]);
  });

  it("defaults missing name to 'Unnamed task'", () => {
    const raw = JSON.stringify([
      { id: "1", description: "Do A", acceptance_criteria: [], status: "pending", retries: 0, maxRetries: 3 },
    ]);
    const tasks = parseTaskArray(raw);
    expect(tasks[0]?.name).toBe("Unnamed task");
  });

  it("defaults missing description to empty string", () => {
    const raw = JSON.stringify([
      { id: "1", name: "Task A", acceptance_criteria: [], status: "pending", retries: 0, maxRetries: 3 },
    ]);
    const tasks = parseTaskArray(raw);
    expect(tasks[0]?.description).toBe("");
  });

  it("defaults missing acceptance_criteria to []", () => {
    const raw = JSON.stringify([
      { id: "1", name: "Task A", description: "Do A", status: "pending", retries: 0, maxRetries: 3 },
    ]);
    const tasks = parseTaskArray(raw);
    expect(tasks[0]?.acceptance_criteria).toEqual([]);
  });

  it("defaults missing status to 'pending'", () => {
    const raw = JSON.stringify([
      { id: "1", name: "Task A", description: "Do A", acceptance_criteria: [] },
    ]);
    const tasks = parseTaskArray(raw);
    expect(tasks[0]?.status).toBe("pending");
  });

  it("defaults missing retries to 0", () => {
    const raw = JSON.stringify([
      { id: "1", name: "Task A", description: "Do A", acceptance_criteria: [] },
    ]);
    const tasks = parseTaskArray(raw);
    expect(tasks[0]?.retries).toBe(0);
  });

  it("defaults missing maxRetries to 3", () => {
    const raw = JSON.stringify([
      { id: "1", name: "Task A", description: "Do A", acceptance_criteria: [] },
    ]);
    const tasks = parseTaskArray(raw);
    expect(tasks[0]?.maxRetries).toBe(3);
  });

  it("throws when input is not an array", () => {
    const raw = JSON.stringify({ id: "1", name: "Task A" });
    expect(() => parseTaskArray(raw)).toThrow("Claude plan response was not a JSON array");
  });

  it("throws on invalid JSON", () => {
    expect(() => parseTaskArray("not-json")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// parseTaskExecution
// ---------------------------------------------------------------------------

describe("parseTaskExecution", () => {
  it("parses a valid done outcome", () => {
    const raw = JSON.stringify({ outcome: "done" });
    const result = parseTaskExecution(raw);
    expect(result.outcome).toBe("done");
    expect(result.rawResponse).toBe(raw);
    expect(result.error).toBeUndefined();
  });

  it("parses a valid failed outcome with error string", () => {
    const raw = JSON.stringify({ outcome: "failed", error: "something broke" });
    const result = parseTaskExecution(raw);
    expect(result.outcome).toBe("failed");
    expect(result.error).toBe("something broke");
    expect(result.rawResponse).toBe(raw);
  });

  it("parses a valid failed outcome without error field", () => {
    const raw = JSON.stringify({ outcome: "failed" });
    const result = parseTaskExecution(raw);
    expect(result.outcome).toBe("failed");
    expect(result.error).toBeUndefined();
  });

  it("throws when outcome is invalid", () => {
    const raw = JSON.stringify({ outcome: "skipped" });
    expect(() => parseTaskExecution(raw)).toThrow("Claude task response missing valid outcome");
  });

  it("throws when outcome is missing", () => {
    const raw = JSON.stringify({ error: "oops" });
    expect(() => parseTaskExecution(raw)).toThrow("Claude task response missing valid outcome");
  });

  it("throws when input is not a JSON object", () => {
    const raw = JSON.stringify([{ outcome: "done" }]);
    expect(() => parseTaskExecution(raw)).toThrow("Claude task response was not a JSON object");
  });

  it("throws on invalid JSON", () => {
    expect(() => parseTaskExecution("not-json")).toThrow();
  });

  it("throws when error field is not a string", () => {
    const raw = JSON.stringify({ outcome: "failed", error: 42 });
    expect(() => parseTaskExecution(raw)).toThrow("Claude task response error must be a string");
  });
});
