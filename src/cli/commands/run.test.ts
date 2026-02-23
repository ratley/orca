import { describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createRunCommandTestHarness } from "./run-command.test-harness.js";

type ResumeModule = typeof import("./resume.js");

const harness = createRunCommandTestHarness("orca-run-command-test-");
const { loadRunModule, parseRun, getTempDir } = harness;

describe("first-run config initialization", () => {
  test("creates ~/.orca/config.js when no global or project config exists", async () => {
    const { runModule } = await loadRunModule();
    const fakeHome = await mkdtemp(path.join(os.tmpdir(), "orca-home-"));
    const originalCwd = process.cwd();
    const tempProjectDir = await mkdtemp(path.join(os.tmpdir(), "orca-project-"));

    try {
      process.chdir(tempProjectDir);
      await runModule.maybeCreateFirstRunGlobalConfig(fakeHome);

      const written = await readFile(path.join(fakeHome, ".orca", "config.js"), "utf8");
      expect(written).toContain('executor: "codex"');
    } finally {
      process.chdir(originalCwd);
      await rm(fakeHome, { recursive: true, force: true });
      await rm(tempProjectDir, { recursive: true, force: true });
    }
  });

  test("does not create global config when project config already exists", async () => {
    const { runModule } = await loadRunModule();
    const fakeHome = await mkdtemp(path.join(os.tmpdir(), "orca-home-"));
    const originalCwd = process.cwd();
    const tempProjectDir = await mkdtemp(path.join(os.tmpdir(), "orca-project-"));

    try {
      process.chdir(tempProjectDir);
      await writeFile(path.join(tempProjectDir, "orca.config.ts"), "export default { executor: 'claude' };\n", "utf8");
      await runModule.maybeCreateFirstRunGlobalConfig(fakeHome);

      await expect(readFile(path.join(fakeHome, ".orca", "config.js"), "utf8")).rejects.toBeDefined();
    } finally {
      process.chdir(originalCwd);
      await rm(fakeHome, { recursive: true, force: true });
      await rm(tempProjectDir, { recursive: true, force: true });
    }
  });

  test("does not create global js config when global ts config already exists", async () => {
    const { runModule } = await loadRunModule();
    const fakeHome = await mkdtemp(path.join(os.tmpdir(), "orca-home-"));
    const originalCwd = process.cwd();
    const tempProjectDir = await mkdtemp(path.join(os.tmpdir(), "orca-project-"));

    try {
      process.chdir(tempProjectDir);
      await mkdir(path.join(fakeHome, ".orca"), { recursive: true });
      const tsConfigPath = path.join(fakeHome, ".orca", "config.ts");
      const tsConfig = "export default { executor: 'codex' };\n";
      await writeFile(tsConfigPath, tsConfig, "utf8");
      await runModule.maybeCreateFirstRunGlobalConfig(fakeHome);

      await expect(readFile(path.join(fakeHome, ".orca", "config.js"), "utf8")).rejects.toBeDefined();
      await expect(readFile(tsConfigPath, "utf8")).resolves.toBe(tsConfig);
    } finally {
      process.chdir(originalCwd);
      await rm(fakeHome, { recursive: true, force: true });
      await rm(tempProjectDir, { recursive: true, force: true });
    }
  });
});

describe("run command executor flags", () => {
  test("parses --codex-only and overrides resolved executor", async () => {
    const { runModule, runPlannerMock, runTaskRunnerMock } = await loadRunModule();
    const configPath = path.join(getTempDir(), "orca.config.js");
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
    const configPath = path.join(getTempDir(), "orca.config.js");
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
    const configPath = path.join(getTempDir(), "orca.config.js");
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

  test("forces codex executor when nested inside Claude Code", async () => {
    const { runModule, runPlannerMock, runTaskRunnerMock } = await loadRunModule();
    const configPath = path.join(getTempDir(), "orca.config.js");
    const originalNested = process.env.CLAUDE_CODE_SESSION_ID;
    const originalOpenai = process.env.OPENAI_API_KEY;

    try {
      process.env.CLAUDE_CODE_SESSION_ID = "nested-session";
      process.env.OPENAI_API_KEY = "sk-openai";
      await writeFile(configPath, "export default { executor: 'claude' };\n", "utf8");

      await parseRun(runModule, ["run", "--task", "x", "--config", configPath]);

      const plannerConfig = runPlannerMock.mock.calls[0]?.[3] as { executor?: string } | undefined;
      const runnerArg = runTaskRunnerMock.mock.calls[0]?.[0] as { config?: { executor?: string } } | undefined;
      expect(plannerConfig?.executor).toBe("codex");
      expect(runnerArg?.config?.executor).toBe("codex");
    } finally {
      if (originalNested === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
      else process.env.CLAUDE_CODE_SESSION_ID = originalNested;

      if (originalOpenai === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalOpenai;
    }
  });

  test("exits with code 1 in nested Claude Code session when Codex is unavailable", async () => {
    const { runModule, runPlannerMock, runTaskRunnerMock } = await loadRunModule();
    const originalNested = process.env.CLAUDE_CODE_ENTRYPOINT;
    const originalOpenai = process.env.OPENAI_API_KEY;
    const originalOrcaOpenai = process.env.ORCA_OPENAI_API_KEY;
    const originalHome = process.env.HOME;
    const isolatedHome = await mkdtemp(path.join(os.tmpdir(), "orca-no-codex-home-"));

    try {
      process.env.CLAUDE_CODE_ENTRYPOINT = "nested-entrypoint";
      delete process.env.OPENAI_API_KEY;
      delete process.env.ORCA_OPENAI_API_KEY;
      process.env.HOME = isolatedHome;

      await parseRun(runModule, ["run", "--task", "x"]);

      expect(process.exitCode).toBe(1);
      expect(runPlannerMock).not.toHaveBeenCalled();
      expect(runTaskRunnerMock).not.toHaveBeenCalled();
    } finally {
      if (originalNested === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT;
      else process.env.CLAUDE_CODE_ENTRYPOINT = originalNested;

      if (originalOpenai === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalOpenai;

      if (originalOrcaOpenai === undefined) delete process.env.ORCA_OPENAI_API_KEY;
      else process.env.ORCA_OPENAI_API_KEY = originalOrcaOpenai;

      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;

      await rm(isolatedHome, { recursive: true, force: true });
    }
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

    const configPath = path.join(getTempDir(), "orca.config.js");
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

    const configPath = path.join(getTempDir(), "orca.config.js");
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

    const configPath = path.join(getTempDir(), "orca.config.js");
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

    const configPath = path.join(getTempDir(), "orca.config.js");
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

    const configPath = path.join(getTempDir(), "orca.config.js");
    await writeFile(configPath, "export default { review: { execution: { onFindings: 'fail', maxCycles: 3, validator: { auto: false } } } };\n", "utf8");

    await parseRun(runModule, ["run", "--task", "x", "--config", configPath]);
    expect(runPromptMock).toHaveBeenCalledTimes(1);

    const statusPath = path.join(getTempDir(), "runs", "run-test-1000-abcd", "status.json");
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

    const configPath = path.join(getTempDir(), "orca.config.js");
    await writeFile(configPath, "export default { review: { execution: { onFindings: 'report_only', maxCycles: 3, validator: { auto: false } } } };\n", "utf8");

    await parseRun(runModule, ["run", "--task", "x", "--config", configPath]);
    expect(runPromptMock).toHaveBeenCalledTimes(1);
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
