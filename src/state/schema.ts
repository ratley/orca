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

const PrStatusSchema = z.object({
  draftTitle: z.string().optional(),
  draftBody: z.string().optional(),
  readyForFinalize: z.boolean(),
  finalizedAt: z.string().optional(),
  url: z.string().optional()
});

export const RunStatusSchema = z.object({
  schemaVersion: z.number().int().nonnegative(),
  runId: z.string().regex(/^.+-\d+-[0-9a-f]{4}$/),
  mode: z.enum(["plan", "run"]),
  specPath: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  overallStatus: z.enum(["planning", "running", "completed", "failed", "cancelled"]),
  tasks: z.array(TaskSchema),
  milestones: z.array(z.string()),
  errors: z.array(ErrorEntrySchema),
  pr: PrStatusSchema.optional()
});
