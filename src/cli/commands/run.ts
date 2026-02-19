import type { Command } from "commander";

export interface RunCommandOptions {
  spec: string;
  config?: string;
  onMilestone?: string;
  onTaskComplete?: string;
  onTaskFail?: string;
  onComplete?: string;
  onError?: string;
}

export async function runCommandHandler(_options: RunCommandOptions): Promise<void> {
  console.log("not yet implemented");
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
