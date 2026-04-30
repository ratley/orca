import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { OrcaConfigSchema, type OrcaConfig } from "../types/index.js";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function formatConfigPath(pathParts: PropertyKey[]): string {
  if (pathParts.length === 0) {
    return "Config";
  }

  return `Config.${pathParts.map(String).join(".")}`;
}

function formatConfigIssue(issue: { path: PropertyKey[]; message: string }): string {
  if (issue.message.startsWith("Config.") || issue.message.startsWith("Unknown hook key")) {
    return issue.message;
  }

  if (
    issue.message === "must be a string" &&
    issue.path.join(".").match(/^codex\.perCwdExtraUserRoots\.\d+\.extraUserRoots\.\d+$/)
  ) {
    return "Config.codex.perCwdExtraUserRoots[].extraUserRoots entries must be strings";
  }

  return `${formatConfigPath(issue.path)} ${issue.message}`;
}

function coerceConfig(candidate: unknown): OrcaConfig {
  if (!isObject(candidate)) {
    throw new Error("Config module must export an object");
  }

  if ("executor" in candidate && candidate.executor !== undefined) {
    candidate.executor = "codex";
  }

  const parsed = OrcaConfigSchema.safeParse(candidate);
  if (!parsed.success) {
    const [firstIssue] = parsed.error.issues;
    throw new Error(firstIssue ? formatConfigIssue(firstIssue) : "Config module is invalid");
  }

  return parsed.data as OrcaConfig;
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

const TOP_LEVEL_SCALARS: Array<
  keyof Pick<OrcaConfig, "runsDir" | "sessionLogs" | "maxRetries" | "openaiApiKey" | "executor">
> = ["runsDir", "sessionLogs", "maxRetries", "openaiApiKey", "executor"];

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

    if (merged.codex !== undefined || config.codex !== undefined) {
      const mergedThinkingLevel =
        merged.codex?.thinkingLevel !== undefined || config.codex?.thinkingLevel !== undefined
          ? {
              ...merged.codex?.thinkingLevel,
              ...config.codex?.thinkingLevel,
            }
          : undefined;

      merged.codex = {
        ...merged.codex,
        ...config.codex,
        ...(mergedThinkingLevel !== undefined ? { thinkingLevel: mergedThinkingLevel } : {}),
      };
    }

    if (merged.planner !== undefined || config.planner !== undefined) {
      const mergedRouter =
        merged.planner?.router !== undefined || config.planner?.router !== undefined
          ? {
              ...merged.planner?.router,
              ...config.planner?.router,
            }
          : undefined;
      const mergedPlannerWithoutRouter = { ...merged.planner };
      const configPlannerWithoutRouter = { ...config.planner };
      delete (mergedPlannerWithoutRouter as { router?: unknown }).router;
      delete (configPlannerWithoutRouter as { router?: unknown }).router;

      merged.planner = {
        ...mergedPlannerWithoutRouter,
        ...configPlannerWithoutRouter,
        ...(mergedRouter !== undefined && config.planner?.agent !== "claude" && config.planner?.agent !== "codex"
          ? { router: mergedRouter }
          : {}),
      };
    }

    if (merged.claude !== undefined || config.claude !== undefined) {
      merged.claude = { ...merged.claude, ...config.claude };
    }

    if (merged.pr !== undefined || config.pr !== undefined) {
      merged.pr = { ...merged.pr, ...config.pr };
    }

    if (merged.review !== undefined || config.review !== undefined) {
      merged.review = {
        ...merged.review,
        ...config.review,
        plan: {
          ...merged.review?.plan,
          ...config.review?.plan,
        },
        execution: {
          ...merged.review?.execution,
          ...config.review?.execution,
          validator: {
            ...merged.review?.execution?.validator,
            ...config.review?.execution?.validator,
          },
        },
      };
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
  cliConfigPath?: string,
): Promise<OrcaConfig | undefined> {
  const globalConfig = await loadOptionalConfig(globalConfigPath);
  const projectConfig = await loadOptionalConfig(projectConfigPath);
  const cliConfig = await loadConfig(cliConfigPath);

  return mergeConfigs(globalConfig, projectConfig, cliConfig);
}

export async function resolveConfig(cliConfigPath?: string): Promise<OrcaConfig | undefined> {
  const globalJsConfigPath = path.join(os.homedir(), ".orca", "config.js");
  const globalTsConfigPath = path.join(os.homedir(), ".orca", "config.ts");
  const projectJsConfigPath = path.join(process.cwd(), "orca.config.js");
  const projectTsConfigPath = path.join(process.cwd(), "orca.config.ts");

  let globalConfigPath = globalTsConfigPath;
  try {
    await access(globalTsConfigPath, fsConstants.R_OK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    globalConfigPath = globalJsConfigPath;
  }

  let projectConfigPath = projectTsConfigPath;
  try {
    await access(projectTsConfigPath, fsConstants.R_OK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    projectConfigPath = projectJsConfigPath;
  }

  return resolveConfigFromPaths(globalConfigPath, projectConfigPath, cliConfigPath);
}
