import { afterEach, describe, expect, it } from "bun:test";

import { generateRunId } from "./ids.js";

describe("generateRunId", () => {
  const originalDateNow = Date.now;
  const originalMathRandom = Math.random;

  afterEach(() => {
    Date.now = originalDateNow;
    Math.random = originalMathRandom;
  });

  it("returns run IDs in <slug>-<timestamp>-<hex4> format", () => {
    Date.now = () => 1739999999999;
    Math.random = () => 0.25;

    const runId = generateRunId("specs/My First Spec.md");

    expect(runId).toMatch(/^my-first-spec-1739999999999-[0-9a-f]{4}$/);
  });

  it("derives slug from the spec file path", () => {
    Date.now = () => 1739999999999;
    Math.random = () => 0;

    const runId = generateRunId("/tmp/Nested Dir/My___Spec V2!.md");

    expect(runId.startsWith("my-spec-v2-1739999999999-")).toBe(true);
  });

  it("produces unique IDs across multiple calls", () => {
    let tick = 1740000000000;
    Date.now = () => tick++;
    Math.random = () => 0;

    const ids = new Set(Array.from({ length: 50 }, () => generateRunId("specs/test.md")));

    expect(ids.size).toBe(50);
  });
});
