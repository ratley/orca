import type { CodexEffort } from "./effort.js";

export type RunId = `${string}-${number}-${string}`;

export interface Spec {
  id: string;
  path: string;
  title: string;
  rawMarkdown: string;
  createdAt: string;
}

export type TaskStatus =
  | "pending"
  | "in_progress"
  | "done"
  | "failed"
  | "cancelled";

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
  overallStatus:
    | "planning"
    | "running"
    | "waiting_for_answer"
    | "completed"
    | "failed"
    | "cancelled";
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
  context: HookHandlerContext
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

export interface OrcaConfig {
  openaiApiKey?: string;
  runsDir?: string;
  sessionLogs?: string;
  skills?: string[];
  maxRetries?: number;
  executor?: "codex";
  codex?: {
    enabled?: boolean;
    model?: string;
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

export function defineOrcaConfig(config: OrcaConfig): OrcaConfig {
  return config;
}
