import path from "node:path";
import { promises as fs } from "node:fs";

import { createCodexSession } from "../agents/codex/session.js";
import { RunStore } from "../state/store.js";
import type { HookEvent, OrcaConfig, RunId, RunStatus, Task } from "../types/index.js";
import { loadSkills, type LoadedSkill } from "../utils/skill-loader.js";
import { isCodexMultiAgentActive } from "./codex-config.js";
import { getRunnable, validateDAG } from "./dependency-graph.js";
import { getTaskReviewConfig } from "./review-cycle.js";
import { shouldRetry } from "./retry-policy.js";

export type EmitHook = (event: HookEvent) => Promise<void>;

export type ExecuteTaskFn = (
  task: Task,
  runId: string,
  config?: OrcaConfig,
  systemContext?: string
) => Promise<{ outcome: "done" | "failed"; rawResponse: string; error?: string }>;

export type ReviewCompletedTaskFn = (context: {
  task: Task;
  run: RunStatus;
  spec: string | null;
  systemContext?: string;
}) => Promise<{ outcome: "accepted" | "failed"; summary: string; error?: string }>;

type CodexSession = Awaited<ReturnType<typeof createCodexSession>>;

type TaskAttemptResult =
  | { task: Task; outcome: "done" }
  | { task: Task; outcome: "retry"; error: string; retries: number }
  | { task: Task; outcome: "failed"; error: string };

// Non-null only when set by tests — null means "use real executor logic"
let testExecuteTaskOverride: ExecuteTaskFn | null = null;

const SPEC_CONTEXT_CHAR_CAP = 12_000;
const DEFAULT_MULTI_AGENT_PARALLEL_TASKS = 4;

export function setExecuteTaskForTests(fn: ExecuteTaskFn | null): void {
  testExecuteTaskOverride = fn;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  return String(error);
}

async function defaultEmitHook(event: HookEvent): Promise<void> {
  console.log(JSON.stringify(event));
}

function applyTaskUpdate(tasks: Task[], taskId: string, patch: Partial<Task>): Task[] {
  return tasks.map((task) => {
    if (task.id !== taskId) {
      return task;
    }

    return {
      ...task,
      ...patch
    };
  });
}

function stripOptionalFields(task: Task, fields: Array<"finishedAt" | "lastError">): Task {
  const next = { ...task };

  for (const field of fields) {
    delete next[field];
  }

  return next;
}

function hasPendingTasks(tasks: Task[]): boolean {
  return tasks.some((task) => task.status === "pending" || task.status === "in_progress");
}

function getConfiguredParallelTaskLimit(config?: OrcaConfig): number {
  return config?.codex?.maxParallelTasks ?? DEFAULT_MULTI_AGENT_PARALLEL_TASKS;
}

function shouldSerializeAutoFixTaskReview(config?: OrcaConfig): boolean {
  const taskReviewConfig = getTaskReviewConfig(config);
  return taskReviewConfig.enabled && taskReviewConfig.onFindings === "auto_fix";
}

export async function resolveTaskRunnerParallelism(config?: OrcaConfig): Promise<number> {
  if (!(await isCodexMultiAgentActive(config))) {
    return 1;
  }

  return getConfiguredParallelTaskLimit(config);
}

function selectRunnableTasks(tasks: Task[], parallelTaskLimit: number): Task[] {
  return getRunnable(tasks).slice(0, parallelTaskLimit);
}

function buildTaskAttemptErrorResult(task: Task, inProgressTasks: Task[], error: unknown): TaskAttemptResult {
  const errorMessage = toErrorMessage(error);
  const currentTask = inProgressTasks.find((candidate) => candidate.id === task.id);

  if (!currentTask) {
    throw new Error(`Task missing during error handling: ${task.id}`);
  }

  if (shouldRetry(currentTask, error)) {
    return {
      task,
      outcome: "retry",
      error: errorMessage,
      retries: currentTask.retries + 1
    };
  }

  return { task, outcome: "failed", error: errorMessage };
}

function buildTaskAttemptFailureResult(task: Task, error: unknown): TaskAttemptResult {
  return { task, outcome: "failed", error: toErrorMessage(error) };
}

