#!/usr/bin/env node

import { createRequire } from "node:module";
import { Command } from "commander";

const require = createRequire(import.meta.url);
const { version } = require("../../package.json") as { version: string };

import { registerAnswerCommand } from "./commands/answer.js";
import { registerCancelCommand } from "./commands/cancel.js";
import { registerHelpCommand } from "./commands/help.js";
import { registerListCommand } from "./commands/list.js";
import { registerPrCommand } from "./commands/pr/index.js";
import { registerPlanCommand } from "./commands/plan.js";
import { registerPrFinalizeCommand } from "./commands/pr-finalize.js";
import { registerResumeCommand } from "./commands/resume.js";
import { registerRunCommand } from "./commands/run.js";
import { registerSetupCommand } from "./commands/setup.js";
import { registerSkillsCommand } from "./commands/skills.js";
import { registerStatusCommand } from "./commands/status.js";

const program = new Command();

program.name("orca").description("Orca CLI: coordinated agent run harness").version(version);

registerRunCommand(program);
registerAnswerCommand(program);
registerPlanCommand(program);
registerStatusCommand(program);
registerListCommand(program);
registerSkillsCommand(program);
registerResumeCommand(program);
registerCancelCommand(program);
registerPrCommand(program);
registerPrFinalizeCommand(program);
registerSetupCommand(program);
registerHelpCommand(program);

await program.parseAsync(process.argv);
