import { constants as fsConstants } from "node:fs";
import { access, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { Command } from "commander";

import { createCodexSession } from "../../agents/codex/session.js";
import { ensureCodexMultiAgent } from "../../core/codex-config.js";
import { resolveConfig } from "../../core/config-loader.js";
import { runPlanner } from "../../core/planner.js";
import { runTaskRunner } from "../../core/task-runner.js";
import { createOpenclawHookHandler, detectOpenclawAvailability } from "../../hooks/adapters/openclaw.js";
import { createStdoutHookHandler } from "../../hooks/adapters/stdout.js";
import { HookDispatcher } from "../../hooks/dispatcher.js";
import { RunStore } from "../../state/store.js";
import type { HookEvent, HookName, OrcaConfig } from "../../types/index.js";
import { generateRunId } from "../../utils/ids.js";

export interface RunCommandOptions {
  spec?: string;
  plan?: string;
  task?: string;
  prompt?: string;
  goal?: string;
  config?: string;
  codexOnly?: boolean;
  claudeOnly?: boolean;
  onMilestone?: string;
  onTaskComplete?: string;
  onTaskFail?: string;
  onComplete?: string;
  onError?: string;
}

const ALL_HOOKS: HookName[] = [
  "onMilestone",
  "onTaskComplete",
  "onTaskFail",
  "onComplete",
  "onError"
];
const VALID_HOOK_NAMES = new Set<HookName>([
  "onMilestone",
  "onTaskComplete",
  "onTaskFail",
  "onComplete",
  "onError"
]);

function isHookName(value: string): value is HookName {
  return VALID_HOOK_NAMES.has(value as HookName);
}

function createStore(): RunStore {
  const runsDir = process.env.ORCA_RUNS_DIR;
  return runsDir ? new RunStore(runsDir) : new RunStore();
}

function computeFinalStatus(overallStatus: string, allTasksDone: boolean): "completed" | "failed" | "cancelled" {
  if (overallStatus === "cancelled") {
    return "cancelled";
  }

  return allTasksDone ? "completed" : "failed";
}

function buildCliCommandHooks(options: RunCommandOptions): Partial<Record<HookName, string>> {
  return {
    ...(options.onMilestone ? { onMilestone: options.onMilestone } : {}),
    ...(options.onTaskComplete ? { onTaskComplete: options.onTaskComplete } : {}),
    ...(options.onTaskFail ? { onTaskFail: options.onTaskFail } : {}),
    ...(options.onComplete ? { onComplete: options.onComplete } : {}),
    ...(options.onError ? { onError: options.onError } : {})
  };
}

function applyExecutorOverrideForRun(
  config: OrcaConfig | undefined,
  options: Pick<RunCommandOptions, "codexOnly" | "claudeOnly">
): OrcaConfig | undefined {
  if (!options.codexOnly && !options.claudeOnly) {
    return config;
  }

  const executor: OrcaConfig["executor"] = options.codexOnly ? "codex" : "claude";
  return { ...config, executor };
}

export async function runCommandHandler(options: RunCommandOptions): Promise<void> {
  if (options.codexOnly && options.claudeOnly) {
    throw new Error("--codex-only and --claude-only are mutually exclusive; choose only one executor override.");
  }

  const inlineTask = options.task ?? options.prompt ?? options.goal;
  const inputSpecPath = options.spec ?? options.plan;

  if (options.goal !== undefined && (options.task || options.prompt)) {
    throw new Error("positional goal and --task/--prompt are mutually exclusive");
  }

  if (options.goal !== undefined && inputSpecPath) {
    throw new Error("positional goal and --spec/--plan are mutually exclusive");
  }

  if (!inputSpecPath && !inlineTask) {
    throw new Error("One of --spec, --task, or --prompt (-p) must be provided.");
  }

  if (inputSpecPath && inlineTask) {
    throw new Error("--spec is mutually exclusive with --task / --prompt.");
  }

  const usesInlineTask = Boolean(inlineTask);
  const specPath = usesInlineTask
    ? path.join(os.tmpdir(), `orca-task-${Date.now()}-${randomUUID()}.md`)
    : path.resolve(inputSpecPath ?? "");

  if (usesInlineTask) {
    await writeFile(specPath, `${inlineTask}\n`, "utf8");
  }

  try {
    await access(specPath, fsConstants.R_OK).catch(() => {
      throw new Error(`Spec file not found or not readable: ${specPath}`);
    });

    const orcaConfig = await resolveConfig(options.config);
    const effectiveConfig = applyExecutorOverrideForRun(orcaConfig, options);

    const runId = generateRunId(specPath);
    console.log(`Run ID: ${runId}`);

    const store = createStore();
    await store.createRun(runId, specPath);

    await runPlanner(specPath, store, runId, effectiveConfig);
    await store.updateRun(runId, {
      mode: "run",
      overallStatus: "running"
    });

    const cliCommandHooks = buildCliCommandHooks(options);
    const dispatcher = new HookDispatcher({
      commandHooks: {
        ...orcaConfig?.hookCommands,
        ...cliCommandHooks
      }
    });

    const openclawAvailability = detectOpenclawAvailability();
    if (openclawAvailability.available) {
      const handler = createOpenclawHookHandler();
      for (const hookName of ALL_HOOKS) {
        dispatcher.on(hookName, handler);
      }
    } else {
      if (openclawAvailability.warning) {
        console.error(openclawAvailability.warning);
      }

      const handler = createStdoutHookHandler();
      for (const hookName of ALL_HOOKS) {
        dispatcher.on(hookName, handler);
      }
    }

    if (orcaConfig?.hooks) {
      for (const [hookName, handler] of Object.entries(orcaConfig.hooks)) {
        if (!isHookName(hookName)) {
          console.error(`Warning: ignoring unknown hook name in config: ${hookName}`);
          continue;
        }

        if (typeof handler !== "function") {
          console.error(
            `Warning: ignoring invalid hook handler for ${hookName}; expected function, got ${typeof handler}`
          );
          continue;
        }

        dispatcher.on(hookName, handler);
      }
    }

    const emitHook = async (event: HookEvent): Promise<void> => {
      await dispatcher.dispatch(event);
    };

    const executor = effectiveConfig?.executor ?? "codex";
    if (executor === "codex") {
      const cwd = process.cwd();

      const multiAgentResult = await ensureCodexMultiAgent(effectiveConfig);
      if (multiAgentResult.action === "created" || multiAgentResult.action === "appended") {
        console.log(`Multi-agent: enabled (updated ${multiAgentResult.path})`);
      }

      const codexSession = await createCodexSession(cwd, effectiveConfig);

      try {
        // Phase 4: Codex consults the task graph before execution begins.
        const plannedRun = await store.getRun(runId);
        if (!plannedRun) {
          throw new Error(`Run not found after planning: ${runId}`);
        }

        console.log("Phase 4: Codex reviewing task graph...");
        const consultation = await codexSession.consultTaskGraph(plannedRun.tasks);
        if (consultation.issues.length > 0) {
          console.log("Codex consultation issues:");
          for (const issue of consultation.issues) {
            console.log(`  - ${issue}`);
          }
        }

        if (!consultation.ok) {
          console.error("Codex flagged the task graph as not OK. Aborting.");
          await store.updateRun(runId, { overallStatus: "failed" });
          return;
        }

        console.log("Codex consultation passed. Starting execution...");

        await runTaskRunner({
          runId,
          store,
          ...(effectiveConfig ? { config: effectiveConfig } : {}),
          emitHook,
          executeTask: (task, taskRunId, _config, systemContext) =>
            codexSession.executeTask(task, taskRunId, systemContext),
        });

        const reviewText = await codexSession.reviewChanges();
        console.log("Codex post-execution review:");
        console.log(reviewText);
      } finally {
        await codexSession.disconnect();
      }
    } else {
      console.log("Phase 4: Skipping Codex consultation because executor is set to Claude.");
      await runTaskRunner({
        runId,
        store,
        ...(effectiveConfig ? { config: effectiveConfig } : {}),
        emitHook
      });
    }

    const run = await store.getRun(runId);
    if (!run) {
      throw new Error(`Run not found after execution: ${runId}`);
    }

    const finalStatus = computeFinalStatus(
      run.overallStatus,
      run.tasks.length > 0 && run.tasks.every((task) => task.status === "done")
    );

    await store.updateRun(runId, {
      overallStatus: finalStatus
    });

    const refreshed = await store.getRun(runId);
    if (!refreshed) {
      throw new Error(`Run missing after final status write: ${runId}`);
    }

    console.log(`Overall status: ${refreshed.overallStatus}`);
    console.log(`Run dir: ${store.getRunDir(runId)}`);
  } finally {
    if (usesInlineTask) {
      await unlink(specPath).catch(() => {
        // Best-effort cleanup for temp spec files.
      });
    }
  }
}

export function registerRunCommand(program: Command): void {
  program
    .command("run [goal]", { isDefault: true })
    .description("Run pre-planning and execution")
    .option("--spec <path>", "Path to spec markdown file")
    .option("--plan <path>", "Alias for --spec — path to a plan/spec file")
    .option("--task <text>", "Inline task text (alternative to --spec)")
    .option("-p, --prompt <text>", "Inline task text (alias for --task)")
    .option("--config <path>", "Path to orca config file")
    .option("--codex-only", "Force Codex executor for this run (overrides config)")
    .option("--claude-only", "Force Claude executor for this run (overrides config)")
    .option("--on-milestone <cmd>", "Shell hook command for onMilestone")
    .option("--on-task-complete <cmd>", "Shell hook command for onTaskComplete")
    .option("--on-task-fail <cmd>", "Shell hook command for onTaskFail")
    .option("--on-complete <cmd>", "Shell hook command for onComplete")
    .option("--on-error <cmd>", "Shell hook command for onError")
    .action(async (goal: string | undefined, commandOptions: RunCommandOptions) => {
      try {
        const normalizedOptions: RunCommandOptions = {
          ...commandOptions,
          ...(goal !== undefined ? { goal } : {})
        };

        if (normalizedOptions.codexOnly && normalizedOptions.claudeOnly) {
          console.error("Error: --codex-only and --claude-only are mutually exclusive; choose only one.");
          process.exitCode = 1;
          return;
        }

        const inlineTask = normalizedOptions.task ?? normalizedOptions.prompt ?? normalizedOptions.goal;
        const inputSpecPath = normalizedOptions.spec ?? normalizedOptions.plan;

        if (normalizedOptions.goal !== undefined && (normalizedOptions.task || normalizedOptions.prompt)) {
          console.error("Error: positional goal and --task/--prompt are mutually exclusive.");
          process.exitCode = 1;
          return;
        }

        if (normalizedOptions.goal !== undefined && inputSpecPath) {
          console.error("Error: positional goal and --spec/--plan are mutually exclusive.");
          process.exitCode = 1;
          return;
        }

        if (!inputSpecPath && !inlineTask) {
          console.error("Error: one of --spec, --task, or --prompt (-p) must be provided.");
          process.exitCode = 1;
          return;
        }

        if (inputSpecPath && inlineTask) {
          console.error("Error: --spec is mutually exclusive with --task / --prompt.");
          process.exitCode = 1;
          return;
        }

        await runCommandHandler(normalizedOptions);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    });
}
