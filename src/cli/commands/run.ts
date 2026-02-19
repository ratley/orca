import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";

import type { Command } from "commander";

import { runPlanner } from "../../core/planner.js";
import { runTaskRunner } from "../../core/task-runner.js";
import { HookDispatcher } from "../../hooks/dispatcher.js";
import { RunStore } from "../../state/store.js";
import type { HookEvent } from "../../types/index.js";
import { generateRunId } from "../../utils/ids.js";

export interface RunCommandOptions {
  spec: string;
  config?: string;
  onMilestone?: string;
  onTaskComplete?: string;
  onTaskFail?: string;
  onComplete?: string;
  onError?: string;
}

function createStore(): RunStore {
  const runsDir = process.env.ORCA_RUNS_DIR;
  return runsDir ? new RunStore(runsDir) : new RunStore();
}

function computeFinalStatus(overallStatus: string, allTasksDone: boolean): "completed" | "failed" | "cancelled" {
  if (overallStatus === "cancelled") {
    return "cancelled";
  }

  return allTasksDone ? "completed" : "failed";
}

export async function runCommandHandler(options: RunCommandOptions): Promise<void> {
  const specPath = path.resolve(options.spec);
  await access(specPath, fsConstants.R_OK);

  const runId = generateRunId(specPath);
  console.log(`Run ID: ${runId}`);

  const store = createStore();
  await store.createRun(runId, specPath);

  await runPlanner(specPath, store, runId);
  await store.updateRun(runId, {
    mode: "run",
    overallStatus: "running"
  });

  const dispatcher = options.onMilestone
    ? new HookDispatcher({
      commandHooks: {
        onMilestone: options.onMilestone
      }
    })
    : null;

  const emitHook = async (event: HookEvent): Promise<void> => {
    console.log(JSON.stringify(event));
    if (dispatcher) {
      await dispatcher.dispatch(event);
    }
  };

  await runTaskRunner({
    runId,
    store,
    emitHook
  });

  const run = await store.getRun(runId);
  if (!run) {
    throw new Error(`Run not found after execution: ${runId}`);
  }

  const finalStatus = computeFinalStatus(
    run.overallStatus,
    run.tasks.length > 0 && run.tasks.every((task) => task.status === "done")
  );

  await store.updateRun(runId, {
    overallStatus: finalStatus
  });

  const refreshed = await store.getRun(runId);
  if (!refreshed) {
    throw new Error(`Run missing after final status write: ${runId}`);
  }

  console.log(`Overall status: ${refreshed.overallStatus}`);
  console.log(`Run dir: ${store.getRunDir(runId)}`);
}

export function registerRunCommand(program: Command): void {
  program
    .command("run")
    .description("Run pre-planning and execution")
    .requiredOption("--spec <path>", "Path to spec markdown file")
    .option("--config <path>", "Path to orca config file")
    .option("--on-milestone <cmd>", "Shell hook command for onMilestone")
    .option("--on-task-complete <cmd>", "Shell hook command for onTaskComplete")
    .option("--on-task-fail <cmd>", "Shell hook command for onTaskFail")
    .option("--on-complete <cmd>", "Shell hook command for onComplete")
    .option("--on-error <cmd>", "Shell hook command for onError")
    .action(async (options: RunCommandOptions) => runCommandHandler(options));
}
