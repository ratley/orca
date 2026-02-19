import { afterEach, describe, expect, mock, test } from "bun:test";

type OpenclawModule = typeof import("./openclaw.js");

async function loadModuleWithMocks(options: {
  binaryPresent: boolean;
  authPresent: boolean;
}): Promise<OpenclawModule> {
  mock.module("node:child_process", () => ({
    spawnSync: () => ({ status: options.binaryPresent ? 0 : 1 }),
    spawn: () => {
      throw new Error("spawn should not be called in detectOpenclawAvailability tests");
    }
  }));

  mock.module("node:fs", () => ({
    existsSync: () => options.authPresent
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
