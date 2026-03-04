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

  test("resolveConfig prefers project ts config over project js config when both exist", async () => {
    process.chdir(tempDir);
    process.env.HOME = tempDir;

    await fs.writeFile(path.join(tempDir, "orca.config.js"), "export default { runsDir: 'from-js' };\n", "utf8");
    await fs.writeFile(path.join(tempDir, "orca.config.ts"), "export default { runsDir: 'from-ts' };\n", "utf8");

    const resolved = await resolveConfig();

    expect(resolved?.runsDir).toBe("from-ts");
  });

  test("resolveConfigFromPaths loads a global ts config path", async () => {
    process.chdir(tempDir);

    const globalTsPath = path.join(tempDir, "global.config.ts");
    await fs.writeFile(globalTsPath, "export default { runsDir: 'global-ts' };\n", "utf8");

    const resolved = await resolveConfigFromPaths(globalTsPath, path.join(tempDir, "missing-project.js"));

    expect(resolved?.runsDir).toBe("global-ts");
  });

  test("resolveConfigFromPaths returns undefined when no configs exist", async () => {
    const resolved = await resolveConfigFromPaths(
      path.join(tempDir, "missing-global.js"),
      path.join(tempDir, "missing-project.js")
    );

    expect(resolved).toBeUndefined();
  });

  test("resolveConfigFromPaths loads explicit cli path", async () => {
    const cliPath = path.join(tempDir, "cli.config.js");
    await fs.writeFile(
      cliPath,
      "export default { runsDir: 'from-cli', sessionLogs: '/tmp/orca-session-logs' };\n",
      "utf8"
    );

    const resolved = await resolveConfigFromPaths(
      path.join(tempDir, "missing-global.js"),
      path.join(tempDir, "missing-project.js"),
      cliPath
    );

    expect(resolved?.runsDir).toBe("from-cli");
    expect(resolved?.sessionLogs).toBe("/tmp/orca-session-logs");
  });

  test("resolveConfigFromPaths throws on invalid executor value", async () => {
    const cliPath = path.join(tempDir, "cli.config.js");
    await fs.writeFile(cliPath, "export default { executor: 'invalid-executor' };\n", "utf8");

    await expect(
      resolveConfigFromPaths(
        path.join(tempDir, "missing-global.js"),
        path.join(tempDir, "missing-project.js"),
        cliPath
      )
    ).rejects.toThrow("Config.executor must be 'codex', got invalid-executor");
  });

  test("resolveConfigFromPaths rejects unknown hookCommands keys", async () => {
    const cliPath = path.join(tempDir, "cli.config.js");
    await fs.writeFile(cliPath, "export default { hookCommands: { onMystery: 'echo nope' } };\n", "utf8");

    await expect(
      resolveConfigFromPaths(
        path.join(tempDir, "missing-global.js"),
        path.join(tempDir, "missing-project.js"),
        cliPath
      )
    ).rejects.toThrow("Unknown hook key in Config.hookCommands: onMystery");
  });

  test("resolveConfigFromPaths rejects unknown hooks keys", async () => {
    const cliPath = path.join(tempDir, "cli.config.js");
    await fs.writeFile(cliPath, "export default { hooks: { onMystery: async () => {} } };\n", "utf8");

    await expect(
      resolveConfigFromPaths(
        path.join(tempDir, "missing-global.js"),
        path.join(tempDir, "missing-project.js"),
        cliPath
      )
    ).rejects.toThrow("Unknown hook key in Config.hooks: onMystery");
  });

  test("resolveConfigFromPaths validates legacy review.enabled", async () => {
    const cliPath = path.join(tempDir, "cli.config.js");
    await fs.writeFile(cliPath, "export default { review: { enabled: 'invalid' } };\n", "utf8");

    await expect(
      resolveConfigFromPaths(
        path.join(tempDir, "missing-global.js"),
        path.join(tempDir, "missing-project.js"),
        cliPath
      )
    ).rejects.toThrow("Config.review.enabled must be a boolean");
  });

  test("resolveConfigFromPaths validates legacy review.onInvalid", async () => {
    const cliPath = path.join(tempDir, "cli.config.js");
    await fs.writeFile(cliPath, "export default { review: { onInvalid: 'invalid' } };\n", "utf8");

    await expect(
      resolveConfigFromPaths(
        path.join(tempDir, "missing-global.js"),
        path.join(tempDir, "missing-project.js"),
        cliPath
      )
    ).rejects.toThrow("Config.review.onInvalid must be 'fail' or 'warn_skip'");
  });

  test("resolveConfigFromPaths accepts executor 'codex'", async () => {
    const cliPath = path.join(tempDir, "cli.config.js");
    await fs.writeFile(cliPath, "export default { executor: 'codex' };\n", "utf8");

    const resolved = await resolveConfigFromPaths(
      path.join(tempDir, "missing-global.js"),
      path.join(tempDir, "missing-project.js"),
      cliPath
    );

    expect(resolved?.executor).toBe("codex");
  });

  test("resolveConfigFromPaths throws on invalid codex effort value", async () => {
    const cliPath = path.join(tempDir, "cli.config.js");
    await fs.writeFile(cliPath, "export default { codex: { effort: 'extreme' } };\n", "utf8");

    await expect(
      resolveConfigFromPaths(
        path.join(tempDir, "missing-global.js"),
        path.join(tempDir, "missing-project.js"),
        cliPath
      )
    ).rejects.toThrow("Codex thinking level must be one of");
  });

  test("resolveConfigFromPaths accepts codex.thinkingLevel per-step efforts", async () => {
    const cliPath = path.join(tempDir, "cli.config.js");
    await fs.writeFile(
      cliPath,
      "export default { codex: { thinkingLevel: { decision: 'low', planning: 'xhigh', execution: 'medium' } } };\n",
      "utf8"
    );

    const resolved = await resolveConfigFromPaths(
      path.join(tempDir, "missing-global.js"),
      path.join(tempDir, "missing-project.js"),
      cliPath
    );

    expect(resolved?.codex?.thinkingLevel).toEqual({
      decision: "low",
      planning: "xhigh",
      execution: "medium",
    });
  });

  test("resolveConfigFromPaths normalizes deprecated 'extra-high' to 'xhigh'", async () => {
    const cliPath = path.join(tempDir, "cli.config.js");
    await fs.writeFile(
      cliPath,
      "export default { codex: { thinkingLevel: { planning: 'extra-high' }, effort: 'extra-high' } };\n",
      "utf8"
    );

    const resolved = await resolveConfigFromPaths(
      path.join(tempDir, "missing-global.js"),
      path.join(tempDir, "missing-project.js"),
      cliPath
    );

    expect(resolved?.codex?.thinkingLevel?.planning).toBe("xhigh");
    expect(resolved?.codex?.effort).toBe("xhigh");
  });

  test("resolveConfigFromPaths still accepts deprecated codex.thinking", async () => {
    const cliPath = path.join(tempDir, "cli.config.js");
    await fs.writeFile(
      cliPath,
      "export default { codex: { thinking: { decision: 'low', planning: 'high', execution: 'medium' } } };\n",
      "utf8"
    );

    const resolved = await resolveConfigFromPaths(
      path.join(tempDir, "missing-global.js"),
      path.join(tempDir, "missing-project.js"),
      cliPath
    );

    expect(resolved?.codex?.thinking).toEqual({
      decision: "low",
      planning: "high",
      execution: "medium",
    });
  });

  test("resolveConfigFromPaths validates codex.perCwdExtraUserRoots shape", async () => {
    const cliPath = path.join(tempDir, "cli.config.js");
    await fs.writeFile(
      cliPath,
      "export default { codex: { perCwdExtraUserRoots: [{ cwd: '/repo', extraUserRoots: [123] }] } };\n",
      "utf8"
    );

    await expect(
      resolveConfigFromPaths(
        path.join(tempDir, "missing-global.js"),
        path.join(tempDir, "missing-project.js"),
        cliPath
      )
    ).rejects.toThrow("Config.codex.perCwdExtraUserRoots[].extraUserRoots entries must be strings");
  });

  test("resolveConfigFromPaths accepts valid codex.perCwdExtraUserRoots", async () => {
    const cliPath = path.join(tempDir, "cli.config.js");
    await fs.writeFile(
      cliPath,
      "export default { codex: { perCwdExtraUserRoots: [{ cwd: '/repo', extraUserRoots: ['/tmp/skills'] }] } };\n",
      "utf8"
    );

    const resolved = await resolveConfigFromPaths(
      path.join(tempDir, "missing-global.js"),
      path.join(tempDir, "missing-project.js"),
      cliPath
    );

    expect(resolved?.codex?.perCwdExtraUserRoots).toEqual([
      { cwd: "/repo", extraUserRoots: ["/tmp/skills"] },
    ]);
  });

  test("resolveConfigFromPaths merges global and project", async () => {
    const globalPath = path.join(tempDir, "global.config.js");
    const projectPath = path.join(tempDir, "project.config.js");

    await fs.writeFile(
      globalPath,
      "export default { runsDir: 'global-runs', maxRetries: 2, skills: ['/skills/global', '/skills/shared'], codex: { enabled: false, model: 'gpt-global' }, pr: { enabled: true, requireConfirmation: true }, hookCommands: { onError: 'echo global-error' } };\n",
      "utf8"
    );
    await fs.writeFile(
      projectPath,
      "export default { runsDir: 'project-runs', sessionLogs: '/tmp/project-session-logs', skills: ['/skills/project', '/skills/shared'], codex: { model: 'gpt-project' }, pr: { requireConfirmation: false }, hookCommands: { onMilestone: 'echo project-milestone' } };\n",
      "utf8"
    );

    const resolved = await resolveConfigFromPaths(globalPath, projectPath);

    expect(resolved).toEqual({
      runsDir: "project-runs",
      sessionLogs: "/tmp/project-session-logs",
      maxRetries: 2,
      skills: ["/skills/global", "/skills/shared", "/skills/project"],
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
      sessionLogs: "global-logs",      skills: ["global-skill", "shared-skill"],
            codex: { enabled: false },
      pr: { enabled: true },
      hookCommands: { onError: "echo global-error" }
    };

    const projectConfig = {
      runsDir: "project",
      maxRetries: 2,
      sessionLogs: "project-logs",
      skills: ["project-skill", "shared-skill"],
            codex: { model: "gpt-project" },
      pr: { requireConfirmation: true },
      hookCommands: { onError: "echo project-error", onComplete: "echo project-complete" }
    };

    const cliConfig = {
      runsDir: "cli",
      maxRetries: 3,
      sessionLogs: "cli-logs",
      openaiApiKey: "cli-openai",
      skills: ["cli-skill", "project-skill"],
            codex: { enabled: true },
      pr: { requireConfirmation: false },
      hookCommands: { onComplete: "echo cli-complete" }
    };

    const merged = mergeConfigs(globalConfig, projectConfig, cliConfig);

    expect(merged).toEqual({
      runsDir: "cli",
      sessionLogs: "cli-logs",
      maxRetries: 3,      openaiApiKey: "cli-openai",
      skills: ["global-skill", "shared-skill", "project-skill", "cli-skill"],
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

  test("mergeConfigs merges executor with global < project < cli precedence", () => {
    const globalConfig = { executor: "codex" as const };
    const projectConfig = undefined;
    const cliConfig = { executor: "codex" as const };

    const merged = mergeConfigs(globalConfig, projectConfig, cliConfig);

    expect(merged?.executor).toBe("codex");
  });

  test("mergeConfigs deeply merges codex thinkingLevel settings", () => {
    const globalConfig = {
      codex: {
        thinkingLevel: {
          decision: "low" as const,
          planning: "high" as const,
        },
      },
    };

    const projectConfig = {
      codex: {
        thinkingLevel: {
          execution: "medium" as const,
        },
      },
    };

    const merged = mergeConfigs(globalConfig, projectConfig);

    expect(merged?.codex?.thinkingLevel).toEqual({
      decision: "low",
      planning: "high",
      execution: "medium",
    });
  });

  test("mergeConfigs deeply merges review plan/execution settings", () => {
    const globalConfig = {
      review: {
        plan: { enabled: true, onInvalid: "fail" as const },
        execution: { enabled: true, maxCycles: 2, validator: { auto: true } }
      }
    };
    const projectConfig = {
      review: {
        execution: { onFindings: "auto_fix" as const, validator: { commands: ["npm run test"] } }
      }
    };

    const merged = mergeConfigs(globalConfig, projectConfig);

    expect(merged?.review).toEqual({
      plan: { enabled: true, onInvalid: "fail" },
      execution: {
        enabled: true,
        maxCycles: 2,
        onFindings: "auto_fix",
        validator: {
          auto: true,
          commands: ["npm run test"]
        }
      }
    });
  });
});
