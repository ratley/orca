import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

import { getBundledSkillsDir, loadSkill, loadSkills, loadSkillsFromDir, parseSkillFile } from "./skill-loader.js";

describe("skill-loader", () => {
  let tempDir: string;
  let originalCwd: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "orca-skill-loader-test-"));
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

  test("parseSkillFile parses frontmatter correctly", () => {
    const parsed = parseSkillFile(
      [
        "---",
        "name: Build Skill",
        "description: Helps with builds",
        "---",
        "# Skill Body",
        "Run the build command.",
      ].join("\n"),
    );

    expect(parsed).toEqual({
      name: "Build Skill",
      description: "Helps with builds",
      body: "# Skill Body\nRun the build command.",
    });
  });

  test("parseSkillFile handles missing frontmatter", () => {
    const content = "# No Frontmatter\nJust markdown.";
    const parsed = parseSkillFile(content);

    expect(parsed).toEqual({
      name: "",
      description: "",
      body: content,
    });
  });

  test("loadSkill returns null for dir without SKILL.md", async () => {
    const skillDir = path.join(tempDir, "missing-skill-file");
    await fs.mkdir(skillDir, { recursive: true });

    const loaded = await loadSkill(skillDir);
    expect(loaded).toBeNull();
  });

  test("loadSkill loads skill with frontmatter", async () => {
    const skillDir = path.join(tempDir, "frontmatter-skill");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      ["---", "name: Deploy", "description: Deploy helper", "---", "Use this for deploy steps."].join("\n"),
      "utf8",
    );

    const loaded = await loadSkill(skillDir);
    expect(loaded).toEqual({
      name: "Deploy",
      description: "Deploy helper",
      body: "Use this for deploy steps.",
      dirPath: skillDir,
      filePath: path.join(skillDir, "SKILL.md"),
    });
  });

  test("loadSkill infers name from dir name when frontmatter absent", async () => {
    const skillDir = path.join(tempDir, "inferred-name");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "Body only", "utf8");

    const loaded = await loadSkill(skillDir);
    expect(loaded).not.toBeNull();
    expect(loaded?.name).toBe("inferred-name");
    expect(loaded?.description).toBe("");
    expect(loaded?.body).toBe("Body only");
  });

  test("loadSkillsFromDir returns all skills in a dir", async () => {
    const skillsRoot = path.join(tempDir, "skills-root");
    const alphaDir = path.join(skillsRoot, "alpha");
    const betaDir = path.join(skillsRoot, "beta");
    await fs.mkdir(alphaDir, { recursive: true });
    await fs.mkdir(betaDir, { recursive: true });
    await fs.writeFile(path.join(alphaDir, "SKILL.md"), "---\nname: Alpha\ndescription: A\n---\nAlpha body", "utf8");
    await fs.writeFile(path.join(betaDir, "SKILL.md"), "---\nname: Beta\ndescription: B\n---\nBeta body", "utf8");

    const loaded = await loadSkillsFromDir(skillsRoot);
    expect(loaded.map((skill) => skill.name)).toEqual(["Alpha", "Beta"]);
    expect(loaded.map((skill) => skill.body)).toEqual(["Alpha body", "Beta body"]);
  });

  test("loadSkillsFromDir skips symlinked skill directories with warning", async () => {
    const skillsRoot = path.join(tempDir, "skills-root");
    const realSkillDir = path.join(skillsRoot, "real");
    const externalSkillDir = path.join(tempDir, "external-skill");
    const symlinkPath = path.join(skillsRoot, "linked");
    await fs.mkdir(realSkillDir, { recursive: true });
    await fs.mkdir(externalSkillDir, { recursive: true });
    await fs.writeFile(path.join(realSkillDir, "SKILL.md"), "---\nname: Real\ndescription: R\n---\nreal body", "utf8");
    await fs.writeFile(
      path.join(externalSkillDir, "SKILL.md"),
      "---\nname: Linked\ndescription: L\n---\nlinked body",
      "utf8",
    );
    await fs.symlink(externalSkillDir, symlinkPath, "dir");

    const originalWarn = console.warn;
    const warnMock = mock(() => {});
    console.warn = warnMock as unknown as typeof console.warn;

    try {
      const loaded = await loadSkillsFromDir(skillsRoot);
      expect(loaded.map((skill) => skill.name)).toEqual(["Real"]);
      expect(warnMock).toHaveBeenCalledTimes(1);
      expect(warnMock).toHaveBeenCalledWith(`Skipping symlinked skill entry: ${symlinkPath}`);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("loadSkill returns null when SKILL.md is unreadable", async () => {
    const skillDir = path.join(tempDir, "unreadable-skill");
    const skillFilePath = path.join(skillDir, "SKILL.md");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(skillFilePath, "---\nname: Hidden\ndescription: x\n---\nbody", "utf8");
    await fs.chmod(skillFilePath, 0o000);

    const originalWarn = console.warn;
    const warnMock = mock(() => {});
    console.warn = warnMock as unknown as typeof console.warn;

    try {
      const loaded = await loadSkill(skillDir);
      expect(loaded).toBeNull();
      expect(warnMock).toHaveBeenCalledTimes(1);
      expect(String((warnMock.mock.calls as unknown[][])[0]?.[0] ?? "")).toContain(
        `Skipping skill at ${skillDir}: unable to read SKILL.md`,
      );
    } finally {
      console.warn = originalWarn;
      await fs.chmod(skillFilePath, 0o644);
    }
  });

  test("loadSkills uses precedence config > project > global > bundled (first name wins)", async () => {
    const projectDir = path.join(tempDir, "project");
    const homeDir = path.join(tempDir, "home");
    const configSkillDir = path.join(tempDir, "config-skill");

    await fs.mkdir(projectDir, { recursive: true });
    await fs.mkdir(homeDir, { recursive: true });
    process.chdir(projectDir);
    process.env.HOME = homeDir;
    await fs.mkdir(configSkillDir, { recursive: true });
    await fs.mkdir(path.join(projectDir, ".orca", "skills", "project-dup"), { recursive: true });
    await fs.mkdir(path.join(homeDir, ".orca", "skills", "global-dup"), { recursive: true });
    await fs.mkdir(path.join(projectDir, ".orca", "skills", "project-unique"), { recursive: true });

    await fs.writeFile(
      path.join(configSkillDir, "SKILL.md"),
      "---\nname: Duplicate\ndescription: from config\n---\nconfig body",
      "utf8",
    );
    await fs.writeFile(
      path.join(projectDir, ".orca", "skills", "project-dup", "SKILL.md"),
      "---\nname: Duplicate\ndescription: from project\n---\nproject body",
      "utf8",
    );
    await fs.writeFile(
      path.join(homeDir, ".orca", "skills", "global-dup", "SKILL.md"),
      "---\nname: Duplicate\ndescription: from global\n---\nglobal body",
      "utf8",
    );
    await fs.writeFile(
      path.join(projectDir, ".orca", "skills", "project-unique", "SKILL.md"),
      "---\nname: Unique\ndescription: unique\n---\nunique body",
      "utf8",
    );

    const loaded = await loadSkills({ skills: [configSkillDir] });

    expect(loaded[0]?.name).toBe("Duplicate");
    expect(loaded[0]?.description).toBe("from config");
    expect(loaded[0]?.body).toBe("config body");
    expect(loaded.some((skill) => skill.name === "Unique")).toBe(true);
  });

  test("loadSkills allows project skills to override bundled defaults by name", async () => {
    const projectDir = path.join(tempDir, "project-override");
    const homeDir = path.join(tempDir, "home-override");
    const overrideDir = path.join(projectDir, ".orca", "skills", "code-simplifier");
    await fs.mkdir(overrideDir, { recursive: true });
    await fs.mkdir(homeDir, { recursive: true });
    process.chdir(projectDir);
    process.env.HOME = homeDir;
    await fs.writeFile(
      path.join(overrideDir, "SKILL.md"),
      "---\nname: code-simplifier\ndescription: project override\n---\nproject override body",
      "utf8",
    );

    const loaded = await loadSkills();
    const codeSimplifier = loaded.find((skill) => skill.name === "code-simplifier");

    expect(codeSimplifier).toBeDefined();
    expect(codeSimplifier?.description).toBe("project override");
    expect(codeSimplifier?.dirPath.endsWith(path.join(".orca", "skills", "code-simplifier"))).toBe(true);
  });

  test("loadSkills loads bundled defaults even with empty project/global/config", async () => {
    const projectDir = path.join(tempDir, "empty-project");
    const homeDir = path.join(tempDir, "empty-home");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.mkdir(homeDir, { recursive: true });
    process.chdir(projectDir);
    process.env.HOME = homeDir;

    const loaded = await loadSkills();
    const bundled = loaded.find((skill) => skill.name === "code-simplifier");

    expect(bundled).toBeDefined();
    expect(bundled?.dirPath).toBe(path.join(getBundledSkillsDir(), "code-simplifier"));
  });

  test("loadSkills does not duplicate bundled skills when cwd is the Orca package root", async () => {
    const homeDir = path.join(tempDir, "home-package-root");
    await fs.mkdir(homeDir, { recursive: true });
    process.chdir(originalCwd);
    process.env.HOME = homeDir;

    const loaded = await loadSkills();
    const bundledMatches = loaded.filter((skill) => skill.name === "code-simplifier");

    expect(bundledMatches).toHaveLength(1);
    expect(bundledMatches[0]?.dirPath).toBe(path.join(getBundledSkillsDir(), "code-simplifier"));
  });
});
