import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, mock, test } from "bun:test";

import { RunStore } from "../../state/store.js";

afterEach(() => {
  mock.restore();
});

async function waitFor<T>(load: () => Promise<T | null>, timeoutMs = 2_000): Promise<T> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const value = await load();
    if (value !== null) {
      return value;
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`Timed out after ${timeoutMs}ms`);
}

function mockMultiAgentDetection(active = false): void {
  mock.module("../../core/codex-config.js", () => ({
    isCodexMultiAgentActive: async () => active,
  }));
}

describe("codex session effort wiring", () => {
  test("uses ORCA_CODEX_PATH override and otherwise resolves a default Codex binary", async () => {
    const constructedOptions: Array<{ codexPath?: string }> = [];
    const originalCodexPath = process.env.ORCA_CODEX_PATH;

    mockMultiAgentDetection(false);
    mock.module("@ratley/codex-client", () => ({
      CodexClient: class {
        constructor(options: { codexPath?: string }) {
          constructedOptions.push(options);
        }
        async connect(): Promise<void> {}
        async disconnect(): Promise<void> {}
        async startThread(): Promise<{ id: string }> {
          return { id: "thread-1" };
        }
        async runReview(): Promise<{ reviewText: string }> {
          return { reviewText: "ok" };
        }
      },
    }));

    mock.module("../../utils/skill-loader.js", () => ({
      loadSkills: async () => [],
    }));

    const { createCodexSession } = await import(`./session.ts?test=${Math.random()}`);

    try {
      delete process.env.ORCA_CODEX_PATH;
      const defaultSession = await createCodexSession(process.cwd());
      await defaultSession.disconnect();

      process.env.ORCA_CODEX_PATH = "/tmp/custom-codex";
      const overriddenSession = await createCodexSession(process.cwd());
      await overriddenSession.disconnect();

      expect(constructedOptions[0]?.codexPath).toBeTruthy();
      expect(constructedOptions[1]?.codexPath).toBe("/tmp/custom-codex");
    } finally {
      if (originalCodexPath === undefined) {
        delete process.env.ORCA_CODEX_PATH;
      } else {
        process.env.ORCA_CODEX_PATH = originalCodexPath;
      }
    }
  });

  test("passes configured effort into Codex runTurn", async () => {
    const runTurnMock = mock(async () => ({
      agentMessage: "[]",
      turn: { status: "completed" },
      items: [],
    }));

    mockMultiAgentDetection(false);
    mock.module("@ratley/codex-client", () => ({
      CodexClient: class {
        async connect(): Promise<void> {}
        async disconnect(): Promise<void> {}
        async startThread(): Promise<{ id: string }> {
          return { id: "thread-1" };
        }
        runTurn = runTurnMock;
        async runReview(): Promise<{ reviewText: string }> {
          return { reviewText: "ok" };
        }
      },
    }));

    mock.module("../../utils/skill-loader.js", () => ({
      loadSkills: async () => [],
    }));

    const { createCodexSession } = await import(`./session.ts?test=${Math.random()}`);
    const session = await createCodexSession(process.cwd(), { codex: { effort: "medium" } });

    try {
      await session.planSpec("spec", "context");
      expect(runTurnMock).toHaveBeenCalled();
      expect((runTurnMock.mock.calls as Array<Array<{ effort?: string }>>)[0]?.[0]?.effort).toBe("medium");
    } finally {
      await session.disconnect();
    }
  });

  test("smoke: uses per-step thinkingLevel values for decision/planning/review/execution turns", async () => {
    const efforts: string[] = [];
    const runTurnMock = mock(async (params: { effort?: string; input?: Array<{ text?: string }> }) => {
      efforts.push(params.effort ?? "");
      const prompt = params.input?.[0]?.text ?? "";
      if (prompt.includes("planning gate")) {
        return {
          agentMessage: '{"needsPlan":true,"reason":"multi-step"}',
          turn: { status: "completed" },
          items: [],
        };
      }

      if (prompt.includes("pre-execution task-graph reviewer")) {
        return {
          agentMessage: '{"changes":[]}',
          turn: { status: "completed" },
          items: [],
        };
      }

      if (prompt.includes("Review this Orca task graph before execution.")) {
        return {
          agentMessage: '{"issues":[],"ok":true}',
          turn: { status: "completed" },
          items: [],
        };
      }

      return {
        agentMessage: "[]",
        turn: { status: "completed" },
        items: [],
      };
    });

    mockMultiAgentDetection(false);
    mock.module("@ratley/codex-client", () => ({
      CodexClient: class {
        async connect(): Promise<void> {}
        async disconnect(): Promise<void> {}
        async startThread(): Promise<{ id: string }> {
          return { id: "thread-1" };
        }
        runTurn = runTurnMock;
        async runReview(): Promise<{ reviewText: string }> {
          return { reviewText: "ok" };
        }
      },
    }));

    mock.module("../../utils/skill-loader.js", () => ({
      loadSkills: async () => [],
    }));

    const { createCodexSession } = await import(`./session.ts?test=${Math.random()}`);
    const session = await createCodexSession(process.cwd(), {
      codex: {
        thinkingLevel: {
          decision: "low",
          planning: "xhigh",
          review: "high",
          execution: "medium",
        },
      },
    });

    try {
      await session.decidePlanningNeed("spec", "context");
      await session.planSpec("spec", "context");
      await session.reviewTaskGraph([], "context");
      await session.executeTask(
        {
          id: "t1",
          name: "Task",
          description: "Do thing",
          dependencies: [],
          acceptance_criteria: ["Done"],
          status: "pending",
          retries: 0,
          maxRetries: 3,
        },
        "run-1",
        "context",
      );
      await session.consultTaskGraph([]);
      await session.runPrompt("review prompt", "review");

      expect(efforts).toEqual(["low", "xhigh", "high", "medium", "high", "high"]);
    } finally {
      await session.disconnect();
    }
  });

});

