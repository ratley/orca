import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

import { AdapterError, ContinuityError } from "../../../lane/adapter";
import { AgentManifestSchema, DispatchOutcomeSchema } from "../../../types/lane";
import type { LaneEventInput, LaneRecord } from "../../../types/lane";
import { buildClaudeManifest, CLAUDE_PERMISSION_MODES, ClaudeAdapter } from "../adapter";
import type { ClaudeExec, ClaudeExecRequest, ClaudeProcessInfo, TerminationProof } from "../exec";
import { transcriptPath } from "../transcript";

// ---------------------------------------------------------------------------
// Fixtures: verbatim stdout captures from live probes of Claude Code 2.1.207
// (2026-07-11). Do not "fix" these — they pin the real CLI behavior.
// ---------------------------------------------------------------------------

/** `echo 'Reply with exactly the word: pong' | claude -p --output-format json --model haiku` */
const RESULT_SUCCESS = `{"type":"result","subtype":"success","is_error":false,"api_error_status":null,"duration_ms":1941,"duration_api_ms":1909,"ttft_ms":1923,"ttft_stream_ms":1404,"time_to_request_ms":36,"num_turns":1,"result":"pong","stop_reason":"end_turn","session_id":"92e1e510-1558-474b-88ae-f7f8ebb2d182","total_cost_usd":0.019243800000000002,"usage":{"input_tokens":9,"cache_creation_input_tokens":8602,"cache_read_input_tokens":17358,"output_tokens":59,"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":"standard","cache_creation":{"ephemeral_1h_input_tokens":8602,"ephemeral_5m_input_tokens":0},"inference_geo":"not_available","iterations":[{"input_tokens":9,"output_tokens":59,"cache_read_input_tokens":17358,"cache_creation_input_tokens":8602,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":8602},"type":"message"}],"speed":"standard"},"modelUsage":{"claude-haiku-4-5-20251001":{"inputTokens":9,"outputTokens":59,"cacheReadInputTokens":17358,"cacheCreationInputTokens":8602,"webSearchRequests":0,"costUSD":0.019243800000000002,"contextWindow":200000,"maxOutputTokens":32000}},"permission_denials":[],"terminal_reason":"completed","fast_mode_state":"off","uuid":"d290ee0a-c25a-42d9-9ddb-f344e2e7e3a4"}`;

/** Same probe resumed: `claude -p --resume 92e1e510-... --output-format json`. Same session id. */
const RESULT_RESUME = `{"type":"result","subtype":"success","is_error":false,"api_error_status":null,"duration_ms":1490,"duration_api_ms":1393,"ttft_ms":1473,"ttft_stream_ms":1170,"time_to_request_ms":101,"num_turns":1,"result":"pong2","stop_reason":"end_turn","session_id":"92e1e510-1558-474b-88ae-f7f8ebb2d182","total_cost_usd":0.0035160000000000005,"usage":{"input_tokens":9,"cache_creation_input_tokens":348,"cache_read_input_tokens":25960,"output_tokens":43,"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":"standard","cache_creation":{"ephemeral_1h_input_tokens":348,"ephemeral_5m_input_tokens":0},"inference_geo":"not_available","iterations":[{"input_tokens":9,"output_tokens":43,"cache_read_input_tokens":25960,"cache_creation_input_tokens":348,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":348},"type":"message"}],"speed":"standard"},"modelUsage":{"claude-haiku-4-5-20251001":{"inputTokens":9,"outputTokens":43,"cacheReadInputTokens":25960,"cacheCreationInputTokens":348,"webSearchRequests":0,"costUSD":0.0035160000000000005,"contextWindow":200000,"maxOutputTokens":32000}},"permission_denials":[],"terminal_reason":"completed","fast_mode_state":"off","uuid":"674e9e69-7135-4c42-918c-b3b86047a190"}`;

/**
 * Bogus model probe: process exited 1, yet subtype is still "success" —
 * is_error is the authoritative failure signal.
 */
const RESULT_API_ERROR = `{"type":"result","subtype":"success","is_error":true,"api_error_status":404,"duration_ms":615,"duration_api_ms":0,"num_turns":1,"result":"There's an issue with the selected model (totally-bogus-model-xyz). It may not exist or you may not have access to it. Run --model to pick a different model.","stop_reason":"stop_sequence","session_id":"cad03a8d-9d9a-4e53-92bc-81c848ae625e","total_cost_usd":0,"usage":{"input_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":0,"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":"standard","cache_creation":{"ephemeral_1h_input_tokens":0,"ephemeral_5m_input_tokens":0},"inference_geo":"","iterations":[],"speed":"standard"},"modelUsage":{},"permission_denials":[],"terminal_reason":"api_error","fast_mode_state":"off","uuid":"5c4e72fd-534b-4af7-a6df-32e3777d48f4"}`;

/**
 * Default-permission probe: a Write attempt landed in permission_denials and
 * the run still completed with is_error:false.
 */
