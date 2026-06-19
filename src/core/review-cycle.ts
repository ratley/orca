import { z } from "zod";

import type { OrcaConfig, RunStatus, Task } from "../types/index.js";

export type FindingsMode = "auto_fix" | "report_only" | "fail";

export interface ValidationResult {
  command: string;
  exitCode: number;
  output: string;
}

export interface ExecutionReviewResult {
  findings: string[];
  summary: string;
  fixed: boolean;
  rawResponse: string;
}

export interface TaskReviewConfig {
  enabled: boolean;
  maxCycles: number;
  onFindings: FindingsMode;
  prompt?: string;
}

export interface ExecutionReviewConfig {
  enabled: boolean;
  maxCycles: number;
  onFindings: FindingsMode;
  validatorAuto: boolean;
  validatorCommands?: string[];
  prompt?: string;
}

const ExecutionReviewPayloadSchema = z.object({
  summary: z.string().min(1),
  findings: z.array(z.string()),
  fixed: z.boolean()
}).strict();

type StructuredReviewResult = z.infer<typeof ExecutionReviewPayloadSchema>;

function reviewInstructionsForMode(mode: FindingsMode): string[] {
  if (mode === "auto_fix") {
    return [
      "If there are fixable findings, apply fixes directly in the workspace before responding.",
      "Set fixed=true only when you changed files during this review cycle."
    ];
  }

  return [
    "Do not edit files or run mutating commands during this review. Report findings only.",
    "Set fixed=false because this review mode is read-only."
  ];
}

export function getExecutionReviewConfig(config?: OrcaConfig, env: NodeJS.ProcessEnv = process.env): ExecutionReviewConfig {
  const review = (config?.review ?? {}) as OrcaConfig["review"] & { enabled?: boolean };
  const executionConfig = review.execution;
  const skipValidators = env.ORCA_SKIP_VALIDATORS === "1";
  return {
    enabled: executionConfig?.enabled ?? review.enabled ?? true,
    maxCycles: executionConfig?.maxCycles ?? 2,
    onFindings: executionConfig?.onFindings ?? "auto_fix",
    validatorAuto: skipValidators ? false : (executionConfig?.validator?.auto ?? true),
    ...(executionConfig?.validator?.commands !== undefined ? { validatorCommands: executionConfig.validator.commands } : {}),
    ...(executionConfig?.prompt !== undefined ? { prompt: executionConfig.prompt } : {})
  };
}

export function getTaskReviewConfig(config?: OrcaConfig): TaskReviewConfig {
  const review = (config?.review ?? {}) as OrcaConfig["review"] & { enabled?: boolean };
  const taskConfig = review.task;
  return {
    enabled: taskConfig?.enabled ?? review.enabled ?? true,
    maxCycles: taskConfig?.maxCycles ?? 2,
    onFindings: taskConfig?.onFindings ?? "auto_fix",
    ...(taskConfig?.prompt !== undefined ? { prompt: taskConfig.prompt } : {})
  };
}

export function buildTaskReviewPrompt(
  cycleIndex: number,
  task: Pick<Task, "id" | "name" | "description" | "acceptance_criteria">,
  spec: string | null,
  taskGraphJson: string,
  extraPrompt?: string,
  findingsMode: FindingsMode = "auto_fix"
): string {
  return [
    "You are Orca's per-task spec reviewer.",
    "Review the just-completed task against the original spec, full task graph, and task acceptance criteria.",
    "Inspect the current uncommitted repository changes. Focus on whether this task is complete, minimal, and still aligned with the original spec.",
    ...reviewInstructionsForMode(findingsMode),
    "Use findings only for actionable defects, spec drift, missing acceptance criteria, or risky incomplete work.",
    "If the task is acceptable, set findings to [] even if you have positive observations or a summary.",
    "Do not broaden scope beyond this task unless the original spec requires it.",
    "Respond with JSON only using this exact shape:",
    '{"summary":"...","findings":["..."],"fixed":true|false}',
    `Cycle: ${cycleIndex}`,
    `Task ID: ${task.id}`,
    `Task Name: ${task.name}`,
    "Task Description:",
    task.description,
    "Acceptance Criteria:",
    ...task.acceptance_criteria.map((criterion, index) => `${index + 1}. ${criterion}`),
    "Original spec:",
    spec ?? "(original spec unavailable)",
    "Current task graph:",
    taskGraphJson,
    ...(extraPrompt ? ["Additional per-task reviewer instructions:", extraPrompt] : [])
  ].join("\n\n");
}

export function buildPostExecutionReviewPrompt(
  cycleIndex: number,
  validationResults: ValidationResult[],
  extraPrompt?: string,
  findingsMode: FindingsMode = "auto_fix"
): string {
  return [
    "You are Orca's post-execution reviewer.",
    "Inspect uncommitted repository changes and validation command output.",
    ...reviewInstructionsForMode(findingsMode),
    "Use findings only for actionable defects, spec drift, validator failures, or risky incomplete work.",
    "If the run is acceptable, set findings to [] even if you have positive observations or a summary.",
    "Respond with JSON only using this exact shape:",
    '{"summary":"...","findings":["..."],"fixed":true|false}',
    `Cycle: ${cycleIndex}`,
    "Validation output:",
    JSON.stringify(validationResults, null, 2),
    ...(extraPrompt ? ["Additional reviewer instructions:", extraPrompt] : [])
  ].join("\n\n");
}

