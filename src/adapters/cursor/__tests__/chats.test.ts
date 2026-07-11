import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

import {
  getSessionDir,
  hashWorkspacePath,
  readSessionMeta,
  resolveWorkspaceRealpath,
} from "../chats";
import { sessionMetaFixture } from "./fixtures.test";
import { seedSession } from "./helpers.test";

describe("cursor chats store helpers", () => {
  let cursorHome: string;

  beforeEach(async () => {
    cursorHome = await fs.mkdtemp(path.join(os.tmpdir(), "orca-cursor-chats-"));
  });

  afterEach(async () => {
    await fs.rm(cursorHome, { recursive: true, force: true });
  });

  test("hashWorkspacePath matches the empirically recorded chats-dir hash", () => {
    // Recorded 2026-07-11: sessions started in this workspace landed in
    // ~/.cursor/chats/8fc36594199974b0e0a7f74ecf0d2db0/.
    expect(hashWorkspacePath("/Users/bradleyinniss/dev/orca-dev")).toBe(
      "8fc36594199974b0e0a7f74ecf0d2db0",
    );
  });

  test("hashWorkspacePath of a REALPATH matches the recorded live-session hash", () => {
    // Recorded 2026-07-11: a session dispatched with --workspace
    // /var/folders/.../orca-cursor-live-hWUfXb (macOS tmp symlink) landed in
    // the chats dir keyed by the md5 of the RESOLVED path.
    expect(
      hashWorkspacePath(
        "/private/var/folders/9j/14s8h3fn0cx42hgz7my_jh3c0000gn/T/orca-cursor-live-hWUfXb",
      ),
    ).toBe("83d196f4377beb64f7c6f3227d6d95f7");
  });

  test("resolveWorkspaceRealpath resolves symlinks and falls back when missing", async () => {
    const real = await fs.mkdtemp(path.join(os.tmpdir(), "orca-cursor-real-"));
    const link = path.join(cursorHome, "workspace-link");
    await fs.symlink(real, link);

    try {
      expect(await resolveWorkspaceRealpath(link)).toBe(await fs.realpath(real));
      expect(await resolveWorkspaceRealpath("/tmp/does-not-exist-anywhere-xyz")).toBe(
        "/tmp/does-not-exist-anywhere-xyz",
      );
    } finally {
      await fs.rm(real, { recursive: true, force: true });
    }
  });

  test("getSessionDir composes chats/<md5(cwd)>/<sessionId>", () => {
    const dir = getSessionDir("/home/x/.cursor", "/tmp/proj", "abc-123");
    expect(dir).toBe(
      path.join("/home/x/.cursor", "chats", hashWorkspacePath("/tmp/proj"), "abc-123"),
    );
  });

  test("readSessionMeta round-trips the recorded meta.json shape", async () => {
    await seedSession(cursorHome, "/tmp/proj", "abc-123", sessionMetaFixture({ cwd: "/tmp/proj" }));

    const meta = await readSessionMeta(cursorHome, "/tmp/proj", "abc-123");
    expect(meta).toEqual({
      schemaVersion: 1,
      createdAtMs: 1783780270140,
      hasConversation: true,
      updatedAtMs: 1783780279051,
      cwd: "/tmp/proj",
    });
  });

  test("readSessionMeta returns null for missing or corrupt meta.json", async () => {
    expect(await readSessionMeta(cursorHome, "/tmp/proj", "missing")).toBeNull();

    const dir = getSessionDir(cursorHome, "/tmp/proj", "corrupt");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "meta.json"), "{not json", "utf8");
    expect(await readSessionMeta(cursorHome, "/tmp/proj", "corrupt")).toBeNull();
  });
});
