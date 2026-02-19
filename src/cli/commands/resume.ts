import type { Command } from "commander";

export interface ResumeCommandOptions {
  run: string;
  config?: string;
}

export async function resumeCommandHandler(_options: ResumeCommandOptions): Promise<void> {
  console.log("not yet implemented");
}

export function registerResumeCommand(program: Command): void {
  program
    .command("resume")
    .description("Resume an incomplete run")
    .requiredOption("--run <run-id>", "Run ID to resume")
    .option("--config <path>", "Path to orca config file")
    .action(async (options: ResumeCommandOptions) => resumeCommandHandler(options));
}
