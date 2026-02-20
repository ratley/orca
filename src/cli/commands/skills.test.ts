import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import type { OrcaConfig } from "../../types/index.js";
import type { LoadedSkill } from "../../utils/skill-loader.js";

type SkillsModule = typeof import("./skills.js");

let tempDir = "";
let logs: string[] = [];
const originalConsoleLog = console.log;

function makeSkill(input: {
  name: string;
  description: string;
  dirPath: string;
}): LoadedSkill {
  return {
    name: input.name,
    description: input.description,
    body: `${input.name} body`,
    dirPath: input.dirPath,
    filePath: path.join(input.dirPath, "SKILL.md")
  };
}

async function loadSkillsModule(options?: {
  resolveConfig?: (configPath?: string) => Promise<OrcaConfig | undefined>;
  loadSkills?: (config?: OrcaConfig) => Promise<LoadedSkill[]>;
}): Promise<{
  skillsModule: SkillsModule;
  resolveConfigMock: ReturnType<typeof mock>;
  loadSkillsMock: ReturnType<typeof mock>;
}> {
  const resolveConfigMock = mock(options?.resolveConfig ?? (async () => undefined));
  const loadSkillsMock = mock(options?.loadSkills ?? (async () => []));

  mock.module("../../core/config-loader.js", () => ({
    resolveConfig: resolveConfigMock
  }));

  mock.module("../../utils/skill-loader.js", () => ({
    loadSkills: loadSkillsMock
  }));

  const skillsModule = await import(`./skills.js?test=${Math.random()}`);
  return { skillsModule, resolveConfigMock, loadSkillsMock };
}

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "orca-skills-command-test-"));
  logs = [];

  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
});

afterEach(async () => {
  console.log = originalConsoleLog;
  mock.restore();

  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

describe("skills command", () => {
  test("prints 'No skills found.' when loader returns no skills", async () => {
    const { skillsModule } = await loadSkillsModule({
      resolveConfig: async () => undefined,
      loadSkills: async () => []
    });

    await skillsModule.skillsCommandHandler({});

    expect(logs).toEqual(["No skills found."]);
  });

  test("prints table for a single skill", async () => {
    const configSkillDir = path.join(tempDir, "config", "writer");
    const { skillsModule } = await loadSkillsModule({
      resolveConfig: async () => ({ skills: [configSkillDir] }),
      loadSkills: async () => [
        makeSkill({
          name: "Writer",
          description: "Generates copy",
          dirPath: configSkillDir
        })
      ]
    });

    await skillsModule.skillsCommandHandler({});

    expect(logs).toHaveLength(1);
    const output = logs[0] ?? "";
    expect(output).toContain("Name");
    expect(output).toContain("Description");
    expect(output).toContain("Source");
    expect(output).toContain("Path");
    expect(output).toContain("Writer");
    expect(output).toContain("Generates copy");
    expect(output).toContain("config");
    expect(output).toContain(configSkillDir);
  });

  test("labels skills from config, project, and global sources", async () => {
    const configSkillDir = path.join(tempDir, "config", "config-skill");
    const projectSkillDir = path.join(process.cwd(), ".orca", "skills", "project-skill");
    const globalSkillDir = path.join(os.homedir(), ".orca", "skills", "global-skill");

    const { skillsModule } = await loadSkillsModule({
      resolveConfig: async () => ({ skills: [configSkillDir] }),
      loadSkills: async () => [
        makeSkill({ name: "ConfigSkill", description: "From config", dirPath: configSkillDir }),
        makeSkill({ name: "ProjectSkill", description: "From project", dirPath: projectSkillDir }),
        makeSkill({ name: "GlobalSkill", description: "From global", dirPath: globalSkillDir })
      ]
    });

    await skillsModule.skillsCommandHandler({});

    const output = logs.join("\n");
    expect(output).toContain("ConfigSkill");
    expect(output).toContain("ProjectSkill");
    expect(output).toContain("GlobalSkill");
    expect(output).toContain("From config");
    expect(output).toContain("From project");
    expect(output).toContain("From global");

    expect(output).toMatch(/ConfigSkill\s+From config\s+config\s+/);
    expect(output).toMatch(/ProjectSkill\s+From project\s+project\s+/);
    expect(output).toMatch(/GlobalSkill\s+From global\s+global\s+/);
  });

  test("passes --config option through resolveConfig and loadSkills", async () => {
    const resolvedConfig: OrcaConfig = {
      skills: [path.join(tempDir, "config", "one")]
    };

    const { skillsModule, resolveConfigMock, loadSkillsMock } = await loadSkillsModule({
      resolveConfig: async () => resolvedConfig,
      loadSkills: async () => []
    });

    await skillsModule.skillsCommandHandler({ config: "./custom-orca.config.js" });

    expect(resolveConfigMock).toHaveBeenCalledWith("./custom-orca.config.js");
    expect(loadSkillsMock).toHaveBeenCalledWith(resolvedConfig);
  });
});
