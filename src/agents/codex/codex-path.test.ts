import { describe, expect, test } from "bun:test";

import {
  clearResolvedCodexPathCacheForTests,
  compareCodexCliVersions,
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

  test("clearResolvedCodexPathCacheForTests is callable", () => {
    clearResolvedCodexPathCacheForTests();
    expect(true).toBe(true);
  });
});
