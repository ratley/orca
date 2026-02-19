import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

import { RunStatusSchema } from "./schema.js";
import type { RunId, RunStatus, Spec } from "../types/index.js";

export class RunStore {
  private readonly runsDir: string;

  constructor(runsDir = path.join(os.homedir(), ".orca", "runs")) {
    this.runsDir = runsDir;
  }

  async createRun(runId: RunId, spec: Spec): Promise<RunStatus> {
    const now = new Date().toISOString();
    const runStatus: RunStatus = {
      schemaVersion: 1,
      runId,
      mode: "run",
      specPath: spec.path,
      createdAt: now,
      updatedAt: now,
      overallStatus: "planning",
      tasks: [],
      milestones: [],
      errors: []
    };

    await this.writeStatus(runId, runStatus);
    return runStatus;
  }

  async getRun(runId: RunId): Promise<RunStatus | null> {
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

  async updateRun(runId: RunId, patch: Partial<RunStatus>): Promise<RunStatus> {
    const existing = await this.getRun(runId);
    if (!existing) {
      throw new Error(`Run not found: ${runId}`);
    }

    const next: RunStatus = {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString()
    };

    await this.writeStatus(runId, next);
    return next;
  }

  async listRuns(): Promise<RunStatus[]> {
    await fs.mkdir(this.runsDir, { recursive: true });
    const entries = await fs.readdir(this.runsDir, { withFileTypes: true });
    const runs: RunStatus[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const runId = entry.name as RunId;
      const run = await this.getRun(runId);
      if (run) {
        runs.push(run);
      }
    }

    runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return runs;
  }

  private getStatusPath(runId: RunId): string {
    return path.join(this.runsDir, runId, "status.json");
  }

  private async writeStatus(runId: RunId, status: RunStatus): Promise<void> {
    const runDir = path.join(this.runsDir, runId);
    const statusPath = this.getStatusPath(runId);
    const tempPath = `${statusPath}.${process.pid}.${Date.now()}.tmp`;

    await fs.mkdir(runDir, { recursive: true });

    const payload = `${JSON.stringify(status, null, 2)}\n`;
    await fs.writeFile(tempPath, payload, "utf8");
    await fs.rename(tempPath, statusPath);
  }
}
