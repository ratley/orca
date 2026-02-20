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
