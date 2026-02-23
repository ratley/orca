import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  buildConfigModule,
  buildProjectConfigTemplate,
  detectPackageManager,
  readClaudeCodeKeychain,
  resolveApiKey
} from "./setup.js";

describe("resolveApiKey", () => {
  const originalAnthropic = process.env.ANTHROPIC_API_KEY;
  const originalOpenai = process.env.OPENAI_API_KEY;
  const originalOrcaAnthropic = process.env.ORCA_ANTHROPIC_API_KEY;
  const originalOrcaOpenai = process.env.ORCA_OPENAI_API_KEY;
  let tempDir: string | undefined;

  afterEach(async () => {
    if (originalAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalAnthropic;

    if (originalOpenai === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenai;

    if (originalOrcaAnthropic === undefined) delete process.env.ORCA_ANTHROPIC_API_KEY;
    else process.env.ORCA_ANTHROPIC_API_KEY = originalOrcaAnthropic;

    if (originalOrcaOpenai === undefined) delete process.env.ORCA_OPENAI_API_KEY;
    else process.env.ORCA_OPENAI_API_KEY = originalOrcaOpenai;

    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  test("returns flag value when provided", () => {
    process.env.ORCA_ANTHROPIC_API_KEY = "orca-env";
    process.env.ANTHROPIC_API_KEY = "generic-env";

    const resolved = resolveApiKey("flag-value", "ANTHROPIC_API_KEY");

    expect(resolved).toBe("flag-value");
  });

  test("ORCA env vars override generic env vars", () => {
    process.env.ORCA_ANTHROPIC_API_KEY = "orca-env";
    process.env.ANTHROPIC_API_KEY = "generic-env";

    const resolved = resolveApiKey(undefined, "ANTHROPIC_API_KEY");

    expect(resolved).toBe("orca-env");
  });

  test("falls back to generic env vars", () => {
    delete process.env.ORCA_OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "generic-openai";

    const resolved = resolveApiKey(undefined, "OPENAI_API_KEY");

    expect(resolved).toBe("generic-openai");
  });

  test("returns OpenClaw env var when shell env is absent", async () => {
    delete process.env.ORCA_ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    tempDir = await mkdtemp(path.join(os.tmpdir(), "orca-setup-test-"));
    const openclawDir = path.join(tempDir, ".openclaw");
    await mkdir(openclawDir, { recursive: true });
    const configPath = path.join(openclawDir, "openclaw.json");
    await writeFile(
      configPath,
      JSON.stringify({ env: { vars: { ANTHROPIC_API_KEY: "gateway-value" } } }),
      "utf8"
    );

    const resolved = resolveApiKey(undefined, "ANTHROPIC_API_KEY", configPath);

    expect(resolved).toBe("gateway-value");
  });

  test("returns undefined when no source provides a key", async () => {
    delete process.env.ORCA_OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    tempDir = await mkdtemp(path.join(os.tmpdir(), "orca-setup-test-"));

    const resolved = resolveApiKey(undefined, "OPENAI_API_KEY", {
      homedir: tempDir,
      openclawConfigPath: path.join(tempDir, ".openclaw", "openclaw.json")
    });

    expect(resolved).toBeUndefined();
  });
});

describe("readClaudeCodeKeychain", () => {
  test("never throws and returns undefined outside darwin", () => {
    const value = readClaudeCodeKeychain();

    if (process.platform === "darwin") {
      if (value !== undefined) expect(typeof value).toBe("string");
      return;
    }

    expect(value).toBeUndefined();
  });
});

describe("detectPackageManager", () => {
  test("prefers brew over other package managers", () => {
    const manager = detectPackageManager((command) => command === "brew" || command === "apt");

    expect(manager).toBe("brew");
  });

  test("returns apt when brew is unavailable", () => {
    const manager = detectPackageManager((command) => command === "apt");

    expect(manager).toBe("apt");
  });

  test("returns winget when only winget is available", () => {
    const manager = detectPackageManager((command) => command === "winget");

    expect(manager).toBe("winget");
  });

  test("returns null when no package manager is found", () => {
    const manager = detectPackageManager(() => false);

    expect(manager).toBeNull();
  });
});

describe("buildProjectConfigTemplate", () => {
  test("includes typed function hooks and stdin command-hook guidance", () => {
    const template = buildProjectConfigTemplate();

    expect(template).toContain('import { defineOrcaConfig } from "orcastrator";');
    expect(template).toContain("const config = defineOrcaConfig({");
    expect(template).toContain("hooks:");
    expect(template).toContain("onTaskComplete: async (event)");
    expect(template).toContain("event payload JSON to stdin");
    expect(template).toContain("hookCommands:");
  });
});

describe("buildConfigModule", () => {
  test("builds module string with both API keys", () => {
    const moduleText = buildConfigModule({
      anthropicApiKey: "sk-ant-test",
      openaiApiKey: "sk-openai-test"
    });

    expect(moduleText).toBe(
      "// generated by orca setup\n" +
        "export default {\n" +
        '  anthropicApiKey: "sk-ant-test",\n' +
        '  openaiApiKey: "sk-openai-test",\n' +
        "};\n"
    );
  });

  test("omits missing keys", () => {
    const moduleText = buildConfigModule({
      anthropicApiKey: "sk-ant-test"
    });

    expect(moduleText).toBe(
      "// generated by orca setup\n" +
        "export default {\n" +
        '  anthropicApiKey: "sk-ant-test",\n' +
        "};\n"
    );
  });
});
