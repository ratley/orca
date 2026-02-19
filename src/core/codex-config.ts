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

function isMultiAgentEnabled(config?: OrcaConfig): boolean {
  // Default: off. Only enable if explicitly set to true.
  return config?.codex?.multiAgent === true;
}

function containsMultiAgentSetting(content: string): boolean {
  return /multi_agent\s*=/.test(content);
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
