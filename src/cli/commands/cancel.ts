import type { Command } from "commander";

import { RunStore } from "../../state/store.js";
import type { RunStatus } from "../../types/index.js";
import { getLastRun } from "../../utils/last-run.js";

export interface CancelCommandOptions {
  run?: string;
  last?: boolean;
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

export async function cancelCommandHandler(options: CancelCommandOptions): Promise<void> {
  const store = createStore();

  if (options.last) {
    const lastRun = await getLastRun(store);
    if (!lastRun) {
      console.error("No runs found.");
      process.exitCode = 1;
      return;
    }

    options.run = lastRun.runId;
  }

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

  const cancelledAt = new Date().toISOString();
  let cancelledTaskId: string | null = null;

  const tasks = run.tasks.map((task) => {
    if (task.status === "in_progress") {
      cancelledTaskId = task.id;
      return {
        ...task,
        status: "cancelled" as const,
        finishedAt: cancelledAt,
        lastError: "Run cancelled"
      };
    }

    return task;
  });

  await store.updateRun(run.runId, {
    overallStatus: "cancelled",
    tasks
  });

  if (cancelledTaskId) {
    console.log(`Cancelled run ${run.runId}; task ${cancelledTaskId} marked cancelled.`);
    return;
  }

  console.log(`Cancelled run ${run.runId}.`);
}

export function registerCancelCommand(program: Command): void {
  program
    .command("cancel")
    .description("Cancel an active run")
    .option("--run <run-id>", "Run ID to cancel")
    .option("--last", "Use the most recent run")
    .option("--config <path>", "Path to orca config file")
    .action(async (options: CancelCommandOptions) => cancelCommandHandler(options));
}
