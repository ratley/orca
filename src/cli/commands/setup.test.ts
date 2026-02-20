import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { buildConfigModule, detectPackageManager, resolveApiKey } from "./setup.js";

describe("resolveApiKey", () => {
  const originalAnthropic = process.env.ANTHROPIC_API_KEY;
  const originalOpenai = process.env.OPENAI_API_KEY;
  let tempDir: string | undefined;

  afterEach(async () => {
    if (originalAnthropic === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = originalAnthropic;
    }

    if (originalOpenai === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenai;
    }

    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  test("returns flag value when provided", () => {
    process.env.ANTHROPIC_API_KEY = "env-value";

    const resolved = resolveApiKey("flag-value", "ANTHROPIC_API_KEY");

    expect(resolved).toBe("flag-value");
  });

  test("returns env var when flag is absent", () => {
    process.env.ANTHROPIC_API_KEY = "env-value";

    const resolved = resolveApiKey(undefined, "ANTHROPIC_API_KEY");

    expect(resolved).toBe("env-value");
  });

  test("returns OpenClaw env var when shell env is absent", async () => {
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

  test("treats OpenClaw 1Password refs as configured", async () => {
    delete process.env.ANTHROPIC_API_KEY;

    tempDir = await mkdtemp(path.join(os.tmpdir(), "orca-setup-test-"));
    const openclawDir = path.join(tempDir, ".openclaw");
    await mkdir(openclawDir, { recursive: true });
    const configPath = path.join(openclawDir, "openclaw.json");
    await writeFile(
      configPath,
      JSON.stringify({ env: { vars: { ANTHROPIC_API_KEY: "op://Eve/Anthropic/credential" } } }),
      "utf8"
    );

    const resolved = resolveApiKey(undefined, "ANTHROPIC_API_KEY", configPath);

    expect(resolved).toBe("op://Eve/Anthropic/credential");
  });

  test("returns value from ~/.claude/.env fallback", async () => {
    delete process.env.OPENAI_API_KEY;

    tempDir = await mkdtemp(path.join(os.tmpdir(), "orca-setup-test-"));
    const claudeDir = path.join(tempDir, ".claude");
    await mkdir(claudeDir, { recursive: true });
    await writeFile(
      path.join(claudeDir, ".env"),
      "# comment\nOPENAI_API_KEY=claude-home-value\n",
      "utf8"
    );

    const resolved = resolveApiKey(undefined, "OPENAI_API_KEY", {
      homedir: tempDir,
      openclawConfigPath: path.join(tempDir, ".openclaw", "openclaw.json")
    });

    expect(resolved).toBe("claude-home-value");
  });

  test("returns value from ~/.config/claude/.env fallback", async () => {
    delete process.env.ANTHROPIC_API_KEY;

    tempDir = await mkdtemp(path.join(os.tmpdir(), "orca-setup-test-"));
    const claudeConfigDir = path.join(tempDir, ".config", "claude");
    await mkdir(claudeConfigDir, { recursive: true });
    await writeFile(
      path.join(claudeConfigDir, ".env"),
      "ANTHROPIC_API_KEY=linux-config-value",
      "utf8"
    );

    const resolved = resolveApiKey(undefined, "ANTHROPIC_API_KEY", {
      homedir: tempDir,
      openclawConfigPath: path.join(tempDir, ".openclaw", "openclaw.json")
    });

    expect(resolved).toBe("linux-config-value");
  });

  test("ignores project-local .env", async () => {
    delete process.env.OPENAI_API_KEY;

    tempDir = await mkdtemp(path.join(os.tmpdir(), "orca-setup-test-"));
    await writeFile(
      path.join(tempDir, ".env"),
      "OPENAI_API_KEY=project-env-value",
      "utf8"
    );

    const resolved = resolveApiKey(undefined, "OPENAI_API_KEY", {
      homedir: path.join(tempDir, "home-without-keys"),
      openclawConfigPath: path.join(tempDir, ".openclaw", "openclaw.json")
    });

    expect(resolved).toBeUndefined();
  });

  test("supports quoted .env values and ignores comments", async () => {
    delete process.env.ANTHROPIC_API_KEY;

    tempDir = await mkdtemp(path.join(os.tmpdir(), "orca-setup-test-"));
    const claudeDir = path.join(tempDir, ".claude");
    await mkdir(claudeDir, { recursive: true });
    await writeFile(
      path.join(claudeDir, ".env"),
      "\n# line comment\nexport ANTHROPIC_API_KEY=\"quoted value\" # trailing comment\n",
      "utf8"
    );

    const resolved = resolveApiKey(undefined, "ANTHROPIC_API_KEY", {
      homedir: tempDir,
      openclawConfigPath: path.join(tempDir, ".openclaw", "openclaw.json")
    });

    expect(resolved).toBe("quoted value");
  });

  test("respects precedence across supported sources", async () => {
    process.env.ANTHROPIC_API_KEY = "env-value";

    tempDir = await mkdtemp(path.join(os.tmpdir(), "orca-setup-test-"));

    const openclawDir = path.join(tempDir, ".openclaw");
    await mkdir(openclawDir, { recursive: true });
    const openclawConfigPath = path.join(openclawDir, "openclaw.json");
    await writeFile(
      openclawConfigPath,
      JSON.stringify({ env: { vars: { ANTHROPIC_API_KEY: "gateway-value" } } }),
      "utf8"
    );

    const claudeDir = path.join(tempDir, ".claude");
    await mkdir(claudeDir, { recursive: true });
    await writeFile(path.join(claudeDir, ".env"), "ANTHROPIC_API_KEY=claude-value\n", "utf8");
    await writeFile(path.join(tempDir, ".env"), "ANTHROPIC_API_KEY=project-value\n", "utf8");

    const withFlag = resolveApiKey("flag-value", "ANTHROPIC_API_KEY", {
      homedir: tempDir,
      openclawConfigPath
    });
    expect(withFlag).toBe("flag-value");

    const withEnv = resolveApiKey(undefined, "ANTHROPIC_API_KEY", {
      homedir: tempDir,
      openclawConfigPath
    });
    expect(withEnv).toBe("env-value");

    delete process.env.ANTHROPIC_API_KEY;

    const withOpenclaw = resolveApiKey(undefined, "ANTHROPIC_API_KEY", {
      homedir: tempDir,
      openclawConfigPath
    });
    expect(withOpenclaw).toBe("gateway-value");
  });

  test("returns undefined when no source provides a key", async () => {
    delete process.env.ANTHROPIC_API_KEY;

    tempDir = await mkdtemp(path.join(os.tmpdir(), "orca-setup-test-"));

    const resolved = resolveApiKey(undefined, "ANTHROPIC_API_KEY", {
      homedir: tempDir,
      openclawConfigPath: path.join(tempDir, ".openclaw", "openclaw.json")
    });

    expect(resolved).toBeUndefined();
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
