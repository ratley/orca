import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { parseCodexEffort } from "../types/effort.js";
import type {
  HookName,
  OrcaConfig,
  OrcaFlowConfig,
  OrcaFlowOverridesConfig
} from "../types/index.js";

const KNOWN_HOOK_NAMES: HookName[] = [
  "onMilestone",
  "onQuestion",
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

function requireConfigObject(value: unknown, pathLabel: string): Record<string, unknown> {
  if (!isObject(value) || Array.isArray(value)) {
    throw new Error(`${pathLabel} must be an object, got ${describeType(value)}`);
  }

  return value;
}

function assertAllowedKeys(
  object: Record<string, unknown>,
  pathLabel: string,
  allowedKeys: readonly string[]
): void {
  const allowed = new Set(allowedKeys);

  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) {
      throw new Error(
        `${pathLabel}.${key} is not supported. Allowed keys: ${allowedKeys.join(", ")}`
      );
    }
  }
}

function assertOptionalString(
  object: Record<string, unknown>,
  key: string,
  pathLabel: string
): void {
  const value = object[key];
  if (value !== undefined && typeof value !== "string") {
    throw new Error(`${pathLabel} must be a string, got ${describeType(value)}`);
  }
}

function assertOptionalStringArray(
  object: Record<string, unknown>,
  key: string,
  pathLabel: string
): void {
  const value = object[key];
  if (value === undefined) {
    return;
  }

  if (!Array.isArray(value)) {
    throw new Error(`${pathLabel} must be an array, got ${describeType(value)}`);
  }

  for (const entry of value) {
    if (typeof entry !== "string") {
      throw new Error(`${pathLabel} entries must be strings, got ${describeType(entry)}`);
    }
  }
}

