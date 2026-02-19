import { unstable_v2_createSession } from "@anthropic-ai/claude-agent-sdk";

import type { OrcaConfig, Task } from "../../types/index.js";

export interface PlanResult {
  tasks: Task[];
  rawResponse: string;
}

export interface TaskExecutionResult {
  outcome: "done" | "failed";
  rawResponse: string;
  error?: string;
}

function buildPlanningPrompt(spec: string, systemContext: string): string {
  return [
    systemContext,
    "You are decomposing a spec into an ordered task graph.",
    "Return a JSON array of tasks.",
    "Each task must include fields: id, name, description, dependencies, acceptance_criteria, status, retries, maxRetries.",
    "Set status to \"pending\", retries to 0, and maxRetries to 3 for every task.",
    "dependencies must be an array of task IDs.",
    "acceptance_criteria must be an array of strings.",
    "Return ONLY valid JSON. No markdown fences. No explanation.",
    "Spec:",
    spec
  ].join("\n\n");
}

function buildTaskExecutionPrompt(task: Task, runId: string, cwd: string): string {
  return [
    "You are Orca's task execution assistant.",
    `Run ID: ${runId}`,
    `Repository CWD: ${cwd}`,
    `Task ID: ${task.id}`,
    `Task Name: ${task.name}`,
    "Task Description:",
    task.description,
    "Acceptance Criteria:",
    ...task.acceptance_criteria.map((criterion, index) => `${index + 1}. ${criterion}`),
    "Execute this task and return ONLY JSON.",
    "JSON schema:",
    "{\"outcome\":\"done\"|\"failed\",\"error\"?:\"string\"}",
    "If you cannot complete the task, return outcome=failed with a short error reason."
  ].join("\n\n");
}

function extractAssistantText(message: unknown): string | null {
  if (!message || typeof message !== "object") {
    return null;
  }

  const obj = message as { type?: string; message?: { content?: Array<{ type?: string; text?: string }> } };
  if (obj.type !== "assistant") {
    return null;
  }

  const blocks = obj.message?.content;
  if (!Array.isArray(blocks)) {
    return null;
  }

  const text = blocks
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n")
    .trim();

  return text.length > 0 ? text : null;
}

function parseTaskArray(raw: string): Task[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("Claude plan response was not a JSON array");
  }

  return parsed as Task[];
}

function parseTaskExecution(raw: string): TaskExecutionResult {
  const parsed = JSON.parse(raw) as unknown;

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Claude task response was not a JSON object");
  }

  const candidate = parsed as { outcome?: unknown; error?: unknown };

  if (candidate.outcome !== "done" && candidate.outcome !== "failed") {
    throw new Error("Claude task response missing valid outcome");
  }

  if (candidate.error !== undefined && typeof candidate.error !== "string") {
    throw new Error("Claude task response error must be a string");
  }

  return {
    outcome: candidate.outcome,
    rawResponse: raw,
    ...(typeof candidate.error === "string" ? { error: candidate.error } : {})
  };
}

async function collectSessionResult(session: ReturnType<typeof unstable_v2_createSession>): Promise<string> {
  const assistantMessages: string[] = [];
  let resultText: string | null = null;

  for await (const message of session.stream()) {
    const assistantText = extractAssistantText(message);
    if (assistantText) {
      assistantMessages.push(assistantText);
    }

    if (
      message.type === "result" &&
      message.subtype === "success" &&
      typeof message.result === "string"
    ) {
      resultText = message.result;
    }

    if (message.type === "result" && message.subtype !== "success") {
      const details = "errors" in message ? message.errors.join("; ") : "unknown error";
      throw new Error(`Claude session failed (${message.subtype}): ${details}`);
    }
  }

  const rawResponse = assistantMessages.length > 0
    ? assistantMessages[assistantMessages.length - 1]
    : resultText;

  if (!rawResponse) {
    throw new Error("Claude response was empty");
  }

  return rawResponse;
}

function getModel(config?: OrcaConfig): string {
  return config?.claude?.model ?? process.env.ORCA_CLAUDE_MODEL ?? "claude-sonnet-4-5";
}

export async function planSpec(spec: string, systemContext: string): Promise<PlanResult> {
  const session = unstable_v2_createSession({
    model: getModel()
  });

  try {
    const streamPromise = collectSessionResult(session);

    await session.send(buildPlanningPrompt(spec, systemContext));
    const rawResponse = await streamPromise;

    return {
      tasks: parseTaskArray(rawResponse),
      rawResponse
    };
  } finally {
    session.close();
  }
}

export async function executeTask(
  task: Task,
  runId: string,
  config?: OrcaConfig
): Promise<TaskExecutionResult> {
  const session = unstable_v2_createSession({
    model: getModel(config),
    permissionMode: "bypassPermissions",
  });

  try {
    const streamPromise = collectSessionResult(session);

    await session.send(buildTaskExecutionPrompt(task, runId, process.cwd()));
    const rawResponse = await streamPromise;

    return parseTaskExecution(rawResponse);
  } finally {
    session.close();
  }
}
