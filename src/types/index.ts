import { z } from "zod";

import { CODEX_EFFORT_VALUES, parseCodexEffort, type CodexEffort } from "./effort.js";

export type RunId = `${string}-${number}-${string}`;

export interface Spec {
  id: string;
  path: string;
  title: string;
  rawMarkdown: string;
  createdAt: string;
}

export type TaskStatus = "pending" | "in_progress" | "done" | "failed" | "cancelled";

export interface Task {
  id: string;
  name: string;
  description: string;
  dependencies: string[];
  acceptance_criteria: string[];
  status: TaskStatus;
  retries: number;
  maxRetries: number;
  startedAt?: string;
  finishedAt?: string;
  lastError?: string;
}

export interface RunStatus {
  schemaVersion: number;
  runId: RunId;
  mode: "plan" | "run";
  specPath: string;
  createdAt: string;
  updatedAt: string;
  overallStatus: "planning" | "running" | "reviewing" | "waiting_for_answer" | "completed" | "failed" | "cancelled";
  tasks: Task[];
  milestones: string[];
  errors: Array<{ at: string; message: string; taskId?: string }>;
  pendingQuestion?: PendingQuestion | undefined;
  pr?: {
    draftTitle?: string;
    draftBody?: string;
    readyForFinalize: boolean;
    finalizedAt?: string;
    url?: string;
  };
}

export interface PendingQuestionOption {
  label: string;
  description: string;
}

export interface PendingQuestionPrompt {
  header: string;
  id: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options?: PendingQuestionOption[] | null;
}

export interface PendingQuestion {
  requestId: string | number;
  threadId: string;
  turnId: string;
  itemId: string;
  receivedAt: string;
  questions: PendingQuestionPrompt[];
}

export interface PendingAnswerChannel {
  transport: "ipc";
  path: string;
  token: string;
}

