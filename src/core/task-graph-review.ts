import { z } from "zod";

import type { Task, TaskGraphReviewOperation } from "../types/index.js";

const TaskSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  dependencies: z.array(z.string()),
  acceptance_criteria: z.array(z.string()),
  status: z.enum(["pending", "in_progress", "done", "failed", "cancelled"]),
  retries: z.number(),
  maxRetries: z.number(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  lastError: z.string().optional()
}).strict();

const ReviewOperationSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("update_task"),
    taskId: z.string().min(1),
    fields: z.object({
      name: z.string().min(1).optional(),
      description: z.string().optional(),
      acceptance_criteria: z.array(z.string()).optional()
    }).strict()
  }).strict(),
  z.object({
    op: z.literal("add_task"),
    task: TaskSchema
  }).strict(),
  z.object({
    op: z.literal("remove_task"),
    taskId: z.string().min(1)
  }).strict(),
  z.object({
    op: z.literal("add_dependency"),
    taskId: z.string().min(1),
    dependsOn: z.string().min(1)
  }).strict(),
  z.object({
    op: z.literal("remove_dependency"),
    taskId: z.string().min(1),
    dependsOn: z.string().min(1)
  }).strict()
]);

export const TaskGraphReviewPayloadSchema = z.object({
  changes: z.array(ReviewOperationSchema)
}).strict();

function findTaskIndex(tasks: Task[], taskId: string): number {
  return tasks.findIndex((task) => task.id === taskId);
}

export function summarizeReviewChanges(changes: TaskGraphReviewOperation[]): string[] {
  return changes.map((change) => {
    switch (change.op) {
      case "update_task": {
        const keys = Object.keys(change.fields);
        return `update_task(${change.taskId}: ${keys.join(",") || "no fields"})`;
      }
      case "add_task":
        return `add_task(${change.task.id})`;
      case "remove_task":
        return `remove_task(${change.taskId})`;
      case "add_dependency":
        return `add_dependency(${change.taskId}<-${change.dependsOn})`;
      case "remove_dependency":
        return `remove_dependency(${change.taskId}<-${change.dependsOn})`;
      default:
        return "unknown";
    }
  });
}

export function applyTaskGraphReviewChanges(tasks: Task[], changes: TaskGraphReviewOperation[]): Task[] {
  const nextTasks = tasks.map((task) => ({ ...task, dependencies: [...task.dependencies], acceptance_criteria: [...task.acceptance_criteria] }));

  for (const change of changes) {
    switch (change.op) {
      case "update_task": {
        const index = findTaskIndex(nextTasks, change.taskId);
        if (index === -1) {
          throw new Error(`Review update_task failed: task not found (${change.taskId})`);
        }

        const current = nextTasks[index] as Task;
        nextTasks[index] = {
          ...current,
          ...("name" in change.fields ? { name: change.fields.name ?? current.name } : {}),
          ...("description" in change.fields ? { description: change.fields.description ?? current.description } : {}),
          ...("acceptance_criteria" in change.fields
            ? { acceptance_criteria: [...(change.fields.acceptance_criteria ?? current.acceptance_criteria)] }
            : {})
        };
        break;
      }
      case "add_task": {
        if (findTaskIndex(nextTasks, change.task.id) !== -1) {
          throw new Error(`Review add_task failed: task already exists (${change.task.id})`);
        }
        nextTasks.push({
          ...change.task,
          dependencies: [...change.task.dependencies],
          acceptance_criteria: [...change.task.acceptance_criteria]
        });
        break;
      }
      case "remove_task": {
        const index = findTaskIndex(nextTasks, change.taskId);
        if (index === -1) {
          throw new Error(`Review remove_task failed: task not found (${change.taskId})`);
        }
        nextTasks.splice(index, 1);
        break;
      }
      case "add_dependency": {
        const index = findTaskIndex(nextTasks, change.taskId);
        if (index === -1) {
          throw new Error(`Review add_dependency failed: task not found (${change.taskId})`);
        }
        const current = nextTasks[index] as Task;
        if (!current.dependencies.includes(change.dependsOn)) {
          current.dependencies = [...current.dependencies, change.dependsOn];
        }
        break;
      }
      case "remove_dependency": {
        const index = findTaskIndex(nextTasks, change.taskId);
        if (index === -1) {
          throw new Error(`Review remove_dependency failed: task not found (${change.taskId})`);
        }
        const current = nextTasks[index] as Task;
        current.dependencies = current.dependencies.filter((dependency) => dependency !== change.dependsOn);
        break;
      }
    }
  }

  return nextTasks;
}
