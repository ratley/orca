import { afterEach, beforeEach, mock } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Command } from "commander";

type RunModule = typeof import("./run.js");

export type RunCommandTestHarness = {
  getTempDir: () => string;
  loadRunModule: () => Promise<{
    runModule: RunModule;
    runPlannerMock: ReturnType<typeof mock>;
    runTaskRunnerMock: ReturnType<typeof mock>;
    createCodexSessionMock: ReturnType<typeof mock>;
    ensureCodexMultiAgentMock: ReturnType<typeof mock>;
    hookDispatchMock: ReturnType<typeof mock>;
    InvalidPlanErrorCtor: new (stage: "planner" | "review", message: string) => Error;
  }>;
  parseRun: (runModule: RunModule, argv: string[]) => Promise<void>;
};

export function createRunCommandTestHarness(tempPrefix: string): RunCommandTestHarness {
  let tempDir = "";
  const originalRunsDir = process.env.ORCA_RUNS_DIR;
  const originalSkipValidators = process.env.ORCA_SKIP_VALIDATORS;
  const originalOpenaiApiKey = process.env.OPENAI_API_KEY;
  const originalHome = process.env.HOME;
  const originalCwd = process.cwd();

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), tempPrefix));
    process.env.ORCA_RUNS_DIR = path.join(tempDir, "runs");
    process.env.ORCA_SKIP_VALIDATORS = "1";
    process.env.OPENAI_API_KEY = "test-openai-key";
    process.env.HOME = tempDir;
    process.chdir(tempDir);
    process.exitCode = 0;
  });

  afterEach(async () => {
    mock.restore();
    process.exitCode = 0;
    process.chdir(originalCwd);
    if (originalRunsDir === undefined) {
      delete process.env.ORCA_RUNS_DIR;
    } else {
      process.env.ORCA_RUNS_DIR = originalRunsDir;
    }
    if (originalSkipValidators === undefined) {
      delete process.env.ORCA_SKIP_VALIDATORS;
    } else {
      process.env.ORCA_SKIP_VALIDATORS = originalSkipValidators;
    }
    if (originalOpenaiApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenaiApiKey;
    }
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  async function loadRunModule(): Promise<{
    runModule: RunModule;
    runPlannerMock: ReturnType<typeof mock>;
    runTaskRunnerMock: ReturnType<typeof mock>;
    createCodexSessionMock: ReturnType<typeof mock>;
    ensureCodexMultiAgentMock: ReturnType<typeof mock>;
    hookDispatchMock: ReturnType<typeof mock>;
    InvalidPlanErrorCtor: new (stage: "planner" | "review", message: string) => Error;
  }> {
    const runPlannerMock = mock(async () => {});
    const runTaskRunnerMock = mock(async (options: { runId: string; store: { updateRun: (runId: string, patch: unknown) => Promise<void> } }) => {
      await options.store.updateRun(options.runId, {
        tasks: [
          {
            id: "t1",
            name: "task",
            description: "task",
            dependencies: [],
            acceptance_criteria: ["done"],
            status: "done",
            retries: 0,
            maxRetries: 3,
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString()
          }
        ]
      });
    });
    const hookDispatchMock = mock(async () => {});

    class TestInvalidPlanError extends Error {
      stage: "planner" | "review";

      constructor(stage: "planner" | "review", message: string) {
        super(message);
        this.stage = stage;
        this.name = "InvalidPlanError";
      }
    }

    const resolveConfigMock = mock(async (configPath?: string) => {
      if (configPath) {
        const imported = await import(`${pathToFileURL(configPath).href}?test=${Math.random()}`);
        return imported.default;
      }

      return { executor: "codex" as const };
    });
    const ensureCodexMultiAgentMock = mock(async () => ({
      action: "skipped" as const,
      path: path.join(tempDir, "mock-codex-config.toml")
    }));
    const createCodexSessionMock = mock(async () => ({
      consultTaskGraph: async () => ({ issues: [], ok: true }),
      executeTask: async () => ({ outcome: "done" as const, rawResponse: '{"outcome":"done"}' }),
      runPrompt: async () => '{"summary":"clean","findings":[],"fixed":false}',
      reviewChanges: async () => "review",
      disconnect: async () => {}
    }));

    void mock.module("../../core/planner.js", () => ({
      runPlanner: runPlannerMock,
      InvalidPlanError: TestInvalidPlanError
    }));
    void mock.module("../../core/task-runner.js", () => ({
      runTaskRunner: runTaskRunnerMock
    }));
    void mock.module("../../core/config-loader.js", () => ({
      resolveConfig: resolveConfigMock
    }));
    void mock.module("../../core/codex-config.js", () => ({
      ensureCodexMultiAgent: ensureCodexMultiAgentMock
    }));
    void mock.module("../../agents/codex/session.js", () => ({
      createCodexSession: createCodexSessionMock
    }));
    void mock.module("../../hooks/adapters/openclaw.js", () => ({
      detectOpenclawAvailability: () => ({ available: false }),
      createOpenclawHookHandler: () => async () => {}
    }));
    void mock.module("../../hooks/dispatcher.js", () => ({
      HookDispatcher: class {
        on(): void {}
        async dispatch(event: unknown): Promise<void> {
          await (hookDispatchMock as (value: unknown) => Promise<void>)(event);
        }
      }
    }));
    void mock.module("../../utils/ids.js", () => ({
      generateRunId: () => "run-test-1000-abcd"
    }));
    const runModule = await import(`./run.js?test=${Math.random()}`);
    return {
      runModule,
      runPlannerMock,
      runTaskRunnerMock,
      createCodexSessionMock,
      ensureCodexMultiAgentMock,
      hookDispatchMock,
      InvalidPlanErrorCtor: TestInvalidPlanError
    };
  }

  async function parseRun(runModule: RunModule, argv: string[]): Promise<void> {
    const program = new Command();
    program.exitOverride();
    runModule.registerRunCommand(program);
    await program.parseAsync(argv, { from: "user" });
  }

  return {
    getTempDir: () => tempDir,
    loadRunModule,
    parseRun
  };
}
