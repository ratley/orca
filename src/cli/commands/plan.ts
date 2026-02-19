import type { Command } from "commander";

export interface PlanCommandOptions {
  spec: string;
  config?: string;
  onMilestone?: string;
  onError?: string;
}

export async function planCommandHandler(_options: PlanCommandOptions): Promise<void> {
  console.log("not yet implemented");
}

export function registerPlanCommand(program: Command): void {
  program
    .command("plan")
    .description("Run pre-planning and output validated task graph")
    .requiredOption("--spec <path>", "Path to spec markdown file")
    .option("--config <path>", "Path to orca config file")
    .option("--on-milestone <cmd>", "Shell hook command for onMilestone")
    .option("--on-error <cmd>", "Shell hook command for onError")
    .action(async (options: PlanCommandOptions) => planCommandHandler(options));
}
