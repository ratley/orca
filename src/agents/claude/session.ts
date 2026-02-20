import Anthropic from "@anthropic-ai/sdk";
import { unstable_v2_createSession } from "@anthropic-ai/claude-agent-sdk";

import type { OrcaConfig, PlanResult, Task, TaskExecutionResult } from "../../types/index.js";

export type { PlanResult, TaskExecutionResult };

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

function buildTaskExecutionPrompt(
  task: Task,
  runId: string,
  cwd: string,
  systemContext?: string
): string {
  return [
    ...(systemContext ? [systemContext] : []),
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

export function parseTaskArray(raw: string): Task[] {
  // Strip markdown fences if present (defensive fallback)
  const stripped = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "");
  const parsed = JSON.parse(stripped) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("Claude plan response was not a JSON array");
  }

  // Coerce numeric task IDs and dependency refs to strings.
  // LLMs sometimes emit numeric IDs (1, 2, 3) even when we ask for strings.
  return (parsed as Array<Record<string, unknown>>).map((task) => ({
    ...task,
    id: String(task.id),
    dependencies: Array.isArray(task.dependencies)
      ? (task.dependencies as unknown[]).map(String)
      : [],
    // Apply sensible defaults for required fields the LLM may have omitted.
    name: typeof task.name === "string" && task.name.length > 0 ? task.name : "Unnamed task",
    description: typeof task.description === "string" ? task.description : "",
    acceptance_criteria: Array.isArray(task.acceptance_criteria) ? task.acceptance_criteria : [],
    status: typeof task.status === "string" && task.status.length > 0 ? task.status : "pending",
    retries: typeof task.retries === "number" ? task.retries : 0,
    maxRetries: typeof task.maxRetries === "number" ? task.maxRetries : 3,
  })) as Task[];
}

export function parseTaskExecution(raw: string): TaskExecutionResult {
  const parsed = JSON.parse(raw) as unknown;

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
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

export async function planSpec(spec: string, systemContext: string, config?: OrcaConfig): Promise<PlanResult> {
  const client = new Anthropic();

  const response = await client.messages.create({
    model: getModel(config),
    max_tokens: 8192,
    system: systemContext,
    messages: [
      {
        role: "user",
        content: buildPlanningPrompt(spec, systemContext)
      }
    ],
    tools: [
      {
        name: "submit_plan",
        description: "Submit the task plan as a structured JSON array",
        input_schema: {
          type: "object" as const,
          properties: {
            tasks: {
              type: "array" as const,
              items: {
                type: "object" as const,
                properties: {
                  id: { type: "string" as const },
                  name: { type: "string" as const },
                  description: { type: "string" as const },
                  dependencies: { type: "array" as const, items: { type: "string" as const } },
                  acceptance_criteria: { type: "array" as const, items: { type: "string" as const } },
                  status: { type: "string" as const },
                  retries: { type: "number" as const },
                  maxRetries: { type: "number" as const }
                },
                required: ["id", "name", "description", "dependencies", "acceptance_criteria", "status", "retries", "maxRetries"]
              }
            }
          },
          required: ["tasks"]
        }
      }
    ],
    tool_choice: { type: "any" as const }
  });

  // Extract the task array from the tool_use block
  const toolUseBlock = response.content.find((block) => block.type === "tool_use" && block.name === "submit_plan");
  if (!toolUseBlock || toolUseBlock.type !== "tool_use") {
    throw new Error("Claude did not call the submit_plan tool");
  }

  const toolInput = toolUseBlock.input as { tasks: unknown[] };
  const rawResponse = JSON.stringify(toolInput.tasks);

  return {
    tasks: parseTaskArray(rawResponse),
    rawResponse
  };
}

export async function executeTask(
  task: Task,
  runId: string,
  config?: OrcaConfig,
  systemContext?: string
): Promise<TaskExecutionResult> {
  const session = unstable_v2_createSession({
    model: getModel(config),
    permissionMode: "bypassPermissions",
  });

  try {
    const streamPromise = collectSessionResult(session);

    await session.send(buildTaskExecutionPrompt(task, runId, process.cwd(), systemContext));
    const rawResponse = await streamPromise;

    return parseTaskExecution(rawResponse);
  } finally {
    session.close();
  }
}
