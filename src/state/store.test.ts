import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

import { RunStore } from "./store";

describe("RunStore", () => {
  let tempDir: string;
  let store: RunStore;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "orca-store-test-"));
    store = new RunStore(tempDir);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test("createRun creates directory and status.json", async () => {
    const runId = "sample-1000-abcd";

    const run = await store.createRun(runId, "/tmp/spec.md");

    const runDir = store.getRunDir(runId);
    const statusPath = path.join(runDir, "status.json");

    const raw = await fs.readFile(statusPath, "utf8");
    const status = JSON.parse(raw) as { runId: string; overallStatus: string };

    expect(run.runId).toBe(runId);
    expect(status.runId).toBe(runId);
    expect(status.overallStatus).toBe("planning");
  });

  test("getRun returns null for unknown runId", async () => {
    const run = await store.getRun("missing-1000-abcd");

    expect(run).toBeNull();
  });

  test("updateRun does atomic write and merges correctly", async () => {
    const runId = "merge-1000-abcd";

    await store.createRun(runId, "/tmp/spec.md");
    const updated = await store.updateRun(runId, {
      overallStatus: "running",
      milestones: ["started"],
    });

    const statusPath = path.join(store.getRunDir(runId), "status.json");
    const tmpPath = `${statusPath}.tmp`;

    const tmpExists = await fs
      .access(tmpPath)
      .then(() => true)
      .catch(() => false);

    expect(updated.overallStatus).toBe("running");
    expect(updated.milestones).toEqual(["started"]);
    expect(tmpExists).toBe(false);
  });

  test("listRuns returns sorted array by createdAt desc", async () => {
    await store.createRun("old-1000-abcd", "/tmp/spec-a.md");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await store.createRun("new-1001-abcd", "/tmp/spec-b.md");

    const runs = await store.listRuns();

    expect(runs.map((run) => run.runId)).toEqual(["new-1001-abcd", "old-1000-abcd"]);
  });
});
