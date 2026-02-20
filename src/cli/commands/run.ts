import { constants as fsConstants } from "node:fs";
import { exec as execCallback } from "node:child_process";
import { access, readFile, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

import { InvalidArgumentError, type Command } from "commander";

import { createCodexSession } from "../../agents/codex/session.js";
import { ensureCodexMultiAgent } from "../../core/codex-config.js";
import { resolveConfig } from "../../core/config-loader.js";
import { InvalidPlanError, runPlanner } from "../../core/planner.js";
import { runTaskRunner } from "../../core/task-runner.js";
import { createOpenclawHookHandler, detectOpenclawAvailability } from "../../hooks/adapters/openclaw.js";
import { createStdoutHookHandler } from "../../hooks/adapters/stdout.js";
import { HookDispatcher } from "../../hooks/dispatcher.js";
import { RunStore } from "../../state/store.js";
import type { HookEvent, HookHandler, HookName, OrcaConfig } from "../../types/index.js";
import { parseClaudeEffort, parseCodexEffort, type ClaudeEffort, type CodexEffort } from "../../types/effort.js";
import { generateRunId } from "../../utils/ids.js";

const exec = promisify(execCallback);

type FindingsMode = "auto_fix" | "report_only" | "fail";

interface ValidationResult {
  command: string;
  exitCode: number;
  output: string;
}

interface ExecutionReviewResult {
  findings: string[];
  summary: string;
  fixed: boolean;
  rawResponse: string;
}

export interface RunCommandOptions {
  spec?: string;
  plan?: string;
  task?: string;
  prompt?: string;
  goal?: string;
  config?: string;
  codexOnly?: boolean;
  claudeOnly?: boolean;
  codexEffort?: CodexEffort;
  claudeEffort?: ClaudeEffort;
  onMilestone?: string;
  onTaskComplete?: string;
  onTaskFail?: string;
  onInvalidPlan?: string;
  onFindings?: string;
  onComplete?: string;
  onError?: string;
}

const ALL_HOOKS: HookName[] = [
  "onMilestone",
  "onTaskComplete",
  "onTaskFail",
  "onInvalidPlan",
  "onFindings",
  "onComplete",
  "onError"
];
const VALID_HOOK_NAMES = new Set<HookName>([
  "onMilestone",
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

function parseClaudeEffortOption(value: string): ClaudeEffort {
  try {
    return parseClaudeEffort(value);
  } catch (error) {
    throw new InvalidArgumentError(error instanceof Error ? error.message : String(error));
  }
}

function createStore(): RunStore {
  const runsDir = process.env.ORCA_RUNS_DIR;
  return runsDir ? new RunStore(runsDir) : new RunStore();
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
    ...(options.onTaskComplete ? { onTaskComplete: options.onTaskComplete } : {}),
    ...(options.onTaskFail ? { onTaskFail: options.onTaskFail } : {}),
    ...(options.onInvalidPlan ? { onInvalidPlan: options.onInvalidPlan } : {}),
    ...(options.onFindings ? { onFindings: options.onFindings } : {}),
    ...(options.onComplete ? { onComplete: options.onComplete } : {}),
    ...(options.onError ? { onError: options.onError } : {})
  };
}

function applyExecutorOverrideForRun(
  config: OrcaConfig | undefined,
  options: Pick<RunCommandOptions, "codexOnly" | "claudeOnly" | "codexEffort" | "claudeEffort">
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

function getExecutionReviewConfig(config?: OrcaConfig): {
  enabled: boolean;
  maxCycles: number;
  onFindings: FindingsMode;
  validatorAuto: boolean;
  validatorCommands?: string[];
  prompt?: string;
} {
  const review = (config?.review ?? {}) as OrcaConfig["review"] & { enabled?: boolean };
  const executionConfig = review.execution;
  const skipValidators = process.env.ORCA_SKIP_VALIDATORS === "1";
  return {
    enabled: executionConfig?.enabled ?? review.enabled ?? true,
    maxCycles: executionConfig?.maxCycles ?? 2,
    onFindings: executionConfig?.onFindings ?? "auto_fix",
    validatorAuto: skipValidators ? false : (executionConfig?.validator?.auto ?? true),
    ...(executionConfig?.validator?.commands !== undefined ? { validatorCommands: executionConfig.validator.commands } : {}),
    ...(executionConfig?.prompt !== undefined ? { prompt: executionConfig.prompt } : {})
  };
}

async function detectValidatorCommands(): Promise<string[]> {
  try {
    const packageJson = JSON.parse(await readFile(path.join(process.cwd(), "package.json"), "utf8")) as { scripts?: Record<string, string> };
    const scripts = packageJson.scripts ?? {};
    if (typeof scripts.validate === "string") {
      return ["npm run validate"];
    }

    const fallbacks = ["lint", "typecheck", "test", "build"].filter((name) => typeof scripts[name] === "string");
    return fallbacks.map((name) => `npm run ${name}`);
  } catch {
    return [];
  }
}

async function runValidatorCommands(commands: string[]): Promise<ValidationResult[]> {
  const results: ValidationResult[] = [];
  for (const command of commands) {
    try {
      const { stdout, stderr } = await exec(command, { cwd: process.cwd() });
      results.push({ command, exitCode: 0, output: `${stdout}${stderr}`.trim() });
    } catch (error) {
      const failed = error as { stdout?: string; stderr?: string; code?: number };
      results.push({
        command,
        exitCode: typeof failed.code === "number" ? failed.code : 1,
        output: `${failed.stdout ?? ""}${failed.stderr ?? ""}`.trim()
      });
    }
  }

  return results;
}

function buildPostExecutionReviewPrompt(cycleIndex: number, validationResults: ValidationResult[], extraPrompt?: string): string {
  return [
    "You are Orca's post-execution reviewer.",
    "Inspect uncommitted repository changes and validation command output.",
    "If there are fixable findings, apply fixes directly in the workspace before responding.",
    "Respond with JSON only using this exact shape:",
    '{"summary":"...","findings":["..."],"fixed":true|false}',
    `Cycle: ${cycleIndex}`,
    "Validation output:",
    JSON.stringify(validationResults, null, 2),
    ...(extraPrompt ? ["Additional reviewer instructions:", extraPrompt] : [])
  ].join("\n\n");
}

function parseExecutionReviewResult(raw: string): ExecutionReviewResult {
  const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (match?.[1] ?? raw).trim();

  try {
    const parsed = JSON.parse(candidate) as { summary?: unknown; findings?: unknown; fixed?: unknown };
    const findings = Array.isArray(parsed.findings) ? parsed.findings.filter((item): item is string => typeof item === "string") : [];

    return {
      findings,
      summary: typeof parsed.summary === "string" ? parsed.summary : (findings.length > 0 ? findings.join("; ") : "No findings."),
      fixed: parsed.fixed === true,
      rawResponse: raw
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      findings: [`review-response-parse-error: ${message}`],
      summary: `Post-execution reviewer returned invalid JSON (${message})`,
      fixed: false,
      rawResponse: raw
    };
  }
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
      await runPlanner(specPath, store, runId, effectiveConfig);
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

        const reviewConfig = getExecutionReviewConfig(effectiveConfig);
        const finalSummaries: string[] = [];
        const runAfterExecution = await store.getRun(runId);

        if (reviewConfig.enabled && (runAfterExecution?.tasks.length ?? 0) > 0) {
          const configured = reviewConfig.validatorCommands?.filter((item) => item.trim().length > 0) ?? [];
          const validatorCommands = configured.length > 0
            ? configured
            : (reviewConfig.validatorAuto ? await detectValidatorCommands() : []);

          for (let cycleIndex = 1; cycleIndex <= reviewConfig.maxCycles; cycleIndex += 1) {
            const validationResults = await runValidatorCommands(validatorCommands);
            const prompt = buildPostExecutionReviewPrompt(cycleIndex, validationResults, reviewConfig.prompt);
            const rawReview = await codexSession.runPrompt(prompt);
            const reviewResult = parseExecutionReviewResult(rawReview);
            finalSummaries.push(`cycle ${cycleIndex}: ${reviewResult.summary}`);

            if (reviewResult.findings.length === 0) {
              break;
            }

            await emitHook({
              runId: runId as HookEvent["runId"],
              hook: "onFindings",
              message: reviewResult.summary,
              timestamp: new Date().toISOString(),
              metadata: {
                findingsCount: reviewResult.findings.length,
                findingsSummary: reviewResult.summary,
                cycleIndex
              }
            });

            if (reviewConfig.onFindings === "report_only") {
              break;
            }

            if (reviewConfig.onFindings === "fail") {
              await store.updateRun(runId, { overallStatus: "failed" });
              break;
            }

            if (!reviewResult.fixed) {
              break;
            }
          }
        }

        let fallbackReview = "";
        if (reviewConfig.enabled) {
          fallbackReview = await codexSession.reviewChanges();
        }

        console.log("Codex post-execution final review summary:");
        if (finalSummaries.length > 0) {
          for (const summary of finalSummaries) {
            console.log(`- ${summary}`);
          }
        } else {
          console.log("- Post-execution review loop disabled.");
        }

        if (fallbackReview.length > 0) {
          console.log(fallbackReview);
        }
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
    .option("--codex-effort <value>", "Codex effort override for this run", parseCodexEffortOption)
    .option("--claude-effort <value>", "Claude effort override for this run", parseClaudeEffortOption)
    .option("--on-milestone <cmd>", "Shell hook command for onMilestone")
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
