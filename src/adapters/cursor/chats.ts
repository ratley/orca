import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

import { z } from "zod";

/**
 * Helpers for Cursor's native chats store.
 *
 * Layout (verified empirically 2026-07-11 against cursor-agent 2026.07.09):
 *
 *   ~/.cursor/chats/<md5 of the ABSOLUTE workspace path, lowercase hex>/<session_id>/
 *     meta.json   {"schemaVersion":1,"createdAtMs":...,"hasConversation":true,
 *                  "updatedAtMs":...,"cwd":"/abs/workspace/path"}
 *     store.db
 *
 * Recorded verification: md5("/Users/bradleyinniss/dev/orca-dev") ===
 * "8fc36594199974b0e0a7f74ecf0d2db0", which matched the on-disk chats dir for
 * sessions started in that workspace.
 *
 * Cursor hashes the REALPATH of the workspace (symlinks resolved). Recorded
 * 2026-07-11: a session started in /var/folders/... (macOS tmp, a symlink
 * into /private/var) landed under md5("/private/var/folders/...") and its
 * meta.json cwd carried the resolved path. Callers must resolve the lane cwd
 * with resolveWorkspaceRealpath() before any native-store lookup.
 */

export function resolveCursorHome(): string {
  return path.join(os.homedir(), ".cursor");
}

/** Cursor keys chat sessions by the md5 of the absolute workspace path string. */
export function hashWorkspacePath(cwd: string): string {
  return crypto.createHash("md5").update(cwd).digest("hex");
}

/**
 * Resolves a workspace path the way Cursor does before hashing it: symlinks
 * resolved. Falls back to the given path when it cannot be resolved (e.g. it
 * no longer exists).
 */
export async function resolveWorkspaceRealpath(cwd: string): Promise<string> {
  try {
    return await fs.realpath(cwd);
  } catch {
    return cwd;
  }
}

export function getSessionDir(cursorHome: string, cwd: string, sessionId: string): string {
  return path.join(cursorHome, "chats", hashWorkspacePath(cwd), sessionId);
}

const SessionMetaSchema = z.object({
  schemaVersion: z.number().optional(),
  createdAtMs: z.number().optional(),
  updatedAtMs: z.number().optional(),
  hasConversation: z.boolean().optional(),
  cwd: z.string().optional(),
});
export type SessionMeta = z.infer<typeof SessionMetaSchema>;

/** Returns the parsed session meta.json, or null when missing or unreadable. */
export async function readSessionMeta(
  cursorHome: string,
  cwd: string,
  sessionId: string,
): Promise<SessionMeta | null> {
  const metaPath = path.join(getSessionDir(cursorHome, cwd, sessionId), "meta.json");

  let raw: string;
  try {
    raw = await fs.readFile(metaPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw error;
  }

  try {
    return SessionMetaSchema.parse(JSON.parse(raw));
  } catch {
    // A corrupt meta.json means continuity cannot be verified from it.
    return null;
  }
}
