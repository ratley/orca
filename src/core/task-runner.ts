import path from "node:path";
import { promises as fs } from "node:fs";

import { createCodexSession } from "../agents/codex/session.js";
import { RunStore } from "../state/store.js";
import type { HookEvent, OrcaConfig, RunId, RunStatus, Task } from "../types/index.js";
import { loadSkills, type LoadedSkill } from "../utils/skill-loader.js";
import { getRunnable, validateDAG } from "./dependency-graph.js";
import { shouldRetry } from "./retry-policy.js";

export type EmitHook = (event: HookEvent) => Promise<void>;

export type ExecuteTaskFn = (
  task: Task,
  runId: string,
  config?: OrcaConfig,
  systemContext?: string,
) => Promise<{ outcome: "done" | "failed"; rawResponse: string; error?: string }>;

// Non-null only when set by tests — null means "use real executor logic"
let testExecuteTaskOverride: ExecuteTaskFn | null = null;

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
      ...patch,
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

export interface TaskRunnerOptions {
  runId: RunId;
  store: RunStore;
  config?: OrcaConfig;
  emitHook?: EmitHook;
  deferCompletion?: boolean;
  /** Override executor — used by tests only. In production, use config.executor. */
  executeTask?: ExecuteTaskFn;
}

function formatSkillsSection(skills: LoadedSkill[]): string {
  const formattedSkills = skills.map((skill) =>
    [`### ${skill.name}`, "", `Description: ${skill.description}`, "", skill.body].join("\n"),
  );

  return ["## Available Skills", "", ...formattedSkills].join("\n");
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
    `- Status: \`${run.overallStatus}\``,
    `- Created At: \`${run.createdAt}\``,
    `- Updated At: \`${run.updatedAt}\``,
    "",
    "## Tasks",
    "",
    "| ID | Name | Status | Started At | Finished At |",
    "| --- | --- | --- | --- | --- |",
    taskRows,
    "",
  ].join("\n");
}

