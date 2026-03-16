import { readFile, unlink } from "node:fs/promises";
import path from "node:path";

import { CodexClient } from "@ratley/codex-client";
import type {
  CompletedTurn,
  RequestId,
  ToolRequestUserInputParams,
  ToolRequestUserInputResponse,
} from "@ratley/codex-client";

import type {
  HookEvent,
  OrcaConfig,
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
import { TaskGraphReviewPayloadSchema } from "../../core/task-graph-review.js";
import { RunStore } from "../../state/store.js";
import type { CodexEffort } from "../../types/effort.js";
import { loadSkills, type LoadedSkill } from "../../utils/skill-loader.js";
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

function buildPlanningPrompt(spec: string, systemContext: string, multiAgentActive: boolean): string {
  return [
    systemContext,
    "You are decomposing a spec into an ordered task graph.",
    "Prefer task decomposition that maximizes safe parallelism for independent workstreams.",
    "Isolate task ownership (files/subsystems) to avoid cross-task collisions.",
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

function buildTaskExecutionPrompt(
  task: Task,
  runId: string,
  cwd: string,
  systemContext?: string,
  multiAgentActive = false,
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

function buildPlanDecisionPrompt(spec: string, systemContext: string): string {
  return [
    systemContext,
    "You are Orca's planning gate.",
    "Decide whether this spec needs multi-step planning or can run as one direct execution task.",
    "Set needsPlan=true when coordination/dependencies/research/design across multiple steps are required.",
    "Set needsPlan=false when a single focused execution task is sufficient.",
    "Return JSON only with shape: {\"needsPlan\":boolean,\"reason\":string}",
    "Spec:",
    spec,
  ].join("\n\n");
}

function buildTaskGraphReviewPrompt(tasks: Task[], systemContext: string, multiAgentActive: boolean): string {
  return [
    systemContext,
    "You are Orca's pre-execution task-graph reviewer.",
    ...getCodeSimplifierGuidance(),
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

function buildTaskGraphConsultationPrompt(tasks: Task[], multiAgentActive: boolean): string {
  const taskGraphJson = JSON.stringify(tasks, null, 2);

  return [
    "Review this Orca task graph before execution.",
    "Flag any: missing steps, wrong dependency order, tasks that are underdefined, or potential blockers.",
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
  path?: unknown;
}

interface RawSkillsListEntry {
  cwd?: unknown;
  skills?: unknown;
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
      if (!skill || typeof skill !== "object" || typeof skill.name !== "string" || typeof skill.path !== "string") {
        continue;
      }

      const normalizedSkillPath = skill.path.trim();
      if (normalizedSkillPath.length === 0) {
        continue;
      }

      let skillBody = "";
      try {
        skillBody = await readFile(normalizedSkillPath, "utf8");
      } catch {
        skillBody = "";
      }

      discovered.push({
        name: skill.name,
        description: "",
        body: skillBody,
        dirPath: path.dirname(normalizedSkillPath),
        filePath: normalizedSkillPath,
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
  const baseSkills = await loadSkills(config);

  const listedSkills = await loadCodexListedSkills(client, cwd, config);

  if (listedSkills.length === 0) {
    return baseSkills;
  }

  const mergedByName = new Map<string, LoadedSkill>();
  for (const skill of baseSkills) {
    mergedByName.set(skill.name, skill);
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

export interface SessionInteractionContext {
  runId: RunId;
  store: RunStore;
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

  let activeTaskContext: { taskId: string; taskName: string } | undefined;

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

  const clearPendingQuestion = async (requestId: RequestId, overallStatus: "running" | "waiting_for_answer"): Promise<void> => {
    if (!interactionContext) {
      return;
    }

    const currentRun = await interactionContext.store.getRun(interactionContext.runId);
    if (!currentRun || currentRun.pendingQuestion?.requestId !== requestId) {
      return;
    }

    await interactionContext.store.updateRun(interactionContext.runId, {
      overallStatus,
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
          await clearAnswerFile(interactionContext.store, interactionContext.runId);
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

          while (true) {
            const currentRun = await interactionContext.store.getRun(interactionContext.runId);
            if (!currentRun) {
              rejectUserInputRequest(request.requestId, `Run not found while waiting for answer: ${interactionContext.runId}`);
              return;
            }

            if (currentRun.overallStatus === "cancelled") {
              rejectUserInputRequest(request.requestId, `Run ${interactionContext.runId} was cancelled while waiting for input.`);
              await clearPendingQuestion(request.requestId, "waiting_for_answer");
              return;
            }

            let rawAnswer: string;
            try {
              rawAnswer = await readFile(answerPath, "utf8");
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                await sleep(ANSWER_FILE_POLL_MS);
                continue;
              }

              throw error;
            }

            try {
              const parsedAnswer = parseQuestionAnswerInput(rawAnswer, pendingQuestion);
              respondToUserInputRequest(request.requestId, parsedAnswer);
              await clearAnswerFile(interactionContext.store, interactionContext.runId);
              await clearPendingQuestion(request.requestId, "running");
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
      void clearPendingQuestion(notification.requestId, "running");
    });
  }

  let skills: LoadedSkill[];
  let threadId: string;
  try {
    skills = await resolveTurnSkills(client, config, cwd);
    const thread = await client.startThread({});
    threadId = thread.id;
  } catch (error) {
    await client.disconnect();
    throw error;
  }

  return {
    threadId,

    async decidePlanningNeed(spec: string, systemContext: string): Promise<PlanNeedDecision> {
      const result = await client.runTurn({
        threadId,
        effort: getEffort(config, "decision"),
        input: buildTurnInput(buildPlanDecisionPrompt(spec, systemContext), skills),
      });

      const rawResponse = extractAgentText(result);
      return parsePlanDecision(rawResponse);
    },

    async planSpec(
      spec: string,
      systemContext: string,
    ): Promise<PlanResult> {
      const result = await client.runTurn({
        threadId,
        effort: getEffort(config, "planning"),
        input: buildTurnInput(buildPlanningPrompt(spec, systemContext, multiAgentActive), skills),
      });

      const rawResponse = extractAgentText(result);

      return {
        tasks: parseTaskArray(rawResponse),
        rawResponse,
      };
    },

    async reviewTaskGraph(tasks: Task[], systemContext: string): Promise<TaskGraphReviewResult> {
      const result = await client.runTurn({
        threadId,
        effort: getEffort(config, "review"),
        input: buildTurnInput(buildTaskGraphReviewPrompt(tasks, systemContext, multiAgentActive), skills),
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
      let result: CompletedTurn;
      try {
        result = await client.runTurn({
          threadId,
          effort: getEffort(config, "execution"),
          input: buildTurnInput(buildTaskExecutionPrompt(task, runId, cwd, systemContext, multiAgentActive), skills),
        });
      } finally {
        activeTaskContext = undefined;
      }

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
      const prompt = buildTaskGraphConsultationPrompt(tasks, multiAgentActive);

      const result = await client.runTurn({
        threadId,
        effort: getEffort(config, "review"),
        input: buildTurnInput(prompt, skills),
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
        threadId,
        effort: getEffort(config, step),
        input: buildTurnInput(prompt, skills),
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
