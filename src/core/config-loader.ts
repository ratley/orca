import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { OrcaConfig } from "../types/index.js";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function describeType(value: unknown): string {
  if (value === null) {
    return "null";
  }

  if (Array.isArray(value)) {
    return "array";
  }

  return typeof value;
}

function coerceConfig(candidate: unknown): OrcaConfig {
  if (!isObject(candidate)) {
    throw new Error("Config module must export an object");
  }

  if ("skills" in candidate && candidate.skills !== undefined) {
    if (!Array.isArray(candidate.skills)) {
      throw new Error(`Config.skills must be an array, got ${describeType(candidate.skills)}`);
    }

    for (const skillPath of candidate.skills) {
      if (typeof skillPath !== "string") {
        throw new Error(
          `Config.skills entries must be strings, got ${describeType(skillPath)}`
        );
      }
    }
  }

  if ("hooks" in candidate && candidate.hooks !== undefined) {
    if (!isObject(candidate.hooks)) {
      throw new Error(`Config.hooks must be an object, got ${describeType(candidate.hooks)}`);
    }

    for (const [hookName, handler] of Object.entries(candidate.hooks)) {
      if (typeof handler !== "function") {
        throw new Error(
          `Config.hooks.${hookName} must be a function, got ${describeType(handler)}`
        );
      }
    }
  }

  if ("hookCommands" in candidate && candidate.hookCommands !== undefined) {
    if (!isObject(candidate.hookCommands)) {
      throw new Error(
        `Config.hookCommands must be an object, got ${describeType(candidate.hookCommands)}`
      );
    }

    for (const [hookName, command] of Object.entries(candidate.hookCommands)) {
      if (typeof command !== "string") {
        throw new Error(
          `Config.hookCommands.${hookName} must be a string, got ${describeType(command)}`
        );
      }
    }
  }

  if ("executor" in candidate && candidate.executor !== undefined) {
    if (candidate.executor !== "claude" && candidate.executor !== "codex") {
      throw new Error(
        `Config.executor must be 'claude' or 'codex', got ${String(candidate.executor)}`
      );
    }
  }

  return candidate as OrcaConfig;
}

export async function loadConfig(configPath?: string): Promise<OrcaConfig | undefined> {
  if (!configPath) {
    return undefined;
  }

  const resolvedPath = path.resolve(configPath);
  await access(resolvedPath, fsConstants.R_OK);

  const moduleUrl = pathToFileURL(resolvedPath).href;
  const importedModule = await import(moduleUrl);
  const configCandidate = "default" in importedModule ? importedModule.default : importedModule;

  return coerceConfig(configCandidate);
}

const TOP_LEVEL_SCALARS: Array<keyof Pick<
  OrcaConfig,
  "runsDir" | "sessionLogs" | "maxRetries" | "anthropicApiKey" | "openaiApiKey" | "executor"
>> = ["runsDir", "sessionLogs", "maxRetries", "anthropicApiKey", "openaiApiKey", "executor"];

export function mergeConfigs(...configs: Array<OrcaConfig | undefined>): OrcaConfig | undefined {
  const presentConfigs = configs.filter((config): config is OrcaConfig => config !== undefined);
  if (presentConfigs.length === 0) {
    return undefined;
  }

  const merged: OrcaConfig = {};

  for (const config of presentConfigs) {
    for (const key of TOP_LEVEL_SCALARS) {
      if (key in config) {
        (merged as Record<string, unknown>)[key] = (config as Record<string, unknown>)[key];
      }
    }

    if (merged.claude !== undefined || config.claude !== undefined) {
      merged.claude = { ...merged.claude, ...config.claude };
    }

    if (merged.codex !== undefined || config.codex !== undefined) {
      merged.codex = { ...merged.codex, ...config.codex };
    }

    if (merged.pr !== undefined || config.pr !== undefined) {
      merged.pr = { ...merged.pr, ...config.pr };
    }

    if (merged.hooks !== undefined || config.hooks !== undefined) {
      merged.hooks = { ...merged.hooks, ...config.hooks };
    }

    if (merged.hookCommands !== undefined || config.hookCommands !== undefined) {
      merged.hookCommands = { ...merged.hookCommands, ...config.hookCommands };
    }

    if (config.skills !== undefined) {
      merged.skills = [...new Set([...(merged.skills ?? []), ...config.skills])];
    }
  }

  return merged;
}

async function loadOptionalConfig(configPath: string): Promise<OrcaConfig | undefined> {
  const resolvedPath = path.resolve(configPath);

  try {
    await access(resolvedPath, fsConstants.R_OK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }

  return loadConfig(resolvedPath);
}

export async function resolveConfigFromPaths(
  globalConfigPath: string,
  projectConfigPath: string,
  cliConfigPath?: string
): Promise<OrcaConfig | undefined> {
  const globalConfig = await loadOptionalConfig(globalConfigPath);
  const projectConfig = await loadOptionalConfig(projectConfigPath);
  const cliConfig = await loadConfig(cliConfigPath);

  return mergeConfigs(globalConfig, projectConfig, cliConfig);
}

export async function resolveConfig(cliConfigPath?: string): Promise<OrcaConfig | undefined> {
  const globalConfigPath = path.join(os.homedir(), ".orca", "config.js");
  const projectJsConfigPath = path.join(process.cwd(), "orca.config.js");
  const projectTsConfigPath = path.join(process.cwd(), "orca.config.ts");

  let projectConfigPath = projectJsConfigPath;
  try {
    await access(projectJsConfigPath, fsConstants.R_OK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    projectConfigPath = projectTsConfigPath;
  }

  return resolveConfigFromPaths(globalConfigPath, projectConfigPath, cliConfigPath);
}
