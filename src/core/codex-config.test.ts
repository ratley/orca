import { readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { ensureCodexMultiAgent, isCodexMultiAgentActive } from "./codex-config.js";

let tmpDir: string;
let tmpConfigFile: string;

beforeEach(async () => {
  const fs = await import("node:fs/promises");
  tmpDir = path.join(os.tmpdir(), `orca-codex-config-test-${Date.now()}`);
  await fs.mkdir(tmpDir, { recursive: true });
  tmpConfigFile = path.join(tmpDir, "config.toml");
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("ensureCodexMultiAgent", () => {
  it("skips by default (multiAgent not set)", async () => {
    const result = await ensureCodexMultiAgent(undefined, tmpConfigFile);
    expect(result.action).toBe("skipped");
  });

  it("skips when codex block is empty", async () => {
    const result = await ensureCodexMultiAgent({ codex: {} }, tmpConfigFile);
    expect(result.action).toBe("skipped");
  });

  it("skips when multiAgent is explicitly false", async () => {
    const result = await ensureCodexMultiAgent({ codex: { multiAgent: false } }, tmpConfigFile);
    expect(result.action).toBe("skipped");

    const fs = await import("node:fs/promises");
    await expect(fs.access(tmpConfigFile)).rejects.toThrow();
  });

  it("creates config file when multiAgent is true and no file exists", async () => {
    const result = await ensureCodexMultiAgent({ codex: { multiAgent: true } }, tmpConfigFile);
    expect(result.action).toBe("created");

    const content = await readFile(result.path, "utf8");
    expect(content).toContain("multi_agent = true");
  });

  it("created file contains orca comment", async () => {
    await ensureCodexMultiAgent({ codex: { multiAgent: true } }, tmpConfigFile);
    const content = await readFile(tmpConfigFile, "utf8");
    expect(content).toContain("Added by orca");
  });

  it("returns already-set when multi_agent already exists in file", async () => {
    const fs = await import("node:fs/promises");
    await fs.writeFile(tmpConfigFile, "[features]\nmulti_agent = false\n", "utf8");

    const result = await ensureCodexMultiAgent({ codex: { multiAgent: true } }, tmpConfigFile);
    expect(result.action).toBe("already-set");

    // Should not overwrite user's setting
    const content = await readFile(tmpConfigFile, "utf8");
    expect(content).toContain("multi_agent = false");
    expect(content).not.toContain("multi_agent = true");
  });

  it("appends feature block when file exists but has no multi_agent", async () => {
    const fs = await import("node:fs/promises");
    await fs.writeFile(tmpConfigFile, '[mcp_servers.context7]\ncommand = "npx"\n', "utf8");

    const result = await ensureCodexMultiAgent({ codex: { multiAgent: true } }, tmpConfigFile);
    expect(result.action).toBe("appended");

    const content = await readFile(tmpConfigFile, "utf8");
    expect(content).toContain("[mcp_servers.context7]");
    expect(content).toContain("multi_agent = true");
  });

  it("appended block is separated from existing content with no trailing newline", async () => {
    const fs = await import("node:fs/promises");
    await fs.writeFile(tmpConfigFile, '[section]\nkey = "value"', "utf8");

    await ensureCodexMultiAgent({ codex: { multiAgent: true } }, tmpConfigFile);
    const content = await readFile(tmpConfigFile, "utf8");
    expect(content).toContain("\n\n");
    expect(content).toContain("multi_agent = true");
  });
});

describe("isCodexMultiAgentActive", () => {
  it("returns true when Orca config enables multiAgent", async () => {
    await expect(isCodexMultiAgentActive({ codex: { multiAgent: true } }, tmpConfigFile)).resolves.toBe(true);
  });

  it("returns true when root config enables multi_agent", async () => {
    const fs = await import("node:fs/promises");
    await fs.writeFile(tmpConfigFile, "[features]\nmulti_agent = true\n", "utf8");

    await expect(isCodexMultiAgentActive(undefined, tmpConfigFile)).resolves.toBe(true);
  });

  it("returns true when both Orca config and root config enable multi-agent", async () => {
    const fs = await import("node:fs/promises");
    await fs.writeFile(tmpConfigFile, "[features]\nmulti_agent = true\n", "utf8");

    await expect(isCodexMultiAgentActive({ codex: { multiAgent: true } }, tmpConfigFile)).resolves.toBe(true);
  });

  it("returns false when Orca config is false and no root config enables multi-agent", async () => {
    await expect(isCodexMultiAgentActive({ codex: { multiAgent: false } }, tmpConfigFile)).resolves.toBe(false);
  });

  it("returns false when Orca config explicitly disables multi-agent even if root config enables it", async () => {
    const fs = await import("node:fs/promises");
    await fs.writeFile(tmpConfigFile, "[features]\nmulti_agent = true\n", "utf8");

    await expect(isCodexMultiAgentActive({ codex: { multiAgent: false } }, tmpConfigFile)).resolves.toBe(false);
  });

  it("returns false when root config contains multi_agent = false", async () => {
    const fs = await import("node:fs/promises");
    await fs.writeFile(tmpConfigFile, "[features]\nmulti_agent = false\n", "utf8");

    await expect(isCodexMultiAgentActive(undefined, tmpConfigFile)).resolves.toBe(false);
  });
});
