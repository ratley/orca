import { promises as fs } from "node:fs";

import { planSpec } from "../agents/claude/session.js";
import { logger } from "../utils/logger.js";
import { RunStore } from "../state/store.js";
import { validateDAG } from "./dependency-graph.js";

const DEFAULT_SYSTEM_CONTEXT = "You are Orca planner.";

type PlanSpecFn = typeof planSpec;

let planSpecImpl: PlanSpecFn = planSpec;

export function setPlanSpecForTests(fn: PlanSpecFn | null): void {
  planSpecImpl = fn ?? planSpec;
}

export async function runPlanner(specPath: string, store: RunStore, runId: string): Promise<void> {
  const spec = await fs.readFile(specPath, "utf8");
  const result = await planSpecImpl(spec, DEFAULT_SYSTEM_CONTEXT);

  validateDAG(result.tasks);

  await store.writeTasks(runId, result.tasks);
  await store.updateRun(runId, {
    overallStatus: "planning",
    tasks: result.tasks,
    milestones: ["plan-complete"]
  });

  logger.success(`Plan complete: ${result.tasks.length} tasks`);
}

export type { PlanSpecFn };
