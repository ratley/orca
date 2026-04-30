import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

import { RunStatusSchema, TaskSchema } from "./schema.js";
import type { RunId, RunStatus, Task } from "../types/index.js";

export class RunStore {
  private readonly runsDir: string;

  constructor(runsDir = path.join(os.homedir(), ".orca", "runs")) {
    this.runsDir = runsDir;
  }

  async createRun(runId: string, specPath: string): Promise<RunStatus> {
    const runDir = this.getRunDir(runId);
    const now = new Date().toISOString();
    const runStatus: RunStatus = {
      schemaVersion: 1,
      runId: runId as RunId,
      mode: "plan",
      specPath,
      createdAt: now,
      updatedAt: now,
      overallStatus: "planning",
      tasks: [],
      milestones: [],
      errors: [],
    };

    await fs.mkdir(runDir, { recursive: true });
    await this.writeJsonAtomic(path.join(runDir, "status.json"), runStatus);

    return runStatus;
  }

  async getRun(runId: string): Promise<RunStatus | null> {
    const statusPath = this.getStatusPath(runId);

    try {
      const raw = await fs.readFile(statusPath, "utf8");
      return RunStatusSchema.parse(JSON.parse(raw)) as RunStatus;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }

      throw error;
    }
  }

  async updateRun(runId: string, patch: Partial<RunStatus>): Promise<RunStatus> {
    const existing = await this.getRun(runId);
    if (!existing) {
      throw new Error(`Run not found: ${runId}`);
    }

    const next = RunStatusSchema.parse({
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString(),
    }) as RunStatus;

    await this.writeJsonAtomic(this.getStatusPath(runId), next);
    return next;
  }

  async writeTasks(runId: string, tasks: Task[]): Promise<void> {
    const runDir = this.getRunDir(runId);
    const tasksPath = path.join(runDir, "tasks.json");
    const validatedTasks = TaskSchema.array().parse(tasks);

    await fs.mkdir(runDir, { recursive: true });
    await this.writeJsonAtomic(tasksPath, validatedTasks);
  }

  async listRuns(): Promise<RunStatus[]> {
    await fs.mkdir(this.runsDir, { recursive: true });
    const entries = await fs.readdir(this.runsDir, { withFileTypes: true });
    const runs: RunStatus[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const run = await this.getRun(entry.name);
      if (run) {
        runs.push(run);
      }
    }

    runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return runs;
  }

  getRunDir(runId: string): string {
    return path.join(this.runsDir, runId);
  }

  private getStatusPath(runId: string): string {
    return path.join(this.getRunDir(runId), "status.json");
  }

  private async writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    const payload = `${JSON.stringify(data, null, 2)}\n`;

    await fs.writeFile(tmpPath, payload, "utf8");
    await fs.rename(tmpPath, filePath);
  }
}
