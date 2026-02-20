import { CodexClient } from "@ratley/codex-client";
import type { CompletedTurn } from "@ratley/codex-client";

import type {
  OrcaConfig,
  PlanResult,
  Task,
  TaskExecutionResult,
  TaskGraphReviewOperation,
  TaskGraphReviewResult
} from "../../types/index.js";
import { TaskGraphReviewPayloadSchema } from "../../core/task-graph-review.js";
import type { CodexEffort } from "../../types/effort.js";

export type { PlanResult, TaskExecutionResult };

const CODE_SIMPLIFIER_MARKERS = [
  /^###\s+code-simplifier\s*$/im,
  /\bname:\s*code-simplifier\b/i,
];

function hasCodeSimplifierSkill(systemContext?: string): boolean {
  if (!systemContext) {
    return false;
  }

  return CODE_SIMPLIFIER_MARKERS.some((marker) => marker.test(systemContext));
}

function getCodeSimplifierGuidance(systemContext?: string): string[] {
  if (!hasCodeSimplifierSkill(systemContext)) {
    return [];
  }

  return [
    "When work involves refactoring or simplification, apply the code-simplifier skill guidance.",
    "Keep changes behavior-preserving unless the task explicitly requires behavior changes.",
  ];
}

function buildPlanningPrompt(spec: string, systemContext: string): string {
  return [
    systemContext,
    "You are decomposing a spec into an ordered task graph.",
    ...getCodeSimplifierGuidance(systemContext),
    "Return a JSON array of tasks.",
    "Each task must include fields: id, name, description, dependencies, acceptance_criteria, status, retries, maxRetries.",
    'Set status to "pending", retries to 0, and maxRetries to 3 for every task.',
    "dependencies must be an array of task IDs.",
    "acceptance_criteria must be an array of strings.",
    "Return ONLY valid JSON. No markdown fences. No explanation.",
    "Spec:",
    spec,
  ].join("\n\n");
}

function buildTaskExecutionPrompt(
  task: Task,
  runId: string,
  cwd: string,
  systemContext?: string,
): string {
  return [
    ...(systemContext ? [systemContext] : []),
    "You are Orca's task execution assistant.",
    ...getCodeSimplifierGuidance(systemContext),
    `Run ID: ${runId}`,
    `Repository CWD: ${cwd}`,
    `Task ID: ${task.id}`,
    `Task Name: ${task.name}`,
    "Task Description:",
    task.description,
    "Acceptance Criteria:",
    ...task.acceptance_criteria.map(
      (criterion, index) => `${index + 1}. ${criterion}`,
    ),
    "Execute this task. You have full shell access — run commands, read/write files, and do whatever is needed.",
    "IMPORTANT: When done, you MUST output the following JSON on its own line as the very last line of your response (no trailing text after it):",
    '{"outcome":"done"}',
    "Or if the task failed:",
    '{"outcome":"failed","error":"short reason"}',
    "Do not wrap it in markdown fences. Do not add any text after the JSON line. The JSON line is required.",
  ].join("\n\n");
}

function buildTaskGraphReviewPrompt(tasks: Task[], systemContext: string): string {
  return [
    systemContext,
    "You are Orca's pre-execution task-graph reviewer.",
    ...getCodeSimplifierGuidance(systemContext),
    "Return JSON matching this shape exactly: {\"changes\":[...operations...]}",
    "Allowed operation shapes:",
    "- {\"op\":\"update_task\",\"taskId\":\"...\",\"fields\":{\"name\"?:string,\"description\"?:string,\"acceptance_criteria\"?:string[]}}",
    "- {\"op\":\"add_task\",\"task\":<full task object>}",
    "- {\"op\":\"remove_task\",\"taskId\":\"...\"}",
    "- {\"op\":\"add_dependency\",\"taskId\":\"...\",\"dependsOn\":\"...\"}",
    "- {\"op\":\"remove_dependency\",\"taskId\":\"...\",\"dependsOn\":\"...\"}",
    "Return ONLY JSON. No markdown.",
    "Current task graph:",
    JSON.stringify(tasks, null, 2),
  ].join("\n\n");
}

