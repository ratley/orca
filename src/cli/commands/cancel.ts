import type { Command } from "commander";

export interface CancelCommandOptions {
  run: string;
  config?: string;
}

export async function cancelCommandHandler(_options: CancelCommandOptions): Promise<void> {
  console.log("not yet implemented");
}

export function registerCancelCommand(program: Command): void {
  program
    .command("cancel")
    .description("Cancel an active run")
    .requiredOption("--run <run-id>", "Run ID to cancel")
    .option("--config <path>", "Path to orca config file")
    .action(async (options: CancelCommandOptions) => cancelCommandHandler(options));
}
