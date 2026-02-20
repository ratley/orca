import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";

type RunModule = typeof import("./run.js");
type ResumeModule = typeof import("./resume.js");

let tempDir = "";
const originalRunsDir = process.env.ORCA_RUNS_DIR;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "orca-run-command-test-"));
  process.env.ORCA_RUNS_DIR = path.join(tempDir, "runs");
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
  await rm(tempDir, { recursive: true, force: true });
});

async function loadRunModule(): Promise<{
  runModule: RunModule;
  runPlannerMock: ReturnType<typeof mock>;
  runTaskRunnerMock: ReturnType<typeof mock>;
  createCodexSessionMock: ReturnType<typeof mock>;
  ensureCodexMultiAgentMock: ReturnType<typeof mock>;
}> {
  const runPlannerMock = mock(async () => {});
  const runTaskRunnerMock = mock(async () => {});
  const { resolveConfig: realResolveConfig } = await import(`../../core/config-loader.js?real=${Math.random()}`);
  const resolveConfigMock = mock((configPath?: string) => realResolveConfig(configPath));
  const ensureCodexMultiAgentMock = mock(async () => ({
    action: "skipped" as const,
    path: path.join(tempDir, "mock-codex-config.toml")
  }));
  const createCodexSessionMock = mock(async () => ({
    consultTaskGraph: async () => ({ issues: [], ok: true }),
    executeTask: async () => ({ outcome: "done" as const, rawResponse: '{"outcome":"done"}' }),
    reviewChanges: async () => "review",
    disconnect: async () => {}
  }));

  mock.module("../../core/planner.js", () => ({
    runPlanner: runPlannerMock
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
      async dispatch(): Promise<void> {}
    }
  }));
  mock.module("../../utils/ids.js", () => ({
    generateRunId: () => "run-test-1000-abcd"
  }));

  const runModule = await import(`./run.js?test=${Math.random()}`);
  return { runModule, runPlannerMock, runTaskRunnerMock, createCodexSessionMock, ensureCodexMultiAgentMock };
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
