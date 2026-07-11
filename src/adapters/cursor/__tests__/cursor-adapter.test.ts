import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

import { AdapterError, AdapterRegistry } from "../../../lane/adapter";
import { AgentManifestSchema, DispatchOutcomeSchema } from "../../../types/lane";
import type { LaneEventInput } from "../../../types/lane";
import { buildCursorManifest, CURSOR_AGENT_NAME, CursorAdapter } from "../adapter";
import type { ExecFn, ExecResult } from "../exec";
import { ExecUnavailableError } from "../exec";
import { registerCursorAdapter } from "../index";
import {
  BENIGN_STDERR,
  BOGUS_MODEL_STDERR,
  MISSING_TRUST_STDERR,
  SUCCESS_SESSION_ID,
  SUCCESS_STDOUT,
  WORKTREE_BANNER,
  sessionMetaFixture,
  successLine,
} from "./fixtures.test";
import { createFakeExec, execResult, makeLane, seedSession } from "./helpers.test";

describe("CursorAdapter dispatch", () => {
  let cursorHome: string;

  beforeEach(async () => {
    cursorHome = await fs.mkdtemp(path.join(os.tmpdir(), "orca-cursor-home-"));
  });

  afterEach(async () => {
    await fs.rm(cursorHome, { recursive: true, force: true });
  });

  test("success: maps the recorded result JSON onto a completed outcome", async () => {
    const { exec, calls } = createFakeExec(() => execResult());
    const adapter = new CursorAdapter({ exec, cursorHome });

    const events: LaneEventInput[] = [];
    const outcome = await adapter.dispatch({
      laneId: "lane_00000001",
      prompt: "Reply with exactly the word: pong",
      cwd: "/tmp/fake-project",
      model: "gpt-5-mini",
      onEvent: (event) => {
        events.push(event);
      },
    });

    DispatchOutcomeSchema.parse(outcome);
    expect(outcome.status).toBe("completed");
    expect(outcome.delivery).toBe("confirmed");
    expect(outcome.nativeStatus).toBe("completed");
    expect(outcome.semanticOutcome).toBe("unknown");
    expect(outcome.agentSessionId).toBe(SUCCESS_SESSION_ID);
    expect(outcome.result?.text).toBe("pong");
    expect(outcome.usage).toEqual({ inputTokens: 24312, outputTokens: 61 });
    expect(outcome.timing?.apiMs).toBe(6751);
    expect(outcome.timing?.wallMs).toBeGreaterThanOrEqual(0);
    // duration_ms excludes client startup; startupMs is wall-derived and
    // clamped at zero (the fake exec returns faster than 6751ms).
    expect(outcome.timing?.startupMs).toBe(0);

    expect(events).toEqual([
      {
        event: "agent_started",
        // Finding 15: process identity (with startedAt) is emitted at spawn,
        // before any native protocol output.
        data: { pid: 1234, pgid: 1234, startedAt: expect.any(String) as unknown as string },
      },
      {
        event: "progress",
        data: {
          phase: "process_exited",
          exitCode: 0,
          timedOut: false,
          killed: false,
          aborted: false,
          overCap: false,
          termination: "verified_gone",
        },
      },
    ]);

    expect(calls).toHaveLength(1);
    const req = calls[0];
    expect(req?.bin).toBe("agent");
    expect(req?.cwd).toBe("/tmp/fake-project");
    expect(req?.args).toEqual([
      "-p",
      "--output-format",
      "json",
      "--trust",
      "--force",
      "--workspace",
      "/tmp/fake-project",
      "--model",
      "gpt-5-mini",
      "Reply with exactly the word: pong",
    ]);
  });

  test("rejected agent_started persistence kills the live process and fails the lane", async () => {
    let killed = false;
    const exec: ExecFn = (req) =>
      new Promise<ExecResult>((resolve) => {
        req.onSpawn?.({
          pid: 4321,
          pgid: 4321,
          kill: async () => {
            killed = true;
            resolve(
              execResult({
                exitCode: null,
                stdout: "",
                killed: true,
                termination: "verified_gone",
              }),
            );
            return true;
          },
        });
      });
    const adapter = new CursorAdapter({ exec, cursorHome });
    const seen: string[] = [];

    const error = await adapter
      .dispatch({
        laneId: "lane_0000000f",
        prompt: "hi",
        cwd: "/tmp/fake-project",
        onEvent: async (event) => {
          seen.push(event.event);
          if (event.event === "agent_started") {
            throw new Error("lane store unavailable");
          }
        },
      })
      .then(() => null)
      .catch((caught: unknown) => caught);

    expect(killed).toBe(true);
    expect(seen).toEqual(["agent_started"]);
    expect(error).toBeInstanceOf(AdapterError);
    expect((error as AdapterError).code).toBe("adapter_error");
    expect((error as Error).message).toContain("event persistence failed");
  });

  test("rejected process-exited progress persistence cannot return success", async () => {
    const { exec } = createFakeExec(() => execResult());
    const adapter = new CursorAdapter({ exec, cursorHome });
    const seen: string[] = [];

    const error = await adapter
      .dispatch({
        laneId: "lane_00000010",
        prompt: "hi",
        cwd: "/tmp/fake-project",
        onEvent: (event) => {
          seen.push(event.event);
          return event.event === "progress"
            ? Promise.reject(new Error("events.ndjson fsync failed"))
            : Promise.resolve();
        },
      })
      .then(() => null)
      .catch((caught: unknown) => caught);

    expect(seen).toEqual(["agent_started", "progress"]);
    expect(error).toBeInstanceOf(AdapterError);
    expect((error as AdapterError).code).toBe("adapter_error");
    expect((error as Error).message).toContain("event persistence failed");
  });

  test("sink rejection after a natural leader close still tree-kills surviving descendants (finding 17)", async () => {
    let killCalls = 0;
    const exec: ExecFn = async (req) => {
      req.onSpawn?.({
        pid: 7777,
        pgid: 7777,
        kill: async () => {
          killCalls += 1;
          return true;
        },
      });
      // The leader exited naturally, but an ignored-stdio descendant
      // survives, so the exec layer honestly reports not_attempted.
      return execResult({ termination: "not_attempted" });
    };
    const adapter = new CursorAdapter({ exec, cursorHome });

    const error = await adapter
      .dispatch({
        laneId: "lane_00000011",
        prompt: "hi",
        cwd: "/tmp/fake-project",
        onEvent: (event) =>
          event.event === "progress"
            ? Promise.reject(new Error("events.ndjson fsync failed"))
            : Promise.resolve(),
      })
      .then(() => null)
      .catch((caught: unknown) => caught);

    // The handle must survive event-chain settlement so a post-exit sink
    // failure can still run verified group cleanup.
    expect(killCalls).toBe(1);
    expect(error).toBeInstanceOf(AdapterError);
    expect((error as AdapterError).code).toBe("adapter_error");
    expect((error as Error).message).toContain("termination was verified");
  });

  test("sink rejection never treats an unverified natural close as termination proof (finding 20)", async () => {
    const exec: ExecFn = async (req) => {
      req.onSpawn?.({
        pid: 7778,
        pgid: 7778,
        // Group cleanup was attempted but could not be verified.
        kill: async () => false,
      });
      return execResult({ termination: "not_attempted" });
    };
    const adapter = new CursorAdapter({ exec, cursorHome });

    const error = await adapter
      .dispatch({
        laneId: "lane_00000012",
        prompt: "hi",
        cwd: "/tmp/fake-project",
        onEvent: (event) =>
          event.event === "progress"
            ? Promise.reject(new Error("events.ndjson fsync failed"))
            : Promise.resolve(),
      })
      .then(() => null)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AdapterError);
    expect((error as Error).message).toContain("could not be confirmed");
  });

  test("a natural close without tree proof still classifies a normal completion", async () => {
    const { exec } = createFakeExec(() => execResult({ termination: "not_attempted" }));
    const adapter = new CursorAdapter({ exec, cursorHome });

    const outcome = await adapter.dispatch({
      laneId: "lane_00000013",
      prompt: "hi",
      cwd: "/tmp/fake-project",
    });

    expect(outcome.status).toBe("completed");
    expect(outcome.delivery).toBe("confirmed");
  });

  test("an aborted run with a signal death maps to status killed", async () => {
    const { exec } = createFakeExec(() =>
      execResult({ exitCode: null, stdout: "", aborted: true }),
    );
    const adapter = new CursorAdapter({ exec, cursorHome });

    const outcome = await adapter.dispatch({
      laneId: "lane_00000014",
      prompt: "hi",
      cwd: "/tmp/fake-project",
    });

    DispatchOutcomeSchema.parse(outcome);
    expect(outcome.status).toBe("killed");
    expect(outcome.nativeStatus).toBe("interrupted");
    expect(outcome.error?.message).toContain("aborted");
  });

  test("an abort that lost the race to a real exit defers to that exit's evidence", async () => {
    const { exec } = createFakeExec(() => execResult({ aborted: true }));
    const adapter = new CursorAdapter({ exec, cursorHome });

    const outcome = await adapter.dispatch({
      laneId: "lane_00000015",
      prompt: "hi",
      cwd: "/tmp/fake-project",
    });

    expect(outcome.status).toBe("completed");
  });

  test("a 'Using worktree:' banner before the JSON line still parses", async () => {
    const { exec } = createFakeExec(() =>
      execResult({ stdout: `${WORKTREE_BANNER}\n${SUCCESS_STDOUT}` }),
    );
    const adapter = new CursorAdapter({ exec, cursorHome });

    const outcome = await adapter.dispatch({
      laneId: "lane_00000002",
      prompt: "p",
      cwd: "/tmp/fake-project",
    });

    expect(outcome.status).toBe("completed");
    expect(outcome.result?.text).toBe("pong");
    expect(outcome.agentSessionId).toBe(SUCCESS_SESSION_ID);
  });

  test("bogus model: exit 1 with EMPTY stdout maps to usage_error / not_sent", async () => {
    const { exec } = createFakeExec(() =>
      execResult({ exitCode: 1, stdout: "", stderr: BOGUS_MODEL_STDERR }),
    );
    const adapter = new CursorAdapter({ exec, cursorHome });

    const outcome = await adapter.dispatch({
      laneId: "lane_00000003",
      prompt: "hi",
      cwd: "/tmp/fake-project",
      model: "totally-bogus-model-xyz",
    });

    DispatchOutcomeSchema.parse(outcome);
    expect(outcome.status).toBe("failed");
    expect(outcome.code).toBe("usage_error");
    expect(outcome.delivery).toBe("not_sent");
    expect(outcome.nativeStatus).toBe("failed");
    expect(outcome.error?.message).toContain("Cannot use this model: totally-bogus-model-xyz");
    expect(outcome.error?.message).toContain("Available models:");
  });

  test("missing trust: exit 1 with EMPTY stdout maps to adapter_error / not_sent", async () => {
    const { exec } = createFakeExec(() =>
      execResult({ exitCode: 1, stdout: "", stderr: MISSING_TRUST_STDERR }),
    );
    const adapter = new CursorAdapter({ exec, cursorHome });

    const outcome = await adapter.dispatch({
      laneId: "lane_00000004",
      prompt: "hi",
      cwd: "/tmp/fake-project",
    });

    DispatchOutcomeSchema.parse(outcome);
    expect(outcome.status).toBe("failed");
    expect(outcome.code).toBe("adapter_error");
    expect(outcome.delivery).toBe("not_sent");
    expect(outcome.nativeStatus).toBe("failed");
    expect(outcome.error?.message).toContain("Workspace Trust Required");
  });

  test("the benign cursor-retrieval stderr line is never treated as failure", async () => {
    const { exec } = createFakeExec(() =>
      execResult({ exitCode: 1, stdout: "", stderr: BENIGN_STDERR }),
    );
    const adapter = new CursorAdapter({ exec, cursorHome });

    const outcome = await adapter.dispatch({
      laneId: "lane_00000005",
      prompt: "hi",
      cwd: "/tmp/fake-project",
    });

    // Nonzero exit still fails, but the benign line must not become the
    // error message.
    expect(outcome.status).toBe("failed");
    expect(outcome.code).toBe("agent_failed");
    expect(outcome.error?.message).not.toContain("cursor-retrieval");
    expect(outcome.error?.message).toContain("exited 1 with no output");
  });

  test("result JSON with is_error true maps to agent_failed / delivery confirmed", async () => {
    const { exec } = createFakeExec(() =>
      execResult({ stdout: successLine({ is_error: true, result: "something broke" }) }),
    );
    const adapter = new CursorAdapter({ exec, cursorHome });

    const outcome = await adapter.dispatch({
      laneId: "lane_00000006",
      prompt: "hi",
      cwd: "/tmp/fake-project",
    });

    DispatchOutcomeSchema.parse(outcome);
    expect(outcome.status).toBe("failed");
    expect(outcome.code).toBe("agent_failed");
    expect(outcome.delivery).toBe("confirmed");
    expect(outcome.nativeStatus).toBe("failed");
    expect(outcome.error?.message).toBe("something broke");
  });

  test("exit 0 without a JSON result line throws AdapterError adapter_error", async () => {
    const { exec } = createFakeExec(() => execResult({ stdout: "no json here\n" }));
    const adapter = new CursorAdapter({ exec, cursorHome });

    const error = await adapter
      .dispatch({ laneId: "lane_00000007", prompt: "hi", cwd: "/tmp/fake-project" })
      .then(() => null)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AdapterError);
    expect((error as AdapterError).code).toBe("adapter_error");
  });

  test("unrelated trailing JSON is rejected with a bounded raw tail", async () => {
    const unrelated = JSON.stringify({ is_error: false, diagnostic: "x".repeat(2_000) });
    const { exec } = createFakeExec(() =>
      execResult({ stdout: `${SUCCESS_STDOUT}${unrelated}\n` }),
    );
    const adapter = new CursorAdapter({ exec, cursorHome });

    const error = await adapter
      .dispatch({ laneId: "lane_0000000b", prompt: "hi", cwd: "/tmp/fake-project" })
      .then(() => null)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AdapterError);
    expect((error as AdapterError).code).toBe("adapter_error");
    expect((error as Error).message).toContain('type:"result"');
    expect((error as Error).message.length).toBeLessThan(700);
  });

  test("a result object without session_id is rejected as malformed terminal output", async () => {
    const { exec } = createFakeExec(() =>
      execResult({ stdout: successLine({ session_id: undefined }) }),
    );
    const adapter = new CursorAdapter({ exec, cursorHome });

    const error = await adapter
      .dispatch({ laneId: "lane_0000000c", prompt: "hi", cwd: "/tmp/fake-project" })
      .then(() => null)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AdapterError);
    expect((error as AdapterError).code).toBe("adapter_error");
    expect((error as Error).message).toContain("session_id");
  });

  test("buffer overflow throws adapter_error and reports the bounded stream tail", async () => {
    const { exec } = createFakeExec(() =>
      execResult({
        exitCode: null,
        stdout: "tail-of-runaway-output",
        overCap: true,
        overCapSource: "stdout",
      }),
    );
    const adapter = new CursorAdapter({ exec, cursorHome });

    const error = await adapter
      .dispatch({ laneId: "lane_0000000d", prompt: "hi", cwd: "/tmp/fake-project" })
      .then(() => null)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AdapterError);
    expect((error as AdapterError).code).toBe("adapter_error");
    expect((error as Error).message).toContain("stdout buffer cap");
    expect((error as Error).message).toContain("tail-of-runaway-output");
  });

  test("unconfirmed process-group termination fails loud", async () => {
    const { exec } = createFakeExec(() =>
      execResult({ exitCode: null, killed: true, termination: "unverified" }),
    );
    const adapter = new CursorAdapter({ exec, cursorHome });

    const error = await adapter
      .dispatch({ laneId: "lane_0000000e", prompt: "hi", cwd: "/tmp/fake-project" })
      .then(() => null)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AdapterError);
    expect((error as AdapterError).code).toBe("adapter_error");
    expect((error as Error).message).toContain("termination could not be confirmed");
  });

  test("timeout maps to code timeout / nativeStatus interrupted", async () => {
    const { exec } = createFakeExec(() =>
      execResult({ exitCode: null, stdout: "", stderr: BENIGN_STDERR, timedOut: true }),
    );
    const adapter = new CursorAdapter({ exec, cursorHome });

    const outcome = await adapter.dispatch({
      laneId: "lane_00000008",
      prompt: "hi",
      cwd: "/tmp/fake-project",
      timeoutMs: 1234,
    });

    DispatchOutcomeSchema.parse(outcome);
    expect(outcome.status).toBe("failed");
    expect(outcome.code).toBe("timeout");
    expect(outcome.delivery).toBe("unknown");
    expect(outcome.nativeStatus).toBe("interrupted");
    expect(outcome.error?.message).toContain("1234ms");
  });

  test("post-deadline exit 0 with a valid result envelope is still a timeout, never success (finding 18 residual)", async () => {
    // The child trapped Orca's deadline SIGTERM, printed a complete success
    // envelope, and exited 0. The exec layer reports timedOut:true and the
    // adapter must not mint a success outcome from that evidence.
    const { exec } = createFakeExec(() =>
      execResult({ exitCode: 0, stdout: SUCCESS_STDOUT, stderr: BENIGN_STDERR, timedOut: true }),
    );
    const adapter = new CursorAdapter({ exec, cursorHome });

    const outcome = await adapter.dispatch({
      laneId: "lane_00000018",
      prompt: "hi",
      cwd: "/tmp/fake-project",
      timeoutMs: 1234,
    });

    DispatchOutcomeSchema.parse(outcome);
    expect(outcome.status).toBe("failed");
    expect(outcome.code).toBe("timeout");
    expect(outcome.nativeStatus).toBe("interrupted");
    expect(outcome.result).toBeUndefined();
  });

  test("missing binary throws AdapterError agent_unavailable", async () => {
    const exec: ExecFn = async (req) => {
      throw new ExecUnavailableError(req.bin);
    };
    const adapter = new CursorAdapter({ exec, cursorHome, bin: "agent-not-installed" });

    const error = await adapter
      .dispatch({ laneId: "lane_00000009", prompt: "hi", cwd: "/tmp/fake-project" })
      .then(() => null)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AdapterError);
    expect((error as AdapterError).code).toBe("agent_unavailable");
    expect((error as AdapterError).message).toContain("agent-not-installed");
  });
});

