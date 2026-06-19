import { constants as fsConstants } from "node:fs";
import { access, mkdir, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { InvalidArgumentError, type Command } from "commander";

import { createCodexSession } from "../../agents/codex/session.js";
import { ensureCodexMultiAgent } from "../../core/codex-config.js";
import { resolveConfig } from "../../core/config-loader.js";
import { formatFlowInstructions, resolveSelectedFlowConfig } from "../../core/flow-config.js";
import { InvalidPlanError, runPlanner } from "../../core/planner.js";
import { resolveTaskRunnerParallelism, runTaskRunner } from "../../core/task-runner.js";
import { createOpenclawHookHandler, detectOpenclawAvailability } from "../../hooks/adapters/openclaw.js";
import { createStdoutHookHandler } from "../../hooks/adapters/stdout.js";
import { HookDispatcher } from "../../hooks/dispatcher.js";
import { RunStore } from "../../state/store.js";
import type { HookEvent, HookHandler, HookName, OrcaConfig } from "../../types/index.js";
import { parseCodexEffort, type CodexEffort } from "../../types/effort.js";
import { generateRunId } from "../../utils/ids.js";
import { buildReviewCompletedTaskOption, runPostExecutionReview } from "./review-runner.js";
import { readCodexAuthJson } from "./setup.js";

export interface RunCommandOptions {
  spec?: string;
  plan?: string;
  task?: string;
  prompt?: string;
  goal?: string;
  config?: string;
  flow?: string;
  codexOnly?: boolean;
  codexEffort?: CodexEffort;
  onMilestone?: string;
  onQuestion?: string;
  onTaskComplete?: string;
  onTaskFail?: string;
  onInvalidPlan?: string;
  onFindings?: string;
  onComplete?: string;
  onError?: string;
}

const ALL_HOOKS: HookName[] = [
  "onMilestone",
  "onQuestion",
  "onTaskComplete",
  "onTaskFail",
  "onInvalidPlan",
  "onFindings",
  "onComplete",
  "onError"
];
const VALID_HOOK_NAMES = new Set<HookName>([
  "onMilestone",
  "onQuestion",
  "onTaskComplete",
  "onTaskFail",
  "onInvalidPlan",
  "onFindings",
  "onComplete",
  "onError"
]);

function isHookName(value: string): value is HookName {
  return VALID_HOOK_NAMES.has(value as HookName);
}

function parseCodexEffortOption(value: string): CodexEffort {
  try {
    return parseCodexEffort(value);
  } catch (error) {
    throw new InvalidArgumentError(error instanceof Error ? error.message : String(error));
  }
}

function createStore(): RunStore {
  const runsDir = process.env.ORCA_RUNS_DIR;
  return runsDir ? new RunStore(runsDir) : new RunStore();
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export async function maybeCreateFirstRunGlobalConfig(homedir: string = os.homedir()): Promise<void> {
  const globalJsConfigPath = path.join(homedir, ".orca", "config.js");
  const globalTsConfigPath = path.join(homedir, ".orca", "config.ts");
  const projectJsConfigPath = path.join(process.cwd(), "orca.config.js");
  const projectTsConfigPath = path.join(process.cwd(), "orca.config.ts");

  const hasAnyConfig = (await pathExists(globalJsConfigPath))
    || (await pathExists(globalTsConfigPath))
    || (await pathExists(projectJsConfigPath))
    || (await pathExists(projectTsConfigPath));

  if (hasAnyConfig) {
    return;
  }

  await mkdir(path.dirname(globalJsConfigPath), { recursive: true });
  await writeFile(globalJsConfigPath, "export default {\n  executor: \"codex\"\n};\n", "utf8");
  console.log("✓ Created ~/.orca/config.js (first run defaults)");
}

function computeFinalStatus(overallStatus: string, allTasksDone: boolean): "completed" | "failed" | "cancelled" {
  if (overallStatus === "cancelled") {
    return "cancelled";
  }

  if (overallStatus === "failed") {
    return "failed";
  }

  return allTasksDone ? "completed" : "failed";
}

function buildCliCommandHooks(options: RunCommandOptions): Partial<Record<HookName, string>> {
  return {
    ...(options.onMilestone ? { onMilestone: options.onMilestone } : {}),
    ...(options.onQuestion ? { onQuestion: options.onQuestion } : {}),
    ...(options.onTaskComplete ? { onTaskComplete: options.onTaskComplete } : {}),
    ...(options.onTaskFail ? { onTaskFail: options.onTaskFail } : {}),
    ...(options.onInvalidPlan ? { onInvalidPlan: options.onInvalidPlan } : {}),
    ...(options.onFindings ? { onFindings: options.onFindings } : {}),
    ...(options.onComplete ? { onComplete: options.onComplete } : {}),
    ...(options.onError ? { onError: options.onError } : {})
  };
}

function isCodexAvailableForRun(env: NodeJS.ProcessEnv = process.env): boolean {
  const envOpenai = env.ORCA_OPENAI_API_KEY ?? env.OPENAI_API_KEY;
  if (typeof envOpenai === "string" && envOpenai.trim().length > 0) {
    return true;
  }

  const homeDir = typeof env.HOME === "string" && env.HOME.trim().length > 0 ? env.HOME : os.homedir();
  return Boolean(readCodexAuthJson(homeDir));
}

function applyExecutorOverrideForRun(
  config: OrcaConfig | undefined,
  options: Pick<RunCommandOptions, "codexOnly" | "codexEffort">
): OrcaConfig | undefined {
  const nextConfig: OrcaConfig = { ...config };

  if (options.codexOnly) {
    nextConfig.executor = "codex";
  }

  if (options.codexEffort !== undefined) {
    nextConfig.codex = { ...nextConfig.codex, effort: options.codexEffort };
  }

  if (config === undefined && Object.keys(nextConfig).length === 0) {
    return undefined;
  }

  return nextConfig;
}

export async function runCommandHandler(options: RunCommandOptions): Promise<void> {
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

    await maybeCreateFirstRunGlobalConfig();
    const selectedFlow = resolveSelectedFlowConfig(await resolveConfig(options.config), options.flow);
    const orcaConfig = selectedFlow.config;
    const effectiveConfig = applyExecutorOverrideForRun(orcaConfig, options);

    if (!isCodexAvailableForRun()) {
      console.error("Codex is unavailable. Set OPENAI_API_KEY (or ORCA_OPENAI_API_KEY) or configure ~/.codex/auth.json.");
      process.exitCode = 1;
      return;
    }

    const runId = generateRunId(specPath);
    console.log(`Run ID: ${runId}`);
    if (selectedFlow.name !== undefined) {
      console.log(`Flow: ${selectedFlow.name}`);
    }

    const store = createStore();
    await store.createRun(runId, specPath);
    if (selectedFlow.name !== undefined) {
      await store.updateRun(runId, { flowName: selectedFlow.name });
    }

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
      for (const [hookNameRaw, handler] of Object.entries(orcaConfig.hooks)) {
        if (!isHookName(hookNameRaw)) {
          console.error(`Warning: ignoring unknown hook name in config: ${hookNameRaw}`);
          continue;
        }

        if (typeof handler !== "function") {
          console.error(
            `Warning: ignoring invalid hook handler for ${hookNameRaw}; expected function, got ${typeof handler}`
          );
          continue;
        }

        const hookName = hookNameRaw as HookName;
        dispatcher.on(hookName, handler as HookHandler<typeof hookName>);
      }
    }

    const emitHook = async (event: HookEvent): Promise<void> => {
      await dispatcher.dispatch(event);
    };

    try {
      const planningFlowInstructions = formatFlowInstructions(selectedFlow, "planning");
      await runPlanner(specPath, store, runId, effectiveConfig, {
        allowPlanSkip: true,
        emitHook,
        ...(planningFlowInstructions !== undefined
          ? { systemContextSections: [planningFlowInstructions] }
          : {})
      });
    } catch (error) {
      if (error instanceof InvalidPlanError) {
        await emitHook({
          runId: runId as HookEvent["runId"],
          hook: "onInvalidPlan",
          message: `invalid-plan:${error.stage}`,
          timestamp: new Date().toISOString(),
          error: error.message,
          metadata: {
            stage: error.stage
          }
        });
      }

      throw error;
    }

    await store.updateRun(runId, {
      mode: "run",
      overallStatus: "running"
    });

    {
      const cwd = process.cwd();

      const multiAgentResult = await ensureCodexMultiAgent(effectiveConfig);
      if (multiAgentResult.action === "created" || multiAgentResult.action === "appended") {
        console.log(`Multi-agent: enabled (updated ${multiAgentResult.path})`);
      }
      const taskRunnerParallelism = await resolveTaskRunnerParallelism(effectiveConfig);
      const runnerUsesParallelSessions = taskRunnerParallelism > 1;

      const codexSession = await createCodexSession(cwd, effectiveConfig, {
        runId: runId as HookEvent["runId"],
        store,
        emitHook,
      });

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

        const executionFlowInstructions = formatFlowInstructions(selectedFlow, "execution");

        await runTaskRunner({
          runId: runId as HookEvent["runId"],
          store,
          ...(effectiveConfig ? { config: effectiveConfig } : {}),
          emitHook,
          ...(executionFlowInstructions !== undefined
            ? { systemContextSections: [executionFlowInstructions] }
            : {}),
          ...(!runnerUsesParallelSessions
            ? {
                executeTask: (task, taskRunId, _config, systemContext) =>
                  codexSession.executeTask(task, taskRunId, systemContext)
              }
            : {}),
          ...buildReviewCompletedTaskOption({
            cwd,
            runId: runId as HookEvent["runId"],
            store,
            ...(effectiveConfig ? { config: effectiveConfig } : {}),
            codexSession,
            runnerUsesParallelSessions,
            emitHook
          }),
        });

        await runPostExecutionReview({
          runId: runId as HookEvent["runId"],
          store,
          ...(effectiveConfig ? { config: effectiveConfig } : {}),
          selectedFlow,
          codexSession,
          emitHook
        });
      } finally {
        await codexSession.disconnect();
      }
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
    .option("--flow <name>", "Use a configured flow preset")
    .option("--codex-only", "Force Codex executor for this run (overrides config)")
    .option("--codex-effort <value>", "Codex thinking level override for this run", parseCodexEffortOption)
    .option("--on-milestone <cmd>", "Shell hook command for onMilestone")
    .option("--on-question <cmd>", "Shell hook command for onQuestion")
    .option("--on-task-complete <cmd>", "Shell hook command for onTaskComplete")
    .option("--on-task-fail <cmd>", "Shell hook command for onTaskFail")
    .option("--on-invalid-plan <cmd>", "Shell hook command for onInvalidPlan")
    .option("--on-findings <cmd>", "Shell hook command for onFindings")
    .option("--on-complete <cmd>", "Shell hook command for onComplete")
    .option("--on-error <cmd>", "Shell hook command for onError")
    .action(async (goal: string | undefined, commandOptions: RunCommandOptions) => {
      try {
        const normalizedOptions: RunCommandOptions = {
          ...commandOptions,
          ...(goal !== undefined ? { goal } : {})
        };

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