function coerceNestedFlowConfig(
  pathLabel: string,
  partialConfig: Record<string, unknown>
): void {
  try {
    coerceConfig(partialConfig);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${pathLabel}: ${message}`);
  }
}

function validatePromptSection(
  section: unknown,
  pathLabel: string,
  allowedKeys: readonly string[]
): Record<string, unknown> {
  const sectionObject = requireConfigObject(section, pathLabel);
  assertAllowedKeys(sectionObject, pathLabel, allowedKeys);
  assertOptionalString(sectionObject, "prompt", `${pathLabel}.prompt`);
  return sectionObject;
}

function validateFlowOverrides(overrides: unknown, pathLabel: string): void {
  const overridesObject = requireConfigObject(overrides, pathLabel);
  const allowedKeys = new Set(["skills", "maxRetries", "codex", "review", "hookCommands", "pr"]);

  for (const key of Object.keys(overridesObject)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`${pathLabel}.${key} is not supported`);
    }
  }

  coerceNestedFlowConfig(pathLabel, overridesObject);
}

function validateFlowPreset(preset: unknown, pathLabel: string): void {
  const flow = requireConfigObject(preset, pathLabel);
  assertAllowedKeys(flow, pathLabel, [
    "description",
    "baseline",
    "planning",
    "execution",
    "review",
    "overrides",
    "summary"
  ]);

  assertOptionalString(flow, "description", `${pathLabel}.description`);

  if ("baseline" in flow && flow.baseline !== undefined) {
    const baseline = validatePromptSection(flow.baseline, `${pathLabel}.baseline`, ["prompt", "skills"]);
    assertOptionalStringArray(baseline, "skills", `${pathLabel}.baseline.skills`);
  }

  if ("planning" in flow && flow.planning !== undefined) {
    const planning = validatePromptSection(flow.planning, `${pathLabel}.planning`, ["prompt", "review"]);
    if ("review" in planning && planning.review !== undefined) {
      coerceNestedFlowConfig(`${pathLabel}.planning.review`, {
        review: { plan: planning.review }
      });
    }
  }

  if ("execution" in flow && flow.execution !== undefined) {
    const execution = validatePromptSection(flow.execution, `${pathLabel}.execution`, [
      "prompt",
      "codex",
      "review"
    ]);
    if ("codex" in execution && execution.codex !== undefined) {
      coerceNestedFlowConfig(`${pathLabel}.execution.codex`, { codex: execution.codex });
    }
    if ("review" in execution && execution.review !== undefined) {
      coerceNestedFlowConfig(`${pathLabel}.execution.review`, {
        review: { task: execution.review }
      });
    }
  }

  if ("review" in flow && flow.review !== undefined) {
    coerceNestedFlowConfig(`${pathLabel}.review`, { review: flow.review });
  }

  if ("overrides" in flow && flow.overrides !== undefined) {
    validateFlowOverrides(flow.overrides, `${pathLabel}.overrides`);
  }

  if ("summary" in flow && flow.summary !== undefined) {
    validatePromptSection(flow.summary, `${pathLabel}.summary`, ["prompt"]);
  }
}

function validateFlowConfig(flow: unknown): void {
  const flowObject = requireConfigObject(flow, "Config.flow");
  assertAllowedKeys(flowObject, "Config.flow", ["default", "presets"]);

  if ("default" in flowObject && flowObject.default !== undefined) {
    if (typeof flowObject.default !== "string" || flowObject.default.trim().length === 0) {
      throw new Error(`Config.flow.default must be a non-empty string, got ${describeType(flowObject.default)}`);
    }
  }

  if ("presets" in flowObject && flowObject.presets !== undefined) {
    const presets = requireConfigObject(flowObject.presets, "Config.flow.presets");
    for (const [presetName, preset] of Object.entries(presets)) {
      if (presetName.trim().length === 0) {
        throw new Error("Config.flow.presets keys must be non-empty strings");
      }
      validateFlowPreset(preset, `Config.flow.presets.${presetName}`);
    }
  }
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
    candidate.executor = "codex";
  }

  if ("codex" in candidate && candidate.codex !== undefined) {
    if (!isObject(candidate.codex)) {
      throw new Error(`Config.codex must be an object, got ${describeType(candidate.codex)}`);
    }
    assertAllowedKeys(candidate.codex, "Config.codex", [
      "enabled",
      "model",
      "effort",
      "thinkingLevel",
      "command",
      "timeoutMs",
      "multiAgent",
      "maxParallelTasks",
      "perCwdExtraUserRoots",
      "thinking"
    ]);

    if ("effort" in candidate.codex && candidate.codex.effort !== undefined) {
      if (typeof candidate.codex.effort !== "string") {
        throw new Error(
          `Config.codex.effort must be a string, got ${describeType(candidate.codex.effort)}`
        );
      }

      candidate.codex.effort = parseCodexEffort(candidate.codex.effort);
    }

    if ("thinkingLevel" in candidate.codex && candidate.codex.thinkingLevel !== undefined) {
      if (!isObject(candidate.codex.thinkingLevel)) {
        throw new Error(`Config.codex.thinkingLevel must be an object, got ${describeType(candidate.codex.thinkingLevel)}`);
      }
      assertAllowedKeys(candidate.codex.thinkingLevel, "Config.codex.thinkingLevel", [
        "decision",
        "planning",
        "review",
        "execution"
      ]);

      for (const key of ["decision", "planning", "review", "execution"] as const) {
        const value = candidate.codex.thinkingLevel[key];
        if (value !== undefined) {
          if (typeof value !== "string") {
            throw new Error(`Config.codex.thinkingLevel.${key} must be a string, got ${describeType(value)}`);
          }
          candidate.codex.thinkingLevel[key] = parseCodexEffort(value);
        }
      }
    }

    if ("thinking" in candidate.codex && candidate.codex.thinking !== undefined) {
      throw new Error("Config.codex.thinking is no longer supported. Use Config.codex.thinkingLevel instead.");
    }

    if ("maxParallelTasks" in candidate.codex && candidate.codex.maxParallelTasks !== undefined) {
      if (typeof candidate.codex.maxParallelTasks !== "number" || !Number.isInteger(candidate.codex.maxParallelTasks) || candidate.codex.maxParallelTasks < 1) {
        const maxParallelTasksDisplay = typeof candidate.codex.maxParallelTasks === "number"
          ? candidate.codex.maxParallelTasks
          : (JSON.stringify(candidate.codex.maxParallelTasks) ?? describeType(candidate.codex.maxParallelTasks));
        throw new Error(`Config.codex.maxParallelTasks must be an integer >= 1, got ${maxParallelTasksDisplay}`);
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
    assertAllowedKeys(candidate.review, "Config.review", [
      "enabled",
      "onInvalid",
      "plan",
      "task",
      "execution"
    ]);

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
      assertAllowedKeys(candidate.review.plan, "Config.review.plan", ["enabled", "onInvalid"]);

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

    if ("task" in candidate.review && candidate.review.task !== undefined) {
      if (!isObject(candidate.review.task)) {
        throw new Error(`Config.review.task must be an object, got ${describeType(candidate.review.task)}`);
      }
      assertAllowedKeys(candidate.review.task, "Config.review.task", [
        "enabled",
        "maxCycles",
        "onFindings",
        "prompt"
      ]);

      if ("enabled" in candidate.review.task && candidate.review.task.enabled !== undefined && typeof candidate.review.task.enabled !== "boolean") {
        throw new Error(`Config.review.task.enabled must be a boolean, got ${describeType(candidate.review.task.enabled)}`);
      }

      if ("maxCycles" in candidate.review.task && candidate.review.task.maxCycles !== undefined) {
        if (typeof candidate.review.task.maxCycles !== "number" || !Number.isInteger(candidate.review.task.maxCycles) || candidate.review.task.maxCycles < 1) {
          const maxCyclesDisplay = typeof candidate.review.task.maxCycles === "number"
            ? candidate.review.task.maxCycles
            : (JSON.stringify(candidate.review.task.maxCycles) ?? describeType(candidate.review.task.maxCycles));
          throw new Error(`Config.review.task.maxCycles must be an integer >= 1, got ${maxCyclesDisplay}`);
        }
      }

      if ("onFindings" in candidate.review.task && candidate.review.task.onFindings !== undefined) {
        if (candidate.review.task.onFindings !== "auto_fix" && candidate.review.task.onFindings !== "report_only" && candidate.review.task.onFindings !== "fail") {
          const display = typeof candidate.review.task.onFindings === "string"
            ? candidate.review.task.onFindings
            : (JSON.stringify(candidate.review.task.onFindings) ?? describeType(candidate.review.task.onFindings));
          throw new Error(`Config.review.task.onFindings must be 'auto_fix', 'report_only', or 'fail', got ${display}`);
        }
      }

      if ("prompt" in candidate.review.task && candidate.review.task.prompt !== undefined && typeof candidate.review.task.prompt !== "string") {
        throw new Error(`Config.review.task.prompt must be a string, got ${describeType(candidate.review.task.prompt)}`);
      }
    }

    if ("execution" in candidate.review && candidate.review.execution !== undefined) {
      if (!isObject(candidate.review.execution)) {
        throw new Error(`Config.review.execution must be an object, got ${describeType(candidate.review.execution)}`);
      }
      assertAllowedKeys(candidate.review.execution, "Config.review.execution", [
        "enabled",
        "maxCycles",
        "onFindings",
        "validator",
        "prompt"
      ]);

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
        assertAllowedKeys(candidate.review.execution.validator, "Config.review.execution.validator", [
          "auto",
          "commands"
        ]);

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

  if ("flow" in candidate && candidate.flow !== undefined) {
    validateFlowConfig(candidate.flow);
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

function mergeStringArrays(
  previous: string[] | undefined,
  next: string[] | undefined
): string[] | undefined {
  if (previous === undefined && next === undefined) {
    return undefined;
  }

  return [...new Set([...(previous ?? []), ...(next ?? [])])];
}

function mergeCodexConfig(
  previous: OrcaConfig["codex"] | undefined,
  next: OrcaConfig["codex"] | undefined
): OrcaConfig["codex"] | undefined {
  return mergeConfigs(
    previous !== undefined ? { codex: previous } : undefined,
    next !== undefined ? { codex: next } : undefined
  )?.codex;
}

function mergeReviewConfig(
  previous: OrcaConfig["review"] | undefined,
  next: OrcaConfig["review"] | undefined
): OrcaConfig["review"] | undefined {
  return mergeConfigs(
    previous !== undefined ? { review: previous } : undefined,
    next !== undefined ? { review: next } : undefined
  )?.review;
}

function mergeFlowOverridesConfig(
  previous: OrcaFlowOverridesConfig | undefined,
  next: OrcaFlowOverridesConfig | undefined
): OrcaFlowOverridesConfig | undefined {
  return mergeConfigs(previous, next) as OrcaFlowOverridesConfig | undefined;
}

function mergeFlowPresetConfigs(
  previous: OrcaFlowConfig | undefined,
  next: OrcaFlowConfig
): OrcaFlowConfig {
  if (previous === undefined) {
    return next;
  }

  const baselineSkills = mergeStringArrays(previous.baseline?.skills, next.baseline?.skills);
  const baseline = previous.baseline !== undefined || next.baseline !== undefined
    ? {
        ...previous.baseline,
        ...next.baseline,
        ...(baselineSkills !== undefined ? { skills: baselineSkills } : {})
      }
    : undefined;

  const planningReview = mergeReviewConfig(
    previous.planning?.review !== undefined ? { plan: previous.planning.review } : undefined,
    next.planning?.review !== undefined ? { plan: next.planning.review } : undefined
  )?.plan;
  const planning = previous.planning !== undefined || next.planning !== undefined
    ? {
        ...previous.planning,
        ...next.planning,
        ...(planningReview !== undefined ? { review: planningReview } : {})
      }
    : undefined;

  const executionCodex = mergeCodexConfig(previous.execution?.codex, next.execution?.codex);
  const executionReview = mergeReviewConfig(
    previous.execution?.review !== undefined ? { task: previous.execution.review } : undefined,
    next.execution?.review !== undefined ? { task: next.execution.review } : undefined
  )?.task;
  const execution = previous.execution !== undefined || next.execution !== undefined
    ? {
        ...previous.execution,
        ...next.execution,
        ...(executionCodex !== undefined ? { codex: executionCodex } : {}),
        ...(executionReview !== undefined ? { review: executionReview } : {})
      }
    : undefined;
  const review = mergeReviewConfig(previous.review, next.review);
  const overrides = mergeFlowOverridesConfig(previous.overrides, next.overrides);

  return {
    ...previous,
    ...next,
    ...(baseline !== undefined ? { baseline } : {}),
    ...(planning !== undefined ? { planning } : {}),
    ...(execution !== undefined ? { execution } : {}),
    ...(review !== undefined ? { review } : {}),
    ...(overrides !== undefined ? { overrides } : {}),
    ...(previous.summary !== undefined || next.summary !== undefined
      ? { summary: { ...previous.summary, ...next.summary } }
      : {})
  };
}

function mergeFlowConfig(
  previous: OrcaConfig["flow"] | undefined,
  next: OrcaConfig["flow"] | undefined
): OrcaConfig["flow"] | undefined {
  if (previous === undefined && next === undefined) {
    return undefined;
  }

  const presets: Record<string, OrcaFlowConfig> = { ...previous?.presets };
  for (const [name, preset] of Object.entries(next?.presets ?? {})) {
    presets[name] = mergeFlowPresetConfigs(presets[name], preset);
  }

  return {
    ...previous,
    ...next,
    ...(Object.keys(presets).length > 0 ? { presets } : {})
  };
}

function validateResolvedFlowReferences(config: OrcaConfig): void {
  const defaultFlow = config.flow?.default;
  if (defaultFlow === undefined) {
    return;
  }

  const presets = config.flow?.presets ?? {};
  if (presets[defaultFlow] !== undefined) {
    return;
  }

  const available = Object.keys(presets);
  const suffix = available.length > 0
    ? ` Available flows: ${available.join(", ")}.`
    : " No flow presets are configured.";
  throw new Error(`Config.flow.default references unknown flow preset "${defaultFlow}".${suffix}`);
}

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
      const mergedThinkingLevel = (merged.codex?.thinkingLevel !== undefined || config.codex?.thinkingLevel !== undefined)
        ? {
          ...merged.codex?.thinkingLevel,
          ...config.codex?.thinkingLevel
        }
        : undefined;

      merged.codex = {
        ...merged.codex,
        ...config.codex,
        ...(mergedThinkingLevel !== undefined ? { thinkingLevel: mergedThinkingLevel } : {})
      };
    }

    if (merged.pr !== undefined || config.pr !== undefined) {
      merged.pr = { ...merged.pr, ...config.pr };
    }

    if (merged.flow !== undefined || config.flow !== undefined) {
      const mergedFlow = mergeFlowConfig(merged.flow, config.flow);
      if (mergedFlow !== undefined) {
        merged.flow = mergedFlow;
      }
    }

    if (merged.review !== undefined || config.review !== undefined) {
      const mergedTaskReview = (merged.review?.task !== undefined || config.review?.task !== undefined)
        ? {
          ...merged.review?.task,
          ...config.review?.task
        }
        : undefined;

      merged.review = {
        ...merged.review,
        ...config.review,
        plan: {
          ...merged.review?.plan,
          ...config.review?.plan
        },
        ...(mergedTaskReview !== undefined ? { task: mergedTaskReview } : {}),
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

  validateResolvedFlowReferences(merged);
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
