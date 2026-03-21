import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { readdir, readFile, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CodexClient } from "@ratley/codex-client";
import type {
  CompletedTurn,
  RequestId,
  ThreadItem,
  ToolRequestUserInputParams,
  ToolRequestUserInputResponse,
} from "@ratley/codex-client";

import type {
  HookEvent,
  OrcaConfig,
  PendingAnswerChannel,
  PlanResult,
  RunId,
  Task,
  TaskExecutionResult,
  TaskGraphReviewOperation,
  TaskGraphReviewResult
} from "../../types/index.js";
import { isCodexMultiAgentActive } from "../../core/codex-config.js";
import {
  buildQuestionHookMessage,
  createPendingQuestion,
  parseQuestionAnswerInput,
} from "../../core/question-flow.js";
import {
  clearSecretAnswerChannel,
  writeSecretAnswerChannel,
} from "../../core/secret-answer-channel.js";
import { TaskGraphReviewPayloadSchema } from "../../core/task-graph-review.js";
import { RunStore } from "../../state/store.js";
import type { CodexEffort } from "../../types/effort.js";
import * as skillLoader from "../../utils/skill-loader.js";
import type { LoadedSkill } from "../../utils/skill-loader.js";
import { logger } from "../../utils/logger.js";
import { resolveCodexPath } from "./codex-path.js";

export type { PlanResult, TaskExecutionResult };

function getCodeSimplifierGuidance(): string[] {
  return [
    "For every code-writing step, explicitly apply code-simplifier guidance (use the bundled code-simplifier skill when available).",
    "For every code-review step, explicitly apply code-simplifier guidance (use the bundled code-simplifier skill when available).",
    "Bias toward the simplest implementation that satisfies the task.",
    "Do not add compatibility fallbacks, legacy branches, or dead code unless explicitly required by the task.",
    "Before finalizing, run a simplification pass: remove unnecessary complexity while preserving required behavior.",
    "Keep changes behavior-preserving unless the task explicitly requires behavior changes.",
  ];
}

function getMultiAgentPlanningGuidance(multiAgentActive: boolean): string[] {
  if (!multiAgentActive) {
    return [];
  }

  return [
    "Codex multi-agent mode is enabled for this run. Shape the task graph so safe subagent parallelization is obvious.",
    "Assign clear file or subsystem ownership per task so subagents do not step on each other.",
    "Only add dependencies that are truly required for correctness.",
    "Do not bundle unrelated work into a single do-everything task when it can be safely split.",
  ];
}

function getClarificationRequestGuidance(clarificationToolAvailable: boolean, scope: "planning" | "execution" | "review"): string[] {
  if (!clarificationToolAvailable) {
    return [];
  }

  const firstLine = scope === "execution"
    ? "If you need any user-provided value, preference, approval, or clarification to complete this task correctly, use Codex's request_user_input tool instead of guessing, failing, or baking the question into a later task."
    : "If a blocking ambiguity prevents correct work, use Codex's request_user_input tool to ask concise clarification questions instead of guessing.";

  return [
    firstLine,
    "Ask at most 3 short questions with stable snake_case ids.",
    "If you need a secret such as a token or password, mark that question as secret.",
    ...(scope === "execution"
      ? [
          "If this task is itself about obtaining clarification, it is not complete until the question has been asked, answered, and the answer has been applied.",
          "After the user answers, continue the same turn and finish the requested file changes, commands, and verification before responding.",
          "Do not stop after acknowledging the answer. Resume implementation immediately and only finish once the requested edits are on disk and validated.",
        ]
      : []),
  ];
}

function buildPlanningPrompt(
  spec: string,
  systemContext: string,
  multiAgentActive: boolean,
  clarificationToolAvailable: boolean,
): string {
  return [
    systemContext,
    "You are decomposing a spec into an ordered task graph.",
    "Prefer task decomposition that maximizes safe parallelism for independent workstreams.",
    "Isolate task ownership (files/subsystems) to avoid cross-task collisions.",
    ...getClarificationRequestGuidance(clarificationToolAvailable, "planning"),
    ...getMultiAgentPlanningGuidance(multiAgentActive),
    ...getCodeSimplifierGuidance(),
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

function isUnsupportedCollaborationModeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("-32601") ||
    message.includes("Method not found") ||
    message.includes("Invalid collaboration mode list response")
  );
}

async function detectCollaborationModeSupport(
  client: CodexClient,
  codexPath: string,
  interactiveRunEnabled: boolean,
): Promise<boolean> {
  if (!interactiveRunEnabled) {
    return false;
  }

  const maybeListCollaborationModes = (
    client as CodexClient & { listCollaborationModes?: () => Promise<unknown> }
  ).listCollaborationModes;

  if (typeof maybeListCollaborationModes !== "function") {
    return true;
  }

  try {
    await maybeListCollaborationModes.call(client);
    return true;
  } catch (error) {
    if (!isUnsupportedCollaborationModeError(error)) {
      throw error;
    }

    logger.warn(
      `Codex binary at ${codexPath} does not support collaboration mode / question flow. Falling back to non-interactive prompts for this run.`,
    );
    return false;
  }
}