function extractJsonCandidate(raw: string): string {
  const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  return (match?.[1] ?? raw).trim();
}

function parseStructuredExecutionReview(raw: string):
  | { ok: true; value: StructuredReviewResult }
  | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonCandidate(raw));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `JSON parse failed: ${message}` };
  }

  const result = ExecutionReviewPayloadSchema.safeParse(parsed);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "<root>"}: ${issue.message}`)
      .join("; ");
    return { ok: false, error: `Schema validation failed: ${details}` };
  }

  return { ok: true, value: result.data };
}

function buildExecutionReviewRepairPrompt(
  cycleIndex: number,
  previousResponse: string,
  parseError: string,
  extraPrompt?: string,
  findingsMode: FindingsMode = "auto_fix"
): string {
  return [
    "Your previous post-execution review response was invalid.",
    `Cycle: ${cycleIndex}`,
    `Validation failure: ${parseError}`,
    "Return JSON only using this exact shape and types:",
    '{"summary":"...","findings":["..."],"fixed":true|false}',
    ...reviewInstructionsForMode(findingsMode),
    "findings must contain only actionable unresolved defects. Use [] for clean/accepted work.",
    "Do not include markdown fences.",
    "Do not include any additional keys.",
    "Previous invalid response:",
    previousResponse,
    ...(extraPrompt ? ["Additional reviewer instructions:", extraPrompt] : [])
  ].join("\n\n");
}

export async function requestStructuredExecutionReview(
  runPrompt: (prompt: string) => Promise<string>,
  cycleIndex: number,
  basePrompt: string,
  extraPrompt?: string,
  findingsMode: FindingsMode = "auto_fix"
): Promise<ExecutionReviewResult> {
  const maxAttempts = 2;
  let prompt = basePrompt;
  let lastRaw = "";
  let lastError = "unknown validation error";

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const raw = await runPrompt(prompt);
    lastRaw = raw;
    const parsed = parseStructuredExecutionReview(raw);
    if (parsed.ok) {
      return {
        findings: parsed.value.findings,
        summary: parsed.value.summary,
        fixed: parsed.value.fixed,
        rawResponse: raw
      };
    }

    lastError = parsed.error;
    console.error(`[orca] Post-execution reviewer response failed validation (attempt ${attempt}/${maxAttempts}): ${parsed.error}`);
    if (attempt < maxAttempts) {
      prompt = buildExecutionReviewRepairPrompt(cycleIndex, raw, parsed.error, extraPrompt, findingsMode);
    }
  }

  return {
    findings: [`review-response-parse-error: ${lastError}`],
    summary: `Post-execution reviewer returned invalid JSON after ${maxAttempts} attempts (${lastError})`,
    fixed: false,
    rawResponse: lastRaw
  };
}

export async function runCompletedTaskReview(options: {
  task: Task;
  run: RunStatus;
  spec: string | null;
  config: TaskReviewConfig;
  runPrompt: (prompt: string) => Promise<string>;
  emitFindings: (event: HookEventMapOnFindingsInput) => Promise<void>;
}): Promise<{ outcome: "accepted" | "failed"; summary: string; error?: string }> {
  const taskGraphJson = JSON.stringify(options.run.tasks, null, 2);
  let lastSummary = "Per-task review found unresolved issues.";

  for (let cycleIndex = 1; cycleIndex <= options.config.maxCycles; cycleIndex += 1) {
    const prompt = buildTaskReviewPrompt(
      cycleIndex,
      options.task,
      options.spec,
      taskGraphJson,
      options.config.prompt,
      options.config.onFindings
    );
    const reviewResult = await requestStructuredExecutionReview(
      options.runPrompt,
      cycleIndex,
      prompt,
      options.config.prompt,
      options.config.onFindings
    );
    lastSummary = reviewResult.summary;

    if (reviewResult.findings.length === 0) {
      return { outcome: "accepted", summary: reviewResult.summary };
    }

    await options.emitFindings({
      task: options.task,
      reviewResult,
      cycleIndex
    });

    if (options.config.onFindings === "report_only") {
      return { outcome: "accepted", summary: reviewResult.summary };
    }

    if (options.config.onFindings === "fail") {
      return {
        outcome: "failed",
        summary: reviewResult.summary,
        error: `Per-task review failed for ${options.task.id}: ${reviewResult.summary}`
      };
    }

    if (!reviewResult.fixed) {
      return {
        outcome: "failed",
        summary: reviewResult.summary,
        error: `Per-task review found unresolved findings for ${options.task.id}: ${reviewResult.summary}`
      };
    }
  }

  return {
    outcome: "failed",
    summary: lastSummary,
    error: `Per-task review did not converge for ${options.task.id}: ${lastSummary}`
  };
}

export type HookEventMapOnFindingsInput = {
  task: Task;
  reviewResult: ExecutionReviewResult;
  cycleIndex: number;
};
