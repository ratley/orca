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
  } as HookEvent;
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

  test("provides deterministic handler context", async () => {
    let observed: { cwd: string; pid: number; invokedAt: string } | undefined;
    const dispatcher = new HookDispatcher();

    dispatcher.on("onMilestone", async (_event, context) => {
      observed = context;
    });

    await dispatcher.dispatch(makeEvent());

    expect(observed?.cwd).toBe(process.cwd());
    expect(observed?.pid).toBe(process.pid);
    expect(typeof observed?.invokedAt).toBe("string");
  });

  test("dispatches shell command hooks via stdin payload JSON", async () => {
    const outputPath = path.join(tempDir, "hook-output.txt");
    const dispatcher = new HookDispatcher({
      commandHooks: {
        onFindings: `node -e 'const fs=require("node:fs"); let input=""; process.stdin.on("data",(d)=>input+=d); process.stdin.on("end",()=>{ const p=JSON.parse(input||"{}"); fs.writeFileSync("${outputPath}", [p.hook,p.message,p.runId,p.taskId,p.metadata?.stage,p.metadata?.findingsCount,p.metadata?.findingsSummary,p.metadata?.cycleIndex,String(process.env.ORCA_HOOK),String(process.env.ORCA_MSG),String(process.env.ORCA_RUN_ID),String(process.env.ORCA_TASK_ID),String(process.env.ORCA_TASK_NAME),String(process.env.ORCA_ERROR)].join("|")); });'`
      }
    });

    await dispatcher.dispatch(
      makeEvent({
        hook: "onFindings",
        message: "hello $(whoami) && keep-literal",
        taskId: "task-9",
        metadata: { stage: "review", findingsCount: 2, findingsSummary: "fix lint", cycleIndex: 1 }
      })
    );

    const output = await fs.readFile(outputPath, "utf8");
    expect(output).toBe("onFindings|hello $(whoami) && keep-literal|run-1000-abcd|task-9|review|2|fix lint|1|undefined|undefined|undefined|undefined|undefined|undefined");
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

  test("onError handler failure does not retrigger onError and does not reject dispatch", async () => {
    let onErrorCalls = 0;
    const dispatcher = new HookDispatcher();

    dispatcher.on("onMilestone", async () => {
      throw new Error("milestone failed");
    });

    dispatcher.on("onError", async () => {
      onErrorCalls += 1;
      throw new Error("onError failed");
    });

    await expect(dispatcher.dispatch(makeEvent())).resolves.toBeUndefined();
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
        onError: `node -e 'const fs=require("node:fs"); let input=""; process.stdin.on("data",(d)=>input+=d); process.stdin.on("end",()=>{ const p=JSON.parse(input||"{}"); fs.writeFileSync("${outputPath}", [p.message,p.runId,p.taskId].join("|")); });'`
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

  test("early command exit with large payload does not crash dispatch", async () => {
    const dispatcher = new HookDispatcher({
      commandHooks: {
        onMilestone: "node -e 'process.exit(0)'"
      }
    });

    await expect(
      dispatcher.dispatch(
        makeEvent({
          message: "x".repeat(2 * 1024 * 1024)
        })
      )
    ).resolves.toBeUndefined();
  });
});
