import type { Task } from "../types/index.js";

export function validateDAG(tasks: Task[]): void {
  const taskIds = new Set<string>();

  for (const task of tasks) {
    if (taskIds.has(task.id)) {
      throw new Error(`Duplicate task id: ${task.id}`);
    }

    taskIds.add(task.id);
  }

  for (const task of tasks) {
    for (const dependency of task.dependencies) {
      if (!taskIds.has(dependency)) {
        throw new Error(`Task ${task.id} has missing dependency: ${dependency}`);
      }
    }
  }

  const state = new Map<string, "visiting" | "visited">();
  const tasksById = new Map(tasks.map((task) => [task.id, task]));

  const visit = (taskId: string): void => {
    const current = state.get(taskId);

    if (current === "visiting") {
      throw new Error(`Task graph has cycle at: ${taskId}`);
    }

    if (current === "visited") {
      return;
    }

    state.set(taskId, "visiting");

    const task = tasksById.get(taskId);
    if (!task) {
      throw new Error(`Unknown task id in graph: ${taskId}`);
    }

    for (const dependency of task.dependencies) {
      visit(dependency);
    }

    state.set(taskId, "visited");
  };

  for (const task of tasks) {
    visit(task.id);
  }
}

export function getRunnable(tasks: Task[]): Task[] {
  const taskById = new Map(tasks.map((task) => [task.id, task]));

  return tasks.filter((task) => {
    if (task.status !== "pending") {
      return false;
    }

    return task.dependencies.every((dependency) => {
      const dependencyTask = taskById.get(dependency);
      return dependencyTask?.status === "done";
    });
  });
}
