import { describe, expect, mock, test } from "bun:test";

import type { RunStatus, Task } from "../types/index";
import {
  buildPostExecutionReviewPrompt,
  buildTaskReviewPrompt,
  getExecutionReviewConfig,
  getTaskReviewConfig,
  requestStructuredExecutionReview,
  runCompletedTaskReview
} from "./review-cycle";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    name: "Write marker",
    description: "Write marker.txt.",
    dependencies: [],
    acceptance_criteria: ["marker.txt exists"],
    status: "in_progress",
    retries: 0,
    maxRetries: 3,
    ...overrides
  };
}

function makeRun(task: Task = makeTask()): RunStatus {
  return {
    schemaVersion: 1,
    runId: "run-1000-abcd",
    specPath: "/tmp/spec.md",
    mode: "run",
    overallStatus: "running",
    createdAt: "2026-05-15T00:00:00.000Z",
    updatedAt: "2026-05-15T00:00:00.000Z",
    tasks: [task],
    milestones: [],
    errors: []
  };
}

describe("review-cycle", () => {
  test("resolves execution review defaults, legacy disable, and validator skip env", () => {
    expect(getExecutionReviewConfig()).toEqual({
      enabled: true,
      maxCycles: 2,
      onFindings: "auto_fix",
      validatorAuto: true
    });

    expect(getExecutionReviewConfig({ review: { enabled: false } })).toMatchObject({
      enabled: false,
      maxCycles: 2,
      onFindings: "auto_fix"
    });

    expect(getExecutionReviewConfig(undefined, { ORCA_SKIP_VALIDATORS: "1" })).toMatchObject({
      validatorAuto: false
    });
  });

  test("resolves task review config from task-specific settings over legacy review settings", () => {
    expect(
      getTaskReviewConfig({
        review: {
          enabled: false,
          task: {
            enabled: true,
            maxCycles: 4,
            onFindings: "fail",
            prompt: "stay within this task"
          }
        }
      })
    ).toEqual({
      enabled: true,
      maxCycles: 4,
      onFindings: "fail",
      prompt: "stay within this task"
    });
  });

  test("builds a per-task review prompt with spec, graph, criteria, and extra instructions", () => {
    const prompt = buildTaskReviewPrompt(
      2,
      makeTask({ acceptance_criteria: ["marker.txt exists", "no unrelated files change"] }),
      "# Original spec\n\nWrite the marker.",
      JSON.stringify([makeTask()], null, 2),
      "Prefer the smallest fix."
    );

    expect(prompt).toContain("You are Orca's per-task spec reviewer.");
    expect(prompt).toContain("Cycle: 2");
    expect(prompt).toContain("Task ID: task-1");
    expect(prompt).toContain("1. marker.txt exists");
    expect(prompt).toContain("2. no unrelated files change");
    expect(prompt).toContain("# Original spec");
    expect(prompt).toContain('"id": "task-1"');
    expect(prompt).toContain("Prefer the smallest fix.");
  });

  test("builds read-only review prompts for report-only mode", () => {
    const taskPrompt = buildTaskReviewPrompt(
      1,
      makeTask(),
      "# Original spec",
      JSON.stringify([makeTask()], null, 2),
      undefined,
      "report_only"
    );
    const postExecutionPrompt = buildPostExecutionReviewPrompt(1, [], undefined, "report_only");

    expect(taskPrompt).toContain("Do not edit files or run mutating commands during this review. Report findings only.");
    expect(taskPrompt).toContain("Set fixed=false because this review mode is read-only.");
    expect(taskPrompt).not.toContain("apply fixes directly");
    expect(postExecutionPrompt).toContain("Do not edit files or run mutating commands during this review. Report findings only.");
    expect(postExecutionPrompt).not.toContain("apply fixes directly");
  });

  test("parses fenced structured review JSON without a retry", async () => {
    const runPrompt = mock(async () => '```json\n{"summary":"clean","findings":[],"fixed":false}\n```');

    const result = await requestStructuredExecutionReview(runPrompt, 1, "base prompt");

    expect(result).toMatchObject({
      summary: "clean",
      findings: [],
      fixed: false
    });
    expect(runPrompt).toHaveBeenCalledTimes(1);
  });

  test("retries once with a repair prompt after invalid structured review JSON", async () => {
    const runPrompt = mock(async (prompt: string) => {
      if (prompt === "base prompt") {
        return "not json";
      }

      expect(prompt).toContain("previous post-execution review response was invalid");
      expect(prompt).toContain("JSON parse failed");
      return '{"summary":"clean after retry","findings":[],"fixed":false}';
    });

    const result = await requestStructuredExecutionReview(runPrompt, 1, "base prompt", "extra guardrail");

    expect(result.summary).toBe("clean after retry");
    expect(result.findings).toEqual([]);
    expect(runPrompt).toHaveBeenCalledTimes(2);
  });

  test("keeps report-only repair prompts read-only after invalid JSON", async () => {
    const prompts: string[] = [];
    const runPrompt = mock(async (prompt: string) => {
      prompts.push(prompt);
      if (prompts.length === 1) {
        return "not json";
      }

      return '{"summary":"reported","findings":["lint"],"fixed":false}';
    });

    await requestStructuredExecutionReview(runPrompt, 1, "base prompt", undefined, "report_only");

    expect(prompts[1]).toContain("Do not edit files or run mutating commands during this review. Report findings only.");
    expect(prompts[1]).toContain("Set fixed=false because this review mode is read-only.");
    expect(prompts[1]).not.toContain("changed files during this review cycle");
  });

  test("returns parse-error findings after bounded structured review retries", async () => {
    const runPrompt = mock(async () => '{"summary":"missing fixed","findings":[]}');

    const result = await requestStructuredExecutionReview(runPrompt, 1, "base prompt");

    expect(result.summary).toContain("invalid JSON after 2 attempts");
    expect(result.findings[0]).toContain("review-response-parse-error");
    expect(result.fixed).toBe(false);
    expect(runPrompt).toHaveBeenCalledTimes(2);
  });

  test("per-task auto-fix review loops until the task is clean", async () => {
    const task = makeTask();
    const runPrompt = mock(async () => {
      if (runPrompt.mock.calls.length === 1) {
        return '{"summary":"fixed missing marker","findings":["missing marker"],"fixed":true}';
      }

      return '{"summary":"clean","findings":[],"fixed":false}';
    });
    const emitFindings = mock(async () => {});

    const result = await runCompletedTaskReview({
      task,
      run: makeRun(task),
      spec: "Write marker.txt.",
      config: {
        enabled: true,
        maxCycles: 2,
        onFindings: "auto_fix"
      },
      runPrompt,
      emitFindings
    });

    expect(result).toEqual({ outcome: "accepted", summary: "clean" });
    expect(runPrompt).toHaveBeenCalledTimes(2);
    expect(emitFindings).toHaveBeenCalledTimes(1);
  });

  test("per-task review policy handles report_only, fail, and unresolved auto_fix findings", async () => {
    const task = makeTask();
    const run = makeRun(task);
    const findingPrompt = async () => '{"summary":"needs work","findings":["missing marker"],"fixed":false}';
    const emitFindings = mock(async () => {});

    await expect(
      runCompletedTaskReview({
        task,
        run,
        spec: null,
        config: { enabled: true, maxCycles: 1, onFindings: "report_only" },
        runPrompt: findingPrompt,
        emitFindings
      })
    ).resolves.toEqual({ outcome: "accepted", summary: "needs work" });

    await expect(
      runCompletedTaskReview({
        task,
        run,
        spec: null,
        config: { enabled: true, maxCycles: 1, onFindings: "fail" },
        runPrompt: findingPrompt,
        emitFindings
      })
    ).resolves.toMatchObject({ outcome: "failed", summary: "needs work" });

    await expect(
      runCompletedTaskReview({
        task,
        run,
        spec: null,
        config: { enabled: true, maxCycles: 1, onFindings: "auto_fix" },
        runPrompt: findingPrompt,
        emitFindings
      })
    ).resolves.toMatchObject({
      outcome: "failed",
      error: expect.stringContaining("unresolved findings")
    });

    expect(emitFindings).toHaveBeenCalledTimes(3);
  });

  test("per-task report-only review does not ask the reviewer to mutate", async () => {
    const task = makeTask();
    const prompts: string[] = [];

    const result = await runCompletedTaskReview({
      task,
      run: makeRun(task),
      spec: null,
      config: { enabled: true, maxCycles: 1, onFindings: "report_only" },
      runPrompt: async (prompt) => {
        prompts.push(prompt);
        return '{"summary":"reported","findings":["missing marker"],"fixed":false}';
      },
      emitFindings: mock(async () => {})
    });

    expect(result).toEqual({ outcome: "accepted", summary: "reported" });
    expect(prompts[0]).toContain("Do not edit files or run mutating commands during this review. Report findings only.");
    expect(prompts[0]).not.toContain("apply fixes directly");
  });
});