const RESULT_PERMISSION_DENIED = `{"type":"result","subtype":"success","is_error":false,"api_error_status":null,"duration_ms":11010,"duration_api_ms":10928,"ttft_ms":4045,"ttft_stream_ms":1495,"time_to_request_ms":57,"num_turns":2,"result":"I need permission to write the file. Once you grant permission for the Write tool, I'll complete this task.","stop_reason":"end_turn","session_id":"34308a6a-8f7b-404f-86fb-dc00122dea9f","total_cost_usd":0.0262683,"usage":{"input_tokens":17,"cache_creation_input_tokens":9069,"cache_read_input_tokens":43333,"output_tokens":756},"modelUsage":{},"permission_denials":[{"tool_name":"Write","tool_use_id":"toolu_019h4LdxM2yMheZu4XFneTts","tool_input":{"file_path":"/tmp/hello.txt","content":"hi"}}],"terminal_reason":"completed","fast_mode_state":"off","uuid":"85e91309-0e9b-48e4-a8f9-3b6c50aa92dc"}`;

/**
 * stream-json init line. type/subtype/session_id/model/permissionMode are
 * verbatim from the probe; the tools/mcp_servers/slash_commands arrays are
 * truncated for fixture size (the adapter never reads them).
 */
const STREAM_INIT = `{"type":"system","subtype":"init","cwd":"/private/tmp/scratch/claude-probe","session_id":"4d7d628e-a8f3-4e3b-9f8a-d7ca80af855f","tools":["Task","Bash","Edit","Read","Write"],"mcp_servers":[],"model":"claude-haiku-4-5-20251001","permissionMode":"default","slash_commands":["claude"]}`;

/** stream-json assistant text line (verbatim). */
const STREAM_ASSISTANT = `{"type":"assistant","message":{"model":"claude-haiku-4-5-20251001","id":"msg_011CcvS9EDnEgDY96DgNaRWL","type":"message","role":"assistant","content":[{"type":"text","text":"pong5"}],"stop_reason":null,"stop_sequence":null,"stop_details":null,"usage":{"input_tokens":9,"cache_creation_input_tokens":4511,"cache_read_input_tokens":21450,"output_tokens":4,"service_tier":"standard","inference_geo":"not_available"},"diagnostics":null,"context_management":null},"parent_tool_use_id":null,"session_id":"4d7d628e-a8f3-4e3b-9f8a-d7ca80af855f","uuid":"3e68d4e6-cab1-475d-8576-2bba8ce870d7","request_id":"req_011CcvS9DVNuy34Rmkd42dTV"}`;

/** stream-json final result line (verbatim, same run as STREAM_INIT). */
const STREAM_RESULT = `{"type":"result","subtype":"success","is_error":false,"api_error_status":null,"duration_ms":1800,"duration_api_ms":1722,"ttft_ms":1760,"ttft_stream_ms":1193,"time_to_request_ms":76,"num_turns":1,"result":"pong5","stop_reason":"end_turn","session_id":"4d7d628e-a8f3-4e3b-9f8a-d7ca80af855f","total_cost_usd":0.011461,"usage":{"input_tokens":9,"cache_creation_input_tokens":4511,"cache_read_input_tokens":21450,"output_tokens":57,"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":"standard","cache_creation":{"ephemeral_1h_input_tokens":4511,"ephemeral_5m_input_tokens":0},"inference_geo":"not_available","iterations":[{"input_tokens":9,"output_tokens":57,"cache_read_input_tokens":21450,"cache_creation_input_tokens":4511,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":4511},"type":"message"}],"speed":"standard"},"modelUsage":{"claude-haiku-4-5-20251001":{"inputTokens":9,"outputTokens":57,"cacheReadInputTokens":21450,"cacheCreationInputTokens":4511,"webSearchRequests":0,"costUSD":0.011461,"contextWindow":200000,"maxOutputTokens":32000}},"permission_denials":[],"terminal_reason":"completed","fast_mode_state":"off","uuid":"2e0a01e1-dc51-44a7-b4ee-1dc16c9997c2"}`;

/** stream-json hook noise line (verbatim); must be tolerated and ignored. */
const STREAM_HOOK = `{"type":"system","subtype":"hook_started","hook_id":"2f677977-e9fa-4d11-a989-6f35d4e7af09","hook_name":"SessionStart:startup","hook_event":"SessionStart","uuid":"c51597e6-a49a-492f-871a-830594f07bc9","session_id":"4d7d628e-a8f3-4e3b-9f8a-d7ca80af855f"}`;

/** stream-json rate limit noise line (verbatim); must be tolerated and ignored. */
const STREAM_RATE_LIMIT = `{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1783788000,"rateLimitType":"five_hour","overageStatus":"allowed","overageResetsAt":1783780200,"isUsingOverage":false},"uuid":"18530d41-093d-48c5-8b97-91a8f1167b07","session_id":"4d7d628e-a8f3-4e3b-9f8a-d7ca80af855f"}`;

/** Verbatim stderr from resuming an unknown session id (exit 1, empty stdout). */
const RESUME_NOT_FOUND_STDERR =
  "No conversation found with session ID: 00000000-0000-0000-0000-00000000abcd\n";

