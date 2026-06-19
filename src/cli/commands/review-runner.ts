import { exec as execCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { createCodexSession } from "../../agents/codex/session.js";
import { formatFlowInstructions, type ResolvedFlowConfig } from "../../core/flow-config.js";
import {
  buildPostExecutionReviewPrompt,
  getExecutionReviewConfig,
  getTaskReviewConfig,
  requestStructuredExecutionReview,
  runCompletedTaskReview,
  type ValidationResult
} from "../../core/review-cycle.js";
import type { ReviewCompletedTaskFn } from "../../core/task-runner.js";
import { RunStore } from "../../state/store.js";
import type { HookEvent, OrcaConfig, RunId } from "../../types/index.js";

const exec = promisify(execCallback);

type CodexSession = Awaited<ReturnType<typeof createCodexSession>>;
export type EmitHook = (event: HookEvent) => Promise<void>;

export async function emitJsonHook(event: HookEvent): Promise<void> {
  console.log(JSON.stringify(event));
}

function combineReviewPrompts(...prompts: Array<string | undefined>): string | undefined {
  const parts = prompts
    .map((prompt) => prompt?.trim())
    .filter((prompt): prompt is string => Boolean(prompt));

  return parts.length > 0 ? parts.join("\n\n") : undefined;
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

export function buildReviewCompletedTaskOption(options: {
  cwd: string;
  runId: RunId;
  store: RunStore;
  config?: OrcaConfig;
  codexSession: CodexSession;
  runnerUsesParallelSessions: boolean;
  emitHook: EmitHook;
}): { reviewCompletedTask?: ReviewCompletedTaskFn } {
  const taskReviewConfig = getTaskReviewConfig(options.config);
  if (!taskReviewConfig.enabled) {
    return {};
  }

  return {
    reviewCompletedTask: async ({ task, run, spec }) => {
      if (options.runnerUsesParallelSessions) {
        const reviewSession = await createCodexSession(options.cwd, options.config, {
          runId: options.runId,
          store: options.store,
          emitHook: options.emitHook,
        });

        try {
          return await runCompletedTaskReview({
            task,
            run,
            spec,
            config: taskReviewConfig,
            runPrompt: (prompt) => reviewSession.runPrompt(prompt, "review"),
            emitFindings: async ({ task, reviewResult, cycleIndex }) => {
              await options.emitHook({
                runId: options.runId,
                hook: "onFindings",
                message: reviewResult.summary,
                timestamp: new Date().toISOString(),
                taskId: task.id,
                taskName: task.name,
                metadata: {
                  findingsCount: reviewResult.findings.length,
                  findingsSummary: reviewResult.summary,
                  cycleIndex,
                  taskReview: true
                }
              });
            }
          });
        } finally {
          await reviewSession.disconnect();
        }
      }

      return runCompletedTaskReview({
        task,
        run,
        spec,
        config: taskReviewConfig,
        runPrompt: (prompt) => options.codexSession.runPrompt(prompt, "review"),
        emitFindings: async ({ task, reviewResult, cycleIndex }) => {
          await options.emitHook({
            runId: options.runId,
            hook: "onFindings",
            message: reviewResult.summary,
            timestamp: new Date().toISOString(),
            taskId: task.id,
            taskName: task.name,
            metadata: {
              findingsCount: reviewResult.findings.length,
              findingsSummary: reviewResult.summary,
              cycleIndex,
              taskReview: true
            }
          });
        }
      });
    }
  };
}

export async function runPostExecutionReview(options: {
  runId: RunId;
  store: RunStore;
  config?: OrcaConfig;
  selectedFlow: ResolvedFlowConfig;
  codexSession: CodexSession;
  emitHook: EmitHook;
}): Promise<void> {
  const reviewConfig = getExecutionReviewConfig(options.config);
  const summaryFlowInstructions = formatFlowInstructions(options.selectedFlow, "summary");
  const postExecutionReviewPrompt = combineReviewPrompts(
    reviewConfig.prompt,
    summaryFlowInstructions
  );
  const finalSummaries: string[] = [];
  const runAfterExecution = await options.store.getRun(options.runId);
  const shouldRunPostExecutionReview = reviewConfig.enabled
    && runAfterExecution?.overallStatus === "completed"
    && runAfterExecution.tasks.length > 0;

  if (shouldRunPostExecutionReview) {
    const configured = reviewConfig.validatorCommands?.filter((item) => item.trim().length > 0) ?? [];
    const validatorCommands = configured.length > 0
      ? configured
      : (reviewConfig.validatorAuto ? await detectValidatorCommands() : []);

    for (let cycleIndex = 1; cycleIndex <= reviewConfig.maxCycles; cycleIndex += 1) {
      const validationResults = await runValidatorCommands(validatorCommands);
      const prompt = buildPostExecutionReviewPrompt(
        cycleIndex,
        validationResults,
        postExecutionReviewPrompt,
        reviewConfig.onFindings
      );
      const reviewResult = await requestStructuredExecutionReview(
        (prompt) => options.codexSession.runPrompt(prompt, "review"),
        cycleIndex,
        prompt,
        postExecutionReviewPrompt,
        reviewConfig.onFindings
      );
      finalSummaries.push(`cycle ${cycleIndex}: ${reviewResult.summary}`);

      if (reviewResult.findings.length === 0) {
        break;
      }

      await options.emitHook({
        runId: options.runId,
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
        await options.store.updateRun(options.runId, { overallStatus: "failed" });
        break;
      }

      if (!reviewResult.fixed) {
        break;
      }
    }
  }

  const fallbackReview = shouldRunPostExecutionReview
    ? await options.codexSession.reviewChanges()
    : "";

  console.log("Codex post-execution final review summary:");
  if (finalSummaries.length > 0) {
    for (const summary of finalSummaries) {
      console.log(`- ${summary}`);
    }
  } else if (!reviewConfig.enabled) {
    console.log("- Post-execution review loop disabled.");
  } else if (runAfterExecution?.overallStatus !== "completed") {
    console.log("- Post-execution review skipped because execution did not complete.");
  } else {
    console.log("- Post-execution review loop disabled.");
  }

  if (fallbackReview.length > 0) {
    console.log(fallbackReview);
  }
}
