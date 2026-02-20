import { promises as fs } from "node:fs";
import path from "node:path";

import { planSpec as planSpecWithClaude } from "../agents/claude/session.js";
import { planSpec as planSpecWithCodex } from "../agents/codex/session.js";
import type { OrcaConfig } from "../types/index.js";
import { logger } from "../utils/logger.js";
import { loadSkills, type LoadedSkill } from "../utils/skill-loader.js";
import { RunStore } from "../state/store.js";
import { validateDAG } from "./dependency-graph.js";

const DEFAULT_SYSTEM_CONTEXT = "You are Orca planner.";
const PROJECT_INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"] as const;
const PROJECT_INSTRUCTION_CHAR_CAP = 4_000;

type PlanSpecFn = typeof planSpecWithClaude;

type ProjectInstruction = {
  fileName: (typeof PROJECT_INSTRUCTION_FILES)[number];
  filePath: string;
  content: string;
  truncated: boolean;
};

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

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function resolveProjectContextDir(specPath: string): Promise<string> {
  let currentDir = path.dirname(path.resolve(specPath));

  while (true) {
    const gitMarker = path.join(currentDir, ".git");
    if (await pathExists(gitMarker)) {
      return currentDir;
    }

    const parent = path.dirname(currentDir);
    if (parent === currentDir) {
      return path.dirname(path.resolve(specPath));
    }

    currentDir = parent;
  }
}

async function loadProjectInstructions(specPath: string): Promise<ProjectInstruction[]> {
  const projectDir = await resolveProjectContextDir(specPath);
  const instructions: ProjectInstruction[] = [];

  for (const fileName of PROJECT_INSTRUCTION_FILES) {
    const filePath = path.join(projectDir, fileName);
    if (!(await pathExists(filePath))) {
      continue;
    }

    const rawContent = await fs.readFile(filePath, "utf8");
    const content = rawContent.slice(0, PROJECT_INSTRUCTION_CHAR_CAP);
    instructions.push({
      fileName,
      filePath,
      content,
      truncated: rawContent.length > PROJECT_INSTRUCTION_CHAR_CAP
    });
  }

  return instructions;
}

function formatProjectInstructionsSection(instructions: ProjectInstruction[]): string {
  const parts: string[] = ["## Project Instructions"];

  for (const instruction of instructions) {
    parts.push("");
    parts.push(`### ${instruction.fileName} (${instruction.filePath})`);
    parts.push("");
    parts.push("```md");
    parts.push(instruction.content);
    parts.push("```");
    if (instruction.truncated) {
      parts.push(`(truncated to ${PROJECT_INSTRUCTION_CHAR_CAP} characters)`);
    }
  }

  return parts.join("\n");
}

function buildSystemContext(skills: LoadedSkill[], instructions: ProjectInstruction[]): string {
  const sections = [DEFAULT_SYSTEM_CONTEXT];

  if (instructions.length > 0) {
    sections.push(formatProjectInstructionsSection(instructions));
  }

  if (skills.length > 0) {
    sections.push(formatSkillsSection(skills));
  }

  return sections.join("\n\n");
}

export async function runPlanner(
  specPath: string,
  store: RunStore,
  runId: string,
  config?: OrcaConfig
): Promise<void> {
  const spec = await fs.readFile(specPath, "utf8");
  const [skills, instructions] = await Promise.all([loadSkills(config), loadProjectInstructions(specPath)]);
  const systemContext = buildSystemContext(skills, instructions);
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