function suppressRetriesAfterTerminalFailure(results: TaskAttemptResult[]): TaskAttemptResult[] {
  if (!results.some((result) => result.outcome === "failed")) {
    return results;
  }

  return results.map((result) => {
    if (result.outcome !== "retry") {
      return result;
    }

    return {
      task: result.task,
      outcome: "failed",
      error: `Retry suppressed because another task failed in the same wave: ${result.error}`
    };
  });
}

function mergeAppendedItems<T>(baseItems: T[], latestItems: T[], nextItems: T[]): T[] {
  return [...latestItems, ...nextItems.slice(baseItems.length)];
}

async function emitRunFailure(run: RunStatus, emitHook: EmitHook, failureMessage: string): Promise<void> {
  const failedAt = new Date().toISOString();
  await emitHook({
    runId: run.runId,
    hook: "onMilestone",
    message: "execution-failed",
    timestamp: failedAt,
    metadata: { overallStatus: "failed" }
  });
  await emitHook({
    runId: run.runId,
    hook: "onError",
    message: `run-failed: ${failureMessage}`,
    timestamp: failedAt,
    error: failureMessage,
    metadata: { overallStatus: "failed" }
  });
}

export interface TaskRunnerOptions {
  runId: RunId;
  store: RunStore;
  config?: OrcaConfig;
  emitHook?: EmitHook;
  systemContextSections?: string[];
  /** Override executor — used by tests only. In production, use config.executor. */
  executeTask?: ExecuteTaskFn;
  reviewCompletedTask?: ReviewCompletedTaskFn;
}

function formatSkillsSection(skills: LoadedSkill[]): string {
  const formattedSkills = skills.map((skill) =>
    [
      `### ${skill.name}`,
      "",
      `Description: ${skill.description}`,
      "",
      skill.body
    ].join("\n")
  );

  return ["## Available Skills", "", ...formattedSkills].join("\n");
}

async function loadSpecContext(specPath: string): Promise<{ content: string; truncated: boolean } | null> {
  try {
    const raw = await fs.readFile(specPath, "utf8");
    return {
      content: raw.slice(0, SPEC_CONTEXT_CHAR_CAP),
      truncated: raw.length > SPEC_CONTEXT_CHAR_CAP
    };
  } catch {
    return null;
  }
}

function formatTaskSystemContext(
  skills: LoadedSkill[],
  spec: { content: string; truncated: boolean } | null,
  run: RunStatus,
  extraSections: string[] = []
): string | undefined {
  const sections: string[] = [];

  if (skills.length > 0) {
    sections.push(formatSkillsSection(skills));
  }

  sections.push(...extraSections.filter((section) => section.trim().length > 0));

  if (spec) {
    sections.push([
      "## Original Spec",
      "",
      "The task graph was derived from this source spec. Keep implementation choices tied back to it.",
      "",
      "```md",
      spec.content,
      "```",
      ...(spec.truncated ? [`(truncated to ${SPEC_CONTEXT_CHAR_CAP} characters)`] : [])
    ].join("\n"));
  }

  sections.push([
    "## Current Task Graph",
    "",
    "Use this to preserve continuity with completed work and avoid drifting away from later tasks.",
    "",
    "```json",
    JSON.stringify(run.tasks, null, 2),
    "```"
  ].join("\n"));

  return sections.length > 0 ? sections.join("\n\n") : undefined;
}

function buildSessionSummary(run: RunStatus): string {
  const taskRows =
    run.tasks.length === 0
      ? "| (none) | - | - | - | - |\n"
      : run.tasks
          .map((task) => {
            return `| ${task.id} | ${task.name} | ${task.status} | ${task.startedAt ?? "-"} | ${task.finishedAt ?? "-"} |`;
          })
          .join("\n");

  return [
    `# Run ${run.runId}`,
    "",
    `- Run ID: \`${run.runId}\``,
    `- Spec Path: \`${run.specPath}\``,
    ...(run.flowName !== undefined ? [`- Flow: \`${run.flowName}\``] : []),
    `- Status: \`${run.overallStatus}\``,
    `- Created At: \`${run.createdAt}\``,
    `- Updated At: \`${run.updatedAt}\``,
    "",
    "## Tasks",
    "",
    "| ID | Name | Status | Started At | Finished At |",
    "| --- | --- | --- | --- | --- |",
    taskRows,
    ""
  ].join("\n");
}