export interface BaseHookEvent {
  runId: RunId;
  message: string;
  timestamp: string;
  taskId?: string;
  taskName?: string;
  error?: string;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface HookEventMap {
  onMilestone: BaseHookEvent & { hook: "onMilestone" };
  onQuestion: BaseHookEvent & {
    hook: "onQuestion";
    requestId: string | number;
    threadId: string;
    turnId: string;
    itemId: string;
    questions: PendingQuestionPrompt[];
  };
  onTaskComplete: BaseHookEvent & { hook: "onTaskComplete"; taskId: string; taskName: string };
  onTaskFail: BaseHookEvent & { hook: "onTaskFail"; taskId: string; taskName: string; error: string };
  onInvalidPlan: BaseHookEvent & { hook: "onInvalidPlan"; error: string };
  onFindings: BaseHookEvent & { hook: "onFindings" };
  onComplete: BaseHookEvent & { hook: "onComplete" };
  onError: BaseHookEvent & { hook: "onError"; error: string };
}

export type HookName = keyof HookEventMap;

export type HookEvent = HookEventMap[HookName];

export interface HookHandlerContext {
  cwd: string;
  pid: number;
  invokedAt: string;
}

export type HookHandler<K extends HookName = HookName> = (
  event: HookEventMap[K],
  context: HookHandlerContext,
) => Promise<void> | void;

// Shared agent result types (used by codex session adapters)
export interface PlanResult {
  tasks: Task[];
  rawResponse: string;
}

export interface TaskExecutionResult {
  outcome: "done" | "failed";
  rawResponse: string;
  error?: string;
}

export type TaskGraphReviewOperation =
  | {
      op: "update_task";
      taskId: string;
      fields: {
        name?: string;
        description?: string;
        acceptance_criteria?: string[];
      };
    }
  | {
      op: "add_task";
      task: Task;
    }
  | {
      op: "remove_task";
      taskId: string;
    }
  | {
      op: "add_dependency";
      taskId: string;
      dependsOn: string;
    }
  | {
      op: "remove_dependency";
      taskId: string;
      dependsOn: string;
    };

export interface TaskGraphReviewResult {
  changes: TaskGraphReviewOperation[];
  rawResponse: string;
}

export type PlannerAgent = "codex" | "claude";
export type PlannerAgentSelection = PlannerAgent | "auto";
export type ClaudeEffort = CodexEffort | "max";

declare const CUSTOM_MODEL_ID: unique symbol;
export type CustomModelId = string & { readonly [CUSTOM_MODEL_ID]: true };

export type OpenAIModelId =
  | "gpt-5.5"
  | "gpt-5.2"
  | "gpt-5.2-pro"
  | "gpt-5.2-codex"
  | "gpt-5.1"
  | "gpt-5.1-codex"
  | "gpt-5.1-codex-max"
  | "gpt-5.1-codex-mini"
  | "gpt-5"
  | "gpt-5-codex"
  | "gpt-5.3-codex"
  | "gpt-5.3-codex-spark"
  | CustomModelId;

export type ClaudeModelId =
  | "claude-opus-4-7"
  | "claude-sonnet-4-6"
  | "claude-opus-4-1"
  | "claude-opus-4-1-20250805"
  | "claude-opus-4-0"
  | "claude-opus-4-20250514"
  | "claude-sonnet-4-0"
  | "claude-sonnet-4-20250514"
  | "claude-3-7-sonnet-latest"
  | "claude-3-7-sonnet-20250219"
  | "claude-3-5-sonnet-latest"
  | "claude-3-5-sonnet-20241022"
  | "claude-3-5-haiku-latest"
  | "claude-3-5-haiku-20241022"
  | "opus"
  | "sonnet"
  | "haiku"
  | "opusplan"
  | "default"
  | CustomModelId;

export interface PlannerRoutingDecision {
  planner: PlannerAgent;
  reason: string;
}

export interface PlannerRouterConfig {
  /**
   * Codex model used only for planner.agent="auto" routing.
   */
  model?: OpenAIModelId;
}

export type PlannerConfig =
  | {
      /**
       * Ask a Codex router to choose Claude or Codex for task graph generation.
       * This is also the default when planner is omitted.
       */
      agent?: "auto";
      router?: PlannerRouterConfig;
    }
  | {
      /**
       * Always use Claude for non-skipped task graph generation.
       */
      agent: "claude";
      router?: never;
    }
  | {
      /**
       * Always use Codex for non-skipped task graph generation.
       */
      agent: "codex";
      router?: never;
    };

export interface OrcaConfig {
  openaiApiKey?: string;
  runsDir?: string;
  sessionLogs?: string;
  skills?: string[];
  maxRetries?: number;
  executor?: "codex";
  planner?: PlannerConfig;
  claude?: {
    command?: string;
    model?: ClaudeModelId;
    effort?: ClaudeEffort;
    timeoutMs?: number;
  };
  codex?: {
    enabled?: boolean;
    model?: OpenAIModelId;
    effort?: CodexEffort;
    thinkingLevel?: {
      decision?: CodexEffort;
      planning?: CodexEffort;
      review?: CodexEffort;
      execution?: CodexEffort;
    };
    command?: string;
    timeoutMs?: number;
    multiAgent?: boolean;
    /**
     * Optional extra skill roots to use for specific working directories when
     * querying Codex app-server skills/list.
     */
    perCwdExtraUserRoots?: Array<{
      cwd: string;
      extraUserRoots: string[];
    }>;
  };
  hooks?: { [K in HookName]?: HookHandler<K> };
  hookCommands?: Partial<Record<HookName, string>>;
  pr?: {
    enabled?: boolean;
    requireConfirmation?: boolean;
  };
  review?: {
    /** @deprecated Use review.plan.enabled */
    enabled?: boolean;
    /** @deprecated Use review.plan.onInvalid */
    onInvalid?: "fail" | "warn_skip";
    plan?: {
      enabled?: boolean;
      onInvalid?: "fail" | "warn_skip";
    };
    execution?: {
      enabled?: boolean;
      maxCycles?: number;
      onFindings?: "auto_fix" | "report_only" | "fail";
      validator?: {
        auto?: boolean;
        commands?: string[];
      };
      prompt?: string;
    };
  };
}

const scalarStringSchema = z.custom<string>((value) => typeof value === "string", {
  message: "must be a string",
});
const scalarBooleanSchema = z.custom<boolean>((value) => typeof value === "boolean", {
  message: "must be a boolean",
});
const positiveIntegerSchema = z.custom<number>(
  (value) => typeof value === "number" && Number.isInteger(value) && value >= 1,
  { message: "must be an integer >= 1" },
);
const nonnegativeIntegerSchema = z.custom<number>(
  (value) => typeof value === "number" && Number.isInteger(value) && value >= 0,
  { message: "must be a nonnegative integer" },
);

const openAIModelSchema = scalarStringSchema as z.ZodType<OpenAIModelId>;
const claudeModelSchema = scalarStringSchema as z.ZodType<ClaudeModelId>;

const codexEffortSchema = z
  .custom<string>((value) => typeof value === "string", {
    message: "must be a string",
  })
  .transform((value, context): CodexEffort => {
    try {
      return parseCodexEffort(value);
    } catch (error) {
      context.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : String(error),
      });

      return z.NEVER;
    }
  });

const claudeEffortSchema = z.custom<ClaudeEffort>(
  (value) => typeof value === "string" && ([...CODEX_EFFORT_VALUES, "max"] as string[]).includes(value),
  { message: "must be one of low, medium, high, xhigh, max" },
);

const hookNameValues = [
  "onMilestone",
  "onQuestion",
  "onTaskComplete",
  "onTaskFail",
  "onInvalidPlan",
  "onFindings",
  "onComplete",
  "onError",
] as const satisfies readonly HookName[];

const hookNameSet = new Set<string>(hookNameValues);

function addUnknownHookIssue(context: z.RefinementCtx, configPath: "hooks" | "hookCommands", hookName: string) {
  context.addIssue({
    code: "custom",
    path: [hookName],
    message: `Unknown hook key in Config.${configPath}: ${hookName}. Allowed hooks: ${hookNameValues.join(", ")}`,
  });
}

const hookHandlerSchema = z.custom<HookHandler>((value) => typeof value === "function", {
  message: "must be a function",
});

