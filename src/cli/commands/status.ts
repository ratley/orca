import type { Command } from "commander";

import { RunStore } from "../../state/store.js";
import type { RunStatus, Task } from "../../types/index.js";
import { formatRunSummaryTable, listRuns } from "./list.js";

export interface StatusCommandOptions {
  run?: string;
  config?: string;
}

function createStore(): RunStore {
  const runsDir = process.env.ORCA_RUNS_DIR;
  return runsDir ? new RunStore(runsDir) : new RunStore();
}

function pad(value: string, width: number): string {
  return value.padEnd(width, " ");
}

function formatTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, index) => {
    const rowWidths = rows.map((row) => row[index]?.length ?? 0);
    return Math.max(header.length, ...rowWidths);
  });

  const headerLine = headers.map((header, index) => pad(header, widths[index] ?? header.length)).join("  ");
  const separator = widths.map((width) => "-".repeat(width)).join("  ");
  const body = rows.map((row) => row.map((cell, index) => pad(cell, widths[index] ?? cell.length)).join("  "));

  return [headerLine, separator, ...body].join("\n");
}

function formatTaskTable(tasks: Task[]): string {
  const headers = ["ID", "Name", "Status", "Retries", "Started", "Finished"];
  const rows = tasks.map((task) => [
    task.id,
    task.name,
    task.status,
    `${task.retries}/${task.maxRetries}`,
    task.startedAt ?? "-",
    task.finishedAt ?? "-"
  ]);

  return formatTable(headers, rows);
}

function formatKnownRunIds(runs: RunStatus[]): string {
  if (runs.length === 0) {
    return "(none)";
  }

  return runs.map((run) => run.runId).join(", ");
}

async function printDetailedRun(run: RunStatus): Promise<void> {
  console.log(`Run ID: ${run.runId}`);
  console.log(`Spec Path: ${run.specPath}`);
  console.log(`Mode: ${run.mode}`);
  console.log(`Overall Status: ${run.overallStatus}`);
  console.log(`Created: ${run.createdAt}`);
  console.log(`Updated: ${run.updatedAt}`);
  console.log(`Milestones: ${run.milestones.length}`);
  console.log(`Errors: ${run.errors.length}`);
  console.log("");
  console.log("Tasks:");
  if (run.tasks.length === 0) {
    console.log("(none)");
    return;
  }

  console.log(formatTaskTable(run.tasks));
}

export async function statusCommandHandler(options: StatusCommandOptions): Promise<void> {
  if (!options.run) {
    const runs = await listRuns();
    if (runs.length === 0) {
      console.log("No runs found.");
      return;
    }

    console.log(formatRunSummaryTable(runs));
    return;
  }

  const store = createStore();
  const run = await store.getRun(options.run);

  if (!run) {
    const knownRuns = await store.listRuns();
    console.error(`Run not found: ${options.run}\nKnown run IDs: ${formatKnownRunIds(knownRuns)}`);
    process.exitCode = 1;
    return;
  }

  await printDetailedRun(run);
}

export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description("Show run status or list all runs")
    .option("--run <run-id>", "Run ID to inspect")
    .option("--config <path>", "Path to orca config file")
    .action(async (options: StatusCommandOptions) => statusCommandHandler(options));
}
