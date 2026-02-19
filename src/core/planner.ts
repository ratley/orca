import { promises as fs } from "node:fs";

import { planSpec } from "../agents/claude/session.js";
import { logger } from "../utils/logger.js";
import type { Task } from "../types/index.js";
import { RunStore } from "../state/store.js";

const DEFAULT_SYSTEM_CONTEXT = "You are Orca planner.";

type PlanSpecFn = typeof planSpec;

let planSpecImpl: PlanSpecFn = planSpec;

export function setPlanSpecForTests(fn: PlanSpecFn | null): void {
  planSpecImpl = fn ?? planSpec;
}

function validateTaskGraph(tasks: Task[]): void {
  const ids = new Set<string>();

  for (const task of tasks) {
    if (ids.has(task.id)) {
      throw new Error(`Duplicate task id: ${task.id}`);
    }

    ids.add(task.id);
  }

  for (const task of tasks) {
    for (const dependency of task.dependencies) {
      if (!ids.has(dependency)) {
        throw new Error(`Task ${task.id} has missing dependency: ${dependency}`);
      }
    }
  }

  const state = new Map<string, "visiting" | "visited">();
  const tasksById = new Map(tasks.map((task) => [task.id, task]));

  const dfs = (taskId: string): void => {
    const current = state.get(taskId);

    if (current === "visiting") {
      throw new Error(`Task graph has cycle at: ${taskId}`);
    }

    if (current === "visited") {
      return;
    }

    state.set(taskId, "visiting");

    const task = tasksById.get(taskId);
    if (!task) {
      throw new Error(`Unknown task id in graph: ${taskId}`);
    }

    for (const dependency of task.dependencies) {
      dfs(dependency);
    }

    state.set(taskId, "visited");
  };

  for (const task of tasks) {
    dfs(task.id);
  }
}

export async function runPlanner(specPath: string, store: RunStore, runId: string): Promise<void> {
  const spec = await fs.readFile(specPath, "utf8");
  const result = await planSpecImpl(spec, DEFAULT_SYSTEM_CONTEXT);

  validateTaskGraph(result.tasks);

  await store.writeTasks(runId, result.tasks);
  await store.updateRun(runId, {
    overallStatus: "planning",
    tasks: result.tasks,
    milestones: ["plan-complete"]
  });

  logger.success(`Plan complete: ${result.tasks.length} tasks`);
}

export type { PlanSpecFn };
