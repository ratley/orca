import { promises as fs } from "node:fs";
import path from "node:path";

import { planSpec as planSpecWithClaude, reviewTaskGraph as reviewTaskGraphWithClaude } from "../agents/claude/session.js";
import { planSpec as planSpecWithCodex, reviewTaskGraph as reviewTaskGraphWithCodex } from "../agents/codex/session.js";
import type { OrcaConfig, Task, TaskGraphReviewResult } from "../types/index.js";
import { logger } from "../utils/logger.js";
import { loadSkills, type LoadedSkill } from "../utils/skill-loader.js";
import { RunStore } from "../state/store.js";
import { validateDAG } from "./dependency-graph.js";
import { applyTaskGraphReviewChanges, summarizeReviewChanges } from "./task-graph-review.js";

const DEFAULT_SYSTEM_CONTEXT = "You are Orca planner.";
const PROJECT_INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"] as const;
const PROJECT_INSTRUCTION_CHAR_CAP = 4_000;

type PlanSpecFn = typeof planSpecWithClaude;
type ReviewTaskGraphFn = typeof reviewTaskGraphWithClaude;

export class InvalidPlanError extends Error {
  readonly stage: "planner" | "review";

  constructor(stage: "planner" | "review", message: string) {
    super(message);
    this.name = "InvalidPlanError";
    this.stage = stage;
  }
}

type ProjectInstruction = {
  fileName: (typeof PROJECT_INSTRUCTION_FILES)[number];
  filePath: string;
  content: string;
  truncated: boolean;
};

let testPlanSpecOverride: PlanSpecFn | null = null;
let testReviewTaskGraphOverride: ReviewTaskGraphFn | null = null;

export function setPlanSpecForTests(fn: PlanSpecFn | null): void {
  testPlanSpecOverride = fn;
}

export function setReviewTaskGraphForTests(fn: ReviewTaskGraphFn | null): void {
  testReviewTaskGraphOverride = fn;
}

function resolveExecutorImpl<T>(
  override: T | null,
  config: OrcaConfig | undefined,
  claudeImpl: T,
  codexImpl: T
): T {
  if (override) {
    return override;
  }

  const executor = config?.executor ?? "codex";
  return executor === "claude" ? claudeImpl : codexImpl;
}

function resolvePlanSpecImpl(config?: OrcaConfig): PlanSpecFn {
  return resolveExecutorImpl(testPlanSpecOverride, config, planSpecWithClaude, planSpecWithCodex);
}

function resolveReviewTaskGraphImpl(config?: OrcaConfig): ReviewTaskGraphFn {
  return resolveExecutorImpl(
    testReviewTaskGraphOverride,
    config,
    reviewTaskGraphWithClaude,
    reviewTaskGraphWithCodex
  );
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

function getPlanReviewConfig(config: OrcaConfig | undefined): { enabled: boolean; onInvalid: "fail" | "warn_skip" } {
  const review = (config?.review ?? {}) as OrcaConfig["review"] & { enabled?: boolean; onInvalid?: "fail" | "warn_skip" };
  return {
    enabled: review.plan?.enabled ?? review.enabled ?? true,
    onInvalid: review.plan?.onInvalid ?? review.onInvalid ?? "fail"
  };
}

async function runTaskGraphReview(
  tasks: Task[],
  systemContext: string,
  config: OrcaConfig | undefined,
): Promise<{ finalTasks: Task[]; review: TaskGraphReviewResult | null }> {
  const planReviewConfig = getPlanReviewConfig(config);
  if (!planReviewConfig.enabled) {
    return { finalTasks: tasks, review: null };
  }

  logger.info("Review started: pre-execution task graph improvement pass");

  const reviewFn = resolveReviewTaskGraphImpl(config);
  let review: TaskGraphReviewResult;
  try {
    review = await reviewFn(tasks, systemContext, config);
  } catch (error) {
    if (planReviewConfig.onInvalid === "warn_skip") {
      logger.warn(`Review output invalid; skipping review changes (${error instanceof Error ? error.message : String(error)})`);
      return { finalTasks: tasks, review: null };
    }

    throw new InvalidPlanError("review", `Review output invalid. ${error instanceof Error ? error.message : String(error)}`);
  }

  if (review.changes.length === 0) {
    logger.info("Review made no changes");
    return { finalTasks: tasks, review };
  }

  const updated = applyTaskGraphReviewChanges(tasks, review.changes);
  try {
    validateDAG(updated);
  } catch (error) {
    throw new InvalidPlanError("review", error instanceof Error ? error.message : String(error));
  }

  const summary = summarizeReviewChanges(review.changes).join("; ");
  logger.success(`Review made ${review.changes.length} changes: ${summary}`);

  return { finalTasks: updated, review };
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

  try {
    validateDAG(result.tasks);
  } catch (error) {
    throw new InvalidPlanError("planner", error instanceof Error ? error.message : String(error));
  }

  const planReviewConfig = getPlanReviewConfig(config);
  let finalTasks = result.tasks;
  try {
    const reviewed = await runTaskGraphReview(result.tasks, systemContext, config);
    finalTasks = reviewed.finalTasks;
  } catch (error) {
    if (planReviewConfig.onInvalid === "warn_skip") {
      logger.warn(`Review changes rejected; proceeding with planner graph (${error instanceof Error ? error.message : String(error)})`);
      finalTasks = result.tasks;
    } else if (error instanceof InvalidPlanError) {
      throw error;
    } else {
      throw new InvalidPlanError("review", `Review stage failed. ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  await store.writeTasks(runId, finalTasks);
  await store.updateRun(runId, {
    overallStatus: "planning",
    tasks: finalTasks,
    milestones: ["plan-complete"]
  });

  logger.success(`Plan complete: ${finalTasks.length} tasks`);
}

export type { PlanSpecFn, ReviewTaskGraphFn };
