import type { Command } from "commander";

import { registerPrCreateCommand } from "./create.js";
import { registerPrDraftCommand } from "./draft.js";
import { registerPrFinalizeCommand } from "./finalize.js";
import { registerPrStatusCommand } from "./status.js";

export function registerPrCommand(program: Command): void {
  const prCommand = program
    .command("pr")
    .description("Pull request workflow commands");

  registerPrDraftCommand(prCommand);
  registerPrCreateCommand(prCommand);
  registerPrFinalizeCommand(prCommand);
  registerPrStatusCommand(prCommand);
}
