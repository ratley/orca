import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { OrcaConfig } from "../types/index.js";

const CODEX_CONFIG_DIR = ".codex";
const CODEX_CONFIG_FILE = "config.toml";

const ORCA_MULTI_AGENT_BLOCK = `# Managed by orca — remove this file or set multi_agent = false to disable
[features]
multi_agent = true
`;

function isMultiAgentEnabled(config?: OrcaConfig): boolean {
  // Default: on. Only disable if explicitly set to false.
  return config?.codex?.multiAgent !== false;
}

function containsMultiAgentSetting(content: string): boolean {
  return /multi_agent\s*=/.test(content);
}

/**
 * Ensures `.codex/config.toml` in `cwd` has `multi_agent = true` set.
 *
 * - If the file doesn't exist: creates it with the orca-managed block.
 * - If the file exists and already has `multi_agent`: leaves it alone (user owns it).
 * - If the file exists but has no `multi_agent`: appends the feature block.
 * - If `multiAgent` is false in orca config: skips entirely.
 *
 * Returns a description of what was done (for logging).
 */
export async function ensureCodexMultiAgent(
  cwd: string,
  config?: OrcaConfig,
): Promise<{ action: "skipped" | "created" | "appended" | "already-set"; path: string }> {
  const configDir = path.join(cwd, CODEX_CONFIG_DIR);
  const configPath = path.join(configDir, CODEX_CONFIG_FILE);

  if (!isMultiAgentEnabled(config)) {
    return { action: "skipped", path: configPath };
  }

  // Check if file exists
  let existingContent: string | null = null;
  try {
    await access(configPath, fsConstants.R_OK);
    existingContent = await readFile(configPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
    // File doesn't exist — we'll create it
  }

  if (existingContent === null) {
    // Create .codex/ dir if needed and write fresh config
    await mkdir(configDir, { recursive: true });
    await writeFile(configPath, ORCA_MULTI_AGENT_BLOCK, "utf8");
    return { action: "created", path: configPath };
  }

  if (containsMultiAgentSetting(existingContent)) {
    // Already has multi_agent = something — don't touch it
    return { action: "already-set", path: configPath };
  }

  // Append our feature block to the existing file
  const separator = existingContent.endsWith("\n") ? "\n" : "\n\n";
  await writeFile(configPath, `${existingContent}${separator}${ORCA_MULTI_AGENT_BLOCK}`, "utf8");
  return { action: "appended", path: configPath };
}