function parseTaskGraphReview(raw: string): TaskGraphReviewResult {
  const parsed = JSON.parse(extractJson(raw)) as unknown;
  const result = TaskGraphReviewPayloadSchema.safeParse(parsed);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "<root>"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Codex review response failed schema validation. ${details}`);
  }

  return {
    changes: result.data.changes as TaskGraphReviewOperation[],
    rawResponse: raw,
  };
}

function extractAgentText(result: CompletedTurn): string {
  if (result.agentMessage.length > 0) {
    return result.agentMessage;
  }

  const agentItems = result.items.filter((item) => item.type === "agentMessage");
  if (agentItems.length > 0) {
    const last = agentItems[agentItems.length - 1];
    if (last !== undefined && "text" in last && typeof last.text === "string") {
      return last.text;
    }
  }

  throw new Error("Codex response was empty");
}

function extractJson(text: string): string {
  // Try to find JSON in the response — could be wrapped in markdown fences
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch?.[1]) {
    return fenceMatch[1].trim();
  }

  // Try the last line (common pattern: explanation then JSON)
  const lines = text.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim() ?? "";
    if (line.startsWith("{") || line.startsWith("[")) {
      try {
        JSON.parse(line);
        return line;
      } catch {
        // not valid JSON, keep looking
      }
    }
  }

  // Fall back to entire text
  return text.trim();
}

function parseTaskArray(raw: string): Task[] {
  const json = extractJson(raw);
  const parsed = JSON.parse(json) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("Codex plan response was not a JSON array");
  }

  return parsed as Task[];
}

const POSITIVE_COMPLETION_PATTERNS = [
  /\bdone\b/i,
  /\bcomplet/i,
  /\bsuccess/i,
  /\bwrote\b/i,
  /\bwritten\b/i,
  /\bcreated\b/i,
  /\bfinished\b/i,
  // Additional patterns to catch natural-language Codex narration
  /\bapplied\b/i,
  /\bimplemented\b/i,
  /\badded\b/i,
  /\bupdated\b/i,
  /\bmodified\b/i,
  /\binstalled\b/i,
  /\bfixed\b/i,
  /\brefactored\b/i,
  /\bchanges?\s+(?:have\s+been\s+)?made\b/i,
  /\bthe\s+task\s+(?:has\s+been|is)\b/i,
  /\bi\s+have\b/i,
  /\ball\s+(?:tasks?|steps?|criteria)\b/i,
  /\btest(?:s|ing)?\s+pass/i,
  /\bno\s+(?:errors?|issues?|failures?)\b/i,
];

const FAILURE_PATTERNS = [
  /\berror\b/i,
  /\bfailed?\b/i,
  /\bcannot\b/i,
  /\bunable\b/i,
  /\bpermission denied\b/i,
];

function inferOutcomeFromText(raw: string): TaskExecutionResult {
  const hasFailure = FAILURE_PATTERNS.some((p) => p.test(raw));
  if (hasFailure) {
    return {
      outcome: "failed",
      rawResponse: raw,
      error: "Codex did not emit a JSON completion marker; inferred failure from response text.",
    };
  }

  // No failure indicators — assume done. Codex often narrates rather than emitting JSON,
  // so false negatives here are more harmful than false positives.
  if (!POSITIVE_COMPLETION_PATTERNS.some((p) => p.test(raw))) {
    console.warn("[orca] Warning: Codex response had no clear completion marker; assuming done.");
  }

  return { outcome: "done", rawResponse: raw };
}

function parseTaskExecution(raw: string): TaskExecutionResult {
  let json: string;
  let parsed: unknown;

  try {
    json = extractJson(raw);
    parsed = JSON.parse(json);
  } catch {
    // Codex did not emit a JSON completion marker — fall back to text inference.
    return inferOutcomeFromText(raw);
  }

  if (!parsed || typeof parsed !== "object") {
    return inferOutcomeFromText(raw);
  }

  const candidate = parsed as { outcome?: unknown; error?: unknown };

  if (candidate.outcome !== "done" && candidate.outcome !== "failed") {
    return inferOutcomeFromText(raw);
  }

  if (candidate.error !== undefined && typeof candidate.error !== "string") {
    throw new Error("Codex task response error must be a string");
  }

  return {
    outcome: candidate.outcome,
    rawResponse: raw,
    ...(typeof candidate.error === "string" ? { error: candidate.error } : {}),
  };
}

function getModel(config?: OrcaConfig): string {
  return config?.codex?.model ?? process.env.ORCA_CODEX_MODEL ?? "gpt-5.3-codex";
}

function getCodexPath(): string {
  return (
    process.env.ORCA_CODEX_PATH ??
    `${process.env.HOME}/.nvm/versions/node/v22.22.0/bin/codex`
  );
}

function getEffort(config?: OrcaConfig): CodexEffort | undefined {
  return config?.codex?.effort;
}

/**
 * Create a persistent Codex session. The thread persists across calls —
 * planSpec and executeTask share context within the same session.
 */
export interface ConsultationResult {
  issues: string[];
  ok: boolean;
}

export async function createCodexSession(
  cwd: string,
  config?: OrcaConfig,
): Promise<{
  planSpec: (spec: string, systemContext: string) => Promise<PlanResult>;
  reviewTaskGraph: (tasks: Task[], systemContext: string) => Promise<TaskGraphReviewResult>;
  executeTask: (task: Task, runId: string, systemContext?: string) => Promise<TaskExecutionResult>;
  consultTaskGraph: (tasks: Task[]) => Promise<ConsultationResult>;
  reviewChanges: (threadId?: string) => Promise<string>;
  runPrompt: (prompt: string) => Promise<string>;
  disconnect: () => Promise<void>;
  threadId: string;
}> {
  const client = new CodexClient({
    codexPath: getCodexPath(),
    model: getModel(config),
    cwd,
    approvalPolicy: "never",
    sandbox: "workspace-write",
  });

  await client.connect();

  const thread = await client.startThread({});
  const threadId = thread.id;

  return {
    threadId,

    async planSpec(
      spec: string,
      systemContext: string,
    ): Promise<PlanResult> {
      const effort = getEffort(config);
      const result = effort
        ? await client.runTurn({
            threadId,
            effort,
            input: [{ type: "text", text: buildPlanningPrompt(spec, systemContext) }],
          })
        : await client.runTurn({
            threadId,
            input: [{ type: "text", text: buildPlanningPrompt(spec, systemContext) }],
          });

      const rawResponse = extractAgentText(result);

      return {
        tasks: parseTaskArray(rawResponse),
        rawResponse,
      };
    },

    async reviewTaskGraph(tasks: Task[], systemContext: string): Promise<TaskGraphReviewResult> {
      const effort = getEffort(config);
      const result = effort
        ? await client.runTurn({
            threadId,
            effort,
            input: [{ type: "text", text: buildTaskGraphReviewPrompt(tasks, systemContext) }],
          })
        : await client.runTurn({
            threadId,
            input: [{ type: "text", text: buildTaskGraphReviewPrompt(tasks, systemContext) }],
          });

      const rawResponse = extractAgentText(result);
      return parseTaskGraphReview(rawResponse);
    },

    async executeTask(
      task: Task,
      runId: string,
      systemContext?: string,
    ): Promise<TaskExecutionResult> {
      const effort = getEffort(config);
      const result = effort
        ? await client.runTurn({
            threadId,
            effort,
            input: [
              {
                type: "text",
                text: buildTaskExecutionPrompt(task, runId, cwd, systemContext),
              },
            ],
          })
        : await client.runTurn({
            threadId,
            input: [
              {
                type: "text",
                text: buildTaskExecutionPrompt(task, runId, cwd, systemContext),
              },
            ],
          });

      const rawResponse = extractAgentText(result);

      // Primary signal: use the SDK's structured turn status.
      const status = result.turn.status;
      if (status === "completed") {
        return { outcome: "done", rawResponse };
      }
      if (status === "failed") {
        return {
          outcome: "failed",
          error: result.turn.error?.message ?? "Turn failed",
          rawResponse,
        };
      }
      if (status === "interrupted") {
        return { outcome: "failed", error: "Turn was interrupted", rawResponse };
      }

      // Fallback: status is unexpected/missing — parse text as before.
      return parseTaskExecution(rawResponse);
    },

    async consultTaskGraph(tasks: Task[]): Promise<ConsultationResult> {
      const taskGraphJson = JSON.stringify(tasks, null, 2);
      const prompt = [
        "Review this Orca task graph before execution.",
        "Flag any: missing steps, wrong dependency order, tasks that are underdefined, or potential blockers.",
        "",
        "Set ok: false ONLY if there is a hard blocking issue — dependency cycle, circular reference, a task that cannot possibly run as defined, or a critical missing step that would cause the run to fail.",
        "For minor issues (ambiguous wording, style preferences, nice-to-haves): list them in issues but set ok: true.",
        "If the graph looks generally reasonable and executable, set ok: true even if you have minor suggestions.",
        "",
        "Be brief. Output JSON on the last line: { \"issues\": [...], \"ok\": boolean }",
        "",
        "Task graph:",
        taskGraphJson,
      ].join("\n");

      const effort = getEffort(config);
      const result = effort
        ? await client.runTurn({
            threadId,
            effort,
            input: [{ type: "text", text: prompt }],
          })
        : await client.runTurn({
            threadId,
            input: [{ type: "text", text: prompt }],
          });

      const rawResponse = extractAgentText(result);
      const json = extractJson(rawResponse);
      const parsed = JSON.parse(json) as unknown;

      if (!parsed || typeof parsed !== "object") {
        throw new Error("Codex consultation response was not a JSON object");
      }

      const candidate = parsed as { issues?: unknown; ok?: unknown };

      return {
        issues: Array.isArray(candidate.issues)
          ? (candidate.issues as unknown[]).filter((i): i is string => typeof i === "string")
          : [],
        ok: typeof candidate.ok === "boolean" ? candidate.ok : false,
      };
    },

    async reviewChanges(): Promise<string> {
      const result = await client.runReview({
        threadId,
        target: { type: "uncommittedChanges" },
      });

      return result.reviewText;
    },

    async runPrompt(prompt: string): Promise<string> {
      const effort = getEffort(config);
      const result = effort
        ? await client.runTurn({
            threadId,
            effort,
            input: [{ type: "text", text: prompt }],
          })
        : await client.runTurn({
            threadId,
            input: [{ type: "text", text: prompt }],
          });

      return extractAgentText(result);
    },

    async disconnect(): Promise<void> {
      await client.disconnect();
    },
  };
}

/**
 * Stateless wrappers that match the Claude adapter interface.
 * Each call creates a new client + thread (no persistence).
 * Use createCodexSession() for persistent threads.
 */
export async function planSpec(
  spec: string,
  systemContext: string,
  config?: OrcaConfig,
): Promise<PlanResult> {
  const session = await createCodexSession(process.cwd(), config);

  try {
    return await session.planSpec(spec, systemContext);
  } finally {
    await session.disconnect();
  }
}

export async function reviewTaskGraph(
  tasks: Task[],
  systemContext: string,
  config?: OrcaConfig,
): Promise<TaskGraphReviewResult> {
  const session = await createCodexSession(process.cwd(), config);

  try {
    return await session.reviewTaskGraph(tasks, systemContext);
  } finally {
    await session.disconnect();
  }
}

export async function executeTask(
  task: Task,
  runId: string,
  config?: OrcaConfig,
  systemContext?: string,
): Promise<TaskExecutionResult> {
  const session = await createCodexSession(process.cwd(), config);

  try {
    return await session.executeTask(task, runId, systemContext);
  } finally {
    await session.disconnect();
  }
}
