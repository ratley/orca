import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";

type RunModule = typeof import("./run.js");
type ResumeModule = typeof import("./resume.js");

let tempDir = "";
const originalRunsDir = process.env.ORCA_RUNS_DIR;
const originalSkipValidators = process.env.ORCA_SKIP_VALIDATORS;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "orca-run-command-test-"));
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
  mock.module("../../core/task-runner.js", () => ({
    runTaskRunner: runTaskRunnerMock
  }));
  mock.module("../../core/config-loader.js", () => ({
    resolveConfig: resolveConfigMock
  }));
  mock.module("../../core/codex-config.js", () => ({
    ensureCodexMultiAgent: ensureCodexMultiAgentMock
  }));
  mock.module("../../agents/codex/session.js", () => ({
    createCodexSession: createCodexSessionMock
  }));
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
  mock.module("../../utils/ids.js", () => ({
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

async function parseRun(
  runModule: RunModule,
  argv: string[]
): Promise<void> {
  const program = new Command();
  program.exitOverride();
  runModule.registerRunCommand(program);
  await program.parseAsync(argv, { from: "user" });
}

describe("run command executor flags", () => {
  test("parses --codex-only and overrides resolved executor", async () => {
    const { runModule, runPlannerMock, runTaskRunnerMock } = await loadRunModule();
    const configPath = path.join(tempDir, "orca.config.js");
    const originalConfig = "export default { executor: 'claude' };\n";
    await writeFile(configPath, originalConfig, "utf8");

    await parseRun(runModule, ["run", "--task", "x", "--config", configPath, "--codex-only"]);

    const plannerConfig = runPlannerMock.mock.calls[0]?.[3] as { executor?: string } | undefined;
    const runnerArg = runTaskRunnerMock.mock.calls[0]?.[0] as { config?: { executor?: string } } | undefined;
    expect(plannerConfig?.executor).toBe("codex");
    expect(runnerArg?.config?.executor).toBe("codex");
    expect(await readFile(configPath, "utf8")).toBe(originalConfig);
  });

  test("parses --claude-only and overrides resolved executor", async () => {
    const { runModule, runPlannerMock, runTaskRunnerMock, createCodexSessionMock, ensureCodexMultiAgentMock } =
      await loadRunModule();
    const configPath = path.join(tempDir, "orca.config.js");
    const originalConfig = "export default { executor: 'codex' };\n";
    await writeFile(configPath, originalConfig, "utf8");

    await parseRun(runModule, ["run", "--task", "x", "--config", configPath, "--claude-only"]);

    const plannerConfig = runPlannerMock.mock.calls[0]?.[3] as { executor?: string } | undefined;
    const runnerArg = runTaskRunnerMock.mock.calls[0]?.[0] as { config?: { executor?: string } } | undefined;
    expect(plannerConfig?.executor).toBe("claude");
    expect(runnerArg?.config?.executor).toBe("claude");
    expect(createCodexSessionMock).not.toHaveBeenCalled();
    expect(ensureCodexMultiAgentMock).not.toHaveBeenCalled();
    expect(await readFile(configPath, "utf8")).toBe(originalConfig);
  });

  test("no executor flags keeps resolved config executor", async () => {
    const { runModule, runPlannerMock, runTaskRunnerMock } = await loadRunModule();
    const configPath = path.join(tempDir, "orca.config.js");
    await writeFile(configPath, "export default { executor: 'claude' };\n", "utf8");

    await parseRun(runModule, ["run", "--task", "x", "--config", configPath]);

    const plannerConfig = runPlannerMock.mock.calls[0]?.[3] as { executor?: string } | undefined;
    const runnerArg = runTaskRunnerMock.mock.calls[0]?.[0] as { config?: { executor?: string } } | undefined;
    expect(plannerConfig?.executor).toBe("claude");
    expect(runnerArg?.config?.executor).toBe("claude");
  });

  test("throws on conflicting executor flags", async () => {
    const { runModule } = await loadRunModule();
    await expect(
      runModule.runCommandHandler({
        task: "x",
        codexOnly: true,
        claudeOnly: true
      })
    ).rejects.toThrow("--codex-only and --claude-only are mutually exclusive");
  });

  test("dispatches onInvalidPlan hook when planner rejects invalid graph", async () => {
    const { runModule, runPlannerMock, hookDispatchMock, runTaskRunnerMock, InvalidPlanErrorCtor } = await loadRunModule();

    runPlannerMock.mockImplementationOnce(async () => {
      throw new InvalidPlanErrorCtor("review", "Review output invalid. cycle");
    });

    await parseRun(runModule, ["run", "--task", "x"]);
    expect(process.exitCode).toBe(1);
    const invalidPlanEvent = hookDispatchMock.mock.calls.find(
      (call) => (call[0] as { hook?: string })?.hook === "onInvalidPlan"
    )?.[0] as { hook: string; message: string; error?: string; metadata?: { stage?: string } } | undefined;

    expect(invalidPlanEvent?.message).toBe("invalid-plan:review");
    expect(invalidPlanEvent?.error).toContain("cycle");
    expect(invalidPlanEvent?.metadata?.stage).toBe("review");
    expect(runTaskRunnerMock).not.toHaveBeenCalled();
  });

  test("applies --codex-effort to effective codex config", async () => {
    const { runModule, runPlannerMock, runTaskRunnerMock } = await loadRunModule();

    await parseRun(runModule, ["run", "--task", "x", "--codex-effort", "medium"]);

    const plannerConfig = runPlannerMock.mock.calls[0]?.[3] as { codex?: { effort?: string } } | undefined;
    const runnerArg = runTaskRunnerMock.mock.calls[0]?.[0] as
      | { config?: { codex?: { effort?: string } } }
      | undefined;
    expect(plannerConfig?.codex?.effort).toBe("medium");
    expect(runnerArg?.config?.codex?.effort).toBe("medium");
  });

  test("applies --claude-effort to effective claude config", async () => {
    const { runModule, runPlannerMock, runTaskRunnerMock } = await loadRunModule();

    await parseRun(runModule, ["run", "--task", "x", "--claude-effort", "max"]);

    const plannerConfig = runPlannerMock.mock.calls[0]?.[3] as { claude?: { effort?: string } } | undefined;
    const runnerArg = runTaskRunnerMock.mock.calls[0]?.[0] as
      | { config?: { claude?: { effort?: string } } }
      | undefined;
    expect(plannerConfig?.claude?.effort).toBe("max");
    expect(runnerArg?.config?.claude?.effort).toBe("max");
  });

  test("both effort flags are accepted; active executor uses matching effort", async () => {
    const { runModule, runPlannerMock, runTaskRunnerMock } = await loadRunModule();

    await parseRun(runModule, [
      "run",
      "--task",
      "x",
      "--codex-only",
      "--codex-effort",
      "high",
      "--claude-effort",
      "low",
    ]);

    const plannerConfig = runPlannerMock.mock.calls[0]?.[3] as
      | { executor?: string; codex?: { effort?: string }; claude?: { effort?: string } }
      | undefined;
    const runnerArg = runTaskRunnerMock.mock.calls[0]?.[0] as
      | { config?: { executor?: string; codex?: { effort?: string }; claude?: { effort?: string } } }
      | undefined;

    expect(plannerConfig?.executor).toBe("codex");
    expect(plannerConfig?.codex?.effort).toBe("high");
    expect(plannerConfig?.claude?.effort).toBe("low");
    expect(runnerArg?.config?.executor).toBe("codex");
    expect(runnerArg?.config?.codex?.effort).toBe("high");
  });

  test("rejects invalid codex effort", async () => {
    const { runModule } = await loadRunModule();
    await expect(parseRun(runModule, ["run", "--task", "x", "--codex-effort", "extreme"])).rejects.toThrow(
      "Codex effort must be one of",
    );
  });

  test("rejects invalid claude effort", async () => {
    const { runModule } = await loadRunModule();
    await expect(parseRun(runModule, ["run", "--task", "x", "--claude-effort", "ultra"])).rejects.toThrow(
      "Claude effort must be one of",
    );
  });

  test("rejects invalid boolean value for --codex-only", async () => {
    const { runModule } = await loadRunModule();
    await expect(
      parseRun(runModule, ["run", "--task", "x", "--codex-only=false"])
    ).rejects.toThrow();
  });

  test("legacy review.enabled=false disables post-execution review", async () => {
    const { runModule, createCodexSessionMock } = await loadRunModule();
    const runPromptMock = mock(async () => '{"summary":"found","findings":["lint"],"fixed":true}');
    const reviewChangesMock = mock(async () => "review");
    createCodexSessionMock.mockImplementationOnce(async () => ({
      consultTaskGraph: async () => ({ issues: [], ok: true }),
      executeTask: async () => ({ outcome: "done" as const, rawResponse: '{"outcome":"done"}' }),
      runPrompt: runPromptMock,
      reviewChanges: reviewChangesMock,
      disconnect: async () => {}
    }));

    const configPath = path.join(tempDir, "orca.config.js");
    await writeFile(configPath, "export default { review: { enabled: false } };\n", "utf8");

    await parseRun(runModule, ["run", "--task", "x", "--config", configPath]);
    expect(runPromptMock).not.toHaveBeenCalled();
    expect(reviewChangesMock).not.toHaveBeenCalled();
  });

  test("dispatches onFindings hook when post-execution review reports findings", async () => {
    const { runModule, createCodexSessionMock, hookDispatchMock } = await loadRunModule();
    createCodexSessionMock.mockImplementationOnce(async () => ({
      consultTaskGraph: async () => ({ issues: [], ok: true }),
      executeTask: async () => ({ outcome: "done" as const, rawResponse: '{"outcome":"done"}' }),
      runPrompt: async () => '{"summary":"needs fixes","findings":["lint"],"fixed":false}',
      reviewChanges: async () => "review",
      disconnect: async () => {}
    }));

    const configPath = path.join(tempDir, "orca.config.js");
    await writeFile(configPath, "export default { review: { execution: { validator: { auto: false } } } };\n", "utf8");

    await parseRun(runModule, ["run", "--task", "x", "--config", configPath]);

    const findingsEvent = hookDispatchMock.mock.calls.find(
      (call) => (call[0] as { hook?: string })?.hook === "onFindings"
    )?.[0] as { metadata?: { findingsCount?: number; cycleIndex?: number } } | undefined;

    expect(findingsEvent?.metadata?.findingsCount).toBe(1);
    expect(findingsEvent?.metadata?.cycleIndex).toBe(1);
  });

  test("auto_fix loop stops when clean", async () => {
    const { runModule, createCodexSessionMock } = await loadRunModule();
    const runPromptMock = mock(async () => '{"summary":"clean","findings":[],"fixed":false}');
    runPromptMock.mockImplementationOnce(async () => '{"summary":"fixed","findings":["lint"],"fixed":true}');
    createCodexSessionMock.mockImplementationOnce(async () => ({
      consultTaskGraph: async () => ({ issues: [], ok: true }),
      executeTask: async () => ({ outcome: "done" as const, rawResponse: '{"outcome":"done"}' }),
      runPrompt: runPromptMock,
      reviewChanges: async () => "review",
      disconnect: async () => {}
    }));

    const configPath = path.join(tempDir, "orca.config.js");
    await writeFile(configPath, "export default { review: { execution: { onFindings: 'auto_fix', maxCycles: 4, validator: { auto: false } } } };\n", "utf8");

    await parseRun(runModule, ["run", "--task", "x", "--config", configPath]);
    expect(runPromptMock).toHaveBeenCalledTimes(2);
  });

  test("maxCycles cap enforced", async () => {
    const { runModule, createCodexSessionMock } = await loadRunModule();
    const runPromptMock = mock(async () => '{"summary":"still findings","findings":["lint"],"fixed":true}');
    createCodexSessionMock.mockImplementationOnce(async () => ({
      consultTaskGraph: async () => ({ issues: [], ok: true }),
      executeTask: async () => ({ outcome: "done" as const, rawResponse: '{"outcome":"done"}' }),
      runPrompt: runPromptMock,
      reviewChanges: async () => "review",
      disconnect: async () => {}
    }));

    const configPath = path.join(tempDir, "orca.config.js");
    await writeFile(configPath, "export default { review: { execution: { onFindings: 'auto_fix', maxCycles: 2, validator: { auto: false } } } };\n", "utf8");

    await parseRun(runModule, ["run", "--task", "x", "--config", configPath]);
    expect(runPromptMock).toHaveBeenCalledTimes(2);
  });

  test("fail mode stops after first findings and marks run failed", async () => {
    const { runModule, createCodexSessionMock } = await loadRunModule();
    const runPromptMock = mock(async () => '{"summary":"found","findings":["lint"],"fixed":true}');
    createCodexSessionMock.mockImplementationOnce(async () => ({
      consultTaskGraph: async () => ({ issues: [], ok: true }),
      executeTask: async () => ({ outcome: "done" as const, rawResponse: '{"outcome":"done"}' }),
      runPrompt: runPromptMock,
      reviewChanges: async () => "review",
      disconnect: async () => {}
    }));

    const configPath = path.join(tempDir, "orca.config.js");
    await writeFile(configPath, "export default { review: { execution: { onFindings: 'fail', maxCycles: 3, validator: { auto: false } } } };\n", "utf8");

    await parseRun(runModule, ["run", "--task", "x", "--config", configPath]);
    expect(runPromptMock).toHaveBeenCalledTimes(1);

    const statusPath = path.join(tempDir, "runs", "run-test-1000-abcd", "status.json");
    const status = JSON.parse(await readFile(statusPath, "utf8")) as { overallStatus?: string };
    expect(status.overallStatus).toBe("failed");
  });

  test("report_only mode does not auto-fix", async () => {
    const { runModule, createCodexSessionMock } = await loadRunModule();
    const runPromptMock = mock(async () => '{"summary":"found","findings":["lint"],"fixed":true}');
    createCodexSessionMock.mockImplementationOnce(async () => ({
      consultTaskGraph: async () => ({ issues: [], ok: true }),
      executeTask: async () => ({ outcome: "done" as const, rawResponse: '{"outcome":"done"}' }),
      runPrompt: runPromptMock,
      reviewChanges: async () => "review",
      disconnect: async () => {}
    }));

    const configPath = path.join(tempDir, "orca.config.js");
    await writeFile(configPath, "export default { review: { execution: { onFindings: 'report_only', maxCycles: 3, validator: { auto: false } } } };\n", "utf8");

    await parseRun(runModule, ["run", "--task", "x", "--config", configPath]);
    expect(runPromptMock).toHaveBeenCalledTimes(1);
  });

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

describe("resume command executor flags", () => {
  test("throws on conflicting executor flags", async () => {
    const resumeModule: ResumeModule = await import(`./resume.js?test=${Math.random()}`);
    await expect(
      resumeModule.resumeCommandHandler({
        run: "run-test-1000-abcd",
        codexOnly: true,
        claudeOnly: true
      })
    ).rejects.toThrow("--codex-only and --claude-only are mutually exclusive");
  });
});
