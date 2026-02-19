import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

import { mergeConfigs, resolveConfig, resolveConfigFromPaths } from "./config-loader.js";

describe("config-loader", () => {
  let tempDir: string;
  let originalCwd: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "orca-config-loader-test-"));
    originalCwd = process.cwd();
    originalHome = process.env.HOME;
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test("resolveConfig returns undefined when no configs exist", async () => {
    process.chdir(tempDir);
    process.env.HOME = tempDir;

    const resolved = await resolveConfig();

    expect(resolved).toBeUndefined();
  });

  test("resolveConfigFromPaths loads explicit cli path", async () => {
    const cliPath = path.join(tempDir, "cli.config.js");
    await fs.writeFile(cliPath, "export default { runsDir: 'from-cli' };\n", "utf8");

    const resolved = await resolveConfigFromPaths(
      path.join(tempDir, "missing-global.js"),
      path.join(tempDir, "missing-project.js"),
      cliPath
    );

    expect(resolved?.runsDir).toBe("from-cli");
  });

  test("resolveConfigFromPaths merges global and project", async () => {
    const globalPath = path.join(tempDir, "global.config.js");
    const projectPath = path.join(tempDir, "project.config.js");

    await fs.writeFile(
      globalPath,
      "export default { runsDir: 'global-runs', maxRetries: 2, claude: { model: 'claude-global' }, codex: { enabled: false, model: 'gpt-global' }, pr: { enabled: true, requireConfirmation: true }, hookCommands: { onError: 'echo global-error' } };\n",
      "utf8"
    );
    await fs.writeFile(
      projectPath,
      "export default { runsDir: 'project-runs', claude: { useV2Preview: true }, codex: { model: 'gpt-project' }, pr: { requireConfirmation: false }, hookCommands: { onMilestone: 'echo project-milestone' } };\n",
      "utf8"
    );

    const resolved = await resolveConfigFromPaths(globalPath, projectPath);

    expect(resolved).toEqual({
      runsDir: "project-runs",
      maxRetries: 2,
      claude: {
        model: "claude-global",
        useV2Preview: true
      },
      codex: {
        enabled: false,
        model: "gpt-project"
      },
      pr: {
        enabled: true,
        requireConfirmation: false
      },
      hookCommands: {
        onError: "echo global-error",
        onMilestone: "echo project-milestone"
      }
    });
  });

  test("mergeConfigs applies precedence global < project < cli", () => {
    const globalConfig = {
      runsDir: "global",
      maxRetries: 1,
      anthropicApiKey: "global-key",
      claude: { model: "claude-global" },
      codex: { enabled: false },
      pr: { enabled: true },
      hookCommands: { onError: "echo global-error" }
    };

    const projectConfig = {
      runsDir: "project",
      maxRetries: 2,
      claude: { useV2Preview: true },
      codex: { model: "gpt-project" },
      pr: { requireConfirmation: true },
      hookCommands: { onError: "echo project-error", onComplete: "echo project-complete" }
    };

    const cliConfig = {
      runsDir: "cli",
      maxRetries: 3,
      openaiApiKey: "cli-openai",
      claude: { model: "claude-cli" },
      codex: { enabled: true },
      pr: { requireConfirmation: false },
      hookCommands: { onComplete: "echo cli-complete" }
    };

    const merged = mergeConfigs(globalConfig, projectConfig, cliConfig);

    expect(merged).toEqual({
      runsDir: "cli",
      maxRetries: 3,
      anthropicApiKey: "global-key",
      openaiApiKey: "cli-openai",
      claude: {
        model: "claude-cli",
        useV2Preview: true
      },
      codex: {
        enabled: true,
        model: "gpt-project"
      },
      pr: {
        enabled: true,
        requireConfirmation: false
      },
      hookCommands: {
        onError: "echo project-error",
        onComplete: "echo cli-complete"
      }
    });
  });
});
