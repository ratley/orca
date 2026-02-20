import { describe, expect, test } from "bun:test";

import { parseAgentJson } from "./agent-json";

describe("parseAgentJson", () => {
  test("parses raw JSON", () => {
    expect(parseAgentJson('{"ok":true}')).toEqual({ ok: true });
  });

  test("parses json fenced block", () => {
    const input = "```json\n[{\"id\":\"1\"}]\n```";
    expect(parseAgentJson(input)).toEqual([{ id: "1" }]);
  });

  test("parses generic fenced block", () => {
    const input = "```\n{\"outcome\":\"done\"}\n```";
    expect(parseAgentJson(input)).toEqual({ outcome: "done" });
  });

  test("parses first json payload from surrounding prose", () => {
    const input = "I finished the task. Result below:\n\n{\"outcome\":\"done\"}\n\nThanks!";
    expect(parseAgentJson(input)).toEqual({ outcome: "done" });
  });

  test("throws when no valid json exists", () => {
    expect(() => parseAgentJson("not json")).toThrow("Response did not contain valid JSON object/array");
  });
});