function buildTaskExecutionPrompt(
  task: Task,
  runId: string,
  cwd: string,
  systemContext?: string,
  multiAgentActive = false,
  clarificationContext?: string,
): string {
  return [
    ...(systemContext ? [systemContext] : []),
    "You are Orca's task execution assistant.",
    ...getCodeSimplifierGuidance(),
    ...(multiAgentActive
      ? [
          "Codex multi-agent mode is enabled for this run.",
          "If this task contains clearly independent subtasks with disjoint ownership, use subagents to parallelize them.",
          "Do not use subagents for tightly coupled, blocking, or highly stateful work.",
          "Integrate subagent results yourself before final completion.",
        ]
      : []),
    `Run ID: ${runId}`,
    `Repository CWD: ${cwd}`,
    `Task ID: ${task.id}`,
    `Task Name: ${task.name}`,
    "Task Description:",
    task.description,
    ...(clarificationContext && clarificationContext.trim().length > 0
      ? ["Resolved Clarification Context:", clarificationContext.trim()]
      : []),
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

function buildTaskExecutionClarificationPrompt(
  task: Task,
  runId: string,
  cwd: string,
  systemContext?: string,
): string {
  return [
    ...(systemContext ? [systemContext] : []),
    "You are Orca's execution clarification gate.",
    ...getClarificationRequestGuidance(true, "execution"),
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
    "Inspect the repository and task to decide whether execution needs any user-provided value or preference.",
    "Do not edit files, do not run mutating commands, and do not claim the task is complete in this turn.",
    "If user input is needed, ask via request_user_input, wait for the answer, then continue and summarize the resolved constraint.",
    'Return JSON only with shape: {"needsInput":boolean,"context":string}',
    "Set needsInput=true only if you actually asked the user in this clarification turn.",
    "Set context to a concise execution-ready summary of the user-provided value(s) and any discovered constraints the execution turn must honor. Use an empty string when no extra context is needed.",
  ].join("\n\n");
}

function buildPlanDecisionPrompt(
  spec: string,
  systemContext: string,
  clarificationToolAvailable: boolean,
): string {
  return [
    systemContext,
    "You are Orca's planning gate.",
    ...getClarificationRequestGuidance(clarificationToolAvailable, "planning"),
    "Decide whether this spec needs multi-step planning or can run as one direct execution task.",
    "Set needsPlan=true when coordination/dependencies/research/design across multiple steps are required.",
    "Set needsPlan=false when a single focused execution task is sufficient.",
    "Return JSON only with shape: {\"needsPlan\":boolean,\"reason\":string}",
    "Spec:",
    spec,
  ].join("\n\n");
}

function buildTaskGraphReviewPrompt(
  tasks: Task[],
  systemContext: string,
  multiAgentActive: boolean,
  clarificationToolAvailable: boolean,
): string {
  return [
    systemContext,
    "You are Orca's pre-execution task-graph reviewer.",
    ...getCodeSimplifierGuidance(),
    ...getClarificationRequestGuidance(clarificationToolAvailable, "review"),
    ...(multiAgentActive
      ? [
          "Codex multi-agent mode is enabled for this run. Review the graph for safe subagent parallelization.",
          "Split independent work into separate tasks when subagents could execute it in parallel.",
          "Remove fake dependencies that unnecessarily serialize independent work.",
          "Flag ownership collisions where multiple tasks would touch the same files or subsystem without coordination.",
          "Add coordination tasks when parallel work needs a final integration step.",
        ]
      : []),
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

function buildTaskGraphConsultationPrompt(
  tasks: Task[],
  multiAgentActive: boolean,
  clarificationToolAvailable: boolean,
): string {
  const taskGraphJson = JSON.stringify(tasks, null, 2);

  return [
    "Review this Orca task graph before execution.",
    "Flag any: missing steps, wrong dependency order, tasks that are underdefined, or potential blockers.",
    ...getClarificationRequestGuidance(clarificationToolAvailable, "review"),
    ...(clarificationToolAvailable
      ? [
          "Execution tasks are allowed to pause and ask request_user_input questions when they truly need a user-provided value.",
          "Do not ask the user whether Orca may pause during execution for clarification. Assume that execution-time request_user_input is available.",
          "If a task already says it should ask for a missing user value during execution, treat that as a valid execution mechanism, not a reason to ask a meta-question about whether clarification is allowed.",
          "Only ask a review-time clarification question if the graph cannot be assessed or corrected without an answer right now.",
        ]
      : []),
    ...(multiAgentActive
      ? [
          "",
          "Codex multi-agent mode is enabled for this run.",
          "Treat missed safe parallelism, fake dependencies, overlapping ownership, or missing integration tasks as review concerns.",
          "Flag tasks that should be split for safe subagent execution, or tasks that would cause subagents to step on each other.",
        ]
      : []),
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

  const completedTurnAgentItems = result.turn.items.filter((item) => item.type === "agentMessage");
  if (completedTurnAgentItems.length > 0) {
    const last = completedTurnAgentItems[completedTurnAgentItems.length - 1];
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

export interface PlanNeedDecision {
  needsPlan: boolean;
  reason: string;
}

interface ExecutionClarificationDecision {
  needsInput: boolean;
  context: string;
}

function parsePlanDecision(raw: string): PlanNeedDecision {
  const json = extractJson(raw);
  const parsed = JSON.parse(json) as unknown;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Codex plan decision response was not a JSON object");
  }

  const candidate = parsed as { needsPlan?: unknown; reason?: unknown };
  if (typeof candidate.needsPlan !== "boolean") {
    throw new Error("Codex plan decision response missing boolean needsPlan");
  }

  if (typeof candidate.reason !== "string" || candidate.reason.trim().length === 0) {
    throw new Error("Codex plan decision response missing non-empty reason");
  }

  return {
    needsPlan: candidate.needsPlan,
    reason: candidate.reason,
  };
}

function parseExecutionClarificationDecision(raw: string): ExecutionClarificationDecision {
  const json = extractJson(raw);
  const parsed = JSON.parse(json) as unknown;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Codex execution clarification response was not a JSON object");
  }

  const candidate = parsed as { needsInput?: unknown; context?: unknown };
  if (typeof candidate.needsInput !== "boolean") {
    throw new Error("Codex execution clarification response missing boolean needsInput");
  }

  if (typeof candidate.context !== "string") {
    throw new Error("Codex execution clarification response missing string context");
  }

  return {
    needsInput: candidate.needsInput,
    context: candidate.context,
  };
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

function parseTaskExecutionWithSource(raw: string): { result: TaskExecutionResult; usedCompletionMarker: boolean } {
  let json: string;
  let parsed: unknown;

  try {
    json = extractJson(raw);
    parsed = JSON.parse(json);
  } catch {
    return {
      result: inferOutcomeFromText(raw),
      usedCompletionMarker: false,
    };
  }

  if (!parsed || typeof parsed !== "object") {
    return {
      result: inferOutcomeFromText(raw),
      usedCompletionMarker: false,
    };
  }

  const candidate = parsed as { outcome?: unknown; error?: unknown };

  if (candidate.outcome !== "done" && candidate.outcome !== "failed") {
    return {
      result: inferOutcomeFromText(raw),
      usedCompletionMarker: false,
    };
  }

  if (candidate.error !== undefined && typeof candidate.error !== "string") {
    throw new Error("Codex task response error must be a string");
  }

  return {
    result: {
      outcome: candidate.outcome,
      rawResponse: raw,
      ...(typeof candidate.error === "string" ? { error: candidate.error } : {}),
    },
    usedCompletionMarker: true,
  };
}

function collectCompletedTurnItems(result: CompletedTurn): ThreadItem[] {
  return [...result.items, ...(Array.isArray(result.turn.items) ? result.turn.items : [])];
}

function taskLikelyMutatesFiles(task: Task): boolean {
  const normalized = [
    task.name,
    task.description,
    ...task.acceptance_criteria,
  ]
    .join("\n")
    .toLowerCase();

  return (
    normalized.includes(".ts") ||
    normalized.includes(".js") ||
    normalized.includes(".tsx") ||
    normalized.includes(".jsx") ||
    normalized.includes(".json") ||
    normalized.includes(".md") ||
    normalized.includes(".txt") ||
    normalized.includes("create ") ||
    normalized.includes("update ") ||
    normalized.includes("write ") ||
    normalized.includes("edit ") ||
    normalized.includes("export ")
  );
}

function hasRecordedFileChanges(items: ThreadItem[]): boolean {
  return items.some((item) => {
    if (item.type !== "fileChange") {
      return false;
    }

    const status = "status" in item ? item.status : undefined;
    const changes = "changes" in item ? item.changes : undefined;
    return status === "completed" && Array.isArray(changes) && changes.length > 0;
  });
}

function hasSuccessfulVerificationCommand(items: ThreadItem[]): boolean {
  return items.some((item) => {
    if (item.type !== "commandExecution") {
      return false;
    }

    const command = typeof item.command === "string" ? item.command : "";
    return (
      item.exitCode === 0 &&
      /(bun test|npm run test|npm test|validate|lint|typecheck|tsc|build|pytest|cargo test)/i.test(command)
    );
  });
}

function enforceFallbackExecutionEvidence(
  task: Task,
  result: CompletedTurn,
  parsedResult: TaskExecutionResult,
  usedCompletionMarker: boolean,
): TaskExecutionResult {
  if (usedCompletionMarker || parsedResult.outcome !== "done") {
    return parsedResult;
  }

  const items = collectCompletedTurnItems(result);
  const fileChangesRecorded = hasRecordedFileChanges(items);
  const verificationRan = hasSuccessfulVerificationCommand(items);

  if (taskLikelyMutatesFiles(task) && !fileChangesRecorded && !verificationRan) {
    return {
      outcome: "failed",
      rawResponse: parsedResult.rawResponse,
      error: "Codex did not emit a JSON completion marker, no file changes were recorded, and no successful verification command ran for a task that required file edits.",
    };
  }

  if (!fileChangesRecorded && !verificationRan && parsedResult.rawResponse.trim().length === 0) {
    return {
      outcome: "failed",
      rawResponse: parsedResult.rawResponse,
      error: "Codex did not emit a JSON completion marker or any concrete execution artifacts.",
    };
  }

  return parsedResult;
}

function getModel(config?: OrcaConfig): string {
  return config?.codex?.model ?? process.env.ORCA_CODEX_MODEL ?? "gpt-5.3-codex";
}

type ThinkingStep = "decision" | "planning" | "review" | "execution";

const DEFAULT_THINKING_BY_STEP: Record<ThinkingStep, CodexEffort> = {
  decision: "low",
  planning: "high",
  review: "high",
  execution: "medium",
};

const ANSWER_FILE_POLL_MS = 500;

function getEffort(config: OrcaConfig | undefined, step: ThinkingStep): CodexEffort {
  const explicitThinkingLevel = config?.codex?.thinkingLevel?.[step];
  if (explicitThinkingLevel !== undefined) {
    return explicitThinkingLevel;
  }

  if (config?.codex?.effort !== undefined) {
    return config.codex.effort;
  }

  return DEFAULT_THINKING_BY_STEP[step];
}

function buildTurnInput(text: string, skills: LoadedSkill[]): Array<{ type: "text"; text: string }> {
  const usableSkills = skills.filter((skill) => skill.body.trim().length > 0);
  if (usableSkills.length === 0) {
    return [{ type: "text", text }];
  }

  const skillContext = usableSkills.map((skill) => [
    `Skill: ${skill.name}`,
    `Source: ${skill.filePath}`,
    skill.body.trim(),
  ].join("\n")).join("\n\n");

  return [{
    type: "text",
    text: [
      text,
      "Referenced Orca skills:",
      skillContext,
    ].join("\n\n"),
  }];
}

interface RawSkill {
  name?: unknown;
  description?: unknown;
  shortDescription?: unknown;
  interface?: unknown;
  dependencies?: unknown;
  path?: unknown;
}

interface RawSkillsListEntry {
  cwd?: unknown;
  skills?: unknown;
}

function renderSkillMetadataBody(skill: RawSkill): string {
  const sections: string[] = [];

  if (typeof skill.description === "string" && skill.description.trim().length > 0) {
    sections.push(skill.description.trim());
  } else if (typeof skill.shortDescription === "string" && skill.shortDescription.trim().length > 0) {
    sections.push(skill.shortDescription.trim());
  }

  if (skill.interface && typeof skill.interface === "object") {
    sections.push(`Interface:\n${JSON.stringify(skill.interface, null, 2)}`);
  }

  if (skill.dependencies && typeof skill.dependencies === "object") {
    sections.push(`Dependencies:\n${JSON.stringify(skill.dependencies, null, 2)}`);
  }

  return sections.join("\n\n").trim();
}

function normalizePerCwdExtraUserRoots(config?: OrcaConfig): Array<{ cwd: string; extraUserRoots: string[] }> {
  const configured = config?.codex?.perCwdExtraUserRoots;
  if (!configured || configured.length === 0) {
    return [];
  }

  return configured
    .filter((entry): entry is { cwd: string; extraUserRoots: string[] } =>
      typeof entry.cwd === "string" && Array.isArray(entry.extraUserRoots)
    )
    .map((entry) => {
      const trimmedCwd = entry.cwd.trim();
      return {
        cwd: trimmedCwd.length > 0 ? path.resolve(trimmedCwd) : "",
        extraUserRoots: entry.extraUserRoots
        .filter((root): root is string => typeof root === "string")
        .map((root) => root.trim())
        .filter((root) => root.length > 0),
      };
    })
    .filter((entry) => entry.cwd.length > 0 && entry.extraUserRoots.length > 0);
}

function getPerCwdExtraUserRootsForCwd(config: OrcaConfig | undefined, cwd: string): Array<{ cwd: string; extraUserRoots: string[] }> {
  const normalizedCwd = path.resolve(cwd);
  return normalizePerCwdExtraUserRoots(config).filter((entry) => entry.cwd === normalizedCwd);
}

async function loadConfiguredPerCwdExtraRootSkills(
  config: OrcaConfig | undefined,
  cwd: string,
): Promise<LoadedSkill[]> {
  const configuredRoots = getPerCwdExtraUserRootsForCwd(config, cwd);
  if (configuredRoots.length === 0) {
    return [];
  }

  const candidateDirs = new Set<string>();
  for (const entry of configuredRoots) {
    for (const root of entry.extraUserRoots) {
      const resolvedRoot = path.resolve(root);
      candidateDirs.add(resolvedRoot);
      candidateDirs.add(path.join(resolvedRoot, "skills"));
      candidateDirs.add(path.join(resolvedRoot, ".agents", "skills"));
      candidateDirs.add(path.join(resolvedRoot, ".codex", "skills"));
    }
  }

  const discovered: LoadedSkill[] = [];
  for (const candidateDir of candidateDirs) {
    let entries;
    try {
      entries = await readdir(candidateDir, { withFileTypes: true, encoding: "utf8" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }

      throw error;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const skillDir = path.join(candidateDir, entry.name);
      const skillFile = path.join(skillDir, "SKILL.md");
      let skillFileContent: string;
      try {
        skillFileContent = await readFile(skillFile, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          continue;
        }

        throw error;
      }

      const frontmatterMatch = skillFileContent.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/u);
      discovered.push({
        name: entry.name,
        description: "",
        body: frontmatterMatch ? skillFileContent.slice(frontmatterMatch[0].length) : skillFileContent,
        dirPath: skillDir,
        filePath: skillFile,
      });
    }
  }
  return discovered;
}

async function loadCodexListedSkills(client: CodexClient, cwd: string, config?: OrcaConfig): Promise<LoadedSkill[]> {
  const perCwdExtraUserRoots = getPerCwdExtraUserRootsForCwd(config, cwd);

  let response: unknown;
  try {
    const maybeListSkills = Reflect.get(client as object, "listSkills");
    if (typeof maybeListSkills === "function") {
      response = await maybeListSkills.call(client, {
        cwds: [cwd],
        forceReload: true,
        ...(perCwdExtraUserRoots.length > 0 ? { perCwdExtraUserRoots } : {}),
      });
    } else {
      const maybeRequest = Reflect.get(client as object, "request");
      if (typeof maybeRequest !== "function") {
        return [];
      }

      const request = maybeRequest as (
        this: unknown,
        method: string,
        params?: unknown,
        timeoutMs?: number
      ) => Promise<unknown>;

      response = await request.call(client, "skills/list", {
        cwds: [cwd],
        forceReload: true,
        ...(perCwdExtraUserRoots.length > 0 ? { perCwdExtraUserRoots } : {}),
      });
    }
  } catch {
    return [];
  }

  if (!response || typeof response !== "object" || !("data" in response) || !Array.isArray(response.data)) {
    return [];
  }

  const discovered: LoadedSkill[] = [];

  for (const entry of response.data as RawSkillsListEntry[]) {
    if (!entry || typeof entry !== "object" || !Array.isArray(entry.skills)) {
      continue;
    }

    for (const skill of entry.skills as RawSkill[]) {
      if (!skill || typeof skill !== "object" || typeof skill.name !== "string") {
        continue;
      }

      let skillBody = "";
      let normalizedSkillPath: string | null = null;
      if (typeof skill.path === "string" && skill.path.trim().length > 0) {
        normalizedSkillPath = skill.path.trim();
        try {
          skillBody = await readFile(normalizedSkillPath, "utf8");
        } catch {
          skillBody = "";
        }
      }

      if (skillBody.trim().length === 0) {
        skillBody = renderSkillMetadataBody(skill);
      }

      discovered.push({
        name: skill.name,
        description:
          typeof skill.description === "string"
            ? skill.description
            : (typeof skill.shortDescription === "string" ? skill.shortDescription : ""),
        body: skillBody,
        dirPath: normalizedSkillPath ? path.dirname(normalizedSkillPath) : cwd,
        filePath: normalizedSkillPath ?? `${cwd}#skills/list:${skill.name}`,
      });
    }
  }

  discovered.sort((a, b) => {
    if (a.name < b.name) {
      return -1;
    }
    if (a.name > b.name) {
      return 1;
    }
    if (a.dirPath < b.dirPath) {
      return -1;
    }
    if (a.dirPath > b.dirPath) {
      return 1;
    }
    return 0;
  });

  return discovered;
}

async function resolveTurnSkills(client: CodexClient, config: OrcaConfig | undefined, cwd: string): Promise<LoadedSkill[]> {
  const baseSkills = await skillLoader.loadSkills(config);
  const configuredExtraRootSkills = await loadConfiguredPerCwdExtraRootSkills(config, cwd);

  const listedSkills = await loadCodexListedSkills(client, cwd, config);

  if (configuredExtraRootSkills.length === 0 && listedSkills.length === 0) {
    return baseSkills;
  }

  const mergedByName = new Map<string, LoadedSkill>();
  for (const skill of baseSkills) {
    mergedByName.set(skill.name, skill);
  }
  for (const skill of configuredExtraRootSkills) {
    if (!mergedByName.has(skill.name)) {
      mergedByName.set(skill.name, skill);
    }
  }
  for (const skill of listedSkills) {
    if (!mergedByName.has(skill.name)) {
      mergedByName.set(skill.name, skill);
    }
  }

  return [...mergedByName.values()];
}

function extractUnknownFeatureKey(line: string): string | null {
  const match = line.match(/unknown feature key in config:\s*([A-Za-z0-9_.-]+)/i);
  return match?.[1] ?? null;
}

function isIgnorableMcpStderrLine(line: string): boolean {
  return (
    line.includes("codex_rmcp_client::oauth: failed to read OAuth tokens from keyring") ||
    line.includes("rmcp::transport::worker: worker quit with fatal: Transport channel closed, when AuthRequired(") ||
    line.includes("codex_core::mcp_connection_manager: Failed to list resources for MCP server") ||
    line.includes("codex_core::mcp_connection_manager: Failed to list resource templates for MCP server") ||
    line.includes("codex_core::shell_snapshot: Failed to delete shell snapshot") ||
    line.includes("codex_rmcp_client::rmcp_client: Failed to kill MCP process group") ||
    line.includes("codex_protocol::openai_models: Model personality requested but model_messages is missing")
  );
}

function attachCodexStderrDiagnostics(client: CodexClient, codexPath: string): void {
  const on = Reflect.get(client as object, "on");
  if (typeof on !== "function") {
    return;
  }

  const reportedLines = new Set<string>();
  const reportedUnsupportedFeatures = new Set<string>();

  on.call(client, "stderr", (payload: unknown) => {
    const line = String(payload).trim();
    if (line.length === 0) {
      return;
    }

    const unsupportedFeature = extractUnknownFeatureKey(line);
    if (unsupportedFeature) {
      if (!reportedUnsupportedFeatures.has(unsupportedFeature)) {
        reportedUnsupportedFeatures.add(unsupportedFeature);
        logger.warn(
          `Codex binary ${codexPath} does not support feature '${unsupportedFeature}'. Orca will continue, but you should update Codex or point ORCA_CODEX_PATH at a newer binary.`,
        );
      }
      return;
    }

    if (isIgnorableMcpStderrLine(line)) {
      return;
    }

    if (reportedLines.has(line)) {
      return;
    }

    reportedLines.add(line);
    logger.warn(`Codex app-server: ${line}`);
  });
}

async function warnAboutUnavailableMcpServers(client: CodexClient): Promise<void> {
  const request = Reflect.get(client as object, "request");
  if (typeof request !== "function") {
    return;
  }

  let response: unknown;
  try {
    response = await request.call(client, "mcpServerStatus/list", { limit: 50 }, 10_000);
  } catch {
    return;
  }

  if (!response || typeof response !== "object" || !("data" in response) || !Array.isArray(response.data)) {
    return;
  }

  const unavailableServers = response.data
    .filter((entry): entry is { name: string; authStatus: string } =>
      !!entry &&
      typeof entry === "object" &&
      typeof (entry as { name?: unknown }).name === "string" &&
      typeof (entry as { authStatus?: unknown }).authStatus === "string",
    )
    .filter((entry) => entry.authStatus === "notLoggedIn")
    .map((entry) => entry.name);

  if (unavailableServers.length === 0) {
    return;
  }

  const loginCommands = unavailableServers.map((name) => `codex mcp login ${name}`).join(" ; ");
  logger.warn(
    `Configured Codex MCP servers need login and will be unavailable for this Orca run: ${unavailableServers.join(", ")}. Orca will continue without them. Run ${loginCommands} or disable them in ~/.codex/config.toml if you do not need them.`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function appendRunError(
  store: RunStore,
  runId: RunId,
  message: string,
  taskId?: string,
): Promise<void> {
  const run = await store.getRun(runId);
  if (!run) {
    return;
  }

  await store.updateRun(runId, {
    errors: [...run.errors, { at: new Date().toISOString(), message, ...(taskId ? { taskId } : {}) }],
  });
}

async function clearAnswerFile(store: RunStore, runId: RunId): Promise<void> {
  const answerPath = path.join(store.getRunDir(runId), "answer.txt");
  await unlink(answerPath).catch(() => undefined);
}

type ResumeOverallStatus = "planning" | "running";

type SecretAnswerChannelState = {
  requestId: RequestId;
  descriptor: PendingAnswerChannel;
  nextSubmission: () => Promise<string>;
  close: () => Promise<void>;
};

type SecretAnswerChannelFactory = (requestId: RequestId) => Promise<SecretAnswerChannelState>;

let testSecretAnswerChannelFactory: SecretAnswerChannelFactory | null = null;

export function setSecretAnswerChannelFactoryForTests(factory: SecretAnswerChannelFactory | null): void {
  testSecretAnswerChannelFactory = factory;
}

function hasSecretQuestions(params: ToolRequestUserInputParams | { questions: Array<{ isSecret?: boolean }> }): boolean {
  return params.questions.some((question) => question.isSecret === true);
}

async function createSecretAnswerChannel(requestId: RequestId): Promise<SecretAnswerChannelState> {
  if (testSecretAnswerChannelFactory) {
    return await testSecretAnswerChannelFactory(requestId);
  }

  const token = randomUUID();
  const socketPath = process.platform === "win32"
    ? `\\\\.\\pipe\\orca-answer-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
    : path.join(os.tmpdir(), `orca-answer-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.sock`);
  const queuedAnswers: string[] = [];
  const waitingResolvers: Array<(answer: string) => void> = [];
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    let handled = false;

    socket.on("data", (chunk) => {
      buffer += chunk;
      if (handled || !buffer.includes("\n")) {
        return;
      }

      handled = true;
      let response: { ok: boolean; error?: string } = { ok: true };

      try {
        const parsed = JSON.parse(buffer.trim()) as { token?: unknown; answer?: unknown };
        if (parsed.token !== token) {
          throw new Error("invalid secret answer token");
        }
        if (typeof parsed.answer !== "string" || parsed.answer.trim().length === 0) {
          throw new Error("secret answer payload must include a non-empty answer string");
        }

        const resolver = waitingResolvers.shift();
        if (resolver) {
          resolver(parsed.answer);
        } else {
          queuedAnswers.push(parsed.answer);
        }
      } catch (error) {
        response = {
          ok: false as const,
          error: error instanceof Error ? error.message : String(error),
        };
      }

      socket.end(`${JSON.stringify(response)}\n`);
    });

    socket.on("error", () => {
      socket.destroy();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    requestId,
    descriptor: {
      transport: "ipc",
      path: socketPath,
      token,
    },
    nextSubmission: async () => {
      const next = queuedAnswers.shift();
      if (next !== undefined) {
        return next;
      }

      return await new Promise<string>((resolve) => {
        waitingResolvers.push(resolve);
      });
    },
    close: async () => {
      for (const resolve of waitingResolvers.splice(0)) {
        resolve("");
      }

      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });

      if (process.platform !== "win32") {
        await unlink(socketPath).catch(() => undefined);
      }
    },
  };
}

export interface SessionInteractionContext {
  runId: RunId;
  store: RunStore;
  resumeOverallStatus?: ResumeOverallStatus;
  emitHook?: (event: HookEvent) => Promise<void>;
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
  interactionContext?: SessionInteractionContext,
): Promise<{
  decidePlanningNeed: (spec: string, systemContext: string) => Promise<PlanNeedDecision>;
  planSpec: (spec: string, systemContext: string) => Promise<PlanResult>;
  reviewTaskGraph: (tasks: Task[], systemContext: string) => Promise<TaskGraphReviewResult>;
  executeTask: (task: Task, runId: string, systemContext?: string) => Promise<TaskExecutionResult>;
  consultTaskGraph: (tasks: Task[]) => Promise<ConsultationResult>;
  reviewChanges: (threadId?: string) => Promise<string>;
  runPrompt: (prompt: string, step?: ThinkingStep) => Promise<string>;
  disconnect: () => Promise<void>;
  threadId: string;
}> {
  const multiAgentActive = await isCodexMultiAgentActive(config);
  const codexPath = await resolveCodexPath();

  const client = new CodexClient({
    codexPath,
    model: getModel(config),
    cwd,
    approvalPolicy: "never",
    sandbox: "workspace-write",
  });

  attachCodexStderrDiagnostics(client, codexPath);
  await client.connect();
  await warnAboutUnavailableMcpServers(client);
  const collaborationModeAvailable = await detectCollaborationModeSupport(
    client,
    codexPath,
    interactionContext !== undefined,
  );

  let activeTaskContext: { taskId: string; taskName: string } | undefined;
  let activeSecretAnswerChannel: SecretAnswerChannelState | undefined;
  const resumedOverallStatus: ResumeOverallStatus = interactionContext?.resumeOverallStatus ?? "running";
  const resolvedServerRequests = new Set<RequestId>();
  const clarificationToolAvailable = interactionContext !== undefined && collaborationModeAvailable;

  const buildRunTurnParams = (
    step: ThinkingStep,
    input: Array<{ type: "text"; text: string }>,
    enableQuestionTool = false,
  ) => {
    const effort = getEffort(config, step);
    const usePlanCollaborationMode = enableQuestionTool && step !== "execution";
    return {
      threadId,
      effort,
      input,
      ...(usePlanCollaborationMode
        ? {
            collaborationMode: {
              mode: "plan" as const,
              settings: {
                model: getModel(config),
                reasoning_effort: effort,
                developer_instructions: null,
              },
            },
          }
        : {}),
    };
  };

  const buildExecutionClarificationTurnParams = (
    input: Array<{ type: "text"; text: string }>,
  ) => {
    const effort = getEffort(config, "execution");
    return {
      threadId,
      effort,
      input,
      collaborationMode: {
        mode: "plan" as const,
        settings: {
          model: getModel(config),
          reasoning_effort: effort,
          developer_instructions: null,
        },
      },
    };
  };

  const respondToUserInputRequest = (requestId: RequestId, response: ToolRequestUserInputResponse): void => {
    const specificResponder = Reflect.get(client as object, "respondToUserInputRequest");
    if (typeof specificResponder === "function") {
      specificResponder.call(client, requestId, response);
      return;
    }

    const genericResponder = Reflect.get(client as object, "respondToServerRequest");
    if (typeof genericResponder === "function") {
      genericResponder.call(client, requestId, response);
      return;
    }

    throw new Error("Codex client does not support responding to server requests");
  };

  const rejectUserInputRequest = (requestId: RequestId, message: string): void => {
    const rejector = Reflect.get(client as object, "rejectServerRequest");
    if (typeof rejector === "function") {
      rejector.call(client, requestId, { code: -32603, message });
      return;
    }

    throw new Error("Codex client does not support rejecting server requests");
  };

  const clearPendingQuestion = async (
    requestId: RequestId,
    overallStatus?: ResumeOverallStatus | "waiting_for_answer"
  ): Promise<void> => {
    const secretAnswerChannel = activeSecretAnswerChannel;
    if (secretAnswerChannel?.requestId === requestId) {
      if (interactionContext) {
        await clearSecretAnswerChannel(interactionContext.runId).catch(() => undefined);
      }
      await secretAnswerChannel.close().catch(() => undefined);
      if (activeSecretAnswerChannel === secretAnswerChannel) {
        activeSecretAnswerChannel = undefined;
      }
    }

    if (!interactionContext) {
      return;
    }

    const currentRun = await interactionContext.store.getRun(interactionContext.runId);
    if (!currentRun || currentRun.pendingQuestion?.requestId !== requestId) {
      return;
    }

    await interactionContext.store.updateRun(interactionContext.runId, {
      ...(overallStatus ? { overallStatus } : {}),
      pendingQuestion: undefined,
    });
  };

  const on = Reflect.get(client as object, "on");
  if (typeof on === "function") {
    on.call(
      client,
      "request:userInput",
      (request: { requestId: RequestId } & ToolRequestUserInputParams) => {
        void (async () => {
          if (!interactionContext) {
            rejectUserInputRequest(
              request.requestId,
              "Orca cannot answer Codex requestUserInput prompts without an interactive run context.",
            );
            return;
          }

          const pendingQuestion = createPendingQuestion(request.requestId, request);
          const currentRun = await interactionContext.store.getRun(interactionContext.runId);
          if (!currentRun) {
            rejectUserInputRequest(request.requestId, `Run not found while waiting for input: ${interactionContext.runId}`);
            return;
          }

          if (
            currentRun.overallStatus === "completed" ||
            currentRun.overallStatus === "failed" ||
            currentRun.overallStatus === "cancelled"
          ) {
            rejectUserInputRequest(
              request.requestId,
              `Run ${interactionContext.runId} is already ${currentRun.overallStatus}; ignoring late requestUserInput prompt.`,
            );
            return;
          }

          await clearAnswerFile(interactionContext.store, interactionContext.runId);
          let secretAnswerChannel: SecretAnswerChannelState | undefined;
          if (hasSecretQuestions(request)) {
            secretAnswerChannel = await createSecretAnswerChannel(request.requestId);
            activeSecretAnswerChannel = secretAnswerChannel;
            await writeSecretAnswerChannel(interactionContext.runId, secretAnswerChannel.descriptor);
          } else if (activeSecretAnswerChannel) {
            await clearSecretAnswerChannel(interactionContext.runId).catch(() => undefined);
            await activeSecretAnswerChannel.close().catch(() => undefined);
            activeSecretAnswerChannel = undefined;
          }

          await interactionContext.store.updateRun(interactionContext.runId, {
            overallStatus: "waiting_for_answer",
            pendingQuestion,
          });

          if (interactionContext.emitHook) {
            await interactionContext.emitHook({
              runId: interactionContext.runId,
              hook: "onQuestion",
              message: buildQuestionHookMessage(pendingQuestion),
              timestamp: pendingQuestion.receivedAt,
              requestId: pendingQuestion.requestId,
              threadId: pendingQuestion.threadId,
              turnId: pendingQuestion.turnId,
              itemId: pendingQuestion.itemId,
              questions: pendingQuestion.questions,
              ...(activeTaskContext
                ? { taskId: activeTaskContext.taskId, taskName: activeTaskContext.taskName }
                : {}),
              metadata: {
                questionCount: pendingQuestion.questions.length,
              },
            });
          }

          const answerPath = path.join(interactionContext.store.getRunDir(interactionContext.runId), "answer.txt");
          let nextSecretAnswer = secretAnswerChannel?.nextSubmission();

          while (true) {
            const currentRun = await interactionContext.store.getRun(interactionContext.runId);
            if (!currentRun) {
              rejectUserInputRequest(request.requestId, `Run not found while waiting for answer: ${interactionContext.runId}`);
              return;
            }

            if (currentRun.overallStatus === "cancelled") {
              rejectUserInputRequest(request.requestId, `Run ${interactionContext.runId} was cancelled while waiting for input.`);
              await clearPendingQuestion(request.requestId);
              return;
            }

            if (resolvedServerRequests.delete(request.requestId)) {
              await clearPendingQuestion(request.requestId, resumedOverallStatus);
              return;
            }

            let rawAnswer: string;
            if (secretAnswerChannel) {
              const submittedSecretAnswer = await Promise.race([
                nextSecretAnswer ?? Promise.resolve(""),
                sleep(ANSWER_FILE_POLL_MS).then(() => null),
              ]);
              if (submittedSecretAnswer === null) {
                continue;
              }

              rawAnswer = submittedSecretAnswer;
              nextSecretAnswer = secretAnswerChannel.nextSubmission();
            } else {
              try {
                rawAnswer = await readFile(answerPath, "utf8");
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                  await sleep(ANSWER_FILE_POLL_MS);
                  continue;
                }

                throw error;
              }
            }

            try {
              const parsedAnswer = parseQuestionAnswerInput(rawAnswer, pendingQuestion);
              respondToUserInputRequest(request.requestId, parsedAnswer);
              await clearAnswerFile(interactionContext.store, interactionContext.runId);
              await clearPendingQuestion(request.requestId, resumedOverallStatus);
              return;
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              logger.warn(`Invalid answer for run ${interactionContext.runId}; waiting for another response (${message})`);
              await appendRunError(
                interactionContext.store,
                interactionContext.runId,
                `invalid-answer: ${message}`,
                activeTaskContext?.taskId,
              );
              await clearAnswerFile(interactionContext.store, interactionContext.runId);
            }
          }
        })().catch(async (error) => {
          const message = error instanceof Error ? error.message : String(error);
          logger.warn(`Failed while handling Codex requestUserInput: ${message}`);
          if (interactionContext) {
            await appendRunError(interactionContext.store, interactionContext.runId, `request-user-input-failed: ${message}`, activeTaskContext?.taskId);
          }
        });
      },
    );

    on.call(client, "serverRequest:resolved", (notification: { requestId: RequestId }) => {
      resolvedServerRequests.add(notification.requestId);
      void clearPendingQuestion(notification.requestId, resumedOverallStatus);
    });
  }

  let skills: LoadedSkill[];
  let threadId: string;
  const startNewThread = async (): Promise<string> => {
    const thread = await client.startThread({});
    threadId = thread.id;
    return threadId;
  };
  try {
    skills = await resolveTurnSkills(client, config, cwd);
    await startNewThread();
  } catch (error) {
    await client.disconnect();
    throw error;
  }

  return {
    get threadId(): string {
      return threadId;
    },

    async decidePlanningNeed(spec: string, systemContext: string): Promise<PlanNeedDecision> {
      const result = await client.runTurn(
        buildRunTurnParams(
          "decision",
          buildTurnInput(buildPlanDecisionPrompt(spec, systemContext, clarificationToolAvailable), skills),
          clarificationToolAvailable,
        ),
      );

      const rawResponse = extractAgentText(result);
      return parsePlanDecision(rawResponse);
    },

    async planSpec(
      spec: string,
      systemContext: string,
    ): Promise<PlanResult> {
      const result = await client.runTurn({
        ...buildRunTurnParams(
          "planning",
          buildTurnInput(buildPlanningPrompt(spec, systemContext, multiAgentActive, clarificationToolAvailable), skills),
          clarificationToolAvailable,
        ),
      });

      const rawResponse = extractAgentText(result);

      return {
        tasks: parseTaskArray(rawResponse),
        rawResponse,
      };
    },

    async reviewTaskGraph(tasks: Task[], systemContext: string): Promise<TaskGraphReviewResult> {
      const result = await client.runTurn({
        ...buildRunTurnParams(
          "review",
          buildTurnInput(
            buildTaskGraphReviewPrompt(tasks, systemContext, multiAgentActive, clarificationToolAvailable),
            skills,
          ),
          clarificationToolAvailable,
        ),
      });

      const rawResponse = extractAgentText(result);
      return parseTaskGraphReview(rawResponse);
    },

    async executeTask(
      task: Task,
      runId: string,
      systemContext?: string,
    ): Promise<TaskExecutionResult> {
      activeTaskContext = { taskId: task.id, taskName: task.name };
      let clarificationContext = "";
      let result: CompletedTurn;
      try {
        if (clarificationToolAvailable) {
          const clarificationResult = await client.runTurn(
            buildExecutionClarificationTurnParams(
              buildTurnInput(
                buildTaskExecutionClarificationPrompt(task, runId, cwd, systemContext),
                skills,
              ),
            ),
          );
          const clarificationRawResponse = extractAgentText(clarificationResult);
          const clarificationDecision = parseExecutionClarificationDecision(clarificationRawResponse);
          clarificationContext = clarificationDecision.context.trim();
        }

        result = await client.runTurn({
          ...buildRunTurnParams(
            "execution",
            buildTurnInput(
              buildTaskExecutionPrompt(
                task,
                runId,
                cwd,
                systemContext,
                multiAgentActive,
                clarificationContext,
              ),
              skills,
            ),
            false,
          ),
        });
      } finally {
        activeTaskContext = undefined;
      }

      const rawResponse = extractAgentText(result);
      const { result: parsedTaskResult, usedCompletionMarker } = parseTaskExecutionWithSource(rawResponse);
      const parsedResult = enforceFallbackExecutionEvidence(task, result, parsedTaskResult, usedCompletionMarker);
      const status = result.turn.status;
      if (status === "failed") {
        return {
          outcome: "failed",
          error: parsedResult.error ?? result.turn.error?.message ?? "Turn failed",
          rawResponse,
        };
      }
      if (status === "interrupted") {
        return { outcome: "failed", error: parsedResult.error ?? "Turn was interrupted", rawResponse };
      }

      return parsedResult;
    },

    async consultTaskGraph(tasks: Task[]): Promise<ConsultationResult> {
      const prompt = buildTaskGraphConsultationPrompt(tasks, multiAgentActive, clarificationToolAvailable);

      const result = await client.runTurn({
        ...buildRunTurnParams("review", buildTurnInput(prompt, skills), clarificationToolAvailable),
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

    async runPrompt(prompt: string, step: ThinkingStep = "execution"): Promise<string> {
      const result = await client.runTurn({
        ...buildRunTurnParams(step, buildTurnInput(prompt, skills), false),
      });

      return extractAgentText(result);
    },

    async disconnect(): Promise<void> {
      if (activeSecretAnswerChannel) {
        if (interactionContext) {
          await clearSecretAnswerChannel(interactionContext.runId).catch(() => undefined);
        }
        await activeSecretAnswerChannel.close().catch(() => undefined);
        activeSecretAnswerChannel = undefined;
      }
      await client.disconnect();
    },
  };
}

/**
 * Stateless wrappers that match the Claude adapter interface.
 * Each call creates a new client + thread (no persistence).
 * Use createCodexSession() for persistent threads.
 */
export async function decidePlanningNeed(
  spec: string,
  systemContext: string,
  config?: OrcaConfig,
  interactionContext?: SessionInteractionContext,
): Promise<PlanNeedDecision> {
  const session = await createCodexSession(process.cwd(), config, interactionContext);

  try {
    return await session.decidePlanningNeed(spec, systemContext);
  } finally {
    await session.disconnect();
  }
}

export async function planSpec(
  spec: string,
  systemContext: string,
  config?: OrcaConfig,
  interactionContext?: SessionInteractionContext,
): Promise<PlanResult> {
  const session = await createCodexSession(process.cwd(), config, interactionContext);

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
  interactionContext?: SessionInteractionContext,
): Promise<TaskGraphReviewResult> {
  const session = await createCodexSession(process.cwd(), config, interactionContext);

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
  interactionContext?: SessionInteractionContext,
): Promise<TaskExecutionResult> {
  const session = await createCodexSession(process.cwd(), config, interactionContext);

  try {
    return await session.executeTask(task, runId, systemContext);
  } finally {
    await session.disconnect();
  }
}
