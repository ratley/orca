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
  pr?: {
    draftTitle?: string;
    draftBody?: string;
    readyForFinalize: boolean;
    finalizedAt?: string;
    url?: string;
  };
}

export type HookName =
  | "onMilestone"
  | "onTaskComplete"
  | "onTaskFail"
  | "onComplete"
  | "onError";

export interface HookEvent {
  runId: RunId;
  hook: HookName;
  message: string;
  timestamp: string;
  taskId?: string;
  taskName?: string;
  error?: string;
  metadata?: Record<string, string | number | boolean | null>;
}

export type HookHandler = (event: HookEvent) => Promise<void>;

// Shared agent result types (used by both claude and codex session adapters)
export interface PlanResult {
  tasks: Task[];
  rawResponse: string;
}

export interface TaskExecutionResult {
  outcome: "done" | "failed";
  rawResponse: string;
  error?: string;
}

export interface OrcaConfig {
  anthropicApiKey?: string;
  openaiApiKey?: string;
  runsDir?: string;
  sessionLogs?: string;
  skills?: string[];
  maxRetries?: number;
  executor?: "claude" | "codex";
  claude?: {
    model?: string;
    useV2Preview?: boolean;
    maxTurnsPerTask?: number;
    allowTextJsonFallback?: boolean;
  };
  codex?: {
    enabled?: boolean;
    model?: string;
    command?: string;
    timeoutMs?: number;
    multiAgent?: boolean;
  };
  hooks?: Partial<Record<HookName, HookHandler>>;
  hookCommands?: Partial<Record<HookName, string>>;
  pr?: {
    enabled?: boolean;
    requireConfirmation?: boolean;
  };
}
