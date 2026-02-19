import type { Command } from "commander";

import { checkGhCli, runGh } from "../../../utils/gh.js";
import { type PrCommandOptions, createStore, loadRunOrExit, printGhMissingAndExit } from "./shared.js";

export async function prFinalizeCommandHandler(options: PrCommandOptions): Promise<void> {
  const run = await loadRunOrExit(options);
  if (!run) {
    return;
  }

  if (!(await checkGhCli())) {
    printGhMissingAndExit();
    return;
  }

  if (!run.pr?.url) {
    console.error("No PR found for this run. Use `orca pr draft` or `orca pr create` first.");
    process.exitCode = 1;
    return;
  }

  const result = await runGh(["pr", "ready", run.pr.url]);
  if (result.exitCode !== 0) {
    console.error(result.stderr || result.stdout || "Failed to mark PR ready for review.");
    process.exitCode = 1;
    return;
  }

  const store = createStore();
  await store.updateRun(options.run, {
    pr: {
      ...run.pr,
      readyForFinalize: true,
      finalizedAt: new Date().toISOString()
    }
  });

  console.log(`PR marked ready for review: ${run.pr.url}`);
}

export function registerPrFinalizeCommand(program: Command): void {
  program
    .command("finalize")
    .description("Promote a draft PR to ready for review")
    .requiredOption("--run <run-id>", "Run ID to finalize PR for")
    .option("--config <path>", "Path to orca config file")
    .action(async (options: PrCommandOptions) => prFinalizeCommandHandler(options));
}
