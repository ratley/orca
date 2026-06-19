import type { Command } from "commander";
import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";

import { resolveConfig } from "../../core/config-loader.js";
import { formatFlowInstructions, resolveSelectedFlowConfig } from "../../core/flow-config.js";
import { runPlanner } from "../../core/planner.js";
import { RunStore } from "../../state/store.js";
import { generateRunId } from "../../utils/ids.js";

export interface PlanCommandOptions {
  spec: string;
  config?: string;
  flow?: string;
  onMilestone?: string;
  onError?: string;
}

export async function planCommand(options: { spec: string; config?: string; flow?: string }): Promise<void> {
  const specPath = path.resolve(options.spec);
  await access(specPath, fsConstants.R_OK);
  const selectedFlow = resolveSelectedFlowConfig(await resolveConfig(options.config), options.flow);
  const orcaConfig = selectedFlow.config;

  const runId = generateRunId(specPath);
  console.log(`Run ID: ${runId}`);
  if (selectedFlow.name !== undefined) {
    console.log(`Flow: ${selectedFlow.name}`);
  }

  const store = new RunStore();
  await store.createRun(runId, specPath);
  if (selectedFlow.name !== undefined) {
    await store.updateRun(runId, { flowName: selectedFlow.name });
  }

  const planningFlowInstructions = formatFlowInstructions(selectedFlow, "planning");
  const plannerOptions = planningFlowInstructions !== undefined
    ? { systemContextSections: [planningFlowInstructions] }
    : undefined;
  await runPlanner(specPath, store, runId, orcaConfig, plannerOptions);

  const run = await store.getRun(runId);
  if (!run) {
    throw new Error(`Run not found after planning: ${runId}`);
  }

  console.log("Tasks:");
  for (const task of run.tasks) {
    console.log(`- ${task.name}`);
  }
  console.log(`Run dir: ${store.getRunDir(runId)}`);
}

export async function planCommandHandler(options: PlanCommandOptions): Promise<void> {
  await planCommand({
    spec: options.spec,
    ...(options.config !== undefined ? { config: options.config } : {}),
    ...(options.flow !== undefined ? { flow: options.flow } : {})
  });
}

export function registerPlanCommand(program: Command): void {
  program
    .command("plan")
    .description("Run pre-planning and output validated task graph")
    .requiredOption("--spec <path>", "Path to spec markdown file")
    .option("--config <path>", "Path to orca config file")
    .option("--flow <name>", "Use a configured flow preset")
    .option("--on-milestone <cmd>", "Shell hook command for onMilestone")
    .option("--on-error <cmd>", "Shell hook command for onError")
    .action(async (options: PlanCommandOptions) => planCommandHandler(options));
}
