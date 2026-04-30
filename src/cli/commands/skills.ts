import os from "node:os";
import path from "node:path";

import type { Command } from "commander";

import { resolveConfig } from "../../core/config-loader.js";
import type { LoadedSkill } from "../../utils/skill-loader.js";
import { getBundledSkillsDir, loadSkills } from "../../utils/skill-loader.js";

export interface SkillsCommandOptions {
  config?: string;
}

type SkillSource = "config" | "project" | "global" | "bundled";

function pad(value: string, width: number): string {
  return value.padEnd(width, " ");
}

function formatTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, index) => {
    const rowWidths = rows.map((row) => row[index]?.length ?? 0);
    return Math.max(header.length, ...rowWidths);
  });

  const headerLine = headers.map((header, index) => pad(header, widths[index] ?? header.length)).join("  ");
  const separator = widths.map((width) => "-".repeat(width)).join("  ");
  const body = rows.map((row) => row.map((cell, index) => pad(cell, widths[index] ?? cell.length)).join("  "));

  return [headerLine, separator, ...body].join("\n");
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

function resolveConfigSkillDir(inputPath: string): string {
  return path.resolve(expandHome(inputPath));
}

function pathWithin(targetPath: string, parentPath: string): boolean {
  const relative = path.relative(parentPath, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function detectSkillSource(skill: LoadedSkill, configSkillDirs: Set<string>): SkillSource {
  if (configSkillDirs.has(skill.dirPath)) {
    return "config";
  }

  const bundledSkillsRoot = getBundledSkillsDir();
  if (pathWithin(skill.dirPath, bundledSkillsRoot)) {
    return "bundled";
  }

  const projectSkillsRoot = path.join(process.cwd(), ".orca", "skills");
  if (pathWithin(skill.dirPath, projectSkillsRoot)) {
    return "project";
  }

  const globalSkillsRoot = path.join(os.homedir(), ".orca", "skills");
  if (pathWithin(skill.dirPath, globalSkillsRoot)) {
    return "global";
  }

  return "config";
}

function formatSkillsTable(skills: LoadedSkill[], configSkillDirs: Set<string>): string {
  const headers = ["Name", "Description", "Source", "Path"];
  const rows = skills.map((skill) => [
    skill.name,
    skill.description,
    detectSkillSource(skill, configSkillDirs),
    skill.dirPath,
  ]);

  return formatTable(headers, rows);
}

export async function skillsCommandHandler(options: SkillsCommandOptions): Promise<void> {
  const config = await resolveConfig(options.config);
  const configSkillDirs = new Set((config?.skills ?? []).map((skillPath) => resolveConfigSkillDir(skillPath)));
  const skills = await loadSkills(config);

  if (skills.length === 0) {
    console.log("No skills found.");
    return;
  }

  console.log(formatSkillsTable(skills, configSkillDirs));
}

export function registerSkillsCommand(program: Command): void {
  program
    .command("skills")
    .description("List available skills")
    .option("--config <path>", "Path to orca config file")
    .action(async (options: SkillsCommandOptions) => skillsCommandHandler(options));
}
