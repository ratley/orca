import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

import { ContinuityError } from "../../../lane/adapter";
import { DispatchOutcomeSchema } from "../../../types/lane";
import type { LaneEventInput } from "../../../types/lane";
import { CursorAdapter } from "../adapter";
import { SUCCESS_SESSION_ID, sessionMetaFixture, successLine } from "./fixtures.test";
import {
  createFakeExec,
  execResult,
  makeLane,
  rewriteSessionMeta,
  seedSession,
} from "./helpers.test";

const CWD = "/tmp/fake-project";

describe("CursorAdapter resume continuity", () => {
  let cursorHome: string;

  beforeEach(async () => {
    cursorHome = await fs.mkdtemp(path.join(os.tmpdir(), "orca-cursor-home-"));
  });

  afterEach(async () => {
    await fs.rm(cursorHome, { recursive: true, force: true });
  });

  function boundLane(sessionId: string = SUCCESS_SESSION_ID) {
    return makeLane({ cwd: CWD, agentSessionId: sessionId, model: "gpt-5-mini" });
  }

  test("refuses to resume a lane that never bound a session id", async () => {
    const { exec, calls } = createFakeExec(() => execResult());
    const adapter = new CursorAdapter({ exec, cursorHome });

    await expect(adapter.resume(makeLane({ cwd: CWD }), "next step")).rejects.toBeInstanceOf(
      ContinuityError,
    );
    expect(calls).toHaveLength(0);
  });

  test("pre-check: unknown session (no native store dir) fails BEFORE running", async () => {
    const { exec, calls } = createFakeExec(() => execResult());
    const adapter = new CursorAdapter({ exec, cursorHome });

    await expect(adapter.resume(boundLane(), "next step")).rejects.toBeInstanceOf(ContinuityError);
    // The critical property: cursor is never invoked, because --resume with
    // an unknown id would silently create a new session.
    expect(calls).toHaveLength(0);
  });

  test("pre-check: session without a conversation fails before running", async () => {
    const { exec, calls } = createFakeExec(() => execResult());
    const adapter = new CursorAdapter({ exec, cursorHome });
    await seedSession(
      cursorHome,
      CWD,
      SUCCESS_SESSION_ID,
      sessionMetaFixture({ hasConversation: false, cwd: CWD }),
    );

    await expect(adapter.resume(boundLane(), "next step")).rejects.toBeInstanceOf(ContinuityError);
    expect(calls).toHaveLength(0);
  });

  test("pre-check: session recorded for a different cwd fails before running", async () => {
    const { exec, calls } = createFakeExec(() => execResult());
    const adapter = new CursorAdapter({ exec, cursorHome });
    await seedSession(
      cursorHome,
      CWD,
      SUCCESS_SESSION_ID,
      sessionMetaFixture({ cwd: "/some/other/project" }),
    );

    await expect(adapter.resume(boundLane(), "next step")).rejects.toBeInstanceOf(ContinuityError);
    expect(calls).toHaveLength(0);
  });

  test("silent new session: echoed id but stale meta.json raises ContinuityError", async () => {
    // Recorded behavior: `agent --resume <id>` exits 0 and echoes the id back
    // even when it silently created a brand-new session. The original
    // session's meta.json does not advance in that case.
    const { exec } = createFakeExec(() => execResult({ stdout: successLine() }));
    const adapter = new CursorAdapter({ exec, cursorHome });
    await seedSession(cursorHome, CWD, SUCCESS_SESSION_ID, sessionMetaFixture({ cwd: CWD }));

    await expect(adapter.resume(boundLane(), "next step")).rejects.toBeInstanceOf(ContinuityError);
  });

  test("session_id mismatch in the response raises ContinuityError", async () => {
    const { exec } = createFakeExec(() =>
      execResult({ stdout: successLine({ session_id: "11111111-2222-3333-4444-555555555555" }) }),
    );
    const adapter = new CursorAdapter({ exec, cursorHome });
    await seedSession(cursorHome, CWD, SUCCESS_SESSION_ID, sessionMetaFixture({ cwd: CWD }));

    await expect(adapter.resume(boundLane(), "next step")).rejects.toBeInstanceOf(ContinuityError);
  });

  test("verified resume: id echo + meta.json advance = method session-id-match", async () => {
    const preMeta = sessionMetaFixture({ cwd: CWD });
    const { exec, calls } = createFakeExec(async () => {
      // Simulate cursor updating the native store during the resumed turn.
      await rewriteSessionMeta(
        cursorHome,
        CWD,
        SUCCESS_SESSION_ID,
        sessionMetaFixture({ cwd: CWD, updatedAtMs: 1783780279051 + 60_000 }),
      );
      return execResult({ stdout: successLine({ result: "resumed fine" }) });
    });
    const adapter = new CursorAdapter({ exec, cursorHome });
    await seedSession(cursorHome, CWD, SUCCESS_SESSION_ID, preMeta);

    const events: LaneEventInput[] = [];
    const outcome = await adapter.resume(boundLane(), "next step", {
      timeoutMs: 42_000,
      onEvent: (event) => void events.push(event),
    });

    DispatchOutcomeSchema.parse(outcome);
    expect(outcome.status).toBe("completed");
    expect(outcome.result?.text).toBe("resumed fine");
    expect(outcome.continuity?.verified).toBe(true);
    expect(outcome.continuity?.method).toBe("session-id-match");
    expect(outcome.continuity?.detail).toContain(SUCCESS_SESSION_ID);

    const req = calls[0];
    expect(req?.args).toContain("--resume");
    expect(req?.args).toContain(SUCCESS_SESSION_ID);
    // resume reuses the lane's model.
    expect(req?.args).toContain("gpt-5-mini");
    expect(req?.timeoutMs).toBe(42_000);
    // The prompt stays last and un-prefixed when strictNonce is off.
    expect(req?.args.at(-1)).toBe("next step");
    expect(events[0]).toEqual({
      event: "agent_started",
      data: { pid: 1234, pgid: 1234, startedAt: expect.any(String) as unknown as string },
    });
    expect(events[1]).toMatchObject({
      event: "progress",
      data: { phase: "process_exited", termination: "verified_gone" },
    });
  });

  test("symlinked lane cwd: the native store is keyed by the REALPATH", async () => {
    // Regression for the live-smoke failure on 2026-07-11: macOS os.tmpdir()
    // returns /var/... (a symlink into /private/var), but Cursor hashes the
    // resolved path, so a literal-cwd lookup missed the session entirely.
    const realDir = await fs.mkdtemp(path.join(os.tmpdir(), "orca-cursor-realcwd-"));
    const resolvedDir = await fs.realpath(realDir);
    const linkDir = path.join(cursorHome, "project-link");
    await fs.symlink(resolvedDir, linkDir);

    try {
      const { exec } = createFakeExec(async () => {
        await rewriteSessionMeta(
          cursorHome,
          resolvedDir,
          SUCCESS_SESSION_ID,
          sessionMetaFixture({ cwd: resolvedDir, updatedAtMs: 1783780279051 + 60_000 }),
        );
        return execResult({ stdout: successLine() });
      });
      const adapter = new CursorAdapter({ exec, cursorHome });
      await seedSession(
        cursorHome,
        resolvedDir,
        SUCCESS_SESSION_ID,
        sessionMetaFixture({ cwd: resolvedDir }),
      );

      const lane = makeLane({ cwd: linkDir, agentSessionId: SUCCESS_SESSION_ID });
      const outcome = await adapter.resume(lane, "next step");

      expect(outcome.status).toBe("completed");
      expect(outcome.continuity?.verified).toBe(true);
    } finally {
      await fs.rm(realDir, { recursive: true, force: true });
    }
  });

  test("failed resume runs return the failure without claiming continuity", async () => {
    const { exec } = createFakeExec(() =>
      execResult({ stdout: successLine({ is_error: true, result: "exploded" }) }),
    );
    const adapter = new CursorAdapter({ exec, cursorHome });
    await seedSession(cursorHome, CWD, SUCCESS_SESSION_ID, sessionMetaFixture({ cwd: CWD }));

    const outcome = await adapter.resume(boundLane(), "next step");
    expect(outcome.status).toBe("failed");
    expect(outcome.code).toBe("agent_failed");
    expect(outcome.continuity).toBeUndefined();
  });

  describe("strict nonce mode", () => {
    test("verified nonce echo upgrades the method and strips the nonce", async () => {
      const { exec, calls } = createFakeExec(async (req) => {
        const prompt = req.args[req.args.length - 1] ?? "";
        const match = /"(nonce-[0-9a-f]{12})"/.exec(prompt);
        if (match === null) {
          throw new Error("expected the resume prompt to embed a nonce");
        }

        await rewriteSessionMeta(
          cursorHome,
          CWD,
          SUCCESS_SESSION_ID,
          sessionMetaFixture({ cwd: CWD, updatedAtMs: 1783780279051 + 60_000 }),
        );
        return execResult({ stdout: successLine({ result: `${match[1]} all done` }) });
      });
      const adapter = new CursorAdapter({ exec, cursorHome, strictNonce: true });
      await seedSession(cursorHome, CWD, SUCCESS_SESSION_ID, sessionMetaFixture({ cwd: CWD }));

      const outcome = await adapter.resume(boundLane(), "next step");

      expect(outcome.status).toBe("completed");
      expect(outcome.continuity?.verified).toBe(true);
      expect(outcome.continuity?.method).toBe("nonce-echo");
      expect(outcome.result?.text).toBe("all done");

      const prompt = calls[0]?.args.at(-1);
      expect(prompt).toContain("continuity check");
      expect(prompt).toContain("next step");
    });

    test("a reply that does not echo the nonce raises ContinuityError", async () => {
      const { exec } = createFakeExec(async () => {
        await rewriteSessionMeta(
          cursorHome,
          CWD,
          SUCCESS_SESSION_ID,
          sessionMetaFixture({ cwd: CWD, updatedAtMs: 1783780279051 + 60_000 }),
        );
        return execResult({ stdout: successLine({ result: "sure, done" }) });
      });
      const adapter = new CursorAdapter({ exec, cursorHome, strictNonce: true });
      await seedSession(cursorHome, CWD, SUCCESS_SESSION_ID, sessionMetaFixture({ cwd: CWD }));

      await expect(adapter.resume(boundLane(), "next step")).rejects.toBeInstanceOf(
        ContinuityError,
      );
    });
  });
});
