import type { Command } from "commander";

import { RunStore } from "../../state/store.js";
import type { RunStatus } from "../../types/index.js";

export interface ListCommandOptions {
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

function toSummaryRow(run: RunStatus): string[] {
  return [run.runId, run.specPath, run.overallStatus, run.createdAt];
}

export function formatRunSummaryTable(runs: RunStatus[]): string {
  const headers = ["Run ID", "Spec", "Status", "Started"];
  const rows = runs.map(toSummaryRow);
  return formatTable(headers, rows);
}

export async function listRuns(): Promise<RunStatus[]> {
  const store = createStore();
  return await store.listRuns();
}

export async function listCommandHandler(_options: ListCommandOptions): Promise<void> {
  const runs = await listRuns();

  if (runs.length === 0) {
    console.log("No runs found.");
    return;
  }

  console.log(formatRunSummaryTable(runs));
}

export function registerListCommand(program: Command): void {
  program
    .command("list")
    .description("List all runs in run store")
    .option("--config <path>", "Path to orca config file")
    .action(async (options: ListCommandOptions) => listCommandHandler(options));
}
