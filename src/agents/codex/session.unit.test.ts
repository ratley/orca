import { afterEach, describe, expect, mock, test } from "bun:test";

afterEach(() => {
  mock.restore();
});

describe("codex session effort wiring", () => {
  test("passes configured effort into Codex runTurn", async () => {
    const runTurnMock = mock(async () => ({
      agentMessage: "[]",
      turn: { status: "completed" },
      items: [],
    }));

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

describe("codex session explicit skill input", () => {
  test("disconnects Codex client if skill loading fails during session creation", async () => {
    const disconnectMock = mock(async () => {});

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

  test("includes skill items with valid name/path alongside text input for every runTurn", async () => {
    type TurnInputItem = { type: "text"; text: string } | { type: "skill"; name: string; path: string };

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
        const textItem = call.input?.find((item) => item.type === "text");
        expect(textItem?.type).toBe("text");
        expect((textItem as { text?: string } | undefined)?.text).toBeTruthy();

        const skillItems = call.input?.filter((item) => item.type === "skill") ?? [];
        expect(skillItems).toHaveLength(1);
        expect(skillItems[0]).toEqual({
          type: "skill",
          name: "code-simplifier",
          path: "/tmp/skills/code-simplifier",
        });
      }
    } finally {
      await session.disconnect();
    }
  });
});
