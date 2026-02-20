import { InvalidArgumentError, type Command } from "commander";

import { resolveConfig } from "../../core/config-loader.js";
import { runTaskRunner } from "../../core/task-runner.js";
import { RunStore } from "../../state/store.js";
import type { OrcaConfig, RunStatus } from "../../types/index.js";
import { parseClaudeEffort, parseCodexEffort, type ClaudeEffort, type CodexEffort } from "../../types/effort.js";
import { getLastRun } from "../../utils/last-run.js";

export interface ResumeCommandOptions {
  run?: string;
  last?: boolean;
  config?: string;
  codexOnly?: boolean;
  claudeOnly?: boolean;
  codexEffort?: CodexEffort;
  claudeEffort?: ClaudeEffort;
}

function createStore(): RunStore {
  const runsDir = process.env.ORCA_RUNS_DIR;
  return runsDir ? new RunStore(runsDir) : new RunStore();
}

function formatRunIds(runs: RunStatus[]): string {
  if (runs.length === 0) {
    return "(none)";
  }

  return runs.map((run) => run.runId).join(", ");
}

function getActiveRuns(runs: RunStatus[]): RunStatus[] {
  return runs.filter((run) => run.overallStatus === "planning" || run.overallStatus === "running");
}

function parseCodexEffortOption(value: string): CodexEffort {
  try {
    return parseCodexEffort(value);
  } catch (error) {
    throw new InvalidArgumentError(error instanceof Error ? error.message : String(error));
  }
}

function parseClaudeEffortOption(value: string): ClaudeEffort {
  try {
    return parseClaudeEffort(value);
  } catch (error) {
    throw new InvalidArgumentError(error instanceof Error ? error.message : String(error));
  }
}

function applyExecutorOverrideForResume(
  config: OrcaConfig | undefined,
  options: Pick<ResumeCommandOptions, "codexOnly" | "claudeOnly" | "codexEffort" | "claudeEffort">
): OrcaConfig | undefined {
  const nextConfig: OrcaConfig = { ...config };

  if (options.codexOnly || options.claudeOnly) {
    nextConfig.executor = options.codexOnly ? "codex" : "claude";
  }

  if (options.codexEffort !== undefined) {
    nextConfig.codex = { ...nextConfig.codex, effort: options.codexEffort };
  }

  if (options.claudeEffort !== undefined) {
    nextConfig.claude = { ...nextConfig.claude, effort: options.claudeEffort };
  }

  if (config === undefined && Object.keys(nextConfig).length === 0) {
    return undefined;
  }

  return nextConfig;
}

export async function resumeCommandHandler(options: ResumeCommandOptions): Promise<void> {
  if (options.codexOnly && options.claudeOnly) {
    throw new Error("--codex-only and --claude-only are mutually exclusive; choose only one executor override.");
  }

  const store = createStore();
  const resolvedConfig = await resolveConfig(options.config);
  const effectiveConfig = applyExecutorOverrideForResume(resolvedConfig, options);

  if (options.last) {
    const lastRun = await getLastRun(store);
    if (!lastRun) {
      console.error("No runs found.");
      process.exitCode = 1;
      return;
    }

    options.run = lastRun.runId;
  }

  const knownRuns = await store.listRuns();

  if (!options.run) {
    console.error(`Missing required --run <run-id>\nActive runs: ${formatRunIds(getActiveRuns(knownRuns))}`);
    process.exitCode = 1;
    return;
  }

  const run = await store.getRun(options.run);
  if (!run) {
    console.error(`Run not found: ${options.run}\nKnown run IDs: ${formatRunIds(knownRuns)}`);
    process.exitCode = 1;
    return;
  }

  if (run.overallStatus === "completed" || run.overallStatus === "cancelled") {
    console.error(`Run ${run.runId} is ${run.overallStatus} and cannot be resumed.`);
    process.exitCode = 1;
    return;
  }

  const resumedTasks = run.tasks.map((task) => {
    if (task.status === "in_progress") {
      return {
        ...task,
        status: "pending" as const,
        lastError: "Recovered from interrupted in_progress task"
      };
    }

    return task;
  });

  await store.updateRun(run.runId, {
    mode: "run",
    overallStatus: "running",
    tasks: resumedTasks
  });

  await runTaskRunner({
    runId: run.runId,
    store,
    ...(effectiveConfig ? { config: effectiveConfig } : {})
  });

  const refreshed = await store.getRun(run.runId);
  if (!refreshed) {
    throw new Error(`Run not found after resume: ${run.runId}`);
  }

  console.log(`Resumed run ${refreshed.runId}: ${refreshed.overallStatus}`);
}

export function registerResumeCommand(program: Command): void {
  program
    .command("resume")
    .description("Resume an incomplete run")
    .option("--run <run-id>", "Run ID to resume")
    .option("--last", "Use the most recent run")
    .option("--config <path>", "Path to orca config file")
    .option("--codex-only", "Force Codex executor for this resumed run (overrides config)")
    .option("--claude-only", "Force Claude executor for this resumed run (overrides config)")
    .option("--codex-effort <value>", "Codex effort override for this resumed run", parseCodexEffortOption)
    .option("--claude-effort <value>", "Claude effort override for this resumed run", parseClaudeEffortOption)
    .action(async (options: ResumeCommandOptions) => {
      try {
        await resumeCommandHandler(options);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    });
}
