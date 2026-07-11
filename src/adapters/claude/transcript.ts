import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

/**
 * Claude Code persists transcripts under
 * `<configDir>/projects/<projectKey>/<sessionId>.jsonl` where the project key
 * is the session cwd with every character outside [a-zA-Z0-9] replaced by
 * "-". Pinned by live probes on 2026-07-11 (Claude Code 2.1.207):
 *
 * - `/Users/bradleyinniss/.agents/skills` -> `-Users-bradleyinniss--agents-skills`
 *   (both `/` and `.` become `-`).
 * - `.../scratchpad/probe_под.dir` -> `...-scratchpad-probe-----dir`
 *   (`_`, non-ASCII letters, and `.` each become one `-`).
 *
 * Claude derives the key from the REALPATH of its working directory (probed
 * on macOS: a cwd under the `/var -> /private/var` symlink produced a
 * `-private-var-...` key). Resolve symlinks before computing the key.
 */
export function claudeProjectKey(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * Resolves the cwd the same way Claude Code sees it (symlinks resolved).
 * Falls back to the given path when it cannot be resolved.
 */
export async function resolveProjectCwd(cwd: string): Promise<string> {
  try {
    return await fs.realpath(cwd);
  } catch {
    return cwd;
  }
}

/** Claude Code config dir; CLAUDE_CONFIG_DIR overrides ~/.claude. */
export function resolveClaudeConfigDir(): string {
  const override = process.env.CLAUDE_CONFIG_DIR;
  if (override !== undefined && override !== "") {
    return override;
  }

  return path.join(os.homedir(), ".claude");
}

export function transcriptPath(configDir: string, cwd: string, sessionId: string): string {
  return path.join(configDir, "projects", claudeProjectKey(cwd), `${sessionId}.jsonl`);
}

export interface TranscriptStat {
  exists: boolean;
  size: number;
  mtimeMs: number;
}

export async function statTranscript(filePath: string): Promise<TranscriptStat> {
  try {
    const stat = await fs.stat(filePath);
    return { exists: true, size: stat.size, mtimeMs: stat.mtimeMs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false, size: 0, mtimeMs: 0 };
    }

    throw error;
  }
}