const RESUME_SESSION_ID = "92e1e510-1558-474b-88ae-f7f8ebb2d182";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface FakeExecPlan {
  lines?: string[];
  exitCode?: number | null;
  stderr?: string;
  timedOut?: boolean;
  aborted?: boolean;
  overflowed?: boolean;
  termination?: TerminationProof;
  processInfo?: ClaudeProcessInfo;
  kill?: () => Promise<boolean>;
  error?: Error;
  beforeClose?: () => Promise<void> | void;
}

function makeFakeExec(plan: FakeExecPlan): { exec: ClaudeExec; calls: ClaudeExecRequest[] } {
  const calls: ClaudeExecRequest[] = [];
  const exec: ClaudeExec = async (req) => {
    calls.push(req);
    if (plan.error) {
      throw plan.error;
    }

    if (plan.processInfo !== undefined) {
      req.onSpawn?.({
        pid: plan.processInfo.pid,
        pgid: plan.processInfo.pgid ?? plan.processInfo.pid,
        kill: plan.kill ?? (async () => true),
      });
    }

    for (const line of plan.lines ?? []) {
      req.onStdoutLine?.(line);
    }

    await plan.beforeClose?.();
    return {
      exitCode: plan.exitCode === undefined ? 0 : plan.exitCode,
      timedOut: plan.timedOut ?? false,
      aborted: plan.aborted ?? false,
      overflowed: plan.overflowed ?? false,
      stderr: plan.stderr ?? "",
      termination: plan.termination ?? "verified_gone",
    };
  };

  return { exec, calls };
}

function makeLane(overrides: Partial<LaneRecord>): LaneRecord {
  const now = new Date().toISOString();
  return {
    id: "lane_ab12cd34",
    agent: "claude",
    cwd: "/tmp/project",
    status: "running",
    createdAt: now,
    updatedAt: now,
    seq: 2,
    ...overrides,
  };
}

const DISPATCH_BASE = { laneId: "lane_ab12cd34", prompt: "do the thing", cwd: "/tmp/project" };

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