describe("codex session code-simplifier guidance", () => {
  test("includes explicit code-simplifier directives in planning, review, and execution prompts", async () => {
    const prompts: string[] = [];
    const runTurnMock = mock(async (params: { input?: Array<{ text?: string }> }) => {
      const prompt = params.input?.[0]?.text ?? "";
      prompts.push(prompt);

      if (prompt.includes("pre-execution task-graph reviewer")) {
        return {
          agentMessage: '{"changes":[]}',
          turn: { status: "completed" },
          items: []
        };
      }

      return {
        agentMessage: "[]",
        turn: { status: "completed" },
        items: []
      };
    });

    mockMultiAgentDetection(false);
    mock.module("@ratley/codex-client", () => ({
      CodexClient: class {
        async connect(): Promise<void> {}
        async disconnect(): Promise<void> {}
        async startThread(): Promise<{ id: string }> {
          return { id: "thread-1" };
        }
        runTurn = runTurnMock;
        async runReview(): Promise<{ reviewText: string }> {
          return { reviewText: "ok" };
        }
      }
    }));

    mock.module("../../utils/skill-loader.js", () => ({
      loadSkills: async () => [],
    }));

    const { createCodexSession } = await import(`./session.ts?test=${Math.random()}`);
    const session = await createCodexSession(process.cwd());

    try {
      await session.planSpec("spec", "context");
      await session.reviewTaskGraph([], "context");
      await session.executeTask(
        {
          id: "t1",
          name: "Task",
          description: "Do thing",
          dependencies: [],
          acceptance_criteria: ["Done"],
          status: "pending",
          retries: 0,
          maxRetries: 3
        },
        "run-1",
        "context"
      );

      expect(prompts).toHaveLength(3);
      for (const prompt of prompts) {
        expect(prompt).toContain("For every code-writing step, explicitly apply code-simplifier guidance");
        expect(prompt).toContain("For every code-review step, explicitly apply code-simplifier guidance");
        expect(prompt).toContain("Keep changes behavior-preserving unless the task explicitly requires behavior changes.");
      }
    } finally {
      await session.disconnect();
    }
  });
});

