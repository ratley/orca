import { query, type Query } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import type { OrcaConfig, PlanResult, Task, TaskExecutionResult } from "../../types/index.js";
import type { ClaudeEffort } from "../../types/effort.js";
import { parseAgentJson } from "../../utils/agent-json.js";

type JsonSchema = Record<string, unknown>;

export type { PlanResult, TaskExecutionResult };

const PlannedTaskSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  dependencies: z.array(z.string()),
  acceptance_criteria: z.array(z.string()),
  status: z.literal("pending"),
  retries: z.literal(0),
  maxRetries: z.literal(3),
}).strict();

const PlanPayloadSchema = z.object({
  tasks: z.array(PlannedTaskSchema).min(1),
}).strict();

const TaskExecutionPayloadSchema = z
  .object({
    outcome: z.enum(["done", "failed"]),
    error: z.string().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.outcome === "failed" && !value.error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "error is required when outcome=failed",
        path: ["error"],
      });
    }

    if (value.outcome === "done" && value.error !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "error must be omitted when outcome=done",
        path: ["error"],
      });
    }
  });

const PLAN_OUTPUT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["tasks"],
  properties: {
    tasks: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "name",
          "description",
          "dependencies",
          "acceptance_criteria",
          "status",
          "retries",
          "maxRetries",
        ],
        properties: {
          id: { type: "string", minLength: 1 },
          name: { type: "string", minLength: 1 },
          description: { type: "string" },
          dependencies: { type: "array", items: { type: "string" } },
          acceptance_criteria: { type: "array", items: { type: "string" } },
          status: { type: "string", enum: ["pending"] },
          retries: { type: "number", enum: [0] },
          maxRetries: { type: "number", enum: [3] },
        },
      },
    },
  },
};

const EXECUTION_OUTPUT_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["outcome"],
  properties: {
    outcome: { type: "string", enum: ["done", "failed"] },
    error: { type: "string" },
  },
  // eslint-disable-next-line unicorn/no-thenable
  allOf: [
    {
      if: { properties: { outcome: { const: "failed" } } },
      // eslint-disable-next-line unicorn/no-thenable
      then: { required: ["error"] },
    },
    {
      if: { properties: { outcome: { const: "done" } } },
      // eslint-disable-next-line unicorn/no-thenable
      then: { not: { required: ["error"] } },
    },
  ],
};

const PLAN_OUTPUT_FORMAT = {
  type: "json_schema" as const,
  schema: PLAN_OUTPUT_SCHEMA,
};

const EXECUTION_OUTPUT_FORMAT = {
  type: "json_schema" as const,
  schema: EXECUTION_OUTPUT_SCHEMA,
};

