import { describe, expect, test } from "bun:test";

import {
  AgentManifestSchema,
  DispatchOutcomeSchema,
  EnvelopeSchema,
  HandleLineSchema,
  InspectSnapshotSchema,
  LaneEventSchema,
  LaneRecordSchema,
} from "../../types/lane";
import type { AgentManifest, Envelope, LaneRecord } from "../../types/lane";

const sampleLane: LaneRecord = {
  id: "lane_a3f8b901",
  agent: "codex",
  model: "gpt-5.5",
  cwd: "/tmp/project",
  label: "fix-tests",
  agentSessionId: "thread_123",
  status: "running",
  createdAt: "2026-07-11T00:00:00.000Z",
  updatedAt: "2026-07-11T00:01:00.000Z",
  seq: 4,
};

const sampleManifest: AgentManifest = {
  v: 1,
  agent: "codex",
  displayName: "Codex CLI",
  capabilities: {
    resume: true,
    kill: true,
    questions: true,
    continuityMethods: ["thread-id-match"],
    models: ["gpt-5.5"],
  },
  overhead: { startupMsP50: 900 },
};

describe("lane contract schemas", () => {
  test("envelope round-trips through JSON", () => {
    const envelope: Envelope = EnvelopeSchema.parse({
      v: 1,
      kind: "lane",
      ok: true,
      status: "blocked",
      lane: sampleLane,
      delivery: "confirmed",
      nativeStatus: "running",
      semanticOutcome: "unknown",
      blocked: {
        questions: [{ id: "q1", question: "Which database?", options: ["staging", "prod"] }],
      },
      timing: { wallMs: 1200, startupMs: 300 },
      continuity: { verified: true, method: "thread-id-match" },
      next: ['orca answer lane_a3f8b901 "staging"'],
    });

    const reparsed = EnvelopeSchema.parse(JSON.parse(JSON.stringify(envelope)));

    expect(reparsed).toEqual(envelope);
  });

  test("envelope lane carries the summary fields, not lane status", () => {
    const envelope = EnvelopeSchema.parse({
      v: 1,
      kind: "lane",
      ok: true,
      status: "completed",
      lane: sampleLane,
      delivery: "confirmed",
      nativeStatus: "completed",
      semanticOutcome: "unknown",
    });

    expect(envelope.lane).toBeDefined();
    expect(envelope.lane).not.toHaveProperty("status");
    expect(envelope.lane?.id).toBe(sampleLane.id);
    expect(envelope.lane?.seq).toBe(sampleLane.seq);
  });

  test("ok:false requires a machine-readable code and error message", () => {
    const base = {
      v: 1,
      kind: "error",
      ok: false,
      status: "failed",
      delivery: "not_sent",
      nativeStatus: "unknown",
      semanticOutcome: "unknown",
    };

    expect(() => EnvelopeSchema.parse(base)).toThrow();
    expect(() => EnvelopeSchema.parse({ ...base, code: "adapter_error" })).toThrow();
    expect(() =>
      EnvelopeSchema.parse({
        ...base,
        code: "adapter_error",
        error: { message: "codex exited 1" },
      }),
    ).not.toThrow();
  });

  test("ok:true must not carry an error code", () => {
    expect(() =>
      EnvelopeSchema.parse({
        v: 1,
        kind: "lane",
        ok: true,
        status: "completed",
        code: "timeout",
        delivery: "confirmed",
        nativeStatus: "completed",
        semanticOutcome: "unknown",
      }),
    ).toThrow();
  });

  test("event line round-trips and defaults data to an empty object", () => {
    const event = LaneEventSchema.parse({
      v: 1,
      seq: 3,
      ts: "2026-07-11T00:00:00.000Z",
      laneId: "lane_a3f8b901",
      event: "progress",
      data: { message: "compiling" },
    });

    expect(LaneEventSchema.parse(JSON.parse(JSON.stringify(event)))).toEqual(event);

    const defaulted = LaneEventSchema.parse({
      v: 1,
      seq: 1,
      ts: "2026-07-11T00:00:00.000Z",
      laneId: "lane_a3f8b901",
      event: "created",
    });

    expect(defaulted.data).toEqual({});
  });

  test("lane record round-trips and rejects unknown status", () => {
    expect(LaneRecordSchema.parse(JSON.parse(JSON.stringify(sampleLane)))).toEqual(sampleLane);
    expect(() => LaneRecordSchema.parse({ ...sampleLane, status: "done" })).toThrow();
  });

  test("lane record round-trips the optional process identity", () => {
    const withProcess: LaneRecord = {
      ...sampleLane,
      process: { pid: 4242, pgid: 4242, startedAt: "2026-07-11T00:00:30.000Z" },
    };

    expect(LaneRecordSchema.parse(JSON.parse(JSON.stringify(withProcess)))).toEqual(withProcess);

    // pgid is optional (spawn may not own a group); pid and startedAt are not.
    const withoutPgid = LaneRecordSchema.parse({
      ...sampleLane,
      process: { pid: 4242, startedAt: "2026-07-11T00:00:30.000Z" },
    });
    expect(withoutPgid.process?.pid).toBe(4242);
    expect(withoutPgid.process?.pgid).toBeUndefined();

    for (const bad of [
      { pid: 0, startedAt: "2026-07-11T00:00:30.000Z" },
      { pid: -1, startedAt: "2026-07-11T00:00:30.000Z" },
      { pid: 1.5, startedAt: "2026-07-11T00:00:30.000Z" },
      { pid: 4242 },
      { startedAt: "2026-07-11T00:00:30.000Z" },
    ]) {
      expect(() => LaneRecordSchema.parse({ ...sampleLane, process: bad })).toThrow();
    }
  });

  test("handle line matches the dispatch-first contract", () => {
    const handle = HandleLineSchema.parse({
      v: 1,
      kind: "handle",
      laneId: "lane_a3f8b901",
      agent: "codex",
    });

    expect(HandleLineSchema.parse(JSON.parse(JSON.stringify(handle)))).toEqual(handle);
    expect(() => HandleLineSchema.parse({ ...handle, kind: "lane" })).toThrow();
  });

  test("agent manifest round-trips", () => {
    expect(AgentManifestSchema.parse(JSON.parse(JSON.stringify(sampleManifest)))).toEqual(
      sampleManifest,
    );
  });

  test("agent manifest round-trips caveats, worktrees, and declared extras", () => {
    const grown: AgentManifest = {
      ...sampleManifest,
      caveats: [
        { code: "no_native_questions", note: "Blocked questions surface via answer.txt polling." },
        { code: "resume_requires_thread", note: "Resume needs a bound agentSessionId." },
      ],
      worktrees: true,
      declared: { sandbox: "seatbelt", maxTurns: 40, flags: ["--full-auto"] },
    };

    expect(AgentManifestSchema.parse(JSON.parse(JSON.stringify(grown)))).toEqual(grown);

    // Caveats must carry both the machine code and the human note.
    expect(() => AgentManifestSchema.parse({ ...grown, caveats: [{ code: "no_kill" }] })).toThrow();
    expect(() => AgentManifestSchema.parse({ ...grown, worktrees: "yes" })).toThrow();
  });

  test("dispatch outcome allows terminal or blocked status only", () => {
    const outcome = DispatchOutcomeSchema.parse({
      status: "completed",
      delivery: "confirmed",
      nativeStatus: "completed",
      semanticOutcome: "unknown",
      result: { text: "done", artifacts: ["report.md"] },
    });

    expect(DispatchOutcomeSchema.parse(JSON.parse(JSON.stringify(outcome)))).toEqual(outcome);
    expect(() =>
      DispatchOutcomeSchema.parse({
        status: "running",
        delivery: "confirmed",
        nativeStatus: "running",
        semanticOutcome: "unknown",
      }),
    ).toThrow();
  });

  test("inspect snapshot round-trips", () => {
    const snapshot = InspectSnapshotSchema.parse({
      nativeStatus: "running",
      agentSessionId: "thread_123",
      lastActivityAt: "2026-07-11T00:02:00.000Z",
      detail: "native rollout file is being appended",
    });

    expect(InspectSnapshotSchema.parse(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);
  });
});
