import { describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createRunCommandTestHarness } from "./run-command.test-harness.js";

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
      await writeFile(path.join(tempProjectDir, "orca.config.ts"), "export default { executor: 'codex' };\n", "utf8");
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
  test("enables planning-skip decision pass for run command", async () => {
    const { runModule, runPlannerMock } = await loadRunModule();

    await parseRun(runModule, ["run", "--task", "x"]);

    const plannerOptions = runPlannerMock.mock.calls[0]?.[4] as { allowPlanSkip?: boolean } | undefined;
    expect(plannerOptions?.allowPlanSkip).toBe(true);
  });

  test("parses --codex-only and overrides resolved executor", async () => {
    const { runModule, runPlannerMock, runTaskRunnerMock } = await loadRunModule();
    const configPath = path.join(getTempDir(), "orca.config.js");
    const originalConfig = "export default { executor: 'codex' };\n";
    await writeFile(configPath, originalConfig, "utf8");

    await parseRun(runModule, ["run", "--task", "x", "--config", configPath, "--codex-only"]);

    const plannerConfig = runPlannerMock.mock.calls[0]?.[3] as { executor?: string } | undefined;
    const runnerArg = runTaskRunnerMock.mock.calls[0]?.[0] as { config?: { executor?: string } } | undefined;
    expect(plannerConfig?.executor).toBe("codex");
    expect(runnerArg?.config?.executor).toBe("codex");
    expect(await readFile(configPath, "utf8")).toBe(originalConfig);
  });

  test("no executor flags keeps resolved config executor", async () => {
    const { runModule, runPlannerMock, runTaskRunnerMock } = await loadRunModule();
    const configPath = path.join(getTempDir(), "orca.config.js");
    await writeFile(configPath, "export default { executor: 'codex' };\n", "utf8");

    await parseRun(runModule, ["run", "--task", "x", "--config", configPath]);

    const plannerConfig = runPlannerMock.mock.calls[0]?.[3] as { executor?: string } | undefined;
    const runnerArg = runTaskRunnerMock.mock.calls[0]?.[0] as { config?: { executor?: string } } | undefined;
    expect(plannerConfig?.executor).toBe("codex");
    expect(runnerArg?.config?.executor).toBe("codex");
  });

  test("dispatches onInvalidPlan hook when planner rejects invalid graph", async () => {
    const { runModule, runPlannerMock, hookDispatchMock, runTaskRunnerMock, InvalidPlanErrorCtor } =
      await loadRunModule();

    runPlannerMock.mockImplementationOnce(async () => {
      throw new InvalidPlanErrorCtor("review", "Review output invalid. cycle");
    });

    await parseRun(runModule, ["run", "--task", "x"]);
    expect(process.exitCode).toBe(1);
    const invalidPlanEvent = hookDispatchMock.mock.calls.find(
      (call) => (call[0] as { hook?: string })?.hook === "onInvalidPlan",
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
    const runnerArg = runTaskRunnerMock.mock.calls[0]?.[0] as { config?: { codex?: { effort?: string } } } | undefined;
    expect(plannerConfig?.codex?.effort).toBe("medium");
    expect(runnerArg?.config?.codex?.effort).toBe("medium");
  });

  test("rejects removed codex effort alias extra-high", async () => {
    const { runModule } = await loadRunModule();
    await expect(parseRun(runModule, ["run", "--task", "x", "--codex-effort", "extra-high"])).rejects.toThrow(
      "Codex thinking level must be one of",
    );
  });

  test("rejects invalid codex effort", async () => {
    const { runModule } = await loadRunModule();
    await expect(parseRun(runModule, ["run", "--task", "x", "--codex-effort", "extreme"])).rejects.toThrow(
      "Codex thinking level must be one of",
    );
  });

  test("rejects invalid boolean value for --codex-only", async () => {
    const { runModule } = await loadRunModule();
    await expect(parseRun(runModule, ["run", "--task", "x", "--codex-only=false"])).rejects.toThrow();
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
      disconnect: async () => {},
    }));

    const configPath = path.join(getTempDir(), "orca.config.js");
    await writeFile(configPath, "export default { review: { enabled: false } };\n", "utf8");

    await parseRun(runModule, ["run", "--task", "x", "--config", configPath]);
    expect(runPromptMock).not.toHaveBeenCalled();
    expect(reviewChangesMock).not.toHaveBeenCalled();
  });

  test("marks run failed when task graph consultation throws", async () => {
    const { runModule, createCodexSessionMock, runTaskRunnerMock } = await loadRunModule();
    createCodexSessionMock.mockImplementationOnce(async () => ({
      consultTaskGraph: async () => {
        throw new Error("Quota exceeded. Check your plan and billing details.");
      },
      executeTask: async () => ({ outcome: "done" as const, rawResponse: '{"outcome":"done"}' }),
      runPrompt: async () => '{"summary":"clean","findings":[],"fixed":false}',
      reviewChanges: async () => "review",
      disconnect: async () => {},
    }));

    await parseRun(runModule, ["run", "--task", "x"]);

    expect(process.exitCode).toBe(1);
    expect(runTaskRunnerMock).not.toHaveBeenCalled();

    const statusPath = path.join(getTempDir(), "runs", "run-test-1000-abcd", "status.json");
    const status = JSON.parse(await readFile(statusPath, "utf8")) as {
      overallStatus?: string;
      errors?: Array<{ message?: string }>;
    };
    expect(status.overallStatus).toBe("failed");
    expect(status.errors?.[0]?.message).toContain("Quota exceeded");
  });

  test("does not dispatch onComplete twice when execution review is disabled", async () => {
    const { runModule, runTaskRunnerMock, hookDispatchMock } = await loadRunModule();
    runTaskRunnerMock.mockImplementationOnce(
      async (options: {
        runId: string;
        store: { updateRun: (runId: string, patch: unknown) => Promise<void> };
        emitHook?: (event: unknown) => Promise<void>;
      }) => {
        await options.store.updateRun(options.runId, {
          overallStatus: "completed",
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
              finishedAt: new Date().toISOString(),
            },
          ],
        });

        await options.emitHook?.({
          runId: options.runId,
          hook: "onComplete",
          message: "run-completed",
          timestamp: new Date().toISOString(),
          metadata: { overallStatus: "completed" },
        });
      },
    );

    const configPath = path.join(getTempDir(), "orca.config.js");
    await writeFile(configPath, "export default { review: { enabled: false } };\n", "utf8");

    await parseRun(runModule, ["run", "--task", "x", "--config", configPath]);

    const onCompleteCalls = hookDispatchMock.mock.calls.filter(
      (call) => (call[0] as { hook?: string })?.hook === "onComplete",
    );
    expect(onCompleteCalls).toHaveLength(1);
  });

  test("dispatches onFindings hook when post-execution review reports findings", async () => {
    const { runModule, createCodexSessionMock, hookDispatchMock } = await loadRunModule();
    createCodexSessionMock.mockImplementationOnce(async () => ({
      consultTaskGraph: async () => ({ issues: [], ok: true }),
      executeTask: async () => ({ outcome: "done" as const, rawResponse: '{"outcome":"done"}' }),
      runPrompt: async () => '{"summary":"needs fixes","findings":["lint"],"fixed":false}',
      reviewChanges: async () => "review",
      disconnect: async () => {},
    }));

    const configPath = path.join(getTempDir(), "orca.config.js");
    await writeFile(configPath, "export default { review: { execution: { validator: { auto: false } } } };\n", "utf8");

    await parseRun(runModule, ["run", "--task", "x", "--config", configPath]);

    const findingsEvent = hookDispatchMock.mock.calls.find(
      (call) => (call[0] as { hook?: string })?.hook === "onFindings",
    )?.[0] as { metadata?: { findingsCount?: number; cycleIndex?: number } } | undefined;

    expect(findingsEvent?.metadata?.findingsCount).toBe(1);
    expect(findingsEvent?.metadata?.cycleIndex).toBe(1);
  });

  test("skips fallback review when structured execution review already ran", async () => {
    const { runModule, createCodexSessionMock } = await loadRunModule();
    const reviewChangesMock = mock(async () => "review");
    createCodexSessionMock.mockImplementationOnce(async () => ({
      consultTaskGraph: async () => ({ issues: [], ok: true }),
      executeTask: async () => ({ outcome: "done" as const, rawResponse: '{"outcome":"done"}' }),
      runPrompt: async () => '{"summary":"clean","findings":[],"fixed":false}',
      reviewChanges: reviewChangesMock,
      disconnect: async () => {},
    }));

    const configPath = path.join(getTempDir(), "orca.config.js");
    await writeFile(configPath, "export default { review: { execution: { validator: { auto: false } } } };\n", "utf8");

    await parseRun(runModule, ["run", "--task", "x", "--config", configPath]);

    expect(reviewChangesMock).not.toHaveBeenCalled();
  });

  test("treats failed validator commands as findings even if reviewer reports none", async () => {
    const { runModule, createCodexSessionMock, hookDispatchMock } = await loadRunModule();
    createCodexSessionMock.mockImplementationOnce(async () => ({
      consultTaskGraph: async () => ({ issues: [], ok: true }),
      executeTask: async () => ({ outcome: "done" as const, rawResponse: '{"outcome":"done"}' }),
      runPrompt: async () => '{"summary":"clean","findings":[],"fixed":false}',
      reviewChanges: async () => "review",
      disconnect: async () => {},
    }));

    const configPath = path.join(getTempDir(), "orca.config.js");
    await writeFile(
      configPath,
      "export default { review: { execution: { onFindings: 'report_only', validator: { auto: false, commands: ['node -e \"process.exit(1)\"'] } } } };\n",
      "utf8",
    );

    await parseRun(runModule, ["run", "--task", "x", "--config", configPath]);

    const findingsEvent = hookDispatchMock.mock.calls.find(
      (call) => (call[0] as { hook?: string })?.hook === "onFindings",
    )?.[0] as { message?: string; metadata?: { findingsCount?: number } } | undefined;

    expect(findingsEvent?.metadata?.findingsCount).toBe(1);
    expect(findingsEvent?.message).toContain("Validator failures still need attention");
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
      disconnect: async () => {},
    }));

    const configPath = path.join(getTempDir(), "orca.config.js");
    await writeFile(
      configPath,
      "export default { review: { execution: { onFindings: 'auto_fix', maxCycles: 4, validator: { auto: false } } } };\n",
      "utf8",
    );

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
      disconnect: async () => {},
    }));

    const configPath = path.join(getTempDir(), "orca.config.js");
    await writeFile(
      configPath,
      "export default { review: { execution: { onFindings: 'auto_fix', maxCycles: 2, validator: { auto: false } } } };\n",
      "utf8",
    );

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
      disconnect: async () => {},
    }));

    const configPath = path.join(getTempDir(), "orca.config.js");
    await writeFile(
      configPath,
      "export default { review: { execution: { onFindings: 'fail', maxCycles: 3, validator: { auto: false } } } };\n",
      "utf8",
    );

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
      disconnect: async () => {},
    }));

    const configPath = path.join(getTempDir(), "orca.config.js");
    await writeFile(
      configPath,
      "export default { review: { execution: { onFindings: 'report_only', maxCycles: 3, validator: { auto: false } } } };\n",
      "utf8",
    );

    await parseRun(runModule, ["run", "--task", "x", "--config", configPath]);
    expect(runPromptMock).toHaveBeenCalledTimes(1);
  });
});

describe("resume command executor flags", () => {});
