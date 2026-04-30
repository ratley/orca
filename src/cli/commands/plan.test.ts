import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

type PlanModule = typeof import("./plan.js");

let tempDir = "";
let runsDir = "";
let specPath = "";
let logs: string[] = [];
const originalRunsDir = process.env.ORCA_RUNS_DIR;
const originalConsoleLog = console.log;

async function loadPlanModule(): Promise<PlanModule> {
  return import(`./plan.js?test=${Math.random()}`);
}

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "orca-plan-test-"));
  runsDir = path.join(tempDir, "runs");
  specPath = path.join(tempDir, "spec.md");
  await writeFile(specPath, "# Spec\n", "utf8");
  process.env.ORCA_RUNS_DIR = runsDir;
  logs = [];

  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };

  mock.module("../../core/config-loader.js", () => ({
    resolveConfig: async () => undefined,
  }));
  mock.module("../../core/planner.js", () => ({
    runPlanner: async () => {},
  }));
});

afterEach(async () => {
  mock.restore();
  console.log = originalConsoleLog;

  if (originalRunsDir === undefined) {
    delete process.env.ORCA_RUNS_DIR;
  } else {
    process.env.ORCA_RUNS_DIR = originalRunsDir;
  }

  await rm(tempDir, { recursive: true, force: true });
});

describe("plan command", () => {
  test("honors ORCA_RUNS_DIR for plan runs", async () => {
    const planModule = await loadPlanModule();

    await planModule.planCommand({ spec: specPath });

    const runDirLine = logs.find((line) => line.startsWith("Run dir: "));
    expect(runDirLine).toBeTruthy();
    expect(runDirLine?.slice("Run dir: ".length)).toStartWith(runsDir);
  });
});
