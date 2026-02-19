import type { Command } from "commander";

import { runGh, checkGhCli } from "../../../utils/gh.js";
import {
  type PrCommandOptions,
  buildPrBody,
  buildPrTitle,
  createStore,
  loadRunOrExit,
  printGhMissingAndExit
} from "./shared.js";

function parsePrUrl(stdout: string): string | null {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.at(-1) ?? null;
}

export async function prDraftCommandHandler(options: PrCommandOptions): Promise<void> {
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
  const result = await runGh(["pr", "create", "--draft", "--title", title, "--body", body]);

  if (result.exitCode !== 0) {
    console.error(result.stderr || result.stdout || "Failed to create draft PR.");
    process.exitCode = 1;
    return;
  }

  const url = parsePrUrl(result.stdout);
  if (!url) {
    console.error("Draft PR created, but URL could not be determined.");
    process.exitCode = 1;
    return;
  }

  const store = createStore();
  await store.updateRun(options.run, {
    pr: {
      ...run.pr,
      url,
      draftTitle: title,
      draftBody: body,
      readyForFinalize: false
    }
  });

  console.log(url);
}

export function registerPrDraftCommand(program: Command): void {
  program
    .command("draft")
    .description("Create a draft pull request for a run")
    .requiredOption("--run <run-id>", "Run ID to create draft PR for")
    .option("--config <path>", "Path to orca config file")
    .action(async (options: PrCommandOptions) => prDraftCommandHandler(options));
}
