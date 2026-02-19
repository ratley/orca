import type { Command } from "commander";

import { checkGhCli, runGh } from "../../../utils/gh.js";
import { type PrCommandOptions, loadRunOrExit, printGhMissingAndExit, resolveRunIdOrExit } from "./shared.js";

interface GhPrStatusCheck {
  name?: string;
  status?: string;
  conclusion?: string | null;
  state?: string;
  context?: string;
}

interface GhPrStatusView {
  state?: string;
  title?: string;
  url?: string;
  statusCheckRollup?: GhPrStatusCheck[] | null;
}

function stringifyCheckStatus(check: GhPrStatusCheck): string {
  const primary = check.status ?? check.state ?? "UNKNOWN";
  const conclusion = check.conclusion ? `/${check.conclusion}` : "";
  return `${primary}${conclusion}`;
}

function checkName(check: GhPrStatusCheck): string {
  return check.name ?? check.context ?? "unnamed-check";
}

export async function prStatusCommandHandler(options: PrCommandOptions): Promise<void> {
  if (!(await resolveRunIdOrExit(options, "status"))) {
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
    console.error("No PR associated with this run.");
    process.exitCode = 1;
    return;
  }

  const result = await runGh(["pr", "view", run.pr.url, "--json", "state,statusCheckRollup,title,url"]);
  if (result.exitCode !== 0) {
    console.error(result.stderr || result.stdout || "Failed to load PR status.");
    process.exitCode = 1;
    return;
  }

  let parsed: GhPrStatusView;
  try {
    parsed = JSON.parse(result.stdout) as GhPrStatusView;
  } catch {
    console.error("Failed to parse PR status output.");
    process.exitCode = 1;
    return;
  }

  console.log(`Title: ${parsed.title ?? "-"}`);
  console.log(`State: ${parsed.state ?? "-"}`);
  console.log(`URL: ${parsed.url ?? run.pr.url}`);
  console.log("Checks:");

  const checks = parsed.statusCheckRollup ?? [];
  if (checks.length === 0) {
    console.log("- (none)");
    return;
  }

  for (const check of checks) {
    console.log(`- ${checkName(check)}: ${stringifyCheckStatus(check)}`);
  }
}

export function registerPrStatusCommand(program: Command): void {
  program
    .command("status")
    .description("Show pull request status for a run")
    .option("--run <run-id>", "Run ID to inspect PR for")
    .option("--last", "Use the most recent run")
    .option("--config <path>", "Path to orca config file")
    .action(async (options: PrCommandOptions) => prStatusCommandHandler(options));
}
