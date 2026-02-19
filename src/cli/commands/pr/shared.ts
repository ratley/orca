import path from "node:path";

import { RunStore } from "../../../state/store.js";
import type { RunStatus } from "../../../types/index.js";

export interface PrCommandOptions {
  run: string;
  config?: string;
}

export function createStore(): RunStore {
  const runsDir = process.env.ORCA_RUNS_DIR;
  return runsDir ? new RunStore(runsDir) : new RunStore();
}

export function buildPrTitle(run: RunStatus): string {
  const specBase = run.specPath ? path.basename(run.specPath) : "";
  const derived = specBase.length > 0 ? specBase : run.runId;
  return `Orca run: ${derived}`;
}

export function buildPrBody(run: RunStatus): string {
  const completedTasks = run.tasks.filter((task) => task.status === "done");
  const lines = [
    `Automated PR for run \`${run.runId}\`.`,
    "",
    `Spec: \`${run.specPath}\``,
    "",
    "Completed tasks:"
  ];

  if (completedTasks.length === 0) {
    lines.push("- (none)");
  } else {
    for (const task of completedTasks) {
      lines.push(`- [x] ${task.name} (${task.id})`);
    }
  }

  return lines.join("\n");
}

export async function loadRunOrExit(options: PrCommandOptions): Promise<RunStatus | null> {
  const store = createStore();
  const run = await store.getRun(options.run);

  if (!run) {
    console.error(`Run not found: ${options.run}`);
    process.exitCode = 1;
    return null;
  }

  return run;
}

export function printGhMissingAndExit(): void {
  console.error("gh CLI not found. Run `orca setup` to install it.");
  process.exitCode = 1;
}