describe("CursorAdapter inspect and kill", () => {
  let cursorHome: string;

  beforeEach(async () => {
    cursorHome = await fs.mkdtemp(path.join(os.tmpdir(), "orca-cursor-home-"));
  });

  afterEach(async () => {
    await fs.rm(cursorHome, { recursive: true, force: true });
  });

  test("inspect reports running while the process is live; kill interrupts it", async () => {
    let release: ((result: ExecResult) => void) | undefined;
    const gate = new Promise<ExecResult>((resolve) => {
      release = resolve;
    });

    const exec: ExecFn = (req) => {
      req.onSpawn?.({
        pid: 4242,
        pgid: 4242,
        kill: async () => {
          release?.({
            exitCode: null,
            stdout: "",
            stderr: "",
            timedOut: false,
            killed: true,
            aborted: false,
            overCap: false,
            termination: "verified_gone",
          });
          return true;
        },
      });
      return gate;
    };

    const adapter = new CursorAdapter({ exec, cursorHome });
    const lane = makeLane({ id: "lane_0000000a" });

    const pending = adapter.dispatch({ laneId: lane.id, prompt: "p", cwd: lane.cwd });
    await Promise.resolve();

    const snapshot = await adapter.inspect(lane);
    expect(snapshot.nativeStatus).toBe("running");
    expect(snapshot.detail).toContain("4242");

    // kill() is awaitable and resolves only after verified group termination.
    expect(await adapter.kill(lane.id)).toBe(true);

    const outcome = await pending;
    DispatchOutcomeSchema.parse(outcome);
    expect(outcome.status).toBe("killed");
    expect(outcome.nativeStatus).toBe("interrupted");

    // After exit the process handle is gone.
    expect(await adapter.kill(lane.id)).toBe(false);
  });

  test("inspect falls back to the native chats store after exit", async () => {
    const adapter = new CursorAdapter({
      exec: createFakeExec(() => execResult()).exec,
      cursorHome,
    });
    const cwd = "/tmp/fake-project";
    const lane = makeLane({ cwd, agentSessionId: SUCCESS_SESSION_ID });

    await seedSession(cursorHome, cwd, SUCCESS_SESSION_ID, sessionMetaFixture({ cwd }));

    const snapshot = await adapter.inspect(lane);
    expect(snapshot.nativeStatus).toBe("unknown");
    expect(snapshot.agentSessionId).toBe(SUCCESS_SESSION_ID);
    expect(snapshot.lastActivityAt).toBe(new Date(1783780279051).toISOString());
  });

  test("inspect reports unknown when there is no session in the native store", async () => {
    const adapter = new CursorAdapter({
      exec: createFakeExec(() => execResult()).exec,
      cursorHome,
    });

    const unbound = await adapter.inspect(makeLane());
    expect(unbound.nativeStatus).toBe("unknown");
    expect(unbound.detail).toContain("no native session");

    const missing = await adapter.inspect(makeLane({ agentSessionId: "not-a-real-session" }));
    expect(missing.nativeStatus).toBe("unknown");
    expect(missing.detail).toContain("chats store");
  });
});