describe("codex session multi-agent prompt guidance", () => {
  test("includes multi-agent guidance in planning, review, consultation, and execution prompts when active", async () => {
    const prompts: string[] = [];
    const runTurnMock = mock(async (params: { input?: Array<{ text?: string }> }) => {
      const prompt = params.input?.[0]?.text ?? "";
      prompts.push(prompt);

      if (prompt.includes("pre-execution task-graph reviewer")) {
        return {
          agentMessage: '{"changes":[]}',
          turn: { status: "completed" },
          items: [],
        };
      }

      if (prompt.includes("Review this Orca task graph before execution.")) {
        return {
          agentMessage: '{"issues":[],"ok":true}',
          turn: { status: "completed" },
          items: [],
        };
      }

      return {
        agentMessage: "[]",
        turn: { status: "completed" },
        items: [],
      };
    });

    mockMultiAgentDetection(true);
    mock.module("@ratley/codex-client", () => ({
      CodexClient: class {
        async connect(): Promise<void> {}
        async disconnect(): Promise<void> {}
        async startThread(): Promise<{ id: string }> {
          return { id: "thread-1" };
        }
        runTurn = runTurnMock;
        async runReview(): Promise<{ reviewText: string }> {
          return { reviewText: "ok" };
        }
      },
    }));

    mock.module("../../utils/skill-loader.js", () => ({
      loadSkills: async () => [],
    }));

    const { createCodexSession } = await import(`./session.ts?test=${Math.random()}`);
    const session = await createCodexSession(process.cwd());

    try {
      await session.planSpec("spec", "context");
      await session.reviewTaskGraph([], "context");
      await session.consultTaskGraph([]);
      await session.executeTask(
        {
          id: "t1",
          name: "Task",
          description: "Do thing",
          dependencies: [],
          acceptance_criteria: ["Done"],
          status: "pending",
          retries: 0,
          maxRetries: 3,
        },
        "run-1",
        "context",
      );

      const planningPrompt = prompts.find((prompt) => prompt.includes("You are decomposing a spec into an ordered task graph.")) ?? "";
      const reviewPrompt = prompts.find((prompt) => prompt.includes("You are Orca's pre-execution task-graph reviewer.")) ?? "";
      const consultationPrompt = prompts.find((prompt) => prompt.includes("Review this Orca task graph before execution.")) ?? "";
      const executionPrompt = prompts.find((prompt) => prompt.includes("You are Orca's task execution assistant.")) ?? "";

      expect(planningPrompt).toContain("Codex multi-agent mode is enabled for this run. Shape the task graph so safe subagent parallelization is obvious.");
      expect(planningPrompt).toContain("Do not bundle unrelated work into a single do-everything task when it can be safely split.");

      expect(reviewPrompt).toContain("Codex multi-agent mode is enabled for this run. Review the graph for safe subagent parallelization.");
      expect(reviewPrompt).toContain("Flag ownership collisions where multiple tasks would touch the same files or subsystem without coordination.");

      expect(consultationPrompt).toContain("Codex multi-agent mode is enabled for this run.");
      expect(consultationPrompt).toContain("Treat missed safe parallelism, fake dependencies, overlapping ownership, or missing integration tasks as review concerns.");

      expect(executionPrompt).toContain("Codex multi-agent mode is enabled for this run.");
      expect(executionPrompt).toContain("If this task contains clearly independent subtasks with disjoint ownership, use subagents to parallelize them.");
      expect(executionPrompt).toContain("Integrate subagent results yourself before final completion.");
    } finally {
      await session.disconnect();
    }
  });

  test("omits multi-agent guidance from planning, review, consultation, and execution prompts when inactive", async () => {
    const prompts: string[] = [];
    const runTurnMock = mock(async (params: { input?: Array<{ text?: string }> }) => {
      const prompt = params.input?.[0]?.text ?? "";
      prompts.push(prompt);

      if (prompt.includes("pre-execution task-graph reviewer")) {
        return {
          agentMessage: '{"changes":[]}',
          turn: { status: "completed" },
          items: [],
        };
      }

      if (prompt.includes("Review this Orca task graph before execution.")) {
        return {
          agentMessage: '{"issues":[],"ok":true}',
          turn: { status: "completed" },
          items: [],
        };
      }

      return {
        agentMessage: "[]",
        turn: { status: "completed" },
        items: [],
      };
    });

    mockMultiAgentDetection(false);
    mock.module("@ratley/codex-client", () => ({
      CodexClient: class {
        async connect(): Promise<void> {}
        async disconnect(): Promise<void> {}
        async startThread(): Promise<{ id: string }> {
          return { id: "thread-1" };
        }
        runTurn = runTurnMock;
        async runReview(): Promise<{ reviewText: string }> {
          return { reviewText: "ok" };
        }
      },
    }));

    mock.module("../../utils/skill-loader.js", () => ({
      loadSkills: async () => [],
    }));

    const { createCodexSession } = await import(`./session.ts?test=${Math.random()}`);
    const session = await createCodexSession(process.cwd());

    try {
      await session.planSpec("spec", "context");
      await session.reviewTaskGraph([], "context");
      await session.consultTaskGraph([]);
      await session.executeTask(
        {
          id: "t1",
          name: "Task",
          description: "Do thing",
          dependencies: [],
          acceptance_criteria: ["Done"],
          status: "pending",
          retries: 0,
          maxRetries: 3,
        },
        "run-1",
        "context",
      );

      for (const prompt of prompts) {
        expect(prompt).not.toContain("Codex multi-agent mode is enabled for this run.");
        expect(prompt).not.toContain("use subagents to parallelize them");
        expect(prompt).not.toContain("safe subagent parallelization");
      }
    } finally {
      await session.disconnect();
    }
  });
});

