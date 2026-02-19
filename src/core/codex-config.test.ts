import { readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { ensureCodexMultiAgent } from "./codex-config.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await import("node:fs/promises").then(async (fs) => {
    const dir = path.join(os.tmpdir(), `orca-codex-config-test-${Date.now()}`);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("ensureCodexMultiAgent", () => {
  it("creates .codex/config.toml when none exists", async () => {
    const result = await ensureCodexMultiAgent(tmpDir);
    expect(result.action).toBe("created");

    const content = await readFile(result.path, "utf8");
    expect(content).toContain("multi_agent = true");
  });

  it("returns already-set when multi_agent is already in the file", async () => {
    const fs = await import("node:fs/promises");
    const configDir = path.join(tmpDir, ".codex");
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, "config.toml"),
      "[features]\nmulti_agent = false\n",
      "utf8",
    );

    const result = await ensureCodexMultiAgent(tmpDir);
    expect(result.action).toBe("already-set");

    // Should not have overwritten the user's setting
    const content = await readFile(result.path, "utf8");
    expect(content).toContain("multi_agent = false");
    expect(content).not.toContain("multi_agent = true");
  });

  it("appends feature block when file exists but has no multi_agent", async () => {
    const fs = await import("node:fs/promises");
    const configDir = path.join(tmpDir, ".codex");
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, "config.toml"),
      "[mcp_servers.context7]\ncommand = \"npx\"\n",
      "utf8",
    );

    const result = await ensureCodexMultiAgent(tmpDir);
    expect(result.action).toBe("appended");

    const content = await readFile(result.path, "utf8");
    expect(content).toContain("[mcp_servers.context7]");
    expect(content).toContain("multi_agent = true");
  });

  it("skips when multiAgent is explicitly false in config", async () => {
    const result = await ensureCodexMultiAgent(tmpDir, { codex: { multiAgent: false } });
    expect(result.action).toBe("skipped");

    // Should not have created any file
    const fs = await import("node:fs/promises");
    await expect(
      fs.access(path.join(tmpDir, ".codex", "config.toml")),
    ).rejects.toThrow();
  });

  it("is on by default (no config passed)", async () => {
    const result = await ensureCodexMultiAgent(tmpDir, undefined);
    expect(result.action).toBe("created");
  });

  it("is on by default (empty codex config block)", async () => {
    const result = await ensureCodexMultiAgent(tmpDir, { codex: {} });
    expect(result.action).toBe("created");
  });

  it("created file contains orca management comment", async () => {
    const result = await ensureCodexMultiAgent(tmpDir);
    const content = await readFile(result.path, "utf8");
    expect(content).toContain("Managed by orca");
  });

  it("appended block is separated from existing content", async () => {
    const fs = await import("node:fs/promises");
    const configDir = path.join(tmpDir, ".codex");
    await fs.mkdir(configDir, { recursive: true });
    // File with no trailing newline
    await fs.writeFile(
      path.join(configDir, "config.toml"),
      "[section]\nkey = \"value\"",
      "utf8",
    );

    const result = await ensureCodexMultiAgent(tmpDir);
    expect(result.action).toBe("appended");

    const content = await readFile(result.path, "utf8");
    // Should have separation before the appended block
    expect(content).toContain("\n\n");
    expect(content).toContain("multi_agent = true");
  });
});
