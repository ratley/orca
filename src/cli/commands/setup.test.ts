import { describe, expect, test } from "bun:test";

import { buildConfigModule, readCodexAuthJson, resolveApiKey } from "./setup.js";

describe("resolveApiKey", () => {
  test("returns flag value when provided", () => {
    process.env.OPENAI_API_KEY = "generic-env";
    const resolved = resolveApiKey("flag-value", "OPENAI_API_KEY");
    expect(resolved).toBe("flag-value");
  });

  test("ORCA env var overrides generic env var", () => {
    process.env.ORCA_OPENAI_API_KEY = "orca-env";
    process.env.OPENAI_API_KEY = "generic-env";
    const resolved = resolveApiKey(undefined, "OPENAI_API_KEY");
    expect(resolved).toBe("orca-env");
    delete process.env.ORCA_OPENAI_API_KEY;
  });
});

describe("readCodexAuthJson", () => {
  test("returns undefined when auth.json is missing", () => {
    const value = readCodexAuthJson("/tmp/does-not-exist");
    expect(value).toBeUndefined();
  });
});

describe("buildConfigModule", () => {
  test("renders codex-only config", () => {
    const moduleText = buildConfigModule({ openaiApiKey: "sk-test", executor: "codex" });
    expect(moduleText).toContain('openaiApiKey: "sk-test"');
    expect(moduleText).toContain('executor: "codex"');
  });
});
