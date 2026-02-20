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
