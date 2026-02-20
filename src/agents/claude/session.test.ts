import { afterEach, describe, expect, mock, test } from "bun:test";

afterEach(() => {
  mock.restore();
  delete process.env.ORCA_CLAUDE_ALLOW_TEXT_JSON_FALLBACK;
});

describe("claude session structured contract", () => {
  test("accepts valid structured planner payload", async () => {
    const { parseStructuredPlanPayload } = await import(`./session.ts?test=${Math.random()}`);
    const tasks = parseStructuredPlanPayload({
      tasks: [
        {
          id: "t1",
          name: "Create file",
          description: "Create foo.txt",
          dependencies: [],
          acceptance_criteria: ["foo.txt exists"],
          status: "pending",
          retries: 0,
          maxRetries: 3,
        },
      ],
    });

    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.id).toBe("t1");
  });

  test("invalid structured payload hard-fails with actionable schema error", async () => {
    const { parseStructuredPlanPayload } = await import(`./session.ts?test=${Math.random()}`);
    expect(() =>
      parseStructuredPlanPayload({
        tasks: [
          {
            id: 1,
            name: "bad id",
            description: "bad",
            dependencies: [],
            acceptance_criteria: [],
            status: "pending",
            retries: 0,
            maxRetries: 3,
          },
        ],
      }),
    ).toThrow("Claude structured plan payload failed schema validation");
  });

  test("structured task payload rejects done+error combination", async () => {
    const { parseStructuredTaskExecutionPayload } = await import(`./session.ts?test=${Math.random()}`);
    expect(() =>
      parseStructuredTaskExecutionPayload({
        outcome: "done",
        error: "should not exist",
      }),
    ).toThrow("Claude structured task payload failed schema validation");
  });
});

describe("claude session effort wiring", () => {
  test("passes configured effort into Claude query options", async () => {
    const queryMock = mock((_params: { options?: { effortValue?: string } }) => ({
      close() {},
      async *[Symbol.asyncIterator]() {
        yield {
          type: "result",
          subtype: "success",
          result: "ok",
          structured_output: {
            tasks: [
              {
                id: "t1",
                name: "N",
                description: "D",
                dependencies: [],
                acceptance_criteria: ["A"],
                status: "pending",
                retries: 0,
                maxRetries: 3,
              },
            ],
          },
        };
      },
    }));

    mock.module("@anthropic-ai/claude-agent-sdk", () => ({ query: queryMock }));

    const { planSpec } = await import(`./session.ts?test=${Math.random()}`);
    await planSpec("spec", "ctx", { claude: { effort: "max" } });

    expect(queryMock).toHaveBeenCalled();
    expect(queryMock.mock.calls[0]?.[0]?.options?.effortValue).toBe("max");
  });
});

describe("claude session prompt guidance", () => {
  test("includes explicit code-simplifier directives in planning, review, and execution prompts", async () => {
    const prompts: string[] = [];

    const queryMock = mock((params: { prompt?: string }) => {
      const prompt = params.prompt ?? "";
      prompts.push(prompt);

      const structuredOutput = prompt.includes("pre-execution task-graph reviewer")
        ? { changes: [] }
        : prompt.includes("task execution assistant")
          ? { outcome: "done" }
          : {
              tasks: [
                {
                  id: "t1",
                  name: "N",
                  description: "D",
                  dependencies: [],
                  acceptance_criteria: ["A"],
                  status: "pending",
                  retries: 0,
                  maxRetries: 3,
                },
              ],
            };

      return {
        close() {},
        async *[Symbol.asyncIterator]() {
          yield {
            type: "result",
            subtype: "success",
            result: "ok",
            structured_output: structuredOutput,
          };
        },
      };
    });

    mock.module("@anthropic-ai/claude-agent-sdk", () => ({ query: queryMock }));

    const { planSpec, reviewTaskGraph, executeTask } = await import(`./session.ts?test=${Math.random()}`);

    await planSpec("spec", "context");
    await reviewTaskGraph([], "context");
    await executeTask(
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
      undefined,
      "context"
    );

    expect(prompts).toHaveLength(3);
    for (const prompt of prompts) {
      expect(prompt).toContain("For every code-writing step, explicitly apply code-simplifier guidance");
      expect(prompt).toContain("For every code-review step, explicitly apply code-simplifier guidance");
      expect(prompt).toContain("Keep changes behavior-preserving unless the task explicitly requires behavior changes.");
    }
  });
});

describe("claude session structured-output critical path", () => {
  test("markdown-fenced assistant text does not hit text parser when structured output exists", async () => {
    mock.module("@anthropic-ai/claude-agent-sdk", () => ({
      query: () => {
        const messages = [
          {
            type: "assistant",
            message: {
              content: [{ type: "text", text: "```json\n{not-valid-json}\n```" }],
            },
          },
          {
            type: "result",
            subtype: "success",
            result: "ignored",
            structured_output: {
              tasks: [
                {
                  id: "t1",
                  name: "N",
                  description: "D",
                  dependencies: [],
                  acceptance_criteria: ["A"],
                  status: "pending",
                  retries: 0,
                  maxRetries: 3,
                },
              ],
            },
          },
        ];

        return {
          close() {},
          async *[Symbol.asyncIterator]() {
            for (const msg of messages) {
              yield msg;
            }
          },
        };
      },
    }));

    const { planSpec } = await import(`./session.ts?test=${Math.random()}`);
    const result = await planSpec("spec", "ctx");
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]?.id).toBe("t1");
  });

  test("missing structured output hard-fails by default", async () => {
    mock.module("@anthropic-ai/claude-agent-sdk", () => ({
      query: () => ({
        close() {},
        async *[Symbol.asyncIterator]() {
          yield {
            type: "assistant",
            message: {
              content: [{ type: "text", text: '{"tasks":[]}' }],
            },
          };
          yield { type: "result", subtype: "success", result: '{"tasks":[]}' };
        },
      }),
    }));

    const { planSpec } = await import(`./session.ts?test=${Math.random()}`);
    await expect(planSpec("spec", "ctx")).rejects.toThrow("Refusing freeform JSON parsing on critical path");
  });

  test("fallback parser is explicitly gated and still zod-validates", async () => {
    process.env.ORCA_CLAUDE_ALLOW_TEXT_JSON_FALLBACK = "1";

    mock.module("@anthropic-ai/claude-agent-sdk", () => ({
      query: () => ({
        close() {},
        async *[Symbol.asyncIterator]() {
          yield {
            type: "assistant",
            message: {
              content: [
                {
                  type: "text",
                  text: "```json\n{\"tasks\":[{\"id\":123,\"name\":\"bad\",\"description\":\"x\",\"dependencies\":[],\"acceptance_criteria\":[],\"status\":\"pending\",\"retries\":0,\"maxRetries\":3}]}\n```",
                },
              ],
            },
          };
          yield { type: "result", subtype: "success", result: "ignored" };
        },
      }),
    }));

    const { planSpec } = await import(`./session.ts?test=${Math.random()}`);
    await expect(planSpec("spec", "ctx")).rejects.toThrow("Claude plan response failed schema validation");
  });
});
