import { afterEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";

import type { HookEvent } from "../../types/index.js";

type OpenclawModule = typeof import("./openclaw.js");

class MockChildProcess extends EventEmitter {
  readonly kill = mock(() => true);
}

function makeEvent(overrides: Partial<HookEvent> = {}): HookEvent {
  return {
    runId: "run-1000-abcd",
    hook: "onMilestone",
    message: "hook-message",
    timestamp: new Date().toISOString(),
    ...overrides,
  } as HookEvent;
}

async function loadModuleWithMocks(options: {
  binaryPresent?: boolean;
  authPresent?: boolean;
  spawnImpl?: (...args: unknown[]) => MockChildProcess;
}): Promise<OpenclawModule> {
  mock.module("node:child_process", () => ({
    spawnSync: () => ({ status: (options.binaryPresent ?? false) ? 0 : 1 }),
    spawn: (...args: unknown[]) => {
      if (!options.spawnImpl) {
        throw new Error("spawn implementation is required for this test");
      }

      return options.spawnImpl(...args);
    },
  }));

  mock.module("node:fs", () => ({
    existsSync: () => options.authPresent ?? false,
  }));

  return await import(`./openclaw.js?test=${Math.random()}`);
}

describe("detectOpenclawAvailability", () => {
  const originalToken = process.env.OPENCLAW_GATEWAY_TOKEN;

  afterEach(() => {
    if (originalToken === undefined) {
      delete process.env.OPENCLAW_GATEWAY_TOKEN;
    } else {
      process.env.OPENCLAW_GATEWAY_TOKEN = originalToken;
    }
    mock.restore();
  });

  test("returns available when binary and auth are present", async () => {
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    const module = await loadModuleWithMocks({ binaryPresent: true, authPresent: true });

    const result = module.detectOpenclawAvailability();

    expect(result).toEqual({ available: true });
  });

  test("returns partial warning on binary/auth mismatch", async () => {
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    const module = await loadModuleWithMocks({ binaryPresent: true, authPresent: false });

    const result = module.detectOpenclawAvailability();

    expect(result.available).toBe(false);
    expect(result.warning).toContain("partial");
  });

  test("returns unavailable when binary and auth are both missing", async () => {
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    const module = await loadModuleWithMocks({ binaryPresent: false, authPresent: false });

    const result = module.detectOpenclawAvailability();

    expect(result).toEqual({ available: false });
  });
});

describe("createOpenclawHookHandler", () => {
  afterEach(() => {
    mock.restore();
  });

  test("resolves when openclaw exits with code 0", async () => {
    const child = new MockChildProcess();
    const spawnArgs: unknown[][] = [];
    const module = await loadModuleWithMocks({
      spawnImpl: (...args) => {
        spawnArgs.push(args);
        queueMicrotask(() => {
          child.emit("exit", 0);
        });
        return child;
      },
    });

    const handler = module.createOpenclawHookHandler(50);

    await expect(
      handler(makeEvent({ message: "hello" }), {
        cwd: process.cwd(),
        pid: process.pid,
        invokedAt: new Date().toISOString(),
      }),
    ).resolves.toBeUndefined();
    expect(spawnArgs[0]?.[0]).toBe("openclaw");
  });

  test("rejects when openclaw exits with non-zero code", async () => {
    const child = new MockChildProcess();
    const module = await loadModuleWithMocks({
      spawnImpl: () => {
        queueMicrotask(() => {
          child.emit("exit", 1);
        });
        return child;
      },
    });

    const handler = module.createOpenclawHookHandler(50);

    await expect(
      handler(makeEvent(), { cwd: process.cwd(), pid: process.pid, invokedAt: new Date().toISOString() }),
    ).rejects.toThrow("openclaw exited with code 1");
  });

  test("rejects when spawn emits error", async () => {
    const child = new MockChildProcess();
    const module = await loadModuleWithMocks({
      spawnImpl: () => {
        queueMicrotask(() => {
          child.emit("error", new Error("binary not found"));
        });
        return child;
      },
    });

    const handler = module.createOpenclawHookHandler(50);

    await expect(
      handler(makeEvent(), { cwd: process.cwd(), pid: process.pid, invokedAt: new Date().toISOString() }),
    ).rejects.toThrow("binary not found");
  });

  test("rejects when spawn throws", async () => {
    const module = await loadModuleWithMocks({
      spawnImpl: () => {
        throw new Error("spawn exploded");
      },
    });

    const handler = module.createOpenclawHookHandler(50);

    await expect(
      handler(makeEvent(), { cwd: process.cwd(), pid: process.pid, invokedAt: new Date().toISOString() }),
    ).rejects.toThrow("spawn exploded");
  });

  test("kills process and rejects on timeout", async () => {
    const child = new MockChildProcess();
    const module = await loadModuleWithMocks({
      spawnImpl: () => child,
    });

    const handler = module.createOpenclawHookHandler(5);

    await expect(
      handler(makeEvent(), { cwd: process.cwd(), pid: process.pid, invokedAt: new Date().toISOString() }),
    ).rejects.toThrow("openclaw timed out after 5ms");
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });
});
