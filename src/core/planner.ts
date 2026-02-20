import { promises as fs } from "node:fs";

import { planSpec as planSpecWithClaude } from "../agents/claude/session.js";
import { planSpec as planSpecWithCodex } from "../agents/codex/session.js";
import type { OrcaConfig } from "../types/index.js";
import { logger } from "../utils/logger.js";
import { loadSkills, type LoadedSkill } from "../utils/skill-loader.js";
import { RunStore } from "../state/store.js";
import { validateDAG } from "./dependency-graph.js";

const DEFAULT_SYSTEM_CONTEXT = "You are Orca planner.";

type PlanSpecFn = typeof planSpecWithClaude;

let testPlanSpecOverride: PlanSpecFn | null = null;

export function setPlanSpecForTests(fn: PlanSpecFn | null): void {
  testPlanSpecOverride = fn;
}

function resolvePlanSpecImpl(config?: OrcaConfig): PlanSpecFn {
  if (testPlanSpecOverride) {
    return testPlanSpecOverride;
  }

  const executor = config?.executor ?? "codex";
  return executor === "claude" ? planSpecWithClaude : planSpecWithCodex;
}

function formatSkillsSection(skills: LoadedSkill[]): string {
  const formattedSkills = skills.map((skill) =>
    [
      `### ${skill.name}`,
      "",
      `Description: ${skill.description}`,
      "",
      skill.body
    ].join("\n")
  );

  return ["## Available Skills", "", ...formattedSkills].join("\n");
}

export async function runPlanner(
  specPath: string,
  store: RunStore,
  runId: string,
  config?: OrcaConfig
): Promise<void> {
  const spec = await fs.readFile(specPath, "utf8");
  const skills = await loadSkills(config);
  const systemContext =
    skills.length === 0
      ? DEFAULT_SYSTEM_CONTEXT
      : `${DEFAULT_SYSTEM_CONTEXT}\n\n${formatSkillsSection(skills)}`;
  const planSpecImpl = resolvePlanSpecImpl(config);
  const result = await planSpecImpl(spec, systemContext, config);

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
