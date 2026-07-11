import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";

import { claudeProjectKey, resolveClaudeConfigDir, transcriptPath } from "../transcript";

describe("claudeProjectKey", () => {
  test("matches the project key Claude Code created for the live probe cwd", () => {
    // Verified 2026-07-11: this exact directory appeared under ~/.claude/projects/.
    expect(
      claudeProjectKey(
        "/private/tmp/claude-501/-Users-bradleyinniss-dev-orca-dev/adf161e3-e7db-4ee6-b19b-e20c093ffbb5/scratchpad/claude-probe",
      ),
    ).toBe(
      "-private-tmp-claude-501--Users-bradleyinniss-dev-orca-dev-adf161e3-e7db-4ee6-b19b-e20c093ffbb5-scratchpad-claude-probe",
    );
  });

  test("replaces dots with dashes (probed via /Users/.../.agents/skills)", () => {
    expect(claudeProjectKey("/Users/bradleyinniss/.agents/skills")).toBe(
      "-Users-bradleyinniss--agents-skills",
    );
  });

  test("replaces every non-alphanumeric char, one dash each (probed via probe_под.dir)", () => {
    // Verified 2026-07-11: cwd .../probe_под.dir produced .../probe-----dir
    // (underscore, two Cyrillic letters, and the dot each became one dash).
    expect(claudeProjectKey("/scratch/probe_под.dir")).toBe("-scratch-probe-----dir");
  });
});

describe("resolveClaudeConfigDir", () => {
  let previous: string | undefined;

  beforeEach(() => {
    previous = process.env.CLAUDE_CONFIG_DIR;
  });

  afterEach(() => {
    if (previous === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = previous;
    }
  });

  test("defaults to ~/.claude", () => {
    delete process.env.CLAUDE_CONFIG_DIR;
    expect(resolveClaudeConfigDir()).toBe(path.join(os.homedir(), ".claude"));
  });

  test("CLAUDE_CONFIG_DIR overrides the default", () => {
    process.env.CLAUDE_CONFIG_DIR = "/tmp/claude-config-override";
    expect(resolveClaudeConfigDir()).toBe("/tmp/claude-config-override");
  });
});

describe("transcriptPath", () => {
  test("composes configDir/projects/<projectKey>/<sessionId>.jsonl", () => {
    expect(
      transcriptPath("/home/user/.claude", "/work/my.repo", "92e1e510-1558-474b-88ae-f7f8ebb2d182"),
    ).toBe("/home/user/.claude/projects/-work-my-repo/92e1e510-1558-474b-88ae-f7f8ebb2d182.jsonl");
  });
});
