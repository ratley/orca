import type { Command } from "commander";

import { runTaskRunner } from "../../core/task-runner.js";
import { RunStore } from "../../state/store.js";
import type { RunStatus } from "../../types/index.js";

export interface ResumeCommandOptions {
  run?: string;
  config?: string;
}

function createStore(): RunStore {
  const runsDir = process.env.ORCA_RUNS_DIR;
  return runsDir ? new RunStore(runsDir) : new RunStore();
}

function formatRunIds(runs: RunStatus[]): string {
  if (runs.length === 0) {
    return "(none)";
  }

  return runs.map((run) => run.runId).join(", ");
}

function getActiveRuns(runs: RunStatus[]): RunStatus[] {
  return runs.filter((run) => run.overallStatus === "planning" || run.overallStatus === "running");
}

export async function resumeCommandHandler(options: ResumeCommandOptions): Promise<void> {
  const store = createStore();
  const knownRuns = await store.listRuns();

  if (!options.run) {
    console.error(`Missing required --run <run-id>\nActive runs: ${formatRunIds(getActiveRuns(knownRuns))}`);
    process.exitCode = 1;
    return;
  }

  const run = await store.getRun(options.run);
  if (!run) {
    console.error(`Run not found: ${options.run}\nKnown run IDs: ${formatRunIds(knownRuns)}`);
    process.exitCode = 1;
    return;
  }

  if (run.overallStatus === "completed" || run.overallStatus === "cancelled") {
    console.error(`Run ${run.runId} is ${run.overallStatus} and cannot be resumed.`);
    process.exitCode = 1;
    return;
  }

  const resumedTasks = run.tasks.map((task) => {
    if (task.status === "in_progress") {
      return {
        ...task,
        status: "pending" as const,
        lastError: "Recovered from interrupted in_progress task"
      };
    }

    return task;
  });

  await store.updateRun(run.runId, {
    mode: "run",
    overallStatus: "running",
    tasks: resumedTasks
  });

  await runTaskRunner({
    runId: run.runId,
    store
  });

  const refreshed = await store.getRun(run.runId);
  if (!refreshed) {
    throw new Error(`Run not found after resume: ${run.runId}`);
  }

  console.log(`Resumed run ${refreshed.runId}: ${refreshed.overallStatus}`);
}

export function registerResumeCommand(program: Command): void {
  program
    .command("resume")
    .description("Resume an incomplete run")
    .option("--run <run-id>", "Run ID to resume")
    .option("--config <path>", "Path to orca config file")
    .action(async (options: ResumeCommandOptions) => resumeCommandHandler(options));
}
