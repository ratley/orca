import { describe, expect, test } from "bun:test";

import { ErrorCodeSchema } from "../../types/lane";
import type { Envelope, ErrorCode, LaneRecord } from "../../types/lane";
import {
  ERROR_CODE_EXIT_CODES,
  errorEnvelope,
  EXIT_CODES,
  exitCodeForEnvelope,
  okEnvelope,
  printEnvelope,
  printHandle,
} from "../envelope";

const sampleLane: LaneRecord = {
  id: "lane_a3f8b901",
  agent: "codex",
  cwd: "/tmp/project",
  status: "running",
  createdAt: "2026-07-11T00:00:00.000Z",
  updatedAt: "2026-07-11T00:01:00.000Z",
  seq: 2,
};

function fakeStream(): { chunks: string[]; write(chunk: string): boolean } {
  const chunks: string[] = [];
  return {
    chunks,
    write(chunk: string): boolean {
      chunks.push(chunk);
      return true;
    },
  };
}

describe("envelope helpers", () => {
  test("okEnvelope defaults the three axes independently", () => {
    const envelope = okEnvelope({ kind: "lane", lane: sampleLane });

    expect(envelope.ok).toBe(true);
    expect(envelope.status).toBe("completed");
    expect(envelope.delivery).toBe("not_sent");
    expect(envelope.nativeStatus).toBe("unknown");
    expect(envelope.semanticOutcome).toBe("unknown");
    expect(envelope.code).toBeUndefined();
  });

  test("errorEnvelope carries code, message, and remediation", () => {
    const envelope = errorEnvelope({
      code: "lane_not_found",
      message: "Lane not found: lane_dead",
      remediation: 'Run "orca lanes" to list known lanes.',
    });

    expect(envelope.ok).toBe(false);
    expect(envelope.kind).toBe("error");
    expect(envelope.status).toBe("failed");
    expect(envelope.code).toBe("lane_not_found");
    expect(envelope.error?.message).toBe("Lane not found: lane_dead");
    expect(envelope.error?.remediation).toBe('Run "orca lanes" to list known lanes.');
  });

  test("printEnvelope writes exactly one JSON line and returns 0 for ok", () => {
    const stream = fakeStream();
    const envelope = okEnvelope({
      kind: "lane",
      status: "completed",
      lane: sampleLane,
      delivery: "confirmed",
      nativeStatus: "completed",
      next: ["orca inspect lane_a3f8b901 --since 2"],
    });

    const exitCode = printEnvelope(stream, envelope);

    expect(exitCode).toBe(EXIT_CODES.ok);
    expect(stream.chunks).toHaveLength(1);
    const line = stream.chunks[0] ?? "";
    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1).includes("\n")).toBe(false);
    expect(JSON.parse(line)).toEqual(JSON.parse(JSON.stringify(envelope)));
  });

  test("blocked is a successful outcome: exit 0", () => {
    const envelope = okEnvelope({
      kind: "lane",
      status: "blocked",
      lane: sampleLane,
      delivery: "confirmed",
      nativeStatus: "running",
      blocked: { questions: [{ id: "q1", question: "Which database?" }] },
    });

    expect(printEnvelope(fakeStream(), envelope)).toBe(EXIT_CODES.ok);
  });

  test("every error code maps to its contract exit code and never to 0", () => {
    const expected: Record<ErrorCode, number> = {
      usage_error: 2,
      invalid_state: 4,
      lane_not_found: 4,
      continuity_unverified: 4,
      agent_unavailable: 3,
      adapter_error: 3,
      agent_failed: 3,
      timeout: 5,
    };

    for (const code of ErrorCodeSchema.options) {
      const envelope = errorEnvelope({ code, message: `failure: ${code}` });
      const exitCode = printEnvelope(fakeStream(), envelope);

      expect(exitCode).toBe(expected[code]);
      expect(exitCode).toBe(ERROR_CODE_EXIT_CODES[code]);
      expect(exitCode).not.toBe(0);
    }
  });

  test("exitCodeForEnvelope never returns 0 for ok:false", () => {
    const withoutCode = {
      v: 1,
      kind: "error",
      ok: false,
      status: "failed",
      delivery: "not_sent",
      nativeStatus: "unknown",
      semanticOutcome: "unknown",
      error: { message: "boom" },
    } as Envelope;

    expect(exitCodeForEnvelope(withoutCode)).toBe(EXIT_CODES.adapterFailure);
  });

  test("printEnvelope rejects envelopes that violate the ok/code invariant", () => {
    const invalid = {
      v: 1,
      kind: "error",
      ok: false,
      status: "failed",
      delivery: "not_sent",
      nativeStatus: "unknown",
      semanticOutcome: "unknown",
    } as Envelope;

    expect(() => printEnvelope(fakeStream(), invalid)).toThrow();
  });

  test("printHandle writes the dispatch handle line first-class", () => {
    const stream = fakeStream();
    const handle = printHandle(stream, { laneId: "lane_a3f8b901", agent: "codex" });

    expect(handle).toEqual({ v: 1, kind: "handle", laneId: "lane_a3f8b901", agent: "codex" });
    expect(stream.chunks).toHaveLength(1);
    expect(JSON.parse(stream.chunks[0] ?? "")).toEqual({
      v: 1,
      kind: "handle",
      laneId: "lane_a3f8b901",
      agent: "codex",
    });
  });
});
