import { z } from "zod";

const TaskStatusSchema = z.enum([
  "pending",
  "in_progress",
  "done",
  "failed",
  "cancelled"
]);

export const TaskSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  dependencies: z.array(z.string()),
  acceptance_criteria: z.array(z.string()),
  status: TaskStatusSchema,
  retries: z.number().int().nonnegative(),
  maxRetries: z.number().int().nonnegative(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  lastError: z.string().optional()
});

const ErrorEntrySchema = z.object({
  at: z.string(),
  message: z.string(),
  taskId: z.string().optional()
});

const PendingQuestionOptionSchema = z.object({
  label: z.string(),
  description: z.string()
});

const PendingQuestionPromptSchema = z.object({
  header: z.string(),
  id: z.string(),
  question: z.string(),
  isOther: z.boolean(),
  isSecret: z.boolean(),
  options: z.array(PendingQuestionOptionSchema).nullable().optional()
});

const PendingQuestionSchema = z.object({
  requestId: z.union([z.string(), z.number().int()]),
  threadId: z.string(),
  turnId: z.string(),
  itemId: z.string(),
  receivedAt: z.string(),
  questions: z.array(PendingQuestionPromptSchema)
});

const PrStatusSchema = z.object({
  draftTitle: z.string().optional(),
  draftBody: z.string().optional(),
  readyForFinalize: z.boolean(),
  finalizedAt: z.string().optional(),
  url: z.string().optional()
});

export const RunStatusSchema = z.object({
  schemaVersion: z.number().int().nonnegative(),
  runId: z.string(),
  mode: z.enum(["plan", "run"]),
  specPath: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  overallStatus: z.enum([
    "planning",
    "running",
    "reviewing",
    "waiting_for_answer",
    "completed",
    "failed",
    "cancelled"
  ]),
  tasks: z.array(TaskSchema),
  milestones: z.array(z.string()),
  errors: z.array(ErrorEntrySchema),
  pendingQuestion: PendingQuestionSchema.optional(),
  pr: PrStatusSchema.optional()
});

export type TaskSchemaType = z.infer<typeof TaskSchema>;
export type RunStatusSchemaType = z.infer<typeof RunStatusSchema>;
