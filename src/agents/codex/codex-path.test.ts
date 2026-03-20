import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";

import {
  clearResolvedCodexPathCacheForTests,
  compareCodexCliVersions,
  resolveCodexPathsOnPath,
  parseCodexCliVersion,
  selectPreferredCodexBinary,
} from "./codex-path.js";

describe("codex-path", () => {
  test("parseCodexCliVersion handles stable releases", () => {
    expect(parseCodexCliVersion("codex-cli 0.77.0")).toEqual({
      major: 0,
      minor: 77,
      patch: 0,
      prerelease: [],
      raw: "codex-cli 0.77.0",
    });
  });

  test("parseCodexCliVersion handles prereleases", () => {
    expect(parseCodexCliVersion("codex-cli 0.115.0-alpha.4")).toEqual({
      major: 0,
      minor: 115,
      patch: 0,
      prerelease: ["alpha", 4],
      raw: "codex-cli 0.115.0-alpha.4",
    });
  });

  test("compareCodexCliVersions prefers newer minors", () => {
    const older = parseCodexCliVersion("codex-cli 0.77.0");
    const newer = parseCodexCliVersion("codex-cli 0.115.0-alpha.4");

    expect(older).not.toBeNull();
    expect(newer).not.toBeNull();
    expect(compareCodexCliVersions(newer!, older!)).toBeGreaterThan(0);
  });

  test("compareCodexCliVersions prefers stable over prerelease for same numeric version", () => {
    const prerelease = parseCodexCliVersion("codex-cli 0.115.0-alpha.4");
    const stable = parseCodexCliVersion("codex-cli 0.115.0");

    expect(prerelease).not.toBeNull();
    expect(stable).not.toBeNull();
    expect(compareCodexCliVersions(stable!, prerelease!)).toBeGreaterThan(0);
  });

  test("selectPreferredCodexBinary prefers the newest parsed version", () => {
    expect(
      selectPreferredCodexBinary([
        { path: "/usr/local/bin/codex", versionOutput: "codex-cli 0.77.0" },
        {
          path: "/Applications/Codex.app/Contents/Resources/codex",
          versionOutput: "codex-cli 0.115.0-alpha.4",
        },
      ]),
    ).toBe("/Applications/Codex.app/Contents/Resources/codex");
  });

  test("selectPreferredCodexBinary falls back to the first available path when versions are unavailable", () => {
    expect(
      selectPreferredCodexBinary([
        { path: "/first/codex", versionOutput: null },
        { path: "/second/codex", versionOutput: null },
      ]),
    ).toBe("/first/codex");
  });

  test("resolveCodexPathsOnPath includes all executable codex binaries on PATH", () => {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), "orca-codex-path-"));
    const firstDir = path.join(tempRoot, "first");
    const secondDir = path.join(tempRoot, "second");
    const firstCodex = path.join(firstDir, "codex");
    const secondCodex = path.join(secondDir, "codex");

    mkdirSync(firstDir, { recursive: true });
    mkdirSync(secondDir, { recursive: true });
    writeFileSync(firstCodex, "#!/bin/sh\necho codex-cli 0.77.0\n", { mode: 0o755 });
    writeFileSync(secondCodex, "#!/bin/sh\necho codex-cli 0.115.0\n", { mode: 0o755 });
    chmodSync(firstCodex, 0o755);
    chmodSync(secondCodex, 0o755);

    try {
      expect(resolveCodexPathsOnPath([firstDir, secondDir].join(path.delimiter))).toEqual([
        firstCodex,
        secondCodex,
      ]);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("clearResolvedCodexPathCacheForTests is callable", () => {
    clearResolvedCodexPathCacheForTests();
    expect(true).toBe(true);
  });
});
