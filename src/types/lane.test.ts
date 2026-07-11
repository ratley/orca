import { describe, expect, test } from "bun:test";

import { LaneEventKindSchema, LaneEventSchema, LaneRecordSchema } from "./lane";

const baseRecord = {
  id: "lane_a3f8b901",
  agent: "codex",
  cwd: "/tmp/project",
  status: "blocked",
  createdAt: "2026-07-11T00:00:00.000Z",
  updatedAt: "2026-07-11T00:00:01.000Z",
  seq: 4,
};

describe("lane schema additions", () => {
  test("LaneRecord round-trips answerGeneration through JSON", () => {
    const parsed = LaneRecordSchema.parse({ ...baseRecord, answerGeneration: 2 });
    expect(parsed.answerGeneration).toBe(2);

    const roundTripped = LaneRecordSchema.parse(JSON.parse(JSON.stringify(parsed)));
    expect(roundTripped).toEqual(parsed);
  });

  test("answerGeneration is optional and must be a nonnegative integer", () => {
    expect(LaneRecordSchema.parse(baseRecord).answerGeneration).toBeUndefined();
    expect(() => LaneRecordSchema.parse({ ...baseRecord, answerGeneration: -1 })).toThrow();
    expect(() => LaneRecordSchema.parse({ ...baseRecord, answerGeneration: 1.5 })).toThrow();
  });

  test("LaneRecord persists settlement usage and timing", () => {
    const parsed = LaneRecordSchema.parse({
      ...baseRecord,
      status: "completed",
      usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.01 },
      timing: { wallMs: 5000, startupMs: 300 },
    });
    expect(parsed.usage?.inputTokens).toBe(100);
    expect(parsed.timing?.wallMs).toBe(5000);

    expect(LaneRecordSchema.parse(baseRecord).usage).toBeUndefined();
    expect(LaneRecordSchema.parse(baseRecord).timing).toBeUndefined();
    expect(() => LaneRecordSchema.parse({ ...baseRecord, timing: { wallMs: -1 } })).toThrow();
  });

  test("resume_started is a valid event kind and round-trips through JSON", () => {
    expect(LaneEventKindSchema.options).toContain("resume_started");

    const parsed = LaneEventSchema.parse({
      v: 1,
      seq: 7,
      ts: "2026-07-11T00:00:02.000Z",
      laneId: "lane_a3f8b901",
      event: "resume_started",
      data: {},
    });
    expect(parsed.event).toBe("resume_started");

    const roundTripped = LaneEventSchema.parse(JSON.parse(JSON.stringify(parsed)));
    expect(roundTripped).toEqual(parsed);
  });
});
