import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { OrcaConfig } from "../types/index.js";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function coerceConfig(candidate: unknown): OrcaConfig {
  if (!isObject(candidate)) {
    throw new Error("Config module must export an object");
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