const hooksSchema = z.record(z.string(), hookHandlerSchema).superRefine((hooks, context) => {
  for (const hookName of Object.keys(hooks)) {
    if (!hookNameSet.has(hookName)) {
      addUnknownHookIssue(context, "hooks", hookName);
    }
  }
}) as z.ZodType<OrcaConfig["hooks"]>;

const hookCommandsSchema = z.record(z.string(), scalarStringSchema).superRefine((hookCommands, context) => {
  for (const hookName of Object.keys(hookCommands)) {
    if (!hookNameSet.has(hookName)) {
      addUnknownHookIssue(context, "hookCommands", hookName);
    }
  }
}) as z.ZodType<OrcaConfig["hookCommands"]>;

export const PlannerRouterConfigSchema = z
  .object({
    model: openAIModelSchema.optional(),
  })
  .passthrough() as z.ZodType<PlannerRouterConfig>;

export const PlannerConfigSchema = z
  .object({
    agent: z
      .enum(["auto", "codex", "claude"], {
        message: "must be 'auto', 'codex', or 'claude'",
      })
      .optional(),
    router: PlannerRouterConfigSchema.optional(),
  })
  .passthrough()
  .superRefine((planner, context) => {
    if ((planner.agent === "claude" || planner.agent === "codex") && planner.router !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["router"],
        message: `Config.planner.router is only used when Config.planner.agent is 'auto'. Remove router for forced '${planner.agent}' planning.`,
      });
    }
  }) as z.ZodType<PlannerConfig>;

const codexThinkingLevelSchema = z
  .object({
    decision: codexEffortSchema.optional(),
    planning: codexEffortSchema.optional(),
    review: codexEffortSchema.optional(),
    execution: codexEffortSchema.optional(),
  })
  .passthrough();

export const CodexConfigSchema = z
  .object({
    enabled: scalarBooleanSchema.optional(),
    model: openAIModelSchema.optional(),
    effort: codexEffortSchema.optional(),
    thinkingLevel: codexThinkingLevelSchema.optional(),
    command: scalarStringSchema.optional(),
    timeoutMs: positiveIntegerSchema.optional(),
    multiAgent: scalarBooleanSchema.optional(),
    perCwdExtraUserRoots: z
      .array(
        z
          .object({
            cwd: scalarStringSchema,
            extraUserRoots: z.array(scalarStringSchema),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough()
  .superRefine((codex, context) => {
    if ("thinking" in codex && codex.thinking !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["thinking"],
        message: "Config.codex.thinking is no longer supported. Use Config.codex.thinkingLevel instead.",
      });
    }
  }) as z.ZodType<OrcaConfig["codex"]>;

export const ClaudeConfigSchema = z
  .object({
    command: scalarStringSchema.optional(),
    model: claudeModelSchema.optional(),
    effort: claudeEffortSchema.optional(),
    timeoutMs: positiveIntegerSchema.optional(),
  })
  .passthrough() as z.ZodType<OrcaConfig["claude"]>;

const reviewOnInvalidSchema = z.enum(["fail", "warn_skip"], {
  message: "must be 'fail' or 'warn_skip'",
});
const reviewOnFindingsSchema = z.enum(["auto_fix", "report_only", "fail"], {
  message: "must be 'auto_fix', 'report_only', or 'fail'",
});

export const ReviewConfigSchema = z
  .object({
    enabled: scalarBooleanSchema.optional(),
    onInvalid: reviewOnInvalidSchema.optional(),
    plan: z
      .object({
        enabled: scalarBooleanSchema.optional(),
        onInvalid: reviewOnInvalidSchema.optional(),
      })
      .passthrough()
      .optional(),
    execution: z
      .object({
        enabled: scalarBooleanSchema.optional(),
        maxCycles: positiveIntegerSchema.optional(),
        onFindings: reviewOnFindingsSchema.optional(),
        validator: z
          .object({
            auto: scalarBooleanSchema.optional(),
            commands: z.array(scalarStringSchema).optional(),
          })
          .passthrough()
          .optional(),
        prompt: scalarStringSchema.optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough() as z.ZodType<OrcaConfig["review"]>;

export const OrcaConfigSchema = z
  .object({
    openaiApiKey: scalarStringSchema.optional(),
    runsDir: scalarStringSchema.optional(),
    sessionLogs: scalarStringSchema.optional(),
    skills: z.array(scalarStringSchema).optional(),
    maxRetries: nonnegativeIntegerSchema.optional(),
    executor: z.literal("codex").optional(),
    planner: PlannerConfigSchema.optional(),
    claude: ClaudeConfigSchema.optional(),
    codex: CodexConfigSchema.optional(),
    hooks: hooksSchema.optional(),
    hookCommands: hookCommandsSchema.optional(),
    pr: z
      .object({
        enabled: scalarBooleanSchema.optional(),
        requireConfirmation: scalarBooleanSchema.optional(),
      })
      .passthrough()
      .optional(),
    review: ReviewConfigSchema.optional(),
  })
  .passthrough();

export function defineOrcaConfig(config: OrcaConfig): OrcaConfig {
  return config;
}

export function customModel<T extends string>(id: T): CustomModelId {
  return id as unknown as CustomModelId;
}
