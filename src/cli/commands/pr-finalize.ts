import type { Command } from "commander";

export interface PrFinalizeCommandOptions {
  run: string;
  config?: string;
}

export async function prFinalizeCommandHandler(_options: PrFinalizeCommandOptions): Promise<void> {
  console.log("not yet implemented");
}

export function registerPrFinalizeCommand(program: Command): void {
  program
    .command("pr-finalize")
    .description("Finalize a prepared pull request")
    .requiredOption("--run <run-id>", "Run ID to finalize PR for")
    .option("--config <path>", "Path to orca config file")
    .action(async (options: PrFinalizeCommandOptions) => prFinalizeCommandHandler(options));
}
