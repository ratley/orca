import type { Command } from "commander";

import { checkGhCli, runGh } from "../../../utils/gh.js";
import {
  type PrCommandOptions,
  buildPrBody,
  buildPrTitle,
  createStore,
  loadRunOrExit,
  printGhMissingAndExit,
  resolveRunIdOrExit
} from "./shared.js";

function parsePrUrl(stdout: string): string | null {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.at(-1) ?? null;
}

export async function prCreateCommandHandler(options: PrCommandOptions): Promise<void> {
  const runId = await resolveRunIdOrExit(options, "create");
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

  const title = buildPrTitle(run);
  const body = buildPrBody(run);
  const result = await runGh(["pr", "create", "--title", title, "--body", body]);

  if (result.exitCode !== 0) {
    console.error(result.stderr || result.stdout || "Failed to create PR.");
    process.exitCode = 1;
    return;
  }

  const url = parsePrUrl(result.stdout);
  if (!url) {
    console.error("PR created, but URL could not be determined.");
    process.exitCode = 1;
    return;
  }

  const store = createStore();
  await store.updateRun(runId, {
    pr: {
      ...run.pr,
      url,
      draftTitle: title,
      draftBody: body,
      readyForFinalize: true
    }
  });

  console.log(url);
}

export function registerPrCreateCommand(program: Command): void {
  program
    .command("create")
    .description("Create a pull request for a run")
    .option("--run <run-id>", "Run ID to create PR for")
    .option("--config <path>", "Path to orca config file")
    .action(async (options: PrCommandOptions) => prCreateCommandHandler(options));
}
