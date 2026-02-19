import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

import { RunStore } from "../state/store";
import { getLastRun } from "./last-run";

describe("getLastRun", () => {
  let tempDir: string;
  let store: RunStore;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "orca-last-run-test-"));
    store = new RunStore(tempDir);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test("returns null when no runs exist", async () => {
    const run = await getLastRun(store);

    expect(run).toBeNull();
  });

  test("returns the most recently created run", async () => {
    await store.createRun("first-1000-abcd", "/tmp/spec-a.md");
    await store.createRun("second-1001-abcd", "/tmp/spec-b.md");

    await store.updateRun("first-1000-abcd", {
      createdAt: "2026-01-01T00:00:00.000Z"
    });
    await store.updateRun("second-1001-abcd", {
      createdAt: "2026-01-02T00:00:00.000Z"
    });

    const run = await getLastRun(store);

    expect(run?.runId).toBe("second-1001-abcd");
  });

  test("uses createdAt (not updatedAt) to determine recency", async () => {
    await store.createRun("older-1000-abcd", "/tmp/spec-a.md");
    await store.createRun("newer-1001-abcd", "/tmp/spec-b.md");

    await store.updateRun("older-1000-abcd", {
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-12-31T00:00:00.000Z"
    });
    await store.updateRun("newer-1001-abcd", {
      createdAt: "2026-01-02T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z"
    });

    const run = await getLastRun(store);

    expect(run?.runId).toBe("newer-1001-abcd");
  });
});