describe("ClaudeAdapter.dispatch", () => {
  test("maps a successful stream run onto a completed outcome", async () => {
    const { exec } = makeFakeExec({
      lines: [STREAM_HOOK, STREAM_INIT, STREAM_ASSISTANT, STREAM_RATE_LIMIT, STREAM_RESULT],
    });
    const adapter = new ClaudeAdapter({ exec });

    const outcome = await adapter.dispatch(DISPATCH_BASE);

    expect(DispatchOutcomeSchema.parse(outcome)).toBeTruthy();
    expect(outcome.status).toBe("completed");
    expect(outcome.delivery).toBe("confirmed");
    expect(outcome.nativeStatus).toBe("completed");
    expect(outcome.semanticOutcome).toBe("unknown");
    expect(outcome.agentSessionId).toBe("4d7d628e-a8f3-4e3b-9f8a-d7ca80af855f");
    expect(outcome.result).toEqual({ text: "pong5" });
    expect(outcome.usage).toEqual({ inputTokens: 9, outputTokens: 57, costUsd: 0.011461 });
    expect(outcome.timing?.apiMs).toBe(1722);
    expect(outcome.timing?.wallMs).toBeGreaterThanOrEqual(0);
    expect(outcome.timing?.startupMs).toBeGreaterThanOrEqual(0);
  });

  test("streams spawn identity, session metadata, and progress events in order", async () => {
    const { exec } = makeFakeExec({
      lines: [STREAM_INIT, STREAM_ASSISTANT, STREAM_RESULT],
      processInfo: { pid: 1234, pgid: 1234 },
    });
    const adapter = new ClaudeAdapter({ exec });
    const events: LaneEventInput[] = [];

    await adapter.dispatch({ ...DISPATCH_BASE, onEvent: (event) => void events.push(event) });

    expect(events.map((event) => event.event)).toEqual(["agent_started", "progress", "progress"]);
    // Finding 15: agent_started carries ONLY spawn-time identity, emitted
    // before any protocol output so a pre-protocol hang is still killable.
    expect(events[0]?.data).toEqual({
      pid: 1234,
      pgid: 1234,
      startedAt: expect.any(String) as unknown as string,
    });
    // Session/model metadata arrives separately after protocol init.
    expect(events[1]?.data).toEqual({
      phase: "session_init",
      agentSessionId: "4d7d628e-a8f3-4e3b-9f8a-d7ca80af855f",
      model: "claude-haiku-4-5-20251001",
      permissionMode: "default",
    });
    expect(events[2]?.data).toEqual({ text: "pong5" });
  });

  test("builds argv from model and adapter options, prompt on stdin, lane cwd", async () => {
    const { exec, calls } = makeFakeExec({ lines: [RESULT_SUCCESS] });
    const adapter = new ClaudeAdapter({
      exec,
      permissionMode: "acceptEdits",
      allowedTools: ["Bash(git *)", "Edit"],
    });

    await adapter.dispatch({ ...DISPATCH_BASE, model: "haiku", timeoutMs: 60_000 });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      "haiku",
      "--permission-mode",
      "acceptEdits",
      "--allowedTools",
      "Bash(git *),Edit",
    ]);
    expect(calls[0]?.stdin).toBe("do the thing");
    expect(calls[0]?.cwd).toBe("/tmp/project");
    expect(calls[0]?.timeoutMs).toBe(60_000);
  });

  test("surfaces permission denials as a progress event and still completes", async () => {
    const { exec } = makeFakeExec({ lines: [RESULT_PERMISSION_DENIED] });
    const adapter = new ClaudeAdapter({ exec });
    const events: LaneEventInput[] = [];

    const outcome = await adapter.dispatch({
      ...DISPATCH_BASE,
      onEvent: (event) => void events.push(event),
    });

    expect(outcome.status).toBe("completed");
    expect(events).toContainEqual({ event: "progress", data: { permissionDenials: ["Write"] } });
  });

  test("is_error:true maps to a failed outcome with code agent_failed (never trusts subtype)", async () => {
    const { exec } = makeFakeExec({ lines: [RESULT_API_ERROR], exitCode: 1 });
    const adapter = new ClaudeAdapter({ exec });

    const outcome = await adapter.dispatch(DISPATCH_BASE);

    expect(DispatchOutcomeSchema.parse(outcome)).toBeTruthy();
    expect(outcome.status).toBe("failed");
    expect(outcome.code).toBe("agent_failed");
    expect(outcome.nativeStatus).toBe("failed");
    expect(outcome.delivery).toBe("confirmed");
    expect(outcome.agentSessionId).toBe("cad03a8d-9d9a-4e53-92bc-81c848ae625e");
    expect(outcome.error?.message).toContain("totally-bogus-model-xyz");
  });

  test("nonzero exit without a result line maps to a failed outcome carrying stderr", async () => {
    const { exec } = makeFakeExec({ exitCode: 1, stderr: "something exploded\n" });
    const adapter = new ClaudeAdapter({ exec });

    const outcome = await adapter.dispatch(DISPATCH_BASE);

    expect(outcome.status).toBe("failed");
    expect(outcome.code).toBe("agent_failed");
    expect(outcome.delivery).toBe("unknown");
    expect(outcome.error?.message).toContain("something exploded");
  });

  test("exit 0 without a result line throws adapter_error (fail loud, never assume)", async () => {
    const { exec } = makeFakeExec({ lines: ["this is not json"], exitCode: 0 });
    const adapter = new ClaudeAdapter({ exec });

    try {
      await adapter.dispatch(DISPATCH_BASE);
      throw new Error("expected dispatch to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AdapterError);
      expect((error as AdapterError).code).toBe("adapter_error");
    }
  });

  test("a result line that fails the pinned schema throws adapter_error", async () => {
    const { exec } = makeFakeExec({
      lines: [`{"type":"result","subtype":"success"}`],
      exitCode: 0,
    });
    const adapter = new ClaudeAdapter({ exec });

    try {
      await adapter.dispatch(DISPATCH_BASE);
      throw new Error("expected dispatch to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AdapterError);
      expect((error as AdapterError).code).toBe("adapter_error");
      expect((error as AdapterError).message).toContain("pinned result shape");
    }
  });

  test("the last valid result record wins", async () => {
    const lastResult = JSON.stringify({
      ...(JSON.parse(STREAM_RESULT) as Record<string, unknown>),
      result: "the last result",
    });
    const { exec } = makeFakeExec({ lines: [STREAM_RESULT, lastResult] });
    const adapter = new ClaudeAdapter({ exec });

    const outcome = await adapter.dispatch(DISPATCH_BASE);

    expect(outcome.status).toBe("completed");
    expect(outcome.result?.text).toBe("the last result");
  });

  test("a malformed last result supersedes an earlier valid result and fails loud", async () => {
    const malformed = `{"type":"result","subtype":"success"}`;
    const { exec } = makeFakeExec({ lines: [STREAM_RESULT, malformed] });
    const adapter = new ClaudeAdapter({ exec });

    const error = await adapter
      .dispatch(DISPATCH_BASE)
      .then(() => null)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AdapterError);
    expect((error as AdapterError).code).toBe("adapter_error");
    expect((error as AdapterError).message).toContain(malformed);
  });

  test("a valid last result supersedes an earlier malformed result", async () => {
    const { exec } = makeFakeExec({
      lines: [`{"type":"result","subtype":"success"}`, STREAM_RESULT],
    });
    const adapter = new ClaudeAdapter({ exec });

    const outcome = await adapter.dispatch(DISPATCH_BASE);

    expect(outcome.status).toBe("completed");
    expect(outcome.result?.text).toBe("pong5");
  });

  test("spawn ENOENT throws agent_unavailable", async () => {
    const enoent = Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
    const { exec } = makeFakeExec({ error: enoent });
    const adapter = new ClaudeAdapter({ exec });

    try {
      await adapter.dispatch(DISPATCH_BASE);
      throw new Error("expected dispatch to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AdapterError);
      expect((error as AdapterError).code).toBe("agent_unavailable");
    }
  });

  test("a timed-out run throws AdapterError with code timeout", async () => {
    const { exec } = makeFakeExec({ exitCode: null, timedOut: true });
    const adapter = new ClaudeAdapter({ exec });

    try {
      await adapter.dispatch({ ...DISPATCH_BASE, timeoutMs: 5 });
      throw new Error("expected dispatch to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AdapterError);
      expect((error as AdapterError).code).toBe("timeout");
    }
  });

  test("post-deadline exit 0 with a valid result line is still a timeout, never success (finding 18 residual)", async () => {
    // The child trapped Orca's deadline SIGTERM, printed a complete success
    // result line, and exited 0. The exec layer reports timedOut:true and
    // the adapter must refuse to mint a success envelope from that evidence.
    const { exec } = makeFakeExec({
      lines: [STREAM_INIT, STREAM_ASSISTANT, STREAM_RESULT],
      exitCode: 0,
      timedOut: true,
    });
    const adapter = new ClaudeAdapter({ exec });

    const error = await adapter
      .dispatch({ ...DISPATCH_BASE, timeoutMs: 5 })
      .then(() => null)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AdapterError);
    expect((error as AdapterError).code).toBe("timeout");
  });

  test("stdout buffer overflow throws AdapterError with code adapter_error", async () => {
    const { exec } = makeFakeExec({ exitCode: null, overflowed: true });
    const adapter = new ClaudeAdapter({ exec });

    const error = await adapter
      .dispatch(DISPATCH_BASE)
      .then(() => null)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AdapterError);
    expect((error as AdapterError).code).toBe("adapter_error");
    expect((error as AdapterError).message).toContain("bounded protocol line buffer");
  });

  test("refuses to report timeout when process-group termination is unconfirmed", async () => {
    const { exec } = makeFakeExec({
      exitCode: null,
      timedOut: true,
      termination: "unverified",
    });
    const adapter = new ClaudeAdapter({ exec });

    const error = await adapter
      .dispatch({ ...DISPATCH_BASE, timeoutMs: 5 })
      .then(() => null)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AdapterError);
    expect((error as AdapterError).code).toBe("adapter_error");
    expect((error as AdapterError).message).toContain("termination could not be confirmed");
  });

  test("a synchronous event-sink throw immediately tree-kills and suppresses queued events", async () => {
    let killCalls = 0;
    let sinkCalls = 0;
    let markKillStarted: (() => void) | undefined;
    const killStarted = new Promise<void>((resolve) => {
      markKillStarted = resolve;
    });
    const exec: ClaudeExec = async (req) => {
      req.onSpawn?.({
        pid: 2468,
        pgid: 2468,
        kill: async () => {
          killCalls += 1;
          markKillStarted?.();
          return true;
        },
      });
      req.onStdoutLine?.(STREAM_INIT);
      await killStarted;
      req.onStdoutLine?.(STREAM_ASSISTANT);
      req.onStdoutLine?.(STREAM_RESULT);
      return {
        exitCode: null,
        timedOut: false,
        aborted: false,
        overflowed: false,
        stderr: "",
        termination: "verified_gone" as const,
      };
    };
    const adapter = new ClaudeAdapter({ exec });

    const error = await adapter
      .dispatch({
        ...DISPATCH_BASE,
        onEvent: () => {
          sinkCalls += 1;
          throw new Error("durable event write failed");
        },
      })
      .then(() => null)
      .catch((caught: unknown) => caught);

    expect(killCalls).toBe(1);
    expect(sinkCalls).toBe(1);
    expect(error).toBeInstanceOf(AdapterError);
    expect((error as AdapterError).code).toBe("adapter_error");
    expect((error as AdapterError).message).toContain("process group was terminated");
  });

  test("an async event-sink rejection awaits verified tree termination", async () => {
    let sinkCalls = 0;
    let dispatchSettled = false;
    let markKillStarted: (() => void) | undefined;
    let confirmTermination: ((confirmed: boolean) => void) | undefined;
    const killStarted = new Promise<void>((resolve) => {
      markKillStarted = resolve;
    });
    const termination = new Promise<boolean>((resolve) => {
      confirmTermination = resolve;
    });
    const exec: ClaudeExec = async (req) => {
      req.onSpawn?.({
        pid: 9753,
        pgid: 9753,
        kill: () => {
          markKillStarted?.();
          return termination;
        },
      });
      req.onStdoutLine?.(STREAM_INIT);
      await killStarted;
      req.onStdoutLine?.(STREAM_ASSISTANT);
      req.onStdoutLine?.(STREAM_RESULT);
      return {
        exitCode: null,
        timedOut: false,
        aborted: false,
        overflowed: false,
        stderr: "",
        termination: "verified_gone" as const,
      };
    };
    const adapter = new ClaudeAdapter({ exec });

    const dispatch = adapter
      .dispatch({
        ...DISPATCH_BASE,
        onEvent: async () => {
          sinkCalls += 1;
          throw new Error("async durable event write failed");
        },
      })
      .then(() => null)
      .catch((caught: unknown) => caught)
      .finally(() => {
        dispatchSettled = true;
      });

    await killStarted;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(dispatchSettled).toBe(false);
    confirmTermination?.(true);
    const error = await dispatch;

    expect(sinkCalls).toBe(1);
    expect(error).toBeInstanceOf(AdapterError);
    expect((error as AdapterError).code).toBe("adapter_error");
  });

  test("a sink failure never trusts a natural leader close as tree-termination proof (finding 20)", async () => {
    // No process handle was ever reported and no kill ran; the exec layer
    // honestly says not_attempted. The adapter must not upgrade that to
    // "terminated" on this safety-sensitive path.
    const { exec } = makeFakeExec({
      lines: [STREAM_INIT, STREAM_RESULT],
      termination: "not_attempted",
    });
    const adapter = new ClaudeAdapter({ exec });

    const error = await adapter
      .dispatch({
        ...DISPATCH_BASE,
        onEvent: () => {
          throw new Error("durable event write failed");
        },
      })
      .then(() => null)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AdapterError);
    expect((error as AdapterError).code).toBe("adapter_error");
    expect((error as Error).message).toContain("termination could not be confirmed");
  });

  test("a sink failure after leader close still runs verified group cleanup via the retained handle (finding 17/20)", async () => {
    let killCalls = 0;
    const { exec } = makeFakeExec({
      lines: [STREAM_INIT, STREAM_RESULT],
      // Natural close with a surviving descendant: no proof from the exec.
      termination: "not_attempted",
      processInfo: { pid: 8642, pgid: 8642 },
      kill: async () => {
        killCalls += 1;
        return true;
      },
    });
    const adapter = new ClaudeAdapter({ exec });

    const error = await adapter
      .dispatch({
        ...DISPATCH_BASE,
        onEvent: (event) => {
          if (event.event === "progress") {
            throw new Error("durable event write failed");
          }
        },
      })
      .then(() => null)
      .catch((caught: unknown) => caught);

    expect(killCalls).toBe(1);
    expect(error).toBeInstanceOf(AdapterError);
    expect((error as AdapterError).code).toBe("adapter_error");
    expect((error as Error).message).toContain("process group was terminated");
  });

  test("an aborted run with a signal death fails loud and reports verified termination", async () => {
    const { exec } = makeFakeExec({ exitCode: null, aborted: true });
    const adapter = new ClaudeAdapter({ exec });

    const error = await adapter
      .dispatch(DISPATCH_BASE)
      .then(() => null)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AdapterError);
    expect((error as AdapterError).code).toBe("adapter_error");
    expect((error as Error).message).toContain("aborted");
    expect((error as Error).message).toContain("termination was verified");
  });

  test("an abort that lost the race to a real exit defers to that exit's evidence", async () => {
    const { exec } = makeFakeExec({ lines: [STREAM_RESULT], aborted: true });
    const adapter = new ClaudeAdapter({ exec });

    const outcome = await adapter.dispatch(DISPATCH_BASE);

    expect(outcome.status).toBe("completed");
    expect(outcome.result?.text).toBe("pong5");
  });
});