async function writeSessionSummary(store: RunStore, runId: string, sessionLogsDir?: string): Promise<void> {
  if (!sessionLogsDir) {
    return;
  }

  try {
    const run = await store.getRun(runId);
    if (!run) {
      throw new Error(`Run not found while writing session summary: ${runId}`);
    }

    await fs.mkdir(sessionLogsDir, { recursive: true });
    await fs.writeFile(path.join(sessionLogsDir, `${runId}.md`), buildSessionSummary(run), "utf8");
  } catch (error) {
    console.error(`Warning: failed to write session summary for ${runId}: ${toErrorMessage(error)}`);
  }
}

export async function runTaskRunner(options: TaskRunnerOptions): Promise<void> {
  const emitHook = options.emitHook ?? defaultEmitHook;
  const { runId, store, config } = options;
  const skills = await loadSkills(config);
  const specContextPromise = store.getRun(runId).then((run) => run ? loadSpecContext(run.specPath) : null);
  const requestedParallelTaskLimit = await resolveTaskRunnerParallelism(config);

  // Test mocks bypass all executor logic entirely — no real sessions created.
  const mockFn: ExecuteTaskFn | null = options.executeTask ?? testExecuteTaskOverride;
  // Per-task auto-fix reviews inspect and may mutate the shared worktree. Keep
  // those waves single-task so a reviewer is not repairing a sibling task's diff.
  const parallelTaskLimit = options.reviewCompletedTask && shouldSerializeAutoFixTaskReview(config)
    ? 1
    : requestedParallelTaskLimit;

  // Sequential execution preserves the original shared persistent session.
  // Parallel execution gives each task its own session so runnable graph
  // branches can make progress concurrently without interleaving turns.
  let codexSession: CodexSession | undefined;
  let executeTaskFn: ExecuteTaskFn;

  if (mockFn) {
    executeTaskFn = mockFn;
  } else if (parallelTaskLimit > 1) {
    executeTaskFn = async (task, taskRunId, _cfg, systemContext) => {
      const taskSession = await createCodexSession(process.cwd(), config, {
        runId,
        store,
        emitHook,
      });

      try {
        return await taskSession.executeTask(task, taskRunId, systemContext);
      } finally {
        await taskSession.disconnect();
      }
    };
  } else {
    codexSession = await createCodexSession(process.cwd(), config, {
      runId,
      store,
      emitHook,
    });
    executeTaskFn = (task, taskRunId, _cfg, systemContext) =>
      codexSession!.executeTask(task, taskRunId, systemContext);
  }

  try {
    let run = await store.getRun(runId);
    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }

    validateDAG(run.tasks);

    await emitHook({
      runId: run.runId,
      hook: "onMilestone",
      message: "execution-started",
      timestamp: new Date().toISOString(),
      metadata: { overallStatus: "running" }
    });

    while (true) {
      run = await store.getRun(runId);
      if (!run) {
        throw new Error(`Run not found: ${runId}`);
      }

      if (run.overallStatus === "cancelled") {
        await emitHook({
          runId: run.runId,
          hook: "onMilestone",
          message: "execution-cancelled",
          timestamp: new Date().toISOString(),
          metadata: { overallStatus: "cancelled" }
        });
        await writeSessionSummary(store, runId, config?.sessionLogs);
        return;
      }

      if (run.overallStatus === "failed") {
        const failureMessage = run.errors[run.errors.length - 1]?.message ?? "execution-failed";
        await emitRunFailure(run, emitHook, failureMessage);
        await writeSessionSummary(store, runId, config?.sessionLogs);
        return;
      }

      const runnable = selectRunnableTasks(run.tasks, parallelTaskLimit);

      if (runnable.length === 0) {
        const hasFailedTask = run.tasks.some((task) => task.status === "failed");
        const hasCancelledTask = run.tasks.some((task) => task.status === "cancelled");
        const allDone = run.tasks.every((task) => task.status === "done");

        if (allDone) {
          await store.updateRun(runId, { overallStatus: "completed" });
          const completedAt = new Date().toISOString();
          await emitHook({
            runId: run.runId,
            hook: "onMilestone",
            message: "execution-completed",
            timestamp: completedAt,
            metadata: { overallStatus: "completed" }
          });
          await emitHook({
            runId: run.runId,
            hook: "onComplete",
            message: "run-completed",
            timestamp: completedAt,
            metadata: { overallStatus: "completed" }
          });
          await writeSessionSummary(store, runId, config?.sessionLogs);
          return;
        }

        if (hasFailedTask) {
          await store.updateRun(runId, { overallStatus: "failed" });
          const failureMessage = run.errors[run.errors.length - 1]?.message ?? "execution-failed";
          await emitRunFailure(run, emitHook, failureMessage);
          await writeSessionSummary(store, runId, config?.sessionLogs);
          return;
        }

        if (hasCancelledTask) {
          await store.updateRun(runId, { overallStatus: "cancelled" });
          await emitHook({
            runId: run.runId,
            hook: "onMilestone",
            message: "execution-cancelled",
            timestamp: new Date().toISOString(),
            metadata: { overallStatus: "cancelled" }
          });
          await writeSessionSummary(store, runId, config?.sessionLogs);
          return;
        }

        if (hasPendingTasks(run.tasks)) {
          throw new Error("No runnable tasks found while tasks remain pending");
        }

        return;
      }

      const now = new Date().toISOString();
      const runnableIds = new Set(runnable.map((task) => task.id));
      const inProgressTasks = run.tasks.map((candidate) => {
        if (!runnableIds.has(candidate.id)) {
          return candidate;
        }

        return {
          ...stripOptionalFields(candidate, ["finishedAt", "lastError"]),
          status: "in_progress" as const,
          startedAt: candidate.startedAt ?? now
        };
      });

      const startedRun = await store.updateRunIfActive(runId, {
        mode: "run",
        overallStatus: "running",
        tasks: inProgressTasks
      });

      if (startedRun.overallStatus === "cancelled") {
        await emitHook({
          runId: startedRun.runId,
          hook: "onMilestone",
          message: "execution-cancelled",
          timestamp: new Date().toISOString(),
          metadata: { overallStatus: "cancelled" }
        });
        await writeSessionSummary(store, runId, config?.sessionLogs);
        return;
      }

      if (startedRun.overallStatus === "failed") {
        const failureMessage = startedRun.errors[startedRun.errors.length - 1]?.message ?? "execution-failed";
        await emitRunFailure(startedRun, emitHook, failureMessage);
        await writeSessionSummary(store, runId, config?.sessionLogs);
        return;
      }

      if (startedRun.overallStatus === "completed") {
        await writeSessionSummary(store, runId, config?.sessionLogs);
        return;
      }

      const specContext = await specContextPromise;
      const runForTaskContext: RunStatus = {
        ...run,
        mode: "run",
        overallStatus: "running",
        tasks: inProgressTasks
      };

      const taskSystemContext = formatTaskSystemContext(
        skills,
        specContext,
        runForTaskContext,
        options.systemContextSections
      );
      const attemptResults = await Promise.all(runnable.map(async (task): Promise<TaskAttemptResult> => {
        try {
          const result = await executeTaskFn(task, runId, config, taskSystemContext);

          if (result.outcome !== "done") {
            throw new Error(result.error ?? "Task execution failed");
          }

          return { task, outcome: "done" };
        } catch (error) {
          return buildTaskAttemptErrorResult(task, inProgressTasks, error);
        }
      }));
      const reviewedAttemptResults: TaskAttemptResult[] = [];

      // Completed-task reviews may inspect and mutate the shared worktree, so
      // keep execution parallel but serialize reviews after the whole wave.
      for (const result of attemptResults) {
        if (result.outcome !== "done" || !options.reviewCompletedTask) {
          reviewedAttemptResults.push(result);
          continue;
        }

        try {
          const reviewResult = await options.reviewCompletedTask({
            task: result.task,
            run: runForTaskContext,
            spec: specContext?.content ?? null,
            ...(taskSystemContext !== undefined ? { systemContext: taskSystemContext } : {})
          });

          if (reviewResult.outcome === "failed") {
            throw new Error(reviewResult.error ?? reviewResult.summary);
          }

          reviewedAttemptResults.push(result);
        } catch (error) {
          reviewedAttemptResults.push(buildTaskAttemptFailureResult(result.task, error));
        }
      }

      const finalAttemptResults = suppressRetriesAfterTerminalFailure(reviewedAttemptResults);
      let nextTasks = inProgressTasks;
      let nextMilestones = run.milestones;
      let nextErrors = run.errors;
      let nextOverallStatus: RunStatus["overallStatus"] = "running";

      for (const result of finalAttemptResults) {
        const currentTask = nextTasks.find((candidate) => candidate.id === result.task.id);
        if (!currentTask) {
          throw new Error(`Task missing during result handling: ${result.task.id}`);
        }

        if (result.outcome === "done") {
          nextTasks = nextTasks.map((candidate) => {
            if (candidate.id !== result.task.id) {
              return candidate;
            }

            return {
              ...stripOptionalFields(candidate, ["lastError"]),
              status: "done" as const,
              finishedAt: new Date().toISOString()
            };
          });
          continue;
        }

        if (result.outcome === "retry") {
          nextTasks = nextTasks.map((candidate) => {
            if (candidate.id !== result.task.id) {
              return candidate;
            }

            return {
              ...stripOptionalFields(candidate, ["finishedAt"]),
              status: "pending" as const,
              retries: result.retries,
              lastError: result.error
            };
          });
          nextMilestones = [...nextMilestones, `retry:${result.task.id}:${result.retries}`];
          continue;
        }

        const failedAt = new Date().toISOString();
        nextTasks = applyTaskUpdate(nextTasks, result.task.id, {
          status: "failed",
          finishedAt: failedAt,
          lastError: result.error
        });
        nextErrors = [
          ...nextErrors,
          {
            at: failedAt,
            message: result.error,
            taskId: result.task.id
          }
        ];
        nextOverallStatus = "failed";
      }

      const latestRun = await store.getRun(runId);
      if (!latestRun) {
        throw new Error(`Run not found before result write: ${runId}`);
      }

      if (latestRun.overallStatus === "cancelled") {
        await emitHook({
          runId: latestRun.runId,
          hook: "onMilestone",
          message: "execution-cancelled",
          timestamp: new Date().toISOString(),
          metadata: { overallStatus: "cancelled" }
        });
        await writeSessionSummary(store, runId, config?.sessionLogs);
        return;
      }

      if (latestRun.overallStatus === "failed") {
        const failureMessage = latestRun.errors[latestRun.errors.length - 1]?.message ?? "execution-failed";
        await emitRunFailure(latestRun, emitHook, failureMessage);
        await writeSessionSummary(store, runId, config?.sessionLogs);
        return;
      }

      const mergedMilestones = mergeAppendedItems(run.milestones, latestRun.milestones, nextMilestones);
      const mergedErrors = mergeAppendedItems(run.errors, latestRun.errors, nextErrors);

      await store.updateRun(runId, {
        tasks: nextTasks,
        milestones: mergedMilestones,
        errors: mergedErrors,
        overallStatus: nextOverallStatus
      });

      for (const result of finalAttemptResults) {
        if (result.outcome === "done") {
          await emitHook({
            runId: run.runId,
            hook: "onTaskComplete",
            message: `Task completed: ${result.task.name}`,
            timestamp: new Date().toISOString(),
            taskId: result.task.id,
            taskName: result.task.name
          });
          continue;
        }

        if (result.outcome === "retry") {
          await emitHook({
            runId: run.runId,
            hook: "onMilestone",
            message: `retrying-task:${result.task.id}`,
            timestamp: new Date().toISOString(),
            taskId: result.task.id,
            taskName: result.task.name,
            metadata: { retries: result.retries }
          });
          continue;
        }

        await emitHook({
          runId: run.runId,
          hook: "onTaskFail",
          message: `Task failed: ${result.task.name}`,
          timestamp: new Date().toISOString(),
          taskId: result.task.id,
          taskName: result.task.name,
          error: result.error
        });
      }

      if (nextOverallStatus === "failed") {
        const failureMessage = mergedErrors[mergedErrors.length - 1]?.message ?? "execution-failed";
        await emitRunFailure(run, emitHook, failureMessage);
        await writeSessionSummary(store, runId, config?.sessionLogs);
        return;
      }
    }
  } catch (error) {
    const errorMessage = toErrorMessage(error);
    const now = new Date().toISOString();
    try {
      await store.updateRun(runId, { overallStatus: "failed" });
    } catch {
      // Preserve the original runner failure if state persistence also fails.
    }
    await emitHook({
      runId: runId as RunId,
      hook: "onError",
      message: `run-failed: ${errorMessage}`,
      timestamp: now,
      error: errorMessage,
      metadata: { overallStatus: "failed" }
    });
    await writeSessionSummary(store, runId, config?.sessionLogs);
    throw error;
  } finally {
    if (codexSession) {
      try {
        await codexSession.disconnect();
      } catch {
        // Best-effort cleanup — don't mask the real error.
      }
    }
  }
}