function buildPlanningPrompt(spec: string, systemContext: string): string {
  return [
    systemContext,
    "You are decomposing a spec into an ordered task graph.",
    "Use the configured structured output schema only.",
    "Do not include prose or markdown.",
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
    `Run ID: ${runId}`,
    `Repository CWD: ${cwd}`,
    `Task ID: ${task.id}`,
    `Task Name: ${task.name}`,
    "Task Description:",
    task.description,
    "Acceptance Criteria:",
    ...task.acceptance_criteria.map((criterion, index) => `${index + 1}. ${criterion}`),
    "Use the configured structured output schema only.",
    "If you cannot complete the task, set outcome=failed and provide a concise error.",
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

function formatSchemaError(prefix: string, error: z.ZodError): Error {
  const details = error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "<root>"}: ${issue.message}`)
    .join("; ");
  return new Error(`${prefix}. ${details}`);
}

export function parseTaskArray(raw: string): Task[] {
  const parsed = parseAgentJson(raw);
  const normalized = Array.isArray(parsed) ? { tasks: parsed } : parsed;
  const result = PlanPayloadSchema.safeParse(normalized);
  if (!result.success) {
    throw formatSchemaError("Claude plan response failed schema validation", result.error);
  }
  return result.data.tasks;
}

export function parseTaskExecution(raw: string): TaskExecutionResult {
  const parsed = parseAgentJson(raw);
  const result = TaskExecutionPayloadSchema.safeParse(parsed);
  if (!result.success) {
    throw formatSchemaError("Claude task response failed schema validation", result.error);
  }

  return {
    outcome: result.data.outcome,
    rawResponse: raw,
    ...(result.data.error ? { error: result.data.error } : {}),
  };
}

export function parseStructuredPlanPayload(payload: unknown): Task[] {
  const result = PlanPayloadSchema.safeParse(payload);
  if (!result.success) {
    throw formatSchemaError("Claude structured plan payload failed schema validation", result.error);
  }

  return result.data.tasks;
}

export function parseStructuredTaskExecutionPayload(payload: unknown, rawResponse = ""): TaskExecutionResult {
  const result = TaskExecutionPayloadSchema.safeParse(payload);
  if (!result.success) {
    throw formatSchemaError("Claude structured task payload failed schema validation", result.error);
  }

  return {
    outcome: result.data.outcome,
    rawResponse,
    ...(result.data.error ? { error: result.data.error } : {}),
  };
}

type CollectedSessionResult = {
  rawResponse: string;
  structuredOutput: unknown;
};

async function collectSessionResult(claudeQuery: Query): Promise<CollectedSessionResult> {
  const assistantMessages: string[] = [];
  let resultText: string | null = null;
  let structuredOutput: unknown;

  for await (const message of claudeQuery) {
    const assistantText = extractAssistantText(message);
    if (assistantText) {
      assistantMessages.push(assistantText);
    }

    if (message.type === "result" && message.subtype === "success") {
      if (typeof message.result === "string") {
        resultText = message.result;
      }
      if ("structured_output" in message) {
        structuredOutput = message.structured_output;
      }
    }

    if (message.type === "result" && message.subtype !== "success") {
      const details = "errors" in message ? message.errors.join("; ") : "unknown error";
      throw new Error(`Claude session failed (${message.subtype}): ${details}`);
    }
  }

  const rawResponse = assistantMessages.length > 0 ? assistantMessages[assistantMessages.length - 1] : resultText;

  if (!rawResponse && structuredOutput === undefined) {
    throw new Error("Claude response was empty");
  }

  return {
    rawResponse: rawResponse ?? "",
    structuredOutput,
  };
}

function getModel(config?: OrcaConfig): string {
  return config?.claude?.model ?? process.env.ORCA_CLAUDE_MODEL ?? "claude-sonnet-4-5";
}

function getEffort(config?: OrcaConfig): ClaudeEffort | undefined {
  return config?.claude?.effort;
}

function buildClaudeQueryOptions(
  config: OrcaConfig | undefined,
  outputFormat: typeof PLAN_OUTPUT_FORMAT | typeof EXECUTION_OUTPUT_FORMAT,
): { model: string; permissionMode: "bypassPermissions"; outputFormat: typeof outputFormat } {
  const options: {
    model: string;
    permissionMode: "bypassPermissions";
    outputFormat: typeof outputFormat;
    effortValue?: ClaudeEffort;
  } = {
    model: getModel(config),
    permissionMode: "bypassPermissions",
    outputFormat,
  };

  const effort = getEffort(config);
  if (effort) {
    options.effortValue = effort;
  }

  return options;
}

function shouldAllowTextJsonFallback(config?: OrcaConfig): boolean {
  if (config?.claude?.allowTextJsonFallback !== undefined) {
    return config.claude.allowTextJsonFallback;
  }

  const env = process.env.ORCA_CLAUDE_ALLOW_TEXT_JSON_FALLBACK;
  return env === "1" || env === "true";
}

function throwMissingStructuredOutput(kind: "planner" | "task execution"): never {
  throw new Error(
    `Claude structured_output missing for ${kind}. Refusing freeform JSON parsing on critical path. ` +
      "Set ORCA_CLAUDE_ALLOW_TEXT_JSON_FALLBACK=1 (or config.claude.allowTextJsonFallback=true) to temporarily enable fallback.",
  );
}

export async function planSpec(spec: string, systemContext: string, config?: OrcaConfig): Promise<PlanResult> {
  const claudeQuery = query({
    prompt: buildPlanningPrompt(spec, systemContext),
    options: buildClaudeQueryOptions(config, PLAN_OUTPUT_FORMAT),
  });

  try {
    const { rawResponse, structuredOutput } = await collectSessionResult(claudeQuery);

    if (structuredOutput !== undefined) {
      return {
        tasks: parseStructuredPlanPayload(structuredOutput),
        rawResponse,
      };
    }

    if (!shouldAllowTextJsonFallback(config)) {
      throwMissingStructuredOutput("planner");
    }

    console.warn("[orca][claude] structured_output missing for planner; fallback text JSON parser enabled via explicit flag");
    return {
      tasks: parseTaskArray(rawResponse),
      rawResponse,
    };
  } finally {
    claudeQuery.close();
  }
}

export async function executeTask(
  task: Task,
  runId: string,
  config?: OrcaConfig,
  systemContext?: string,
): Promise<TaskExecutionResult> {
  const claudeQuery = query({
    prompt: buildTaskExecutionPrompt(task, runId, process.cwd(), systemContext),
    options: buildClaudeQueryOptions(config, EXECUTION_OUTPUT_FORMAT),
  });

  try {
    const { rawResponse, structuredOutput } = await collectSessionResult(claudeQuery);

    if (structuredOutput !== undefined) {
      return parseStructuredTaskExecutionPayload(structuredOutput, rawResponse);
    }

    if (!shouldAllowTextJsonFallback(config)) {
      throwMissingStructuredOutput("task execution");
    }

    console.warn(
      "[orca][claude] structured_output missing for task execution; fallback text JSON parser enabled via explicit flag",
    );
    return parseTaskExecution(rawResponse);
  } finally {
    claudeQuery.close();
  }
}
