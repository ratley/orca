import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { parseCodexEffort } from "../types/effort.js";
import type { HookName, OrcaConfig } from "../types/index.js";

const KNOWN_HOOK_NAMES: HookName[] = [
  "onMilestone",
  "onTaskComplete",
  "onTaskFail",
  "onInvalidPlan",
  "onFindings",
  "onComplete",
  "onError"
];

const knownHookNameSet = new Set<string>(KNOWN_HOOK_NAMES);

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
      if (!knownHookNameSet.has(hookName)) {
        throw new Error(
          `Unknown hook key in Config.hooks: ${hookName}. Allowed hooks: ${KNOWN_HOOK_NAMES.join(", ")}`
        );
      }

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
      if (!knownHookNameSet.has(hookName)) {
        throw new Error(
          `Unknown hook key in Config.hookCommands: ${hookName}. Allowed hooks: ${KNOWN_HOOK_NAMES.join(", ")}`
        );
      }

      if (typeof command !== "string") {
        throw new Error(
          `Config.hookCommands.${hookName} must be a string, got ${describeType(command)}`
        );
      }
    }
  }

  if ("executor" in candidate && candidate.executor !== undefined) {
    if (candidate.executor !== "codex") {
      const executorDisplay =
        typeof candidate.executor === "string"
          ? candidate.executor
          : (JSON.stringify(candidate.executor) ?? describeType(candidate.executor));

      throw new Error(
        `Config.executor must be 'codex', got ${executorDisplay}`
      );
    }
  }

  if ("codex" in candidate && candidate.codex !== undefined) {
    if (!isObject(candidate.codex)) {
      throw new Error(`Config.codex must be an object, got ${describeType(candidate.codex)}`);
    }

    if ("effort" in candidate.codex && candidate.codex.effort !== undefined) {
      if (typeof candidate.codex.effort !== "string") {
        throw new Error(
          `Config.codex.effort must be a string, got ${describeType(candidate.codex.effort)}`
        );
      }

      parseCodexEffort(candidate.codex.effort);
    }

    if ("thinking" in candidate.codex && candidate.codex.thinking !== undefined) {
      if (!isObject(candidate.codex.thinking)) {
        throw new Error(`Config.codex.thinking must be an object, got ${describeType(candidate.codex.thinking)}`);
      }

      for (const key of ["decision", "planning", "execution"] as const) {
        const value = candidate.codex.thinking[key];
        if (value !== undefined) {
          if (typeof value !== "string") {
            throw new Error(`Config.codex.thinking.${key} must be a string, got ${describeType(value)}`);
          }
          parseCodexEffort(value);
        }
      }
    }

    if ("perCwdExtraUserRoots" in candidate.codex && candidate.codex.perCwdExtraUserRoots !== undefined) {
      if (!Array.isArray(candidate.codex.perCwdExtraUserRoots)) {
        throw new Error(
          `Config.codex.perCwdExtraUserRoots must be an array, got ${describeType(candidate.codex.perCwdExtraUserRoots)}`
        );
      }

      for (const entry of candidate.codex.perCwdExtraUserRoots) {
        if (!isObject(entry)) {
          throw new Error(
            `Config.codex.perCwdExtraUserRoots entries must be objects, got ${describeType(entry)}`
          );
        }

        if (typeof entry.cwd !== "string") {
          throw new Error(
            `Config.codex.perCwdExtraUserRoots[].cwd must be a string, got ${describeType(entry.cwd)}`
          );
        }

        if (!Array.isArray(entry.extraUserRoots)) {
          throw new Error(
            `Config.codex.perCwdExtraUserRoots[].extraUserRoots must be an array, got ${describeType(entry.extraUserRoots)}`
          );
        }

        for (const root of entry.extraUserRoots) {
          if (typeof root !== "string") {
            throw new Error(
              `Config.codex.perCwdExtraUserRoots[].extraUserRoots entries must be strings, got ${describeType(root)}`
            );
          }
        }
      }
    }
  }

  if ("review" in candidate && candidate.review !== undefined) {
    if (!isObject(candidate.review)) {
      throw new Error(`Config.review must be an object, got ${describeType(candidate.review)}`);
    }

    // legacy compatibility: allow top-level review.enabled / review.onInvalid
    if ("enabled" in candidate.review && candidate.review.enabled !== undefined && typeof candidate.review.enabled !== "boolean") {
      throw new Error(`Config.review.enabled must be a boolean, got ${describeType(candidate.review.enabled)}`);
    }

    if ("onInvalid" in candidate.review && candidate.review.onInvalid !== undefined) {
      if (candidate.review.onInvalid !== "fail" && candidate.review.onInvalid !== "warn_skip") {
        const onInvalidDisplay =
          typeof candidate.review.onInvalid === "string"
            ? candidate.review.onInvalid
            : (JSON.stringify(candidate.review.onInvalid) ?? describeType(candidate.review.onInvalid));
        throw new Error(`Config.review.onInvalid must be 'fail' or 'warn_skip', got ${onInvalidDisplay}`);
      }
    }

    if ("plan" in candidate.review && candidate.review.plan !== undefined) {
      if (!isObject(candidate.review.plan)) {
        throw new Error(`Config.review.plan must be an object, got ${describeType(candidate.review.plan)}`);
      }

      if ("enabled" in candidate.review.plan && candidate.review.plan.enabled !== undefined && typeof candidate.review.plan.enabled !== "boolean") {
        throw new Error(`Config.review.plan.enabled must be a boolean, got ${describeType(candidate.review.plan.enabled)}`);
      }

      if ("onInvalid" in candidate.review.plan && candidate.review.plan.onInvalid !== undefined) {
        if (candidate.review.plan.onInvalid !== "fail" && candidate.review.plan.onInvalid !== "warn_skip") {
          const onInvalidDisplay =
            typeof candidate.review.plan.onInvalid === "string"
              ? candidate.review.plan.onInvalid
              : (JSON.stringify(candidate.review.plan.onInvalid) ?? describeType(candidate.review.plan.onInvalid));
          throw new Error(`Config.review.plan.onInvalid must be 'fail' or 'warn_skip', got ${onInvalidDisplay}`);
        }
      }
    }

    if ("execution" in candidate.review && candidate.review.execution !== undefined) {
      if (!isObject(candidate.review.execution)) {
        throw new Error(`Config.review.execution must be an object, got ${describeType(candidate.review.execution)}`);
      }

      if ("enabled" in candidate.review.execution && candidate.review.execution.enabled !== undefined && typeof candidate.review.execution.enabled !== "boolean") {
        throw new Error(`Config.review.execution.enabled must be a boolean, got ${describeType(candidate.review.execution.enabled)}`);
      }

      if ("maxCycles" in candidate.review.execution && candidate.review.execution.maxCycles !== undefined) {
        if (typeof candidate.review.execution.maxCycles !== "number" || !Number.isInteger(candidate.review.execution.maxCycles) || candidate.review.execution.maxCycles < 1) {
          const maxCyclesDisplay = typeof candidate.review.execution.maxCycles === "number"
            ? candidate.review.execution.maxCycles
            : (JSON.stringify(candidate.review.execution.maxCycles) ?? describeType(candidate.review.execution.maxCycles));
          throw new Error(`Config.review.execution.maxCycles must be an integer >= 1, got ${maxCyclesDisplay}`);
        }
      }

      if ("onFindings" in candidate.review.execution && candidate.review.execution.onFindings !== undefined) {
        if (candidate.review.execution.onFindings !== "auto_fix" && candidate.review.execution.onFindings !== "report_only" && candidate.review.execution.onFindings !== "fail") {
          const display = typeof candidate.review.execution.onFindings === "string"
            ? candidate.review.execution.onFindings
            : (JSON.stringify(candidate.review.execution.onFindings) ?? describeType(candidate.review.execution.onFindings));
          throw new Error(`Config.review.execution.onFindings must be 'auto_fix', 'report_only', or 'fail', got ${display}`);
        }
      }

      if ("prompt" in candidate.review.execution && candidate.review.execution.prompt !== undefined && typeof candidate.review.execution.prompt !== "string") {
        throw new Error(`Config.review.execution.prompt must be a string, got ${describeType(candidate.review.execution.prompt)}`);
      }

      if ("validator" in candidate.review.execution && candidate.review.execution.validator !== undefined) {
        if (!isObject(candidate.review.execution.validator)) {
          throw new Error(`Config.review.execution.validator must be an object, got ${describeType(candidate.review.execution.validator)}`);
        }

        if ("auto" in candidate.review.execution.validator && candidate.review.execution.validator.auto !== undefined && typeof candidate.review.execution.validator.auto !== "boolean") {
          throw new Error(`Config.review.execution.validator.auto must be a boolean, got ${describeType(candidate.review.execution.validator.auto)}`);
        }

        if ("commands" in candidate.review.execution.validator && candidate.review.execution.validator.commands !== undefined) {
          if (!Array.isArray(candidate.review.execution.validator.commands)) {
            throw new Error(`Config.review.execution.validator.commands must be an array, got ${describeType(candidate.review.execution.validator.commands)}`);
          }

          for (const command of candidate.review.execution.validator.commands) {
            if (typeof command !== "string") {
              throw new Error(`Config.review.execution.validator.commands entries must be strings, got ${describeType(command)}`);
            }
          }
        }
      }
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
  "runsDir" | "sessionLogs" | "maxRetries" | "openaiApiKey" | "executor"
>> = ["runsDir", "sessionLogs", "maxRetries", "openaiApiKey", "executor"];

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
      const mergedThinking = (merged.codex?.thinking !== undefined || config.codex?.thinking !== undefined)
        ? {
          ...merged.codex?.thinking,
          ...config.codex?.thinking
        }
        : undefined;

      merged.codex = {
        ...merged.codex,
        ...config.codex,
        ...(mergedThinking !== undefined ? { thinking: mergedThinking } : {})
      };
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
          ...config.review?.plan
        },
        execution: {
          ...merged.review?.execution,
          ...config.review?.execution,
          validator: {
            ...merged.review?.execution?.validator,
            ...config.review?.execution?.validator
          }
        }
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
  cliConfigPath?: string
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
