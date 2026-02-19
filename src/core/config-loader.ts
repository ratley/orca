import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
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
