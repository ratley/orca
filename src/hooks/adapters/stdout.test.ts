import { describe, expect, test } from "bun:test";

import type { HookEvent } from "../../types/index.js";
import { createStdoutHookHandler } from "./stdout.js";

describe("createStdoutHookHandler", () => {
  test("logs structured JSON with expected fields", async () => {
    const lines: string[] = [];

    const event: HookEvent = {
      runId: "run-1234-abcd",
      hook: "onTaskComplete",
      message: "task finished",
      timestamp: "2026-02-19T00:00:00.000Z",
      taskId: "t1",
      taskName: "task one",
      metadata: { retries: 1 }
    };

    const handler = createStdoutHookHandler("[test-hook]", (line) => {
      lines.push(line);
    });
    await handler(event, { cwd: process.cwd(), pid: process.pid, invokedAt: new Date().toISOString() });

    expect(lines).toHaveLength(1);

    const payload = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(payload).toEqual({
      prefix: "[test-hook]",
      hook: "onTaskComplete",
      runId: "run-1234-abcd",
      taskId: "t1",
      timestamp: "2026-02-19T00:00:00.000Z",
      message: "task finished",
      error: undefined,
      metadata: { retries: 1 }
    });
  });
});
