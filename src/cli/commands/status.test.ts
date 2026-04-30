import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import { RunStore } from "../../state/store.js";

type StatusModule = typeof import("./status.js");

let tempDir = "";
let runsDir = "";
let logs: string[] = [];
const originalRunsDir = process.env.ORCA_RUNS_DIR;
const originalConsoleLog = console.log;

async function loadStatusModule(): Promise<StatusModule> {
  return import(`./status.js?test=${Math.random()}`);
}

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "orca-status-test-"));
  runsDir = path.join(tempDir, "runs");
  process.env.ORCA_RUNS_DIR = runsDir;
  logs = [];
  process.exitCode = 0;

  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
});

afterEach(async () => {
  console.log = originalConsoleLog;

  if (originalRunsDir === undefined) {
    delete process.env.ORCA_RUNS_DIR;
  } else {
    process.env.ORCA_RUNS_DIR = originalRunsDir;
  }

  process.exitCode = 0;
  await rm(tempDir, { recursive: true, force: true });
});

describe("status command", () => {
  test("prints pending question details for runs waiting for input", async () => {
    const runId = "run-1000-abcd";
    const store = new RunStore(runsDir);
    await store.createRun(runId, "/tmp/spec.md");
    await store.updateRun(runId, {
      mode: "run",
      overallStatus: "waiting_for_answer",
      pendingQuestion: {
        requestId: "req-1",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        receivedAt: new Date().toISOString(),
        questions: [
          {
            header: "Game Type",
            id: "game_type",
            question: "Which game type should I build?",
            isOther: true,
            isSecret: false,
            options: [
              { label: "Arcade", description: "Arcade style" },
              { label: "Puzzle", description: "Puzzle style" },
            ],
          },
        ],
      },
    });

    const statusModule = await loadStatusModule();
    await statusModule.statusCommandHandler({ run: runId });

    const output = logs.join("\n");
    expect(output).toContain("Pending Question:");
    expect(output).toContain("Game Type (game_type): Which game type should I build?");
    expect(output).toContain("Options: Arcade, Puzzle.");
  });

  test("prints question ids for multi-question answer payloads", async () => {
    const runId = "run-2000-abcd";
    const store = new RunStore(runsDir);
    await store.createRun(runId, "/tmp/spec.md");
    await store.updateRun(runId, {
      mode: "run",
      overallStatus: "waiting_for_answer",
      pendingQuestion: {
        requestId: "req-2",
        threadId: "thread-2",
        turnId: "turn-2",
        itemId: "item-2",
        receivedAt: new Date().toISOString(),
        questions: [
          {
            header: "Backend",
            id: "backend",
            question: "Which backend should I use?",
            isOther: true,
            isSecret: false,
            options: null,
          },
          {
            header: "Frontend",
            id: "frontend",
            question: "Which frontend should I use?",
            isOther: true,
            isSecret: false,
            options: null,
          },
        ],
      },
    });

    const statusModule = await loadStatusModule();
    await statusModule.statusCommandHandler({ run: runId });

    const output = logs.join("\n");
    expect(output).toContain("Backend (backend): Which backend should I use?");
    expect(output).toContain("Frontend (frontend): Which frontend should I use?");
  });
});
