import chalk from "chalk";
import type { Command } from "commander";

const HELP_COLUMN_WIDTH = 40;

type HelpSectionEntry = {
  command: string;
  description: string;
};

function formatHelpLine(command: string, description: string): string {
  return `  ${chalk.cyan(command.padEnd(HELP_COLUMN_WIDTH, " "))}${chalk.dim(description)}`;
}

function printSection(title: string, entries: HelpSectionEntry[]): void {
  console.log(chalk.bold(title));
  for (const entry of entries) {
    console.log(formatHelpLine(entry.command, entry.description));
  }
  console.log("");
}

function printStyledHelpPage(): void {
  console.log("orca — coordinated codex run harness");
  console.log("");

  printSection("RUNNING", [
    { command: 'orca "add auth to the app"', description: "run with inline goal" },
    { command: "orca --plan ./specs/feature.md", description: "run from plan file" },
    { command: "orca plan --spec ./specs/feature.md", description: "plan only, no execution" }
  ]);

  printSection("RUN MANAGEMENT", [
    { command: "orca status", description: "list all runs" },
    { command: "orca status --last", description: "show most recent run" },
    { command: "orca status --run <id>", description: "show run details" },
    { command: "orca resume --last", description: "resume most recent run" },
    { command: "orca resume --run <id>", description: "resume incomplete run" },
    { command: "orca cancel --run <id>", description: "cancel active run" }
  ]);

  printSection("SETUP", [{ command: "orca setup", description: "first-time setup and Codex environment checks" }]);

  printSection("FLAGS", [
    { command: "-p, --prompt <text>", description: "inline task goal (alias: --task)" },
    { command: "--plan, --spec <path>", description: "path to spec or plan file" },
    { command: "--run <id>", description: "specify run by ID" },
    { command: "--last", description: "use the most recent run" },
    { command: "--config <path>", description: "explicit config file (auto-discovered by default)" },
    { command: "--codex-only", description: "override executor to Codex for the current run" },
    { command: "--codex-effort <value>", description: "override Codex effort for the current run" },
    { command: "--full-auto", description: "skip all questions, proceed autonomously" },
    { command: "--on-complete <cmd>", description: "shell hook on run complete" },
    { command: "--on-error <cmd>", description: "shell hook on run error" },
    { command: "-h, --help", description: "show help for any command" },
    { command: "-V, --version", description: "show version" }
  ]);
}

function findCommand(program: Command, pathText: string): Command | undefined {
  const segments = pathText.split(" ").map((segment) => segment.trim()).filter((segment) => segment.length > 0);
  let current: Command | undefined = program;
  for (const segment of segments) {
    current = current.commands.find((command) => command.name() === segment);
    if (!current) return undefined;
  }
  return current;
}

export function registerHelpCommand(program: Command): void {
  program.addHelpCommand(false);
  program.command("help [command]").description("display help for command").action((commandPath?: string) => {
    if (!commandPath) {
      printStyledHelpPage();
      return;
    }

    const target = findCommand(program, commandPath);
    if (!target) {
      console.error(`error: unknown command '${commandPath}'`);
      process.exitCode = 1;
      return;
    }

    target.outputHelp();
  });
}
