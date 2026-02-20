import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";

type RunModule = typeof import("./run.js");

let tempDir = "";
const originalRunsDir = process.env.ORCA_RUNS_DIR;
const originalSkipValidators = process.env.ORCA_SKIP_VALIDATORS;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "orca-postexec-json-test-"));
  process.env.ORCA_RUNS_DIR = path.join(tempDir, "runs");
  process.env.ORCA_SKIP_VALIDATORS = "1";
  process.exitCode = 0;
});

afterEach(async () => {
  mock.restore();
  process.exitCode = 0;
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
  await rm(tempDir, { recursive: true, force: true });
});

async function loadRunModule(): Promise<{
  runModule: RunModule;
  createCodexSessionMock: ReturnType<typeof mock>;
  hookDispatchMock: ReturnType<typeof mock>;
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

  const { resolveConfig: realResolveConfig } = await import(`../../core/config-loader.js?real=${Math.random()}`);
  const resolveConfigMock = mock((configPath?: string) => realResolveConfig(configPath));
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

  mock.module("../../core/planner.js", () => ({
    runPlanner: runPlannerMock,
    InvalidPlanError: TestInvalidPlanError
  }));
  mock.module("../../core/task-runner.js", () => ({ runTaskRunner: runTaskRunnerMock }));
  mock.module("../../core/config-loader.js", () => ({ resolveConfig: resolveConfigMock }));
  mock.module("../../core/codex-config.js", () => ({ ensureCodexMultiAgent: ensureCodexMultiAgentMock }));
  mock.module("../../agents/codex/session.js", () => ({ createCodexSession: createCodexSessionMock }));
  mock.module("../../hooks/adapters/openclaw.js", () => ({
    detectOpenclawAvailability: () => ({ available: false }),
    createOpenclawHookHandler: () => async () => {}
  }));
  mock.module("../../hooks/dispatcher.js", () => ({
    HookDispatcher: class {
      on(): void {}
      async dispatch(event: unknown): Promise<void> {
        await (hookDispatchMock as (value: unknown) => Promise<void>)(event);
      }
    }
  }));
  mock.module("../../utils/ids.js", () => ({ generateRunId: () => "run-test-1000-abcd" }));

  const runModule = await import(`./run.js?test=${Math.random()}`);
  return { runModule, createCodexSessionMock, hookDispatchMock };
}

async function parseRun(runModule: RunModule, argv: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  runModule.registerRunCommand(program);
  await program.parseAsync(argv, { from: "user" });
}

describe("post-exec reviewer JSON hardening integration", () => {
  test("invalid reviewer JSON retries once and succeeds with structured output", async () => {
    const { runModule, createCodexSessionMock } = await loadRunModule();
    const runPromptMock = mock(async () => "not-json");
    runPromptMock.mockImplementationOnce(async () => "not-json");
    runPromptMock.mockImplementationOnce(async () => '{"summary":"clean","findings":[],"fixed":false}');

    createCodexSessionMock.mockImplementationOnce(async () => ({
      consultTaskGraph: async () => ({ issues: [], ok: true }),
      executeTask: async () => ({ outcome: "done" as const, rawResponse: '{"outcome":"done"}' }),
      runPrompt: runPromptMock,
      reviewChanges: async () => "review",
      disconnect: async () => {}
    }));

    const configPath = path.join(tempDir, "orca.config.js");
    await writeFile(configPath, "export default { review: { execution: { onFindings: 'report_only', validator: { auto: false } } } };\n", "utf8");

    await parseRun(runModule, ["run", "--task", "x", "--config", configPath]);

    expect(runPromptMock).toHaveBeenCalledTimes(2);
    expect(runPromptMock).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("previous post-execution review response was invalid")
    );
  });

  test("schema-invalid reviewer payload retries once and succeeds", async () => {
    const { runModule, createCodexSessionMock } = await loadRunModule();
    const runPromptMock = mock(async () => '{"summary":"missing fixed","findings":[]}');
    runPromptMock.mockImplementationOnce(async () => '{"summary":"missing fixed","findings":[]}');
    runPromptMock.mockImplementationOnce(async () => '{"summary":"clean","findings":[],"fixed":false}');

    createCodexSessionMock.mockImplementationOnce(async () => ({
      consultTaskGraph: async () => ({ issues: [], ok: true }),
      executeTask: async () => ({ outcome: "done" as const, rawResponse: '{"outcome":"done"}' }),
      runPrompt: runPromptMock,
      reviewChanges: async () => "review",
      disconnect: async () => {}
    }));

    const configPath = path.join(tempDir, "orca.config.js");
    await writeFile(configPath, "export default { review: { execution: { onFindings: 'report_only', validator: { auto: false } } } };\n", "utf8");

    await parseRun(runModule, ["run", "--task", "x", "--config", configPath]);

    expect(runPromptMock).toHaveBeenCalledTimes(2);
    expect(runPromptMock).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("Schema validation failed")
    );
  });

  test("invalid reviewer JSON after bounded retries is treated as findings and dispatches onFindings", async () => {
    const { runModule, createCodexSessionMock, hookDispatchMock } = await loadRunModule();
    const runPromptMock = mock(async () => "still-not-json");
    createCodexSessionMock.mockImplementationOnce(async () => ({
      consultTaskGraph: async () => ({ issues: [], ok: true }),
      executeTask: async () => ({ outcome: "done" as const, rawResponse: '{"outcome":"done"}' }),
      runPrompt: runPromptMock,
      reviewChanges: async () => "review",
      disconnect: async () => {}
    }));

    const configPath = path.join(tempDir, "orca.config.js");
    await writeFile(configPath, "export default { review: { execution: { onFindings: 'report_only', validator: { auto: false } } } };\n", "utf8");

    await parseRun(runModule, ["run", "--task", "x", "--config", configPath]);

    const findingsEvent = hookDispatchMock.mock.calls.find(
      (call) => (call[0] as { hook?: string })?.hook === "onFindings"
    )?.[0] as { message?: string; metadata?: { findingsCount?: number } } | undefined;

    expect(runPromptMock).toHaveBeenCalledTimes(2);
    expect(findingsEvent?.metadata?.findingsCount).toBe(1);
    expect(findingsEvent?.message).toContain("invalid JSON after 2 attempts");
  });
});