export async function writeSessionSummary(store: RunStore, runId: string, sessionLogsDir?: string): Promise<void> {
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
  const { runId, store, config, deferCompletion = false } = options;
  const skills = await loadSkills(config);
  const taskSystemContext = skills.length === 0 ? undefined : formatSkillsSection(skills);

  // Test mocks bypass all executor logic entirely — no real sessions created.
  const mockFn: ExecuteTaskFn | null = options.executeTask ?? testExecuteTaskOverride;

  // Build real executor (Codex persistent session).
  // Only runs in production — skipped completely when a mock is active.
  let codexSession: Awaited<ReturnType<typeof createCodexSession>> | undefined;
  let executeTaskFn: ExecuteTaskFn;

  if (mockFn) {
    executeTaskFn = mockFn;
  } else {
    codexSession = await createCodexSession(process.cwd(), config, {
      runId,
      store,
      resumeOverallStatus: "running",
      emitHook,
    });
    executeTaskFn = (task, taskRunId, _cfg, systemContext) => codexSession!.executeTask(task, taskRunId, systemContext);
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
      metadata: { overallStatus: "running" },
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
          metadata: { overallStatus: "cancelled" },
        });
        await writeSessionSummary(store, runId, config?.sessionLogs);
        return;
      }

      const runnable = getRunnable(run.tasks);

      if (runnable.length === 0) {
        const hasFailedTask = run.tasks.some((task) => task.status === "failed");
        const hasCancelledTask = run.tasks.some((task) => task.status === "cancelled");
        const allDone = run.tasks.every((task) => task.status === "done");

        if (allDone) {
          const nextOverallStatus = deferCompletion ? "reviewing" : "completed";
          await store.updateRun(runId, { overallStatus: nextOverallStatus });
          const completedAt = new Date().toISOString();
          await emitHook({
            runId: run.runId,
            hook: "onMilestone",
            message: "execution-completed",
            timestamp: completedAt,
            metadata: { overallStatus: nextOverallStatus },
          });
          if (!deferCompletion) {
            await emitHook({
              runId: run.runId,
              hook: "onComplete",
              message: "run-completed",
              timestamp: completedAt,
              metadata: { overallStatus: "completed" },
            });
          }
          await writeSessionSummary(store, runId, config?.sessionLogs);
          return;
        }

        if (hasFailedTask) {
          await store.updateRun(runId, { overallStatus: "failed" });
          const failedAt = new Date().toISOString();
          const failureMessage = run.errors[run.errors.length - 1]?.message ?? "execution-failed";
          await emitHook({
            runId: run.runId,
            hook: "onMilestone",
            message: "execution-failed",
            timestamp: failedAt,
            metadata: { overallStatus: "failed" },
          });
          await emitHook({
            runId: run.runId,
            hook: "onError",
            message: `run-failed: ${failureMessage}`,
            timestamp: failedAt,
            error: failureMessage,
            metadata: { overallStatus: "failed" },
          });
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
            metadata: { overallStatus: "cancelled" },
          });
          await writeSessionSummary(store, runId, config?.sessionLogs);
          return;
        }

        if (hasPendingTasks(run.tasks)) {
          throw new Error("No runnable tasks found while tasks remain pending");
        }

        return;
      }

      const task = runnable[0];
      if (!task) {
        throw new Error("Task selection failed");
      }

      const now = new Date().toISOString();
      const inProgressTasks = run.tasks.map((candidate) => {
        if (candidate.id !== task.id) {
          return candidate;
        }

        return {
          ...stripOptionalFields(candidate, ["finishedAt", "lastError"]),
          status: "in_progress" as const,
          startedAt: candidate.startedAt ?? now,
        };
      });

      await store.updateRun(runId, {
        mode: "run",
        overallStatus: "running",
        tasks: inProgressTasks,
      });

      try {
        const result = await executeTaskFn(task, runId, config, taskSystemContext);

        if (result.outcome === "done") {
          const doneTasks = inProgressTasks.map((candidate) => {
            if (candidate.id !== task.id) {
              return candidate;
            }

            return {
              ...stripOptionalFields(candidate, ["lastError"]),
              status: "done" as const,
              finishedAt: new Date().toISOString(),
            };
          });

          await store.updateRun(runId, { tasks: doneTasks });

          await emitHook({
            runId: run.runId,
            hook: "onTaskComplete",
            message: `Task completed: ${task.name}`,
            timestamp: new Date().toISOString(),
            taskId: task.id,
            taskName: task.name,
          });

          continue;
        }

        throw new Error(result.error ?? "Task execution failed");
      } catch (error) {
        const errorMessage = toErrorMessage(error);
        const currentTask = inProgressTasks.find((candidate) => candidate.id === task.id);

        if (!currentTask) {
          throw new Error(`Task missing during error handling: ${task.id}`);
        }

        if (shouldRetry(currentTask, error)) {
          const retryTasks = inProgressTasks.map((candidate) => {
            if (candidate.id !== task.id) {
              return candidate;
            }

            return {
              ...stripOptionalFields(candidate, ["finishedAt"]),
              status: "pending" as const,
              retries: currentTask.retries + 1,
              lastError: errorMessage,
            };
          });

          await store.updateRun(runId, {
            tasks: retryTasks,
            milestones: [...run.milestones, `retry:${task.id}:${currentTask.retries + 1}`],
          });

          await emitHook({
            runId: run.runId,
            hook: "onMilestone",
            message: `retrying-task:${task.id}`,
            timestamp: new Date().toISOString(),
            taskId: task.id,
            taskName: task.name,
            metadata: { retries: currentTask.retries + 1 },
          });

          continue;
        }

        const failedAt = new Date().toISOString();
        const failedTasks = applyTaskUpdate(inProgressTasks, task.id, {
          status: "failed",
          finishedAt: failedAt,
          lastError: errorMessage,
        });

        await store.updateRun(runId, {
          tasks: failedTasks,
          overallStatus: "failed",
          errors: [
            ...run.errors,
            {
              at: failedAt,
              message: errorMessage,
              taskId: task.id,
            },
          ],
        });

        await emitHook({
          runId: run.runId,
          hook: "onTaskFail",
          message: `Task failed: ${task.name}`,
          timestamp: failedAt,
          taskId: task.id,
          taskName: task.name,
          error: errorMessage,
        });
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
      metadata: { overallStatus: "failed" },
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