describe("codex session skill discovery", () => {
  test("calls skills/list with forceReload and perCwdExtraUserRoots", async () => {
    const requestMock = mock(async () => ({ data: [] }));

    mockMultiAgentDetection(false);
    mock.module("@ratley/codex-client", () => ({
      CodexClient: class {
        async connect(): Promise<void> {}
        async disconnect(): Promise<void> {}
        async startThread(): Promise<{ id: string }> {
          return { id: "thread-1" };
        }
        async runTurn(): Promise<{ agentMessage: string; turn: { status: "completed" }; items: [] }> {
          return { agentMessage: "[]", turn: { status: "completed" }, items: [] };
        }
        request = requestMock;
        async runReview(): Promise<{ reviewText: string }> {
          return { reviewText: "ok" };
        }
      },
    }));

    mock.module("../../utils/skill-loader.js", () => ({
      loadSkills: async () => [],
    }));

    const { createCodexSession } = await import(`./session.ts?test=${Math.random()}`);
    const cwd = process.cwd();
    const session = await createCodexSession(cwd, {
      codex: {
        perCwdExtraUserRoots: [{ cwd, extraUserRoots: ["/tmp/extra-skills"] }],
      },
    });

    try {
      expect(requestMock).toHaveBeenCalledWith("skills/list", {
        cwds: [cwd],
        forceReload: true,
        perCwdExtraUserRoots: [{ cwd, extraUserRoots: ["/tmp/extra-skills"] }],
      });
    } finally {
      await session.disconnect();
    }
  });

  test("merges app-server listed skills after Orca-loaded skills without overriding deterministic precedence", async () => {
    type TurnInputItem = { type: "text"; text: string };

    let capturedInput: TurnInputItem[] = [];
    const listedSkillsRoot = await mkdtemp(path.join(os.tmpdir(), "orca-listed-skills-"));
    const alphaSkillPath = path.join(listedSkillsRoot, "alpha-skill", "SKILL.md");
    const codeSimplifierPath = path.join(listedSkillsRoot, "code-simplifier", "SKILL.md");
    const zetaSkillPath = path.join(listedSkillsRoot, "zeta-skill", "SKILL.md");

    await mkdir(path.dirname(alphaSkillPath), { recursive: true });
    await mkdir(path.dirname(codeSimplifierPath), { recursive: true });
    await mkdir(path.dirname(zetaSkillPath), { recursive: true });
    await writeFile(alphaSkillPath, "alpha body", "utf8");
    await writeFile(codeSimplifierPath, "server code simplifier body", "utf8");
    await writeFile(zetaSkillPath, "zeta body", "utf8");

    mockMultiAgentDetection(false);
    mock.module("@ratley/codex-client", () => ({
      CodexClient: class {
        async connect(): Promise<void> {}
        async disconnect(): Promise<void> {}
        async startThread(): Promise<{ id: string }> {
          return { id: "thread-1" };
        }
        async runTurn(params: { input?: TurnInputItem[] }): Promise<{ agentMessage: string; turn: { status: "completed" }; items: [] }> {
          capturedInput = params.input ?? [];
          return { agentMessage: "[]", turn: { status: "completed" }, items: [] };
        }
        async request(): Promise<{ data: Array<{ skills: Array<{ name: string; path: string }> }> }> {
          return {
            data: [
              {
                skills: [
                  { name: "zeta-skill", path: zetaSkillPath },
                  { name: "code-simplifier", path: codeSimplifierPath },
                  { name: "alpha-skill", path: alphaSkillPath },
                ],
              },
            ],
          };
        }
        async runReview(): Promise<{ reviewText: string }> {
          return { reviewText: "ok" };
        }
      },
    }));

    mock.module("../../utils/skill-loader.js", () => ({
      loadSkills: async () => [
        {
          name: "code-simplifier",
          description: "desc",
          body: "body",
          dirPath: "/tmp/skills/code-simplifier",
          filePath: "/tmp/skills/code-simplifier/SKILL.md",
        },
      ],
    }));

    const { createCodexSession } = await import(`./session.ts?test=${Math.random()}`);
    const session = await createCodexSession(process.cwd());

    try {
      await session.planSpec("spec", "context");

      const prompt = capturedInput[0]?.text ?? "";
      expect(prompt).toContain("Referenced Orca skills:");
      expect(prompt).toContain("Skill: code-simplifier");
      expect(prompt).toContain("Skill: alpha-skill");
      expect(prompt).toContain("Skill: zeta-skill");
      expect(prompt).toContain("body");
      expect(prompt).toContain("alpha body");
      expect(prompt).toContain("zeta body");
      expect(prompt).not.toContain("server code simplifier body");
    } finally {
      await session.disconnect();
    }
  });
});

