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

  test("executeTask respects an assistant failure marker even when turn status is completed", async () => {
    const runTurnMock = mock(async () => ({
      agentMessage: '{"outcome":"failed","error":"missing dependency"}',
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
    const session = await createCodexSession(process.cwd());

    try {
      const result = await session.executeTask(
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

      expect(result).toEqual({
        outcome: "failed",
        error: "missing dependency",
        rawResponse: '{"outcome":"failed","error":"missing dependency"}',
      });
    } finally {
      await session.disconnect();
    }
  });

  test("falls back to completed turn items when streamed agentMessage text is missing", async () => {
    const runTurnMock = mock(async () => ({
      agentMessage: "",
      turn: {
        status: "completed",
        items: [
          {
            type: "agentMessage",
            id: "msg-1",
            text: '{"outcome":"done"}',
          },
        ],
      },
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
    const session = await createCodexSession(process.cwd());

    try {
      const result = await session.executeTask(
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

      expect(result).toEqual({
        outcome: "done",
        rawResponse: '{"outcome":"done"}',
      });
    } finally {
      await session.disconnect();
    }
  });

  test("starts a fresh Codex thread before executing each task", async () => {
    const startThreadMock = mock(async () => ({ id: `thread-${startThreadMock.mock.calls.length + 1}` }));
    const runTurnMock = mock(async () => {
      if (runTurnMock.mock.calls.length === 1) {
        return {
          agentMessage: "[]",
          turn: { status: "completed", items: [] },
          items: [],
        };
      }

      return {
        agentMessage: '{"outcome":"done"}',
        turn: { status: "completed", items: [] },
        items: [],
      };
    });

    mockMultiAgentDetection(false);
    mock.module("@ratley/codex-client", () => ({
      CodexClient: class {
        async connect(): Promise<void> {}
        async disconnect(): Promise<void> {}
        startThread = startThreadMock;
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
      const initialThreadId = session.threadId;
      await session.planSpec("spec", "context");
      await session.executeTask(
        {
          id: "t1",
          name: "Task",
          description: "Update index.ts and run tests",
          dependencies: [],
          acceptance_criteria: ["Done"],
          status: "pending",
          retries: 0,
          maxRetries: 3,
        },
        "run-1",
        "context",
      );

      expect(startThreadMock).toHaveBeenCalledTimes(2);
      const executeCall = (runTurnMock.mock.calls as Array<Array<{ threadId?: string }>>)[1]?.[0];
      expect(executeCall?.threadId).toBe(session.threadId);
      expect(session.threadId).not.toBe(initialThreadId);
    } finally {
      await session.disconnect();
    }
  });

  test("fails fallback success for file-edit tasks when no file changes were recorded", async () => {
    const runTurnMock = mock(async () => ({
      agentMessage: "Implemented the requested update.",
      turn: {
        status: "completed",
        items: [
          {
            type: "agentMessage",
            id: "msg-1",
            text: "Implemented the requested update.",
          },
        ],
      },
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
    const session = await createCodexSession(process.cwd());

    try {
      const result = await session.executeTask(
        {
          id: "t1",
          name: "Write file",
          description: "Create codename.txt with the exact answer.",
          dependencies: [],
          acceptance_criteria: ["codename.txt exists"],
          status: "pending",
          retries: 0,
          maxRetries: 3,
        },
        "run-1",
        "context",
      );

      expect(result).toEqual({
        outcome: "failed",
        rawResponse: "Implemented the requested update.",
        error: "Codex did not emit a JSON completion marker and no file changes were recorded for a task that required file edits.",
      });
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

      if (prompt.includes("execution clarification gate")) {
        return {
          agentMessage: '{"needsInput":false,"context":"No extra clarification needed."}',
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
    const runsDir = await mkdtemp(path.join(os.tmpdir(), "orca-session-multi-agent-active-"));
    const store = new RunStore(runsDir);
    const runId = "multi-agent-active-run-1000-abcd";
    await store.createRun(runId, "/tmp/spec.md");
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

      if (prompt.includes("execution clarification gate")) {
        return {
          agentMessage: '{"needsInput":false,"context":"No extra clarification needed."}',
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
    const session = await createCodexSession(process.cwd(), undefined, {
      runId,
      store,
      resumeOverallStatus: "running",
    });

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

      expect(consultationPrompt).toContain("Execution tasks are allowed to pause and ask request_user_input questions when they truly need a user-provided value.");
      expect(consultationPrompt).toContain("Do not ask the user whether Orca may pause during execution for clarification. Assume that execution-time request_user_input is available.");
      expect(consultationPrompt).toContain("If a task already says it should ask for a missing user value during execution, treat that as a valid execution mechanism, not a reason to ask a meta-question about whether clarification is allowed.");
      expect(consultationPrompt).toContain("Codex multi-agent mode is enabled for this run.");
      expect(consultationPrompt).toContain("Treat missed safe parallelism, fake dependencies, overlapping ownership, or missing integration tasks as review concerns.");

      expect(executionPrompt).toContain("Codex multi-agent mode is enabled for this run.");
      expect(executionPrompt).toContain("If this task contains clearly independent subtasks with disjoint ownership, use subagents to parallelize them.");
      expect(executionPrompt).toContain("Integrate subagent results yourself before final completion.");
    } finally {
      await session.disconnect();
      await rm(runsDir, { recursive: true, force: true });
    }
  });

  test("omits multi-agent guidance from planning, review, consultation, and execution prompts when inactive", async () => {
    const prompts: string[] = [];
    const runsDir = await mkdtemp(path.join(os.tmpdir(), "orca-session-multi-agent-inactive-"));
    const store = new RunStore(runsDir);
    const runId = "multi-agent-inactive-run-1000-abcd";
    await store.createRun(runId, "/tmp/spec.md");
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

      if (prompt.includes("execution clarification gate")) {
        return {
          agentMessage: '{"needsInput":false,"context":"No extra clarification needed."}',
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
    const session = await createCodexSession(process.cwd(), undefined, {
      runId,
      store,
      resumeOverallStatus: "running",
    });

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
        if (prompt.includes("Review this Orca task graph before execution.")) {
          expect(prompt).toContain("Execution tasks are allowed to pause and ask request_user_input questions when they truly need a user-provided value.");
          expect(prompt).toContain("Do not ask the user whether Orca may pause during execution for clarification. Assume that execution-time request_user_input is available.");
        }
        expect(prompt).not.toContain("Codex multi-agent mode is enabled for this run.");
        expect(prompt).not.toContain("use subagents to parallelize them");
        expect(prompt).not.toContain("safe subagent parallelization");
      }
    } finally {
      await session.disconnect();
      await rm(runsDir, { recursive: true, force: true });
    }
  });

  test("uses a clarification turn before interactive execution", async () => {
    type TurnInputItem = { type: "text"; text: string };

    const runTurnCalls: Array<{
      collaborationMode?: {
        mode?: string;
        settings?: {
          model?: string | null;
          reasoning_effort?: string | null;
          developer_instructions?: string | null;
        };
      };
      input?: TurnInputItem[];
    }> = [];
    const runsDir = await mkdtemp(path.join(os.tmpdir(), "orca-session-interactive-"));
    const store = new RunStore(runsDir);
    const runId = "interactive-run-1000-abcd";
    await store.createRun(runId, "/tmp/spec.md");

    mockMultiAgentDetection(false);
    mock.module("@ratley/codex-client", () => ({
      CodexClient: class {
        async connect(): Promise<void> {}
        async disconnect(): Promise<void> {}
        async startThread(): Promise<{ id: string }> {
          return { id: "thread-1" };
        }
        async runTurn(params: {
          collaborationMode?: {
            mode?: string;
            settings?: {
              model?: string | null;
              reasoning_effort?: string | null;
              developer_instructions?: string | null;
            };
          };
          input?: TurnInputItem[];
        }): Promise<{ agentMessage: string; turn: { status: "completed" }; items: [] }> {
          runTurnCalls.push(params);
          const prompt = params.input?.[0]?.text ?? "";
          if (prompt.includes("decomposing a spec")) {
            return { agentMessage: "[]", turn: { status: "completed" }, items: [] };
          }

          if (prompt.includes("execution clarification gate")) {
            return {
              agentMessage: '{"needsInput":true,"context":"Use the user-provided release codename when updating files."}',
              turn: { status: "completed" },
              items: [],
            };
          }

          return { agentMessage: '{"outcome":"done"}', turn: { status: "completed" }, items: [] };
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
    const session = await createCodexSession(process.cwd(), undefined, {
      runId: runId as `${string}-${number}-${string}`,
      store,
      resumeOverallStatus: "running",
    });

    try {
      await session.planSpec("spec", "context");
      await session.executeTask(
        {
          id: "T1",
          name: "Collect Release Codename",
          description: "Ask the user which release codename to use.",
          dependencies: [],
          acceptance_criteria: ["Ask exactly one clarification question and use the answer."],
          status: "pending",
          retries: 0,
          maxRetries: 3,
        },
        runId,
        "context",
      );

      const planningCall = runTurnCalls[0];
      const clarificationCall = runTurnCalls[1];
      const executionCall = runTurnCalls[2];
      expect(planningCall?.collaborationMode).toEqual({
        mode: "plan",
        settings: {
          model: "gpt-5.3-codex",
          reasoning_effort: "high",
          developer_instructions: null,
        },
      });
      expect(clarificationCall?.collaborationMode).toEqual({
        mode: "plan",
        settings: {
          model: "gpt-5.3-codex",
          reasoning_effort: "medium",
          developer_instructions: null,
        },
      });
      expect(executionCall?.collaborationMode).toBeUndefined();

      const clarificationPrompt = clarificationCall?.input?.[0]?.text ?? "";
      expect(clarificationPrompt).toContain("You are Orca's execution clarification gate.");
      expect(clarificationPrompt).toContain("use Codex's request_user_input tool instead of guessing, failing, or baking the question into a later task");

      const executionPrompt = executionCall?.input?.[0]?.text ?? "";
      expect(executionPrompt).toContain("Resolved Clarification Context:");
      expect(executionPrompt).toContain("Use the user-provided release codename when updating files.");
      expect(executionPrompt).not.toContain("request_user_input");
    } finally {
      await session.disconnect();
      await rm(runsDir, { recursive: true, force: true });
    }
  });

  test("runs a non-mutating clarification pass before ordinary interactive execution", async () => {
    type TurnInputItem = { type: "text"; text: string };

    const runTurnCalls: Array<{ collaborationMode?: { mode?: string }; input?: TurnInputItem[] }> = [];
    const runsDir = await mkdtemp(path.join(os.tmpdir(), "orca-session-default-exec-"));
    const store = new RunStore(runsDir);
    const runId = "default-exec-1000-abcd";
    await store.createRun(runId, "/tmp/spec.md");

    mockMultiAgentDetection(false);
    mock.module("@ratley/codex-client", () => ({
      CodexClient: class {
        async connect(): Promise<void> {}
        async disconnect(): Promise<void> {}
        async startThread(): Promise<{ id: string }> {
          return { id: "thread-1" };
        }
        async runTurn(params: {
          collaborationMode?: { mode?: string };
          input?: TurnInputItem[];
        }): Promise<{ agentMessage: string; turn: { status: "completed" }; items: [] }> {
          runTurnCalls.push(params);
          const prompt = params.input?.[0]?.text ?? "";
          if (prompt.includes("execution clarification gate")) {
            return {
              agentMessage: '{"needsInput":false,"context":""}',
              turn: { status: "completed" },
              items: [],
            };
          }
          return { agentMessage: '{"outcome":"done"}', turn: { status: "completed" }, items: [] };
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
    const session = await createCodexSession(process.cwd(), undefined, {
      runId: runId as `${string}-${number}-${string}`,
      store,
      resumeOverallStatus: "running",
    });

    try {
      await session.executeTask(
        {
          id: "T1",
          name: "Add subtract export",
          description: "Add subtract(a, b) and update tests.",
          dependencies: [],
          acceptance_criteria: ["bun test passes"],
          status: "pending",
          retries: 0,
          maxRetries: 3,
        },
        runId,
        "context",
      );

      expect(runTurnCalls[0]?.collaborationMode).toMatchObject({ mode: "plan" });
      expect(runTurnCalls[1]?.collaborationMode).toBeUndefined();

      const clarificationPrompt = runTurnCalls[0]?.input?.[0]?.text ?? "";
      expect(clarificationPrompt).toContain("You are Orca's execution clarification gate.");

      const executionPrompt = runTurnCalls[1]?.input?.[0]?.text ?? "";
      expect(executionPrompt).not.toContain("request_user_input");
    } finally {
      await session.disconnect();
      await rm(runsDir, { recursive: true, force: true });
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

  test("loads real skill bodies from configured perCwdExtraUserRoots even when skills/list omits path", async () => {
    type TurnInputItem = { type: "text"; text: string };

    let capturedInput: TurnInputItem[] = [];
    const sharedRoot = await mkdtemp(path.join(os.tmpdir(), "orca-extra-skill-root-"));
    const skillName = "shared-root-skill";
    const sharedSkillPath = path.join(sharedRoot, ".agents", "skills", skillName, "SKILL.md");
    await mkdir(path.dirname(sharedSkillPath), { recursive: true });
    await writeFile(sharedSkillPath, "Real shared skill workflow body", "utf8");

    try {
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
          async request(): Promise<{
            data: Array<{
              cwd: string;
              skills: Array<{
                name: string;
                description: string;
                enabled: boolean;
                interface: { displayName: string };
                dependencies: { tools: Array<{ type: string; value: string }> };
              }>;
              errors: [];
            }>;
          }> {
            return {
              data: [
                {
                  cwd: process.cwd(),
                  skills: [
                    {
                      name: skillName,
                      description: "Use metadata when path is absent.",
                      enabled: true,
                      interface: { displayName: "Metadata Skill" },
                      dependencies: { tools: [{ type: "env_var", value: "OPENAI_API_KEY" }] },
                    },
                  ],
                  errors: [],
                },
              ],
            };
          }
          async runReview(): Promise<{ reviewText: string }> {
            return { reviewText: "ok" };
          }
        },
      }));

      const { createCodexSession } = await import(`./session.ts?test=${Math.random()}`);
      const session = await createCodexSession(process.cwd(), {
        codex: {
          perCwdExtraUserRoots: [{ cwd: process.cwd(), extraUserRoots: [sharedRoot] }],
        },
      });

      await session.planSpec("spec", "context");

      const prompt = capturedInput[0]?.text ?? "";
      expect(prompt).toContain("Referenced Orca skills:");
      expect(prompt).toContain(`Skill: ${skillName}`);
      expect(prompt).toContain("Real shared skill workflow body");
      expect(prompt).not.toContain("Use metadata when path is absent.");
      await session.disconnect();
    } finally {
      await rm(sharedRoot, { recursive: true, force: true });
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
  test("restores planning status after answering a planning-time clarification", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "orca-question-flow-planning-"));
    const store = new RunStore(path.join(tempDir, "runs"));
    const runId = "run-1000-abcd";
    await store.createRun(runId, "/tmp/spec.md");
    await store.updateRun(runId, { mode: "plan", overallStatus: "planning" });

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
                    header: "Framework",
                    id: "framework",
                    question: "Which framework should I target?",
                    isOther: true,
                    isSecret: false,
                    options: null,
                  },
                ],
              });
            });

            await answerResponse;
            clientInstance?.emit("serverRequest:resolved", { requestId: "req-1" });

            return {
              agentMessage: "[]",
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
        resumeOverallStatus: "planning",
      });

      try {
        const planningPromise = session.planSpec("spec", "context");

        const waitingRun = await waitFor(async () => {
          const run = await store.getRun(runId);
          return run?.pendingQuestion ? run : null;
        });

        expect(waitingRun.overallStatus).toBe("waiting_for_answer");

        const answerPath = path.join(store.getRunDir(runId), "answer.txt");
        await writeFile(
          answerPath,
          `${JSON.stringify({ answers: { framework: { answers: ["bun"] } } })}\n`,
          "utf8",
        );

        await planningPromise;

        const resumedRun = await waitFor(async () => {
          const run = await store.getRun(runId);
          return run && run.pendingQuestion === undefined ? run : null;
        });

        expect(resumedRun.overallStatus).toBe("planning");
        expect(responses).toEqual([
          {
            requestId: "req-1",
            response: {
              answers: {
                framework: {
                  answers: ["bun"],
                },
              },
            },
          },
        ]);
      } finally {
        await session.disconnect();
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

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
          private runTurnCount = 0;
          async runTurn(): Promise<{ agentMessage: string; turn: { status: "completed" }; items: [] }> {
            this.runTurnCount += 1;
            if (this.runTurnCount === 1) {
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
                agentMessage: '{"needsInput":true,"context":"Game type selected by user: Arcade."}',
                turn: { status: "completed" },
                items: [],
              };
            }

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

  test("keeps a run cancelled when cancellation happens while waiting for input", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "orca-question-flow-cancelled-"));
    const store = new RunStore(path.join(tempDir, "runs"));
    const runId = "run-1000-abcd";
    await store.createRun(runId, "/tmp/spec.md");
    await store.updateRun(runId, { mode: "run", overallStatus: "running" });

    const rejectedRequests: Array<{ requestId: string | number; error: { code: number; message: string } }> = [];
    let settleRequest: (() => void) | undefined;
    const requestSettled = new Promise<void>((resolve) => {
      settleRequest = resolve;
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
          respondToUserInputRequest(): void {
            throw new Error("request should be rejected when run is cancelled");
          }
          rejectServerRequest(requestId: string | number, error: { code: number; message: string }): void {
            rejectedRequests.push({ requestId, error });
            settleRequest?.();
          }
          private runTurnCount = 0;
          async runTurn(): Promise<{ agentMessage: string; turn: { status: "completed" }; items: [] }> {
            this.runTurnCount += 1;
            if (this.runTurnCount === 1) {
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

              await requestSettled;

              return {
                agentMessage: '{"needsInput":true,"context":"Game type must come from the user response."}',
                turn: { status: "completed" },
                items: [],
              };
            }

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

        await waitFor(async () => {
          const run = await store.getRun(runId);
          return run?.pendingQuestion ? run : null;
        });

        await store.updateRun(runId, { overallStatus: "cancelled" });

        await executionPromise;

        const cancelledRun = await waitFor(async () => {
          const run = await store.getRun(runId);
          return run && run.pendingQuestion === undefined ? run : null;
        });

        expect(cancelledRun.overallStatus).toBe("cancelled");
        expect(rejectedRequests).toEqual([
          {
            requestId: "req-1",
            error: {
              code: -32603,
              message: `Run ${runId} was cancelled while waiting for input.`,
            },
          },
        ]);
      } finally {
      await session.disconnect();
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("uses a direct answer channel for secret questions and clears it after resume", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "orca-question-flow-secret-"));
    const store = new RunStore(path.join(tempDir, "runs"));
    const runId = "run-1000-abcd";
    await store.createRun(runId, "/tmp/spec.md");
    await store.updateRun(runId, { mode: "run", overallStatus: "running" });

    const responses: Array<{ requestId: string | number; response: unknown }> = [];
    let resolveAnswerResponse: (() => void) | undefined;
    const answerResponse = new Promise<void>((resolve) => {
      resolveAnswerResponse = resolve;
    });
    let clientInstance: EventEmitter | null = null;
    let submitSecretAnswer: ((answer: string) => void) | undefined;

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
          private runTurnCount = 0;
          async runTurn(): Promise<{ agentMessage: string; turn: { status: "completed" }; items: [] }> {
            this.runTurnCount += 1;
            if (this.runTurnCount === 1) {
              queueMicrotask(() => {
                clientInstance?.emit("request:userInput", {
                  requestId: "req-1",
                  itemId: "item-1",
                  threadId: "thread-1",
                  turnId: "turn-1",
                  questions: [
                    {
                      header: "API Key",
                      id: "api_key",
                      question: "Which API key should I use?",
                      isOther: true,
                      isSecret: true,
                      options: null,
                    },
                  ],
                });
              });

              await answerResponse;
              clientInstance?.emit("serverRequest:resolved", { requestId: "req-1" });

              return {
                agentMessage: '{"needsInput":true,"context":"Use the secret API key provided by the user."}',
                turn: { status: "completed" },
                items: [],
              };
            }

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

      const sessionModule = await import(`./session.ts?test=${Math.random()}`);
      sessionModule.setSecretAnswerChannelFactoryForTests(async (requestId) => {
        let queuedAnswer: string | undefined;
        let waitingResolver: ((answer: string) => void) | undefined;

        submitSecretAnswer = (answer: string) => {
          if (waitingResolver) {
            const resolve = waitingResolver;
            waitingResolver = undefined;
            resolve(answer);
            return;
          }

          queuedAnswer = answer;
        };

        return {
          requestId,
          descriptor: {
            transport: "ipc",
            path: "/tmp/orca-test-secret-answer.sock",
            token: "secret-token",
          },
          nextSubmission: async () => {
            if (queuedAnswer !== undefined) {
              const answer = queuedAnswer;
              queuedAnswer = undefined;
              return answer;
            }

            return await new Promise<string>((resolve) => {
              waitingResolver = resolve;
            });
          },
          close: async () => {
            if (waitingResolver) {
              const resolve = waitingResolver;
              waitingResolver = undefined;
              resolve("");
            }
          },
        };
      });
      const session = await sessionModule.createCodexSession(process.cwd(), undefined, {
        runId: runId as `${string}-${number}-${string}`,
        store,
        resumeOverallStatus: "running",
      });

      try {
        const executionPromise = session.executeTask(
          {
            id: "task-1",
            name: "Configure auth",
            description: "Use the provided secret.",
            dependencies: [],
            acceptance_criteria: ["Auth is configured"],
            status: "pending",
            retries: 0,
            maxRetries: 3,
          },
          runId,
          "context",
        );

        const { readSecretAnswerChannel } = await import("../../core/secret-answer-channel.js");

        const waitingRun = await waitFor(async () => {
          const run = await store.getRun(runId);
          return run?.pendingQuestion ? run : null;
        });

        expect(waitingRun.overallStatus).toBe("waiting_for_answer");
        await expect(readSecretAnswerChannel(runId as `${string}-${number}-${string}`)).resolves.toEqual({
          transport: "ipc",
          path: "/tmp/orca-test-secret-answer.sock",
          token: "secret-token",
        });

        submitSecretAnswer?.("super-secret");

        const result = await executionPromise;
        expect(result.outcome).toBe("done");
        expect(responses).toEqual([
          {
            requestId: "req-1",
            response: {
              answers: {
                api_key: {
                  answers: ["super-secret"],
                },
              },
            },
          },
        ]);

        const resumedRun = await waitFor(async () => {
          const run = await store.getRun(runId);
          return run && run.pendingQuestion === undefined ? run : null;
        });

        await expect(readSecretAnswerChannel(runId as `${string}-${number}-${string}`)).resolves.toBeNull();
        expect(resumedRun.overallStatus).toBe("running");
        await expect(readFile(path.join(store.getRunDir(runId), "answer.txt"), "utf8")).rejects.toThrow();
      } finally {
        sessionModule.setSecretAnswerChannelFactoryForTests(null);
        await session.disconnect();
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("stops waiting when app-server resolves a user-input request before any answer is provided", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "orca-question-flow-resolved-"));
    const store = new RunStore(path.join(tempDir, "runs"));
    const runId = "run-1000-abcd";
    await store.createRun(runId, "/tmp/spec.md");
    await store.updateRun(runId, { mode: "run", overallStatus: "running" });

    const responses: Array<{ requestId: string | number; response: unknown }> = [];
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
          }
          rejectServerRequest(): void {}
          private runTurnCount = 0;
          async runTurn(): Promise<{ agentMessage: string; turn: { status: "completed" }; items: [] }> {
            this.runTurnCount += 1;
            if (this.runTurnCount === 1) {
              queueMicrotask(() => {
                clientInstance?.emit("request:userInput", {
                  requestId: "req-1",
                  itemId: "item-1",
                  threadId: "thread-1",
                  turnId: "turn-1",
                  questions: [
                    {
                      header: "Framework",
                      id: "framework",
                      question: "Which framework should I target?",
                      isOther: true,
                      isSecret: false,
                      options: null,
                    },
                  ],
                });
              });

              queueMicrotask(() => {
                setTimeout(() => {
                  clientInstance?.emit("serverRequest:resolved", { requestId: "req-1" });
                }, 20);
              });

              return {
                agentMessage: '{"needsInput":false,"context":""}',
                turn: { status: "completed" },
                items: [],
              };
            }

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
        resumeOverallStatus: "running",
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

        const result = await executionPromise;
        expect(result.outcome).toBe("done");
        expect(responses).toEqual([]);

        const resumedRun = await waitFor(async () => {
          const run = await store.getRun(runId);
          return run && run.pendingQuestion === undefined ? run : null;
        });

        expect(resumedRun.overallStatus).toBe("running");
        await expect(readFile(path.join(store.getRunDir(runId), "answer.txt"), "utf8")).rejects.toThrow();
      } finally {
        await session.disconnect();
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("ignores late user-input requests after the run has already failed", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "orca-question-flow-late-"));
    const store = new RunStore(path.join(tempDir, "runs"));
    const runId = "run-1000-abcd";
    await store.createRun(runId, "/tmp/spec.md");
    await store.updateRun(runId, { mode: "run", overallStatus: "running" });

    const rejectedRequests: Array<{ requestId: string | number; error: { code: number; message: string } }> = [];
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
          rejectServerRequest(requestId: string | number, error: { code: number; message: string }): void {
            rejectedRequests.push({ requestId, error });
          }
          private runTurnCount = 0;
          async runTurn(): Promise<{ agentMessage: string; turn: { status: "completed" }; items: [] }> {
            this.runTurnCount += 1;
            if (this.runTurnCount === 1) {
              await store.updateRun(runId, { overallStatus: "failed" });
              setTimeout(() => {
                clientInstance?.emit("request:userInput", {
                  requestId: "req-late",
                  itemId: "item-1",
                  threadId: "thread-1",
                  turnId: "turn-1",
                  questions: [
                    {
                      header: "Codename",
                      id: "codename",
                      question: "Which codename should I use?",
                      isOther: true,
                      isSecret: false,
                      options: null,
                    },
                  ],
                });
              }, 10);

              return {
                agentMessage: '{"needsInput":false,"context":""}',
                turn: { status: "completed" },
                items: [],
              };
            }

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
        resumeOverallStatus: "running",
      });

      try {
        const result = await session.executeTask(
          {
            id: "task-1",
            name: "Configure release",
            description: "Use the provided codename.",
            dependencies: [],
            acceptance_criteria: ["Release is configured"],
            status: "pending",
            retries: 0,
            maxRetries: 3,
          },
          runId,
          "context",
        );

        expect(result.outcome).toBe("done");

        await waitFor(async () => {
          const run = await store.getRun(runId);
          return rejectedRequests.length > 0 && run ? run : null;
        });

        const run = await store.getRun(runId);
        expect(run?.overallStatus).toBe("failed");
        expect(run?.pendingQuestion).toBeUndefined();
        expect(rejectedRequests).toEqual([
          {
            requestId: "req-late",
            error: {
              code: -32603,
              message: `Run ${runId} is already failed; ignoring late requestUserInput prompt.`,
            },
          },
        ]);
      } finally {
        await session.disconnect();
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
