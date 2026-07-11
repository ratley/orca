import { describe, expect, test } from "bun:test";

import { ErrorCodeSchema } from "../../types/lane";
import { buildContractPayload, getContractSchema } from "../contract";
import type { JsonSchema } from "../contract";
import { errorEnvelope, okEnvelope, printHandle } from "../envelope";

/**
 * Minimal structural JSON Schema check: required keys present, and when
 * additionalProperties is false, no keys outside the declared properties.
 */
function expectConforms(schema: JsonSchema, value: Record<string, unknown>): void {
  expect(schema.type).toBe("object");

  const required = (schema.required ?? []) as string[];
  for (const key of required) {
    expect(value).toContainKey(key);
  }

  if (schema.additionalProperties === false) {
    const declared = Object.keys((schema.properties ?? {}) as Record<string, unknown>);
    for (const key of Object.keys(value)) {
      expect(declared).toContain(key);
    }
  }
}

describe("contract payload", () => {
  const payload = buildContractPayload();

  test("is stable through JSON serialization", () => {
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload as never);
  });

  test("declares orca/v1 and the four schemas", () => {
    expect(payload.contractVersion).toBe("orca/v1");

    for (const schema of Object.values(payload.schemas)) {
      expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
      expect(schema.type).toBe("object");
    }
  });

  test("getContractSchema matches the payload schemas", () => {
    expect(getContractSchema("envelope")).toEqual(payload.schemas.envelope);
    expect(getContractSchema("event")).toEqual(payload.schemas.event);
    expect(getContractSchema("manifest")).toEqual(payload.schemas.manifest);
  });

  test("envelope schema requires the always-present fields", () => {
    const required = payload.schemas.envelope.required as string[];

    for (const key of [
      "v",
      "kind",
      "ok",
      "status",
      "delivery",
      "nativeStatus",
      "semanticOutcome",
    ]) {
      expect(required).toContain(key);
    }
  });

  test("exit-code table covers 0/2/3/4/5 and every error code exactly once", () => {
    expect(payload.exitCodes.map((row) => row.exitCode)).toEqual([0, 2, 3, 4, 5]);

    const okRow = payload.exitCodes.find((row) => row.exitCode === 0);
    expect(okRow?.errorCodes).toEqual([]);
    expect(okRow?.meaning).toContain("blocked");

    const mapped = payload.exitCodes.flatMap((row) => row.errorCodes);
    expect([...mapped].sort()).toEqual([...ErrorCodeSchema.options].sort());
    expect(new Set(mapped).size).toBe(mapped.length);
  });

  test("every verb ships a synopsis and exactly one literal example", () => {
    expect(payload.verbs.map((verb) => verb.verb)).toEqual([
      "dispatch",
      "inspect",
      "answer",
      "resume",
      "lanes",
      "kill",
      "agents",
      "contract",
    ]);

    for (const verb of payload.verbs) {
      expect(verb.synopsis.startsWith(`orca ${verb.verb}`)).toBe(true);
      expect(verb.example.startsWith(`orca ${verb.verb}`)).toBe(true);
      expect(verb.description.length).toBeGreaterThan(0);
    }
  });

  test("dispatch and resume synopses declare --timeout <ms>", () => {
    const synopses = new Map(payload.verbs.map((verb) => [verb.verb, verb.synopsis]));

    expect(synopses.get("dispatch")).toContain("[--timeout <ms>]");
    expect(synopses.get("resume")).toContain("[--timeout <ms>]");
  });

  test("notes document the --help human-readable exemption", () => {
    const helpNote = payload.notes.find((note) => note.includes("--help"));

    expect(helpNote).toBeDefined();
    expect(helpNote).toContain("exemption");
  });

  test("envelopes produced by the helpers validate against the emitted envelope schema", () => {
    const ok = okEnvelope({
      kind: "contract",
      contract: JSON.parse(JSON.stringify(payload)) as Record<string, unknown>,
    });
    const blocked = okEnvelope({
      kind: "lane",
      status: "blocked",
      delivery: "confirmed",
      nativeStatus: "running",
      blocked: { questions: [{ id: "q1", question: "Which database?" }] },
    });
    const failed = errorEnvelope({
      code: "agent_failed",
      message: "codex exited 1",
      nativeStatus: "failed",
    });

    for (const envelope of [ok, blocked, failed]) {
      expectConforms(payload.schemas.envelope, JSON.parse(JSON.stringify(envelope)));
    }
  });

  test("handle lines validate against the emitted handle schema", () => {
    const stream = { write: () => true };
    const handle = printHandle(stream, { laneId: "lane_a3f8b901", agent: "codex" });

    expectConforms(payload.schemas.handle, JSON.parse(JSON.stringify(handle)));
  });

  test("event and manifest samples validate against their emitted schemas", () => {
    expectConforms(payload.schemas.event, {
      v: 1,
      seq: 1,
      ts: "2026-07-11T00:00:00.000Z",
      laneId: "lane_a3f8b901",
      event: "created",
      data: {},
    });

    expectConforms(payload.schemas.manifest, {
      v: 1,
      agent: "codex",
      capabilities: {
        resume: true,
        kill: true,
        questions: true,
        continuityMethods: ["thread-id-match"],
      },
    });
  });
});