// ---------------------------------------------------------------------------
// resume
// ---------------------------------------------------------------------------

describe("ClaudeAdapter.resume", () => {
  let configDir: string;
  let cwd: string;
  let transcript: string;

  beforeEach(async () => {
    configDir = await fs.mkdtemp(path.join(os.tmpdir(), "orca-claude-config-"));
    // realpath: on macOS os.tmpdir() sits behind the /var -> /private/var
    // symlink, and claude keys its native store by the resolved path.
    cwd = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "orca-claude-cwd-")));
    transcript = transcriptPath(configDir, cwd, RESUME_SESSION_ID);
    await fs.mkdir(path.dirname(transcript), { recursive: true });
    await fs.writeFile(transcript, `{"type":"user"}\n`);
  });

  afterEach(async () => {
    await fs.rm(configDir, { recursive: true, force: true });
    await fs.rm(cwd, { recursive: true, force: true });
  });

  function resumeLane(overrides: Partial<LaneRecord> = {}): LaneRecord {
    return makeLane({ cwd, agentSessionId: RESUME_SESSION_ID, ...overrides });
  }

  test("verifies continuity when the result echoes the session id and the transcript advances", async () => {
    const { exec, calls } = makeFakeExec({
      lines: [RESULT_RESUME],
      beforeClose: () => fs.appendFile(transcript, `{"type":"assistant"}\n`),
    });
    const adapter = new ClaudeAdapter({ exec, claudeConfigDir: configDir });

    const outcome = await adapter.resume(resumeLane({ model: "haiku" }), "keep going");

    expect(DispatchOutcomeSchema.parse(outcome)).toBeTruthy();
    expect(outcome.status).toBe("completed");
    expect(outcome.result).toEqual({ text: "pong2" });
    expect(outcome.continuity).toEqual({
      verified: true,
      method: "session-id-match",
      detail: expect.stringContaining("transcript grew") as unknown as string,
    });
    expect(calls[0]?.args).toContain("--resume");
    expect(calls[0]?.args).toContain(RESUME_SESSION_ID);
    expect(calls[0]?.args).toContain("haiku");
    expect(calls[0]?.stdin).toBe("keep going");
    expect(calls[0]?.cwd).toBe(cwd);
  });

  test("threads resume timeout and emits process plus progress evidence", async () => {
    const resumeInit = JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: RESUME_SESSION_ID,
      model: "claude-haiku-4-5-20251001",
      permissionMode: "default",
    });
    const { exec, calls } = makeFakeExec({
      lines: [resumeInit, STREAM_ASSISTANT, RESULT_RESUME],
      processInfo: { pid: 4321, pgid: 4321 },
      beforeClose: () => fs.appendFile(transcript, `{"type":"assistant"}\n`),
    });
    const adapter = new ClaudeAdapter({ exec, claudeConfigDir: configDir });
    const events: LaneEventInput[] = [];

    const outcome = await adapter.resume(resumeLane(), "keep going", {
      timeoutMs: 12_345,
      onEvent: (event) => void events.push(event),
    });

    expect(outcome.status).toBe("completed");
    expect(calls[0]?.timeoutMs).toBe(12_345);
    expect(events.map((event) => event.event)).toEqual(["agent_started", "progress", "progress"]);
    // Spawn-time identity first (finding 15), session metadata separately.
    expect(events[0]?.data).toMatchObject({ pid: 4321, pgid: 4321 });
    expect(typeof events[0]?.data.startedAt).toBe("string");
    expect(events[1]?.data).toMatchObject({
      phase: "session_init",
      agentSessionId: RESUME_SESSION_ID,
    });
    expect(events[2]?.data).toEqual({ text: "pong5" });
  });

  test("throws ContinuityError without running claude when the lane has no session id", async () => {
    const { exec, calls } = makeFakeExec({ lines: [RESULT_RESUME] });
    const adapter = new ClaudeAdapter({ exec, claudeConfigDir: configDir });
    const lane = makeLane({ cwd });

    try {
      await adapter.resume(lane, "keep going");
      throw new Error("expected resume to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ContinuityError);
    }
    expect(calls).toHaveLength(0);
  });

  test("throws ContinuityError without running claude when the transcript is missing", async () => {
    await fs.rm(transcript);
    const { exec, calls } = makeFakeExec({ lines: [RESULT_RESUME] });
    const adapter = new ClaudeAdapter({ exec, claudeConfigDir: configDir });

    try {
      await adapter.resume(resumeLane(), "keep going");
      throw new Error("expected resume to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ContinuityError);
      expect((error as ContinuityError).detail).toContain(transcript);
    }
    expect(calls).toHaveLength(0);
  });

  test("maps claude's verbatim unknown-session failure to ContinuityError", async () => {
    // Probed: unknown --resume ids exit 1 with empty stdout and this stderr.
    const { exec } = makeFakeExec({ exitCode: 1, stderr: RESUME_NOT_FOUND_STDERR });
    const adapter = new ClaudeAdapter({ exec, claudeConfigDir: configDir });

    try {
      await adapter.resume(resumeLane(), "keep going");
      throw new Error("expected resume to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ContinuityError);
      expect((error as ContinuityError).detail).toContain("No conversation found");
    }
  });

  test("throws ContinuityError when the result echoes a different session id", async () => {
    const otherSession = "ffffffff-1111-2222-3333-444444444444";
    const otherTranscript = transcriptPath(configDir, cwd, otherSession);
    await fs.writeFile(otherTranscript, `{"type":"user"}\n`);

    // RESULT_RESUME echoes 92e1e510-..., not the lane's bound session.
    const { exec } = makeFakeExec({ lines: [RESULT_RESUME] });
    const adapter = new ClaudeAdapter({ exec, claudeConfigDir: configDir });

    try {
      await adapter.resume(resumeLane({ agentSessionId: otherSession }), "keep going");
      throw new Error("expected resume to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ContinuityError);
      expect((error as ContinuityError).detail).toContain(otherSession);
    }
  });

  test("throws ContinuityError when a successful run does not advance the transcript", async () => {
    const { exec } = makeFakeExec({ lines: [RESULT_RESUME] });
    const adapter = new ClaudeAdapter({ exec, claudeConfigDir: configDir });

    try {
      await adapter.resume(resumeLane(), "keep going");
      throw new Error("expected resume to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ContinuityError);
      expect((error as Error).message).toContain("did not advance");
    }
  });

  test("resolves symlinked lane cwds to the realpath claude actually keys by", async () => {
    // Probed: claude computes the project key from the realpath of its cwd,
    // so a lane created with a symlinked cwd must still find the transcript.
    const symlinked = `${cwd}-link`;
    await fs.symlink(cwd, symlinked);
    try {
      const { exec } = makeFakeExec({
        lines: [RESULT_RESUME],
        beforeClose: () => fs.appendFile(transcript, `{"type":"assistant"}\n`),
      });
      const adapter = new ClaudeAdapter({ exec, claudeConfigDir: configDir });

      const outcome = await adapter.resume(resumeLane({ cwd: symlinked }), "keep going");

      expect(outcome.status).toBe("completed");
      expect(outcome.continuity?.verified).toBe(true);
    } finally {
      await fs.rm(symlinked, { force: true });
    }
  });

  test("a failed run that still echoes the session id returns failed with continuity evidence", async () => {
    const failedResume = JSON.stringify({
      ...(JSON.parse(RESULT_RESUME) as Record<string, unknown>),
      is_error: true,
    });
    const { exec } = makeFakeExec({ lines: [failedResume], exitCode: 1 });
    const adapter = new ClaudeAdapter({ exec, claudeConfigDir: configDir });

    const outcome = await adapter.resume(resumeLane(), "keep going");

    expect(outcome.status).toBe("failed");
    expect(outcome.code).toBe("agent_failed");
    expect(outcome.continuity?.verified).toBe(true);
    expect(outcome.continuity?.method).toBe("session-id-match");
  });
});

// ---------------------------------------------------------------------------
// inspect + capabilities
// ---------------------------------------------------------------------------

describe("ClaudeAdapter.inspect", () => {
  test("reports unknown with detail when no session is bound", async () => {
    const adapter = new ClaudeAdapter({ exec: makeFakeExec({}).exec });

    const snapshot = await adapter.inspect(makeLane({}));

    expect(snapshot.nativeStatus).toBe("unknown");
    expect(snapshot.detail).toContain("no claude session");
  });

  test("reports transcript mtime as lastActivityAt when the transcript exists", async () => {
    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "orca-claude-config-"));
    try {
      const cwd = "/tmp/project";
      const sessionId = "11111111-2222-3333-4444-555555555555";
      const transcript = transcriptPath(configDir, cwd, sessionId);
      await fs.mkdir(path.dirname(transcript), { recursive: true });
      await fs.writeFile(transcript, `{"type":"user"}\n`);

      const adapter = new ClaudeAdapter({
        exec: makeFakeExec({}).exec,
        claudeConfigDir: configDir,
      });
      const snapshot = await adapter.inspect(makeLane({ cwd, agentSessionId: sessionId }));

      expect(snapshot.nativeStatus).toBe("unknown");
      expect(snapshot.agentSessionId).toBe(sessionId);
      expect(Date.parse(snapshot.lastActivityAt ?? "")).toBeGreaterThan(0);
    } finally {
      await fs.rm(configDir, { recursive: true, force: true });
    }
  });

  test("reports a missing transcript path in detail", async () => {
    const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "orca-claude-config-"));
    try {
      const adapter = new ClaudeAdapter({
        exec: makeFakeExec({}).exec,
        claudeConfigDir: configDir,
      });
      const snapshot = await adapter.inspect(
        makeLane({ agentSessionId: "11111111-2222-3333-4444-555555555555" }),
      );

      expect(snapshot.nativeStatus).toBe("unknown");
      expect(snapshot.detail).toContain("transcript not found");
    } finally {
      await fs.rm(configDir, { recursive: true, force: true });
    }
  });
});

