#!/usr/bin/env node
import { program } from "commander";
import { runCommand } from "./commands/run.js";
import { planCommand } from "./commands/plan.js";
import { statusCommand } from "./commands/status.js";
import { listCommand } from "./commands/list.js";
import { resumeCommand } from "./commands/resume.js";
import { cancelCommand } from "./commands/cancel.js";
import { prFinalizeCommand } from "./commands/pr-finalize.js";

program
  .name("orca")
  .description("Agent harness — Claude orchestrator, Codex consultation, extensible hooks")
  .version("0.1.0");

program
  .command("run")
  .description("Run planning + execution on a spec")
  .requiredOption("--spec <path>", "Path to spec markdown file")
  .option("--config <path>", "Path to orca.config.ts")
  .action(runCommand);

program
  .command("plan")
  .description("Plan only (no execution)")
  .requiredOption("--spec <path>", "Path to spec markdown file")
  .option("--config <path>", "Path to orca.config.ts")
  .action(planCommand);

program
  .command("status")
  .description("Show status of runs")
  .option("--run <id>", "Specific run ID (lists all if omitted)")
  .action(statusCommand);

program
  .command("list")
  .description("List all runs in run store")
  .action(listCommand);

program
  .command("resume")
  .description("Resume a stopped/incomplete run")
  .requiredOption("--run <id>", "Run ID to resume")
  .action(resumeCommand);

program
  .command("cancel")
  .description("Cancel a running process")
  .requiredOption("--run <id>", "Run ID to cancel")
  .action(cancelCommand);

program
  .command("pr")
  .description("PR management")
  .command("finalize")
  .description("Finalize and create a PR")
  .requiredOption("--run <id>", "Run ID to finalize")
  .action(prFinalizeCommand);

program.parse();
