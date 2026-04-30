import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { OrcaConfig } from "../types/index.js";

const CODEX_HOME = path.join(os.homedir(), ".codex");
const GLOBAL_CONFIG_FILE = path.join(CODEX_HOME, "config.toml");

const ORCA_MULTI_AGENT_BLOCK = `# Added by orca — remove or set multi_agent = false to disable
[features]
multi_agent = true
`;

function getExplicitMultiAgentSetting(config?: OrcaConfig): boolean | undefined {
  return typeof config?.codex?.multiAgent === "boolean" ? config.codex.multiAgent : undefined;
}

function isMultiAgentEnabled(config?: OrcaConfig): boolean {
  // Default: off. Only enable if explicitly set to true.
  return getExplicitMultiAgentSetting(config) === true;
}

function containsMultiAgentSetting(content: string): boolean {
  return /multi_agent\s*=/.test(content);
}

function isRootFeaturesSection(sectionPath: string[]): boolean {
  return sectionPath.length === 1 && sectionPath[0] === "features";
}

function parseSectionPath(line: string): string[] | null {
  const match = line.match(/^\[(.+)\]$/);
  if (!match?.[1]) {
    return null;
  }

  return match[1]
    .split(".")
    .map((part) => part.trim().replace(/^"(.*)"$/, "$1"))
    .filter((part) => part.length > 0);
}

function hasEnabledRootMultiAgentSetting(content: string): boolean {
  let currentSection: string[] = [];

  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.replace(/\s+#.*$/u, "").trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }

    const sectionPath = parseSectionPath(line);
    if (sectionPath !== null) {
      currentSection = sectionPath;
      continue;
    }

    if (!isRootFeaturesSection(currentSection)) {
      continue;
    }

    const match = line.match(/^multi_agent\s*=\s*(true|false)\s*$/u);
    if (!match?.[1]) {
      continue;
    }

    return match[1] === "true";
  }

  return false;
}

export async function isCodexMultiAgentActive(config?: OrcaConfig, _configFile?: string): Promise<boolean> {
  const explicitMultiAgentSetting = getExplicitMultiAgentSetting(config);
  if (explicitMultiAgentSetting !== undefined) {
    return explicitMultiAgentSetting;
  }

  const configFile = _configFile ?? GLOBAL_CONFIG_FILE;

  let existingContent: string;
  try {
    existingContent = await readFile(configFile, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw err;
  }

  return hasEnabledRootMultiAgentSetting(existingContent);
}

/**
 * Ensures `~/.codex/config.toml` has `multi_agent = true` set.
 *
 * Uses the global config (not project-scoped) to avoid the "trusted projects"
 * restriction that prevents project-level config from being loaded headlessly.
 *
 * - If the file doesn't exist: creates it with the multi_agent block.
 * - If the file exists and already has `multi_agent`: leaves it alone.
 * - If the file exists but has no `multi_agent`: appends the feature block.
 * - If `multiAgent` is false in orca config: skips entirely.
 *
 * @param config - Orca config (checks codex.multiAgent flag)
 * @param _configFile - Override config file path (for testing only)
 */
export async function ensureCodexMultiAgent(
  config?: OrcaConfig,
  _configFile?: string,
): Promise<{ action: "skipped" | "created" | "appended" | "already-set"; path: string }> {
  const configFile = _configFile ?? GLOBAL_CONFIG_FILE;

  if (!isMultiAgentEnabled(config)) {
    return { action: "skipped", path: configFile };
  }

  let existingContent: string | null = null;
  try {
    await access(configFile, fsConstants.R_OK);
    existingContent = await readFile(configFile, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }

  if (existingContent === null) {
    await mkdir(path.dirname(configFile), { recursive: true });
    await writeFile(configFile, ORCA_MULTI_AGENT_BLOCK, "utf8");
    return { action: "created", path: configFile };
  }

  if (containsMultiAgentSetting(existingContent)) {
    return { action: "already-set", path: configFile };
  }

  const separator = existingContent.endsWith("\n") ? "\n" : "\n\n";
  await writeFile(configFile, `${existingContent}${separator}${ORCA_MULTI_AGENT_BLOCK}`, "utf8");
  return { action: "appended", path: configFile };
}
