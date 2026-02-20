import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

import type { Task } from "../types/index";
import { RunStore } from "../state/store";
import { InvalidPlanError, runPlanner, setPlanSpecForTests, setReviewTaskGraphForTests } from "./planner";

describe("runPlanner task graph validation", () => {
  let tempDir: string;
  let specPath: string;
  let store: RunStore;
  const runId = "planner-1000-abcd";

  const baseTask: Task = {
    id: "t1",
    name: "Task 1",
    description: "desc",
    dependencies: [],
    acceptance_criteria: ["a"],
    status: "pending",
    retries: 0,
    maxRetries: 3
  };

  const baseTasks: Task[] = [baseTask];

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "orca-planner-test-"));
    specPath = path.join(tempDir, "spec.md");
    await fs.writeFile(specPath, "# test spec\n", "utf8");
    store = new RunStore(path.join(tempDir, "runs"));
    await store.createRun(runId, specPath);
    setReviewTaskGraphForTests(async () => ({ changes: [], rawResponse: '{"changes":[]}' }));
  });

  afterEach(async () => {
    setPlanSpecForTests(null);
    setReviewTaskGraphForTests(null);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test("rejects duplicate IDs", async () => {
    const tasks: Task[] = [
      baseTask,
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

    try {
      await runPlanner(specPath, store, runId);
      throw new Error("expected runPlanner to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidPlanError);
      expect((error as InvalidPlanError).stage).toBe("planner");
      expect((error as Error).message).toContain("Duplicate task id");
    }
  });

  test("rejects missing dependency IDs", async () => {
    const tasks: Task[] = [
      {
        ...baseTask,
        dependencies: ["missing"]
      }
    ];

    setPlanSpecForTests(async () => ({ tasks, rawResponse: JSON.stringify(tasks) }));

    await expect(runPlanner(specPath, store, runId)).rejects.toThrow("missing dependency");
  });

  test("rejects cycles", async () => {
    const tasks: Task[] = [
      {
        ...baseTask,
        dependencies: ["t2"]
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

  test("review returns no changes", async () => {
    setPlanSpecForTests(async () => ({ tasks: baseTasks, rawResponse: JSON.stringify(baseTasks) }));
    setReviewTaskGraphForTests(async () => ({ changes: [], rawResponse: '{"changes":[]}' }));

    await runPlanner(specPath, store, runId);

    const run = await store.getRun(runId);
    expect(run?.tasks).toEqual(baseTasks);
  });

  test("review applies valid changes", async () => {
    const tasks: Task[] = [
      { ...baseTask, id: "t1", name: "Original" },
      { ...baseTask, id: "t2", name: "Second", dependencies: ["t1"] }
    ];

    setPlanSpecForTests(async () => ({ tasks, rawResponse: JSON.stringify(tasks) }));
    setReviewTaskGraphForTests(async () => ({
      changes: [
        { op: "update_task", taskId: "t1", fields: { name: "Renamed" } },
        { op: "add_task", task: { ...baseTask, id: "t3", name: "Third", dependencies: ["t2"] } },
        { op: "add_dependency", taskId: "t2", dependsOn: "t1" }
      ],
      rawResponse: "review"
    }));

    await runPlanner(specPath, store, runId);

    const run = await store.getRun(runId);
    expect(run?.tasks.map((task) => task.id)).toEqual(["t1", "t2", "t3"]);
    expect(run?.tasks.find((task) => task.id === "t1")?.name).toBe("Renamed");
  });

  test("review output causes invalid DAG and is rejected", async () => {
    const tasks: Task[] = [
      { ...baseTask, id: "t1", dependencies: [] },
      { ...baseTask, id: "t2", dependencies: ["t1"] }
    ];

    setPlanSpecForTests(async () => ({ tasks, rawResponse: JSON.stringify(tasks) }));
    setReviewTaskGraphForTests(async () => ({
      changes: [{ op: "add_dependency", taskId: "t1", dependsOn: "t2" }],
      rawResponse: "review"
    }));

    try {
      await runPlanner(specPath, store, runId);
      throw new Error("expected runPlanner to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidPlanError);
      expect((error as InvalidPlanError).stage).toBe("review");
      expect((error as Error).message).toContain("cycle");
    }
  });

  test("legacy review.onInvalid=warn_skip still skips invalid review output", async () => {
    const tasks: Task[] = [
      { ...baseTask, id: "t1", dependencies: [] },
      { ...baseTask, id: "t2", dependencies: ["t1"] }
    ];

    setPlanSpecForTests(async () => ({ tasks, rawResponse: JSON.stringify(tasks) }));
    setReviewTaskGraphForTests(async () => ({
      changes: [{ op: "add_dependency", taskId: "t1", dependsOn: "t2" }],
      rawResponse: "review"
    }));

    await runPlanner(specPath, store, runId, {
      review: {
        onInvalid: "warn_skip"
      } as never
    });

    const run = await store.getRun(runId);
    expect(run?.tasks).toEqual(tasks);
  });

  test("execution path uses reviewed graph from store", async () => {
    setPlanSpecForTests(async () => ({ tasks: baseTasks, rawResponse: JSON.stringify(baseTasks) }));
    setReviewTaskGraphForTests(async () => ({
      changes: [
        { op: "update_task", taskId: "t1", fields: { name: "Reviewed Task" } }
      ],
      rawResponse: "review"
    }));

    await runPlanner(specPath, store, runId);

    const run = await store.getRun(runId);
    expect(run?.tasks[0]?.name).toBe("Reviewed Task");
  });

  test("injects loaded skills into planning system context", async () => {
    const skillDir = path.join(tempDir, "skill-a");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      ["---", "name: Planning Skill", "description: Helps planning", "---", "## Skill Body", "Use this."].join(
        "\n"
      ),
      "utf8"
    );

    let capturedSystemContext = "";
    setPlanSpecForTests(async (_spec, systemContext) => {
      capturedSystemContext = systemContext;
      return { tasks: baseTasks, rawResponse: JSON.stringify(baseTasks) };
    });

    await runPlanner(specPath, store, runId, { skills: [skillDir] });

    expect(capturedSystemContext).toContain("## Available Skills");
    expect(capturedSystemContext).toContain("Planning Skill");
    expect(capturedSystemContext).toContain("Helps planning");
    expect(capturedSystemContext).toContain("## Skill Body");
    expect(capturedSystemContext).toContain("Use this.");
  });

  test("injects AGENTS.md when present", async () => {
    await fs.writeFile(path.join(tempDir, "AGENTS.md"), "Follow AGENTS guidance", "utf8");

    let capturedSystemContext = "";
    setPlanSpecForTests(async (_spec, systemContext) => {
      capturedSystemContext = systemContext;
      return { tasks: baseTasks, rawResponse: JSON.stringify(baseTasks) };
    });

    await runPlanner(specPath, store, runId);

    expect(capturedSystemContext).toContain("## Project Instructions");
    expect(capturedSystemContext).toContain("### AGENTS.md (");
    expect(capturedSystemContext).toContain("Follow AGENTS guidance");
    expect(capturedSystemContext).not.toContain("### CLAUDE.md (");
  });

  test("injects CLAUDE.md when present", async () => {
    await fs.writeFile(path.join(tempDir, "CLAUDE.md"), "Follow CLAUDE guidance", "utf8");

    let capturedSystemContext = "";
    setPlanSpecForTests(async (_spec, systemContext) => {
      capturedSystemContext = systemContext;
      return { tasks: baseTasks, rawResponse: JSON.stringify(baseTasks) };
    });

    await runPlanner(specPath, store, runId);

    expect(capturedSystemContext).toContain("## Project Instructions");
    expect(capturedSystemContext).toContain("### CLAUDE.md (");
    expect(capturedSystemContext).toContain("Follow CLAUDE guidance");
    expect(capturedSystemContext).not.toContain("### AGENTS.md (");
  });

  test("injects AGENTS.md before CLAUDE.md when both are present", async () => {
    await fs.writeFile(path.join(tempDir, "AGENTS.md"), "AGENTS content", "utf8");
    await fs.writeFile(path.join(tempDir, "CLAUDE.md"), "CLAUDE content", "utf8");

    let capturedSystemContext = "";
    setPlanSpecForTests(async (_spec, systemContext) => {
      capturedSystemContext = systemContext;
      return { tasks: baseTasks, rawResponse: JSON.stringify(baseTasks) };
    });

    await runPlanner(specPath, store, runId);

    const agentsIdx = capturedSystemContext.indexOf("### AGENTS.md (");
    const claudeIdx = capturedSystemContext.indexOf("### CLAUDE.md (");
    expect(agentsIdx).toBeGreaterThan(-1);
    expect(claudeIdx).toBeGreaterThan(-1);
    expect(agentsIdx).toBeLessThan(claudeIdx);
  });

  test("does not inject project instructions when neither file is present", async () => {
    let capturedSystemContext = "";
    setPlanSpecForTests(async (_spec, systemContext) => {
      capturedSystemContext = systemContext;
      return { tasks: baseTasks, rawResponse: JSON.stringify(baseTasks) };
    });

    await runPlanner(specPath, store, runId);

    expect(capturedSystemContext.startsWith("You are Orca planner.")).toBe(true);
    expect(capturedSystemContext).not.toContain("## Project Instructions");
  });

  test("caps and marks truncated project instruction content", async () => {
    const longContent = "a".repeat(4_500);
    await fs.writeFile(path.join(tempDir, "AGENTS.md"), longContent, "utf8");

    let capturedSystemContext = "";
    setPlanSpecForTests(async (_spec, systemContext) => {
      capturedSystemContext = systemContext;
      return { tasks: baseTasks, rawResponse: JSON.stringify(baseTasks) };
    });

    await runPlanner(specPath, store, runId);

    expect(capturedSystemContext).toContain("(truncated to 4000 characters)");
    expect(capturedSystemContext).toContain("a".repeat(4_000));
    expect(capturedSystemContext).not.toContain("a".repeat(4_100));
  });
});
