import type { Command } from "commander";

export interface StatusCommandOptions {
  run?: string;
  config?: string;
}

export async function statusCommandHandler(_options: StatusCommandOptions): Promise<void> {
  console.log("not yet implemented");
}

export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description("Show run status or list all runs")
    .option("--run <run-id>", "Run ID to inspect")
    .option("--config <path>", "Path to orca config file")
    .action(async (options: StatusCommandOptions) => statusCommandHandler(options));
}
