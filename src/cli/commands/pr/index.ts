import type { Command } from "commander";
import { select } from "@inquirer/prompts";

import { prCreateCommandHandler, registerPrCreateCommand } from "./create.js";
import { prDraftCommandHandler, registerPrDraftCommand } from "./draft.js";
import { prPublishCommandHandler, registerPrPublishCommand } from "./publish.js";
import { type PrCommandOptions, createStore } from "./shared.js";
import { prStatusCommandHandler, registerPrStatusCommand } from "./status.js";
import { selectRun } from "../../../utils/select-run.js";

export function registerPrCommand(program: Command): void {
  const prCommand = program.command("pr").description("Pull request workflow commands");

  registerPrDraftCommand(prCommand);
  registerPrCreateCommand(prCommand);
  registerPrPublishCommand(prCommand);
  registerPrStatusCommand(prCommand);

  prCommand
    .command("finalize")
    .description("Deprecated: use `orca pr publish`")
    .requiredOption("--run <run-id>", "")
    .action(async (options: PrCommandOptions) => prPublishCommandHandler(options));

  prCommand.action(async () => {
    if (!process.stdout.isTTY) {
      console.error("Usage: orca pr <draft|create|publish|status> --run <id>");
      process.exitCode = 1;
      return;
    }

    const store = createStore();
    const runId = await selectRun(store);
    if (!runId) {
      return;
    }

    const run = await store.getRun(runId);
    if (!run) {
      return;
    }

    if (run.pr?.url) {
      const state = run.pr.finalizedAt ? "published (ready for review)" : "draft";
      console.log(`PR: ${run.pr.url} [${state}]`);
    } else {
      console.log("No PR for this run yet.");
    }

    const action = await select({
      message: "What do you want to do?",
      choices: [
        { name: "Create draft PR", value: "draft" },
        { name: "Create PR (ready for review)", value: "create" },
        { name: "Publish draft → ready for review", value: "publish" },
        { name: "View PR status & CI checks", value: "status" },
      ],
    });

    const options = { run: runId };
    if (action === "draft") {
      await prDraftCommandHandler(options);
    } else if (action === "create") {
      await prCreateCommandHandler(options);
    } else if (action === "publish") {
      await prPublishCommandHandler(options);
    } else if (action === "status") {
      await prStatusCommandHandler(options);
    }
  });
}
