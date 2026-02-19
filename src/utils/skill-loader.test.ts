import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

import { loadSkill, loadSkills, loadSkillsFromDir, parseSkillFile } from "./skill-loader.js";

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
        "Run the build command."
      ].join("\n")
    );

    expect(parsed).toEqual({
      name: "Build Skill",
      description: "Helps with builds",
      body: "# Skill Body\nRun the build command."
    });
  });

  test("parseSkillFile handles missing frontmatter", () => {
    const content = "# No Frontmatter\nJust markdown.";
    const parsed = parseSkillFile(content);

    expect(parsed).toEqual({
      name: "",
      description: "",
      body: content
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
      ["---", "name: Deploy", "description: Deploy helper", "---", "Use this for deploy steps."].join(
        "\n"
      ),
      "utf8"
    );

    const loaded = await loadSkill(skillDir);
    expect(loaded).toEqual({
      name: "Deploy",
      description: "Deploy helper",
      body: "Use this for deploy steps.",
      dirPath: skillDir,
      filePath: path.join(skillDir, "SKILL.md")
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

  test("loadSkills deduplicates by name (first wins)", async () => {
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
      "utf8"
    );
    await fs.writeFile(
      path.join(projectDir, ".orca", "skills", "project-dup", "SKILL.md"),
      "---\nname: Duplicate\ndescription: from project\n---\nproject body",
      "utf8"
    );
    await fs.writeFile(
      path.join(homeDir, ".orca", "skills", "global-dup", "SKILL.md"),
      "---\nname: Duplicate\ndescription: from global\n---\nglobal body",
      "utf8"
    );
    await fs.writeFile(
      path.join(projectDir, ".orca", "skills", "project-unique", "SKILL.md"),
      "---\nname: Unique\ndescription: unique\n---\nunique body",
      "utf8"
    );

    const loaded = await loadSkills({ skills: [configSkillDir] });

    expect(loaded.map((skill) => skill.name)).toEqual(["Duplicate", "Unique"]);
    expect(loaded[0]?.description).toBe("from config");
    expect(loaded[0]?.body).toBe("config body");
  });

  test("loadSkills returns empty array when no skills found", async () => {
    const projectDir = path.join(tempDir, "empty-project");
    const homeDir = path.join(tempDir, "empty-home");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.mkdir(homeDir, { recursive: true });
    process.chdir(projectDir);
    process.env.HOME = homeDir;

    const loaded = await loadSkills();
    expect(loaded).toEqual([]);
  });
});