describe("ClaudeAdapter.capabilities", () => {
  test("returns a valid manifest with probed semantics", () => {
    const manifest = new ClaudeAdapter({ exec: makeFakeExec({}).exec }).capabilities();

    expect(AgentManifestSchema.parse(manifest)).toBeTruthy();
    expect(manifest.agent).toBe("claude");
    expect(manifest.capabilities.resume).toBe(true);
    // This suite runs on POSIX; kill is reported platform-aware (P-POSIX).
    expect(manifest.capabilities.kill).toBe(true);
    expect(manifest.caveats?.map((caveat) => caveat.code)).toContain("posix_only");
    // Probed: AskUserQuestion is not in the headless tool set; runs never park.
    expect(manifest.capabilities.questions).toBe(false);
    expect(manifest.capabilities.continuityMethods).toEqual(["session-id-match"]);
    expect(manifest.caveats?.map((caveat) => caveat.code)).toContain(
      "default_permissions_deny_writes",
    );
    expect(manifest.declared).toMatchObject({
      permissionModes: [...CLAUDE_PERMISSION_MODES],
      promptDelivery: "stdin",
      outputFormat: "stream-json",
    });
  });

  test("kill capability is platform-aware: POSIX true with caveat, win32 false (P-POSIX)", () => {
    const posix = buildClaudeManifest("linux");
    expect(AgentManifestSchema.parse(posix)).toBeTruthy();
    expect(posix.capabilities.kill).toBe(true);
    expect(posix.caveats?.map((caveat) => caveat.code)).toContain("posix_only");

    const windows = buildClaudeManifest("win32");
    expect(AgentManifestSchema.parse(windows)).toBeTruthy();
    expect(windows.capabilities.kill).toBe(false);
    expect(windows.caveats?.map((caveat) => caveat.code)).not.toContain("posix_only");
  });
});
