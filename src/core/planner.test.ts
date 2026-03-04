import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { runPlanner, setDecidePlanningNeedForTests, setPlanSpecForTests, setReviewTaskGraphForTests } from "./planner.js";
import { RunStore } from "../state/store.js";

describe("runPlanner task graph validation", () => {
  let tempDir = "";
  let specPath = "";
  const runId = "run-test-1000-abcd";
  let store: RunStore;
  const originalCwd = process.cwd();

  const baseTasks = [{ id: "t1", name: "Task 1", description: "desc", dependencies: [], acceptance_criteria: ["done"], status: "pending", retries: 0, maxRetries: 3 }] as const;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "orca-planner-test-"));
    specPath = path.join(tempDir, "spec.md");
    await writeFile(specPath, "# spec", "utf8");
    store = new RunStore(path.join(tempDir, "runs"));
    await store.createRun(runId, specPath);
    process.chdir(tempDir);
    setPlanSpecForTests(async () => ({ tasks: [...baseTasks], rawResponse: "[]" }));
    setDecidePlanningNeedForTests(async () => ({ needsPlan: true, reason: "default" }));
    setReviewTaskGraphForTests(async () => ({ changes: [], rawResponse: "{}" }));
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    setPlanSpecForTests(null);
    setDecidePlanningNeedForTests(null);
    setReviewTaskGraphForTests(null);
    await rm(tempDir, { recursive: true, force: true });
  });

  test("injects AGENTS.md when present", async () => {
    await writeFile(path.join(tempDir, "AGENTS.md"), "Follow AGENTS guidance", "utf8");
    let captured = "";
    setPlanSpecForTests(async (_spec, systemContext) => {
      captured = systemContext;
      return { tasks: [...baseTasks], rawResponse: "[]" };
    });

    await runPlanner(specPath, store, runId);
    expect(captured).toContain("## Project Instructions");
    expect(captured).toContain("### AGENTS.md (");
  });

  test("does not inject project instructions when AGENTS.md is missing", async () => {
    let captured = "";
    setPlanSpecForTests(async (_spec, systemContext) => {
      captured = systemContext;
      return { tasks: [...baseTasks], rawResponse: "[]" };
    });

    await runPlanner(specPath, store, runId);
    expect(captured).not.toContain("## Project Instructions");
  });

  test("can skip heavy planning when decision step says no plan needed", async () => {
    setDecidePlanningNeedForTests(async () => ({ needsPlan: false, reason: "single step" }));
    let calledPlanSpec = false;
    setPlanSpecForTests(async () => {
      calledPlanSpec = true;
      return { tasks: [...baseTasks], rawResponse: "[]" };
    });

    await runPlanner(specPath, store, runId, undefined, { allowPlanSkip: true });
    expect(calledPlanSpec).toBe(false);

    const run = await store.getRun(runId);
    expect(run?.tasks).toHaveLength(1);
    expect(run?.tasks[0]?.name).toBe("Execute requested work");
  });

  test("runs planner when decision step says planning is needed", async () => {
    setDecidePlanningNeedForTests(async () => ({ needsPlan: true, reason: "multi-step" }));
    let calledPlanSpec = false;
    setPlanSpecForTests(async () => {
      calledPlanSpec = true;
      return { tasks: [...baseTasks], rawResponse: "[]" };
    });

    await runPlanner(specPath, store, runId, undefined, { allowPlanSkip: true });
    expect(calledPlanSpec).toBe(true);
  });
});
