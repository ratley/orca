import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { OrcaConfig } from "../types/index.js";

export interface ParsedSkillFile {
  name: string;
  description: string;
  body: string;
}

export interface LoadedSkill extends ParsedSkillFile {
  dirPath: string;
  filePath: string;
}

function expandHome(inputPath: string): string {
  if (inputPath === "~") {
    return os.homedir();
  }

  if (inputPath.startsWith("~/") || inputPath.startsWith("~\\")) {
    return path.join(os.homedir(), inputPath.slice(2));
  }

  return inputPath;
}

function parseFrontmatter(frontmatter: string): Record<string, string> {
  const parsed: Record<string, string> = {};

  for (const rawLine of frontmatter.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf(":");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    if (key === "") {
      continue;
    }

    let value = line.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    parsed[key] = value;
  }

  return parsed;
}

export function parseSkillFile(fileContent: string): ParsedSkillFile {
  const frontmatterMatch = fileContent.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u);

  if (!frontmatterMatch) {
    return {
      name: "",
      description: "",
      body: fileContent
    };
  }

  const frontmatter = parseFrontmatter(frontmatterMatch[1] ?? "");
  const body = fileContent.slice(frontmatterMatch[0].length);

  return {
    name: frontmatter.name ?? "",
    description: frontmatter.description ?? "",
    body
  };
}

export async function loadSkill(skillDirPath: string): Promise<LoadedSkill | null> {
  const expandedDirPath = path.resolve(expandHome(skillDirPath));
  const skillFilePath = path.join(expandedDirPath, "SKILL.md");

  let skillFileContent: string;
  try {
    skillFileContent = await readFile(skillFilePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }

  const parsed = parseSkillFile(skillFileContent);
  const inferredName = path.basename(expandedDirPath);

  return {
    name: parsed.name || inferredName,
    description: parsed.description,
    body: parsed.body,
    dirPath: expandedDirPath,
    filePath: skillFilePath
  };
}

export async function loadSkillsFromDir(skillsDirPath: string): Promise<LoadedSkill[]> {
  const expandedDirPath = path.resolve(expandHome(skillsDirPath));

  let entries;
  try {
    entries = await readdir(expandedDirPath, { withFileTypes: true, encoding: "utf8" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const subdirectories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  const loaded = await Promise.all(
    subdirectories.map((subdirName) => loadSkill(path.join(expandedDirPath, subdirName)))
  );

  return loaded.filter((skill): skill is LoadedSkill => skill !== null);
}

export async function loadSkills(config?: OrcaConfig): Promise<LoadedSkill[]> {
  const fromConfig = await Promise.all((config?.skills ?? []).map((skillPath) => loadSkill(skillPath)));
  const projectSkills = await loadSkillsFromDir(path.join(process.cwd(), ".orca", "skills"));
  const globalSkills = await loadSkillsFromDir(path.join(os.homedir(), ".orca", "skills"));

  const allSkills = [
    ...fromConfig.filter((skill): skill is LoadedSkill => skill !== null),
    ...projectSkills,
    ...globalSkills
  ];

  const seenNames = new Set<string>();
  const deduped: LoadedSkill[] = [];

  for (const skill of allSkills) {
    if (seenNames.has(skill.name)) {
      continue;
    }
    seenNames.add(skill.name);
    deduped.push(skill);
  }

  return deduped;
}
