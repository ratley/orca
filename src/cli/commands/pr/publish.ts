import type { Command } from "commander";

import { checkGhCli, runGh } from "../../../utils/gh.js";
import {
  type PrCommandOptions,
  createStore,
  loadRunOrExit,
  printGhMissingAndExit,
  resolveRunIdOrExit,
} from "./shared.js";

export async function prPublishCommandHandler(options: PrCommandOptions): Promise<void> {
  const runId = await resolveRunIdOrExit(options, "publish");
  if (!runId) {
    return;
  }

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
  await store.updateRun(runId, {
    pr: {
      ...run.pr,
      readyForFinalize: true,
      finalizedAt: new Date().toISOString(),
    },
  });

  console.log(`PR marked ready for review: ${run.pr.url}`);
}

export function registerPrPublishCommand(program: Command): void {
  program
    .command("publish")
    .description("Publish a draft PR (mark ready for review)")
    .option("--run <run-id>", "Run ID to publish PR for")
    .option("--last", "Use the most recent run")
    .option("--config <path>", "Path to orca config file")
    .action(async (options: PrCommandOptions) => prPublishCommandHandler(options));
}
