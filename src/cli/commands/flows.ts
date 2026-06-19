import type { Command } from "commander";

import { resolveConfig } from "../../core/config-loader.js";
import { listFlowPresets, type FlowPresetSummary } from "../../core/flow-config.js";

export interface FlowsCommandOptions {
  config?: string;
  json?: boolean;
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

function formatFlowsTable(flows: FlowPresetSummary[]): string {
  return formatTable(
    ["Name", "Default", "Description"],
    flows.map((flow) => [
      flow.name,
      flow.default ? "yes" : "",
      flow.description ?? ""
    ])
  );
}

export async function flowsCommandHandler(options: FlowsCommandOptions): Promise<void> {
  const config = await resolveConfig(options.config);
  const flows = listFlowPresets(config);

  if (options.json) {
    console.log(JSON.stringify(flows, null, 2));
    return;
  }

  if (flows.length === 0) {
    console.log("No flows configured.");
    return;
  }

  console.log(formatFlowsTable(flows));
}

export function registerFlowsCommand(program: Command): void {
  program
    .command("flows")
    .description("List configured flow presets")
    .option("--config <path>", "Path to orca config file")
    .option("--json", "Output flow presets as JSON")
    .action(async (options: FlowsCommandOptions) => flowsCommandHandler(options));
}
