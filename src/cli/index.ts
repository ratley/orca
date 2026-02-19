#!/usr/bin/env node

import { Command } from "commander";

import { registerCancelCommand } from "./commands/cancel.js";
import { registerListCommand } from "./commands/list.js";
import { registerPlanCommand } from "./commands/plan.js";
import { registerPrFinalizeCommand } from "./commands/pr-finalize.js";
import { registerResumeCommand } from "./commands/resume.js";
import { registerRunCommand } from "./commands/run.js";
import { registerSetupCommand } from "./commands/setup.js";
import { registerStatusCommand } from "./commands/status.js";

const program = new Command();

program.name("orca").description("Orca CLI: coordinated agent run harness").version("0.1.0");

registerRunCommand(program);
registerPlanCommand(program);
registerStatusCommand(program);
registerListCommand(program);
registerResumeCommand(program);
registerCancelCommand(program);
registerPrFinalizeCommand(program);
registerSetupCommand(program);

await program.parseAsync(process.argv);
