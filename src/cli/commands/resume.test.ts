import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { RunStore } from "../../state/store.js";
import type { OrcaConfig, Task } from "../../types/index.js";

type ResumeModule = typeof import("./resume.js");

describe("resume command", () => {
  let tempDir: string;
  let originalRunsDir: string | undefined;
  let originalCwd: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "orca-resume-command-test-"));
    originalRunsDir = process.env.ORCA_RUNS_DIR;
    originalCwd = process.cwd();
    process.env.ORCA_RUNS_DIR = path.join(tempDir, "runs");
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
    await rm(tempDir, { recursive: true, force: true });
  });

  async function loadResumeModule(
    runTaskRunnerMock: ReturnType<typeof mock>,
    createCodexSessionMock: ReturnType<typeof mock> = mock(async () => ({
      executeTask: async () => ({ outcome: "done" as const, rawResponse: '{"outcome":"done"}' }),
      runPrompt: async () => '{"summary":"clean","findings":[],"fixed":false}',
      reviewChanges: async () => "review",
      disconnect: async () => {}
    }))
  ): Promise<ResumeModule> {
    const mergeConfigsForTest = (...configs: Array<OrcaConfig | undefined>): OrcaConfig | undefined => {
      const presentConfigs = configs.filter((config): config is OrcaConfig => config !== undefined);
      if (presentConfigs.length === 0) {
        return undefined;
      }

      const merged: OrcaConfig = {};
      for (const config of presentConfigs) {
        for (const [key, value] of Object.entries(config)) {
          if (key !== "skills" && key !== "codex" && key !== "review") {
            (merged as Record<string, unknown>)[key] = value;
          }
        }
        if (config.skills !== undefined) {
          merged.skills = [...new Set([...(merged.skills ?? []), ...config.skills])];
        }
        if (config.codex !== undefined) {
          merged.codex = { ...merged.codex, ...config.codex };
        }
        if (config.review !== undefined) {
          merged.review = {
            ...merged.review,
            ...config.review,
            task: {
              ...merged.review?.task,
              ...config.review.task
            },
            execution: {
              ...merged.review?.execution,
              ...config.review.execution,
              validator: {
                ...merged.review?.execution?.validator,
                ...config.review.execution?.validator
              }
            }
          };
        }
      }

      return merged;
    };

    void mock.module("../../core/config-loader.js", () => ({
      resolveConfig: async (configPath?: string) => {
        if (configPath === undefined) {
          return undefined;
        }

        const imported = await import(`${pathToFileURL(configPath).href}?test=${Math.random()}`);
        return imported.default as OrcaConfig;
      },
      mergeConfigs: mergeConfigsForTest
    }));
    void mock.module("../../core/task-runner.js", () => ({
      runTaskRunner: runTaskRunnerMock,
      resolveTaskRunnerParallelism: async () => 1
    }));
    void mock.module("../../agents/codex/session.js", () => ({
      createCodexSession: createCodexSessionMock
    }));

    return import(`./resume.js?test=${Math.random()}`);
  }

  test("replays persisted flow config and execution instructions on resume", async () => {
    const runTaskRunnerMock = mock(async () => {});
    const resumeModule = await loadResumeModule(runTaskRunnerMock);
    const store = new RunStore(process.env.ORCA_RUNS_DIR);
    const runId = "resume-flow-1000-abcd";
    const specPath = path.join(tempDir, "spec.md");
    const configPath = path.join(tempDir, "orca.config.js");
    const task: Task = {
      id: "t1",
      name: "Resume task",
      description: "Finish the interrupted task.",
      dependencies: [],
      acceptance_criteria: ["task is done"],
      status: "in_progress",
      retries: 0,
      maxRetries: 3
    };

    await writeFile(specPath, "# Spec\n", "utf8");
    await writeFile(
      configPath,
      [
        "export default {",
        "  codex: { model: 'base-model' },",
        "  flow: {",
        "    default: 'default-flow',",
        "    presets: {",
        "      'default-flow': { execution: { prompt: 'Do not use this flow.', codex: { maxParallelTasks: 1 } } },",
        "      'persisted-flow': {",
        "        description: 'Persisted review flow',",
        "        baseline: { prompt: 'Read persisted baseline instructions.', skills: ['persisted-skill'] },",
        "        execution: { prompt: 'Use persisted execution instructions.', codex: { maxParallelTasks: 3 } },",
        "        overrides: { codex: { effort: 'high' } }",
        "      }",
        "    }",
        "  }",
        "};",
        "",
      ].join("\n"),
      "utf8"
    );

    await store.createRun(runId, specPath);
    await store.updateRun(runId, {
      mode: "run",
      overallStatus: "running",
      flowName: "persisted-flow",
      tasks: [task]
    });

    await resumeModule.resumeCommandHandler({ run: runId, config: configPath });

    const runnerArg = runTaskRunnerMock.mock.calls[0]?.[0] as
      | {
        config?: {
          skills?: string[];
          codex?: { model?: string; maxParallelTasks?: number; effort?: string };
        };
        systemContextSections?: string[];
      }
      | undefined;
    const resumed = await store.getRun(runId);

    expect(runnerArg?.config?.skills).toEqual(["persisted-skill"]);
    expect(runnerArg?.config?.codex).toEqual({
      model: "base-model",
      maxParallelTasks: 3,
      effort: "high"
    });
    expect(runnerArg?.systemContextSections?.[0]).toContain("Selected flow: persisted-flow");
    expect(runnerArg?.systemContextSections?.[0]).toContain("Read persisted baseline instructions.");
    expect(runnerArg?.systemContextSections?.[0]).toContain("Use persisted execution instructions.");
    expect(runnerArg?.systemContextSections?.[0]).not.toContain("Do not use this flow.");
    expect(resumed?.tasks[0]?.status).toBe("pending");
    expect(resumed?.tasks[0]?.lastError).toBe("Recovered from interrupted in_progress task");
  });

  test("recreates task and post-execution review wiring on resume", async () => {
    const runPromptMock = mock(async () => '{"summary":"clean","findings":[],"fixed":false}');
    const reviewChangesMock = mock(async () => "review");
    const createCodexSessionMock = mock(async () => ({
      executeTask: async () => ({ outcome: "done" as const, rawResponse: '{"outcome":"done"}' }),
      runPrompt: runPromptMock,
      reviewChanges: reviewChangesMock,
      disconnect: async () => {}
    }));
    const runTaskRunnerMock = mock(async (options: {
      runId: string;
      store: RunStore;
    }) => {
      await options.store.updateRun(options.runId, {
        overallStatus: "completed",
        tasks: [
          {
            id: "t1",
            name: "Resume task",
            description: "Finish the interrupted task.",
            dependencies: [],
            acceptance_criteria: ["task is done"],
            status: "done",
            retries: 0,
            maxRetries: 3,
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString()
          }
        ]
      });
    });
    const resumeModule = await loadResumeModule(runTaskRunnerMock, createCodexSessionMock);
    const store = new RunStore(process.env.ORCA_RUNS_DIR);
    const runId = "resume-review-1000-abcd";
    const specPath = path.join(tempDir, "spec.md");
    const configPath = path.join(tempDir, "orca.config.js");
    const task: Task = {
      id: "t1",
      name: "Resume task",
      description: "Finish the interrupted task.",
      dependencies: [],
      acceptance_criteria: ["task is done"],
      status: "pending",
      retries: 0,
      maxRetries: 3
    };

    await writeFile(specPath, "# Spec\n", "utf8");
    await writeFile(
      configPath,
      [
        "export default {",
        "  flow: {",
        "    presets: {",
        "      'persisted-flow': {",
        "        execution: { review: { enabled: true, maxCycles: 2 } },",
        "        review: { execution: { validator: { auto: false } } },",
        "        summary: { prompt: 'Use the persisted summary prompt.' }",
        "      }",
        "    }",
        "  }",
        "};",
        "",
      ].join("\n"),
      "utf8"
    );

    await store.createRun(runId, specPath);
    await store.updateRun(runId, {
      mode: "run",
      overallStatus: "running",
      flowName: "persisted-flow",
      tasks: [task]
    });

    await resumeModule.resumeCommandHandler({ run: runId, config: configPath });

    const runnerArg = runTaskRunnerMock.mock.calls[0]?.[0] as
      | { reviewCompletedTask?: unknown; executeTask?: unknown }
      | undefined;
    const reviewPrompt = runPromptMock.mock.calls[0]?.[0] as string | undefined;

    expect(runnerArg?.executeTask).toBeFunction();
    expect(runnerArg?.reviewCompletedTask).toBeFunction();
    expect(reviewPrompt).toContain("Use the persisted summary prompt.");
    expect(reviewChangesMock).toHaveBeenCalled();
  });
});