describe("CursorAdapter manifest and registration", () => {
  test("capabilities() parses as an AgentManifest and declares the caveats", () => {
    const manifest = new CursorAdapter().capabilities();

    AgentManifestSchema.parse(manifest);
    expect(manifest.agent).toBe(CURSOR_AGENT_NAME);
    expect(manifest.capabilities.questions).toBe(false);
    expect(manifest.capabilities.resume).toBe(true);
    // This suite runs on POSIX; kill is reported platform-aware (P-POSIX).
    expect(manifest.capabilities.kill).toBe(true);
    expect(manifest.caveats.map((caveat) => caveat.code)).toContain("posix_only");
    expect(manifest.capabilities.continuityMethods).toEqual(["session-id-match", "nonce-echo"]);
    expect(manifest.overhead?.startupMsP95).toBe(100_000);

    expect(manifest.worktrees).toBe(true);
    expect(manifest.caveats.map((caveat) => caveat.code)).toContain("silent_resume_rebind");
    expect(manifest.declared.outputFormat).toBe("json");
  });

  test("kill capability is platform-aware: POSIX true with caveat, win32 false (P-POSIX)", () => {
    const posix = buildCursorManifest("linux");
    expect(posix.capabilities.kill).toBe(true);
    expect(posix.caveats.map((caveat) => caveat.code)).toContain("posix_only");

    const windows = buildCursorManifest("win32");
    AgentManifestSchema.parse(windows);
    expect(windows.capabilities.kill).toBe(false);
    expect(windows.caveats.map((caveat) => caveat.code)).not.toContain("posix_only");
  });

  test("registerCursorAdapter registers under 'cursor'; duplicates throw", () => {
    const registry = new AdapterRegistry();
    const adapter = registerCursorAdapter(registry);

    expect(registry.get(CURSOR_AGENT_NAME)).toBe(adapter);
    expect(() => registerCursorAdapter(registry)).toThrow(AdapterError);
  });
});
