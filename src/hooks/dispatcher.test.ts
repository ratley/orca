import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

import type { HookEvent } from "../types/index.js";
import { HookDispatcher } from "./dispatcher.js";

function makeEvent(overrides: Partial<HookEvent> = {}): HookEvent {
  return {
    runId: "run-1000-abcd",
    hook: "onMilestone",
    message: "hook-message",
    timestamp: new Date().toISOString(),
    ...overrides
  };
}

describe("HookDispatcher", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "orca-hook-dispatcher-test-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test("dispatches programmatic handlers in registration order", async () => {
    const calls: string[] = [];
    const dispatcher = new HookDispatcher();

    dispatcher.on("onMilestone", async () => {
      calls.push("first");
    });
    dispatcher.on("onMilestone", async () => {
      calls.push("second");
    });

    await dispatcher.dispatch(makeEvent());

    expect(calls).toEqual(["first", "second"]);
  });

  test("dispatches shell command hooks using ORCA_* environment variables", async () => {
    const outputPath = path.join(tempDir, "hook-output.txt");
    const dispatcher = new HookDispatcher({
      commandHooks: {
        onMilestone: `if [ "{runId}" = "$ORCA_RUN_ID" ]; then printf '%s|%s|%s|%s|%s|%s' "$ORCA_MSG" "$ORCA_RUN_ID" "$ORCA_TASK_ID" "$ORCA_HOOK" "$ORCA_ERROR" "$ORCA_STAGE" > "${outputPath}"; fi`
      }
    });

    await dispatcher.dispatch(
      makeEvent({
        message: "hello $(whoami) && keep-literal",
        taskId: "task-9",
        metadata: { stage: "review" }
      })
    );

    const output = await fs.readFile(outputPath, "utf8");
    expect(output).toBe("hello $(whoami) && keep-literal|run-1000-abcd|task-9|onMilestone||review");
  });

  test("handler error triggers onError", async () => {
    const errors: HookEvent[] = [];
    const dispatcher = new HookDispatcher();

    dispatcher.on("onMilestone", async () => {
      throw new Error("broken handler");
    });

    dispatcher.on("onError", async (event) => {
      errors.push(event);
    });

    await dispatcher.dispatch(makeEvent());

    expect(errors).toHaveLength(1);
    expect(errors[0]?.hook).toBe("onError");
    expect(errors[0]?.error).toContain("broken handler");
  });

  test("onError handler failure does not retrigger onError", async () => {
    let onErrorCalls = 0;
    const dispatcher = new HookDispatcher();

    dispatcher.on("onMilestone", async () => {
      throw new Error("milestone failed");
    });

    dispatcher.on("onError", async () => {
      onErrorCalls += 1;
      throw new Error("onError failed");
    });

    await expect(dispatcher.dispatch(makeEvent())).rejects.toThrow("onError failed");
    expect(onErrorCalls).toBe(1);
  });

  test("timeout triggers onError for slow handler", async () => {
    const errors: HookEvent[] = [];
    const dispatcher = new HookDispatcher({ timeoutMs: 25 });

    dispatcher.on("onMilestone", async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });

    dispatcher.on("onError", async (event) => {
      errors.push(event);
    });

    await dispatcher.dispatch(makeEvent());

    expect(errors).toHaveLength(1);
    expect(errors[0]?.error).toContain("Hook timeout after 25ms");
  });

  test("command hook failure triggers onError command hook", async () => {
    const outputPath = path.join(tempDir, "hook-error-output.txt");
    const dispatcher = new HookDispatcher({
      commandHooks: {
        onMilestone: "exit 1",
        onError: `printf '%s|%s|%s' "$ORCA_MSG" "$ORCA_RUN_ID" "$ORCA_TASK_ID" > "${outputPath}"`
      }
    });

    await dispatcher.dispatch(
      makeEvent({
        taskId: "task-7"
      })
    );

    const output = await fs.readFile(outputPath, "utf8");
    expect(output).toContain("Hook dispatch failed for onMilestone|run-1000-abcd|task-7");
  });
});
