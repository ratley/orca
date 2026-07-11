#!/usr/bin/env node

import { createRequire } from "node:module";
import { Command } from "commander";

const require = createRequire(import.meta.url);
const { version } = require("../../package.json") as { version: string };

import { attachLaneHelp, runLaneCli } from "./lane-commands.js";
import { registerAnswerCommand } from "./commands/answer.js";
import { registerCancelCommand } from "./commands/cancel.js";
import { registerFlowsCommand } from "./commands/flows.js";
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
registerFlowsCommand(program);
registerResumeCommand(program);
registerCancelCommand(program);
registerPrCommand(program);
registerPrFinalizeCommand(program);
registerSetupCommand(program);
registerHelpCommand(program);

attachLaneHelp(program);

// Lane verbs (orca/v1 agent contract) run on their own program; "answer" and
// "resume" only route there when the id starts with "lane_", so the legacy
// commands above keep their behavior.
const laneCliExitCode = await runLaneCli(process.argv.slice(2));
if (laneCliExitCode === null) {
  await program.parseAsync(process.argv);
} else {
  process.exitCode = laneCliExitCode;
}
