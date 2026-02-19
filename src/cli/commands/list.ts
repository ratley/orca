import type { Command } from "commander";

export interface ListCommandOptions {
  config?: string;
}

export async function listCommandHandler(_options: ListCommandOptions): Promise<void> {
  console.log("not yet implemented");
}

export function registerListCommand(program: Command): void {
  program
    .command("list")
    .description("List all runs in run store")
    .option("--config <path>", "Path to orca config file")
    .action(async (options: ListCommandOptions) => listCommandHandler(options));
}
