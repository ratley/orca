import { describe, expect, test } from "bun:test";

import { assertValidLaneId, InvalidLaneIdError, isValidLaneId, LANE_ID_PATTERN } from "../lane-id";

describe("lane id validation", () => {
  test("accepts exactly lane_ plus 8 lowercase hex chars", () => {
    for (const id of ["lane_a3f8b901", "lane_00000000", "lane_deadbeef", "lane_ffffffff"]) {
      expect(isValidLaneId(id)).toBe(true);
      expect(() => assertValidLaneId(id)).not.toThrow();
    }
  });

  test("rejects wrong shapes", () => {
    for (const id of [
      "",
      "lane_",
      "lane_a3f8", // too short
      "lane_a3f8b9012", // too long
      "lane_A3F8B901", // uppercase hex
      "lane_missing0", // non-hex chars
      "run_a3f8b901", // wrong prefix
      "lane-a3f8b901",
      " lane_a3f8b901",
      "lane_a3f8b901 ",
      "lane_a3f8b901\n",
    ]) {
      expect(isValidLaneId(id)).toBe(false);
      expect(() => assertValidLaneId(id)).toThrow(InvalidLaneIdError);
    }
  });

  test("rejects path traversal attempts before any path could be built", () => {
    for (const id of [
      "lane_../../..",
      "../lane_a3f8b901",
      "lane_a3f8b901/../..",
      "lane_a3f8b901/answer.txt",
      "lane_..%2f..%2f",
      "/etc/passwd",
    ]) {
      expect(isValidLaneId(id)).toBe(false);
      expect(() => assertValidLaneId(id)).toThrow(InvalidLaneIdError);
    }
  });

  test("InvalidLaneIdError carries the usage_error code and offending id", () => {
    try {
      assertValidLaneId("lane_nope");
      throw new Error("expected assertValidLaneId to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidLaneIdError);
      expect((error as InvalidLaneIdError).code).toBe("usage_error");
      expect((error as InvalidLaneIdError).laneId).toBe("lane_nope");
      expect((error as InvalidLaneIdError).name).toBe("InvalidLaneIdError");
    }
  });

  test("the exported pattern is anchored", () => {
    expect(LANE_ID_PATTERN.source.startsWith("^")).toBe(true);
    expect(LANE_ID_PATTERN.source.endsWith("$")).toBe(true);
  });
});