describe("codex session inline skill context", () => {
  test("disconnects Codex client if skill loading fails during session creation", async () => {
    const disconnectMock = mock(async () => {});

    mockMultiAgentDetection(false);
    mock.module("@ratley/codex-client", () => ({
      CodexClient: class {
        async connect(): Promise<void> {}
        disconnect = disconnectMock;
        async startThread(): Promise<{ id: string }> {
          return { id: "thread-1" };
        }
        async runTurn(): Promise<never> {
          throw new Error("not used");
        }
        async runReview(): Promise<{ reviewText: string }> {
          return { reviewText: "ok" };
        }
      },
    }));

    mock.module("../../utils/skill-loader.js", () => ({
      loadSkills: async () => {
        throw new Error("load failed");
      },
    }));

    const { createCodexSession } = await import(`./session.ts?test=${Math.random()}`);

    await expect(createCodexSession(process.cwd())).rejects.toThrow("load failed");
    expect(disconnectMock).toHaveBeenCalledTimes(1);
  });

  test("includes inline skill context inside the text input for every runTurn", async () => {
    type TurnInputItem = { type: "text"; text: string };

    const runTurnCalls: Array<{ input?: TurnInputItem[] }> = [];
    const runTurnMock = mock(async (params: { input?: TurnInputItem[] }) => {
      runTurnCalls.push(params);
      const prompt = params.input?.find((item) => item.type === "text")?.text ?? "";

      if (prompt.includes("pre-execution task-graph reviewer")) {
        return {
          agentMessage: '{"changes":[]}',
          turn: { status: "completed" },
          items: []
        };
      }

      if (prompt.includes('"issues": [...], "ok": boolean')) {
        return {
          agentMessage: '{"issues":[],"ok":true}',
          turn: { status: "completed" },
          items: []
        };
      }

      return {
        agentMessage: "[]",
        turn: { status: "completed" },
        items: []
      };
    });

    mockMultiAgentDetection(false);
    mock.module("@ratley/codex-client", () => ({
      CodexClient: class {
        async connect(): Promise<void> {}
        async disconnect(): Promise<void> {}
        async startThread(): Promise<{ id: string }> {
          return { id: "thread-1" };
        }
        runTurn = runTurnMock;
        async runReview(): Promise<{ reviewText: string }> {
          return { reviewText: "ok" };
        }
      },
    }));

    mock.module("../../utils/skill-loader.js", () => ({
      loadSkills: async () => [
        {
          name: "code-simplifier",
          description: "desc",
          body: "body",
          dirPath: "/tmp/skills/code-simplifier",
          filePath: "/tmp/skills/code-simplifier/SKILL.md",
        },
      ],
    }));

    const { createCodexSession } = await import(`./session.ts?test=${Math.random()}`);
    const session = await createCodexSession(process.cwd());

    try {
      await session.planSpec("spec", "context");
      await session.reviewTaskGraph([], "context");
      await session.executeTask(
        {
          id: "t1",
          name: "Task",
          description: "Do thing",
          dependencies: [],
          acceptance_criteria: ["Done"],
          status: "pending",
          retries: 0,
          maxRetries: 3,
        },
        "run-1",
        "context",
      );
      await session.consultTaskGraph([]);
      await session.runPrompt("hello");

      expect(runTurnCalls.length).toBe(5);

      for (const call of runTurnCalls) {
        expect(call.input).toHaveLength(1);

        const text = call.input?.[0]?.text ?? "";
        expect(text).toBeTruthy();
        expect(text).toContain("Referenced Orca skills:");
        expect(text).toContain("Skill: code-simplifier");
        expect(text).toContain("Source: /tmp/skills/code-simplifier/SKILL.md");
        expect(text).toContain("body");
      }
    } finally {
      await session.disconnect();
    }
  });
});

describe("codex session question flow", () => {
  test("persists pending questions, emits onQuestion, and resumes the same run after an answer", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "orca-question-flow-"));
    const store = new RunStore(path.join(tempDir, "runs"));
    const runId = "run-1000-abcd";
    await store.createRun(runId, "/tmp/spec.md");
    await store.updateRun(runId, { mode: "run", overallStatus: "running" });

    const hookEvents: Array<{ hook: string; message: string; taskId?: string; questions?: Array<{ id: string }> }> = [];
    const responses: Array<{ requestId: string | number; response: unknown }> = [];
    let resolveAnswerResponse: (() => void) | undefined;
    const answerResponse = new Promise<void>((resolve) => {
      resolveAnswerResponse = resolve;
    });
    let clientInstance: EventEmitter | null = null;

    try {
      mockMultiAgentDetection(false);
      mock.module("@ratley/codex-client", () => ({
        CodexClient: class extends EventEmitter {
          constructor() {
            super();
            clientInstance = this;
          }

          async connect(): Promise<void> {}
          async disconnect(): Promise<void> {}
          async startThread(): Promise<{ id: string }> {
            return { id: "thread-1" };
          }
          async runReview(): Promise<{ reviewText: string }> {
            return { reviewText: "ok" };
          }
          respondToUserInputRequest(requestId: string | number, response: unknown): void {
            responses.push({ requestId, response });
            resolveAnswerResponse?.();
          }
          rejectServerRequest(): void {}
          async runTurn(): Promise<{ agentMessage: string; turn: { status: "completed" }; items: [] }> {
            queueMicrotask(() => {
              clientInstance?.emit("request:userInput", {
                requestId: "req-1",
                itemId: "item-1",
                threadId: "thread-1",
                turnId: "turn-1",
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
              });
            });

            await answerResponse;
            clientInstance?.emit("serverRequest:resolved", { requestId: "req-1" });

            return {
              agentMessage: '{"outcome":"done"}',
              turn: { status: "completed" },
              items: [],
            };
          }
        },
      }));

      mock.module("../../utils/skill-loader.js", () => ({
        loadSkills: async () => [],
      }));

      const { createCodexSession } = await import(`./session.ts?test=${Math.random()}`);
      const session = await createCodexSession(process.cwd(), undefined, {
        runId: runId as `${string}-${number}-${string}`,
        store,
        emitHook: async (event) => {
          hookEvents.push({
            hook: event.hook,
            message: event.message,
            ...(event.taskId ? { taskId: event.taskId } : {}),
            ...("questions" in event ? { questions: event.questions.map((question) => ({ id: question.id })) } : {}),
          });
        },
      });

      try {
        const executionPromise = session.executeTask(
          {
            id: "task-1",
            name: "Build the game",
            description: "Implement the requested game.",
            dependencies: [],
            acceptance_criteria: ["Game is implemented"],
            status: "pending",
            retries: 0,
            maxRetries: 3,
          },
          runId,
          "context",
        );

        const waitingRun = await waitFor(async () => {
          const run = await store.getRun(runId);
          return run?.pendingQuestion ? run : null;
        });

        expect(waitingRun.overallStatus).toBe("waiting_for_answer");
        expect(waitingRun.pendingQuestion?.requestId).toBe("req-1");
        expect(waitingRun.pendingQuestion?.questions[0]?.id).toBe("game_type");
        expect(hookEvents).toContainEqual({
          hook: "onQuestion",
          message: "Which game type should I build?",
          taskId: "task-1",
          questions: [{ id: "game_type" }],
        });

        const answerPath = path.join(store.getRunDir(runId), "answer.txt");
        await writeFile(
          answerPath,
          `${JSON.stringify({ answers: { game_type: { answers: ["Arcade"] } } })}\n`,
          "utf8",
        );

        const result = await executionPromise;
        expect(result.outcome).toBe("done");
        expect(responses).toEqual([
          {
            requestId: "req-1",
            response: {
              answers: {
                game_type: {
                  answers: ["Arcade"],
                },
              },
            },
          },
        ]);

        const resumedRun = await waitFor(async () => {
          const run = await store.getRun(runId);
          return run && run.pendingQuestion === undefined ? run : null;
        });
        expect(resumedRun.overallStatus).toBe("running");
        await expect(readFile(answerPath, "utf8")).rejects.toThrow();
      } finally {
        await session.disconnect();
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
