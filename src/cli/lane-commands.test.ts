import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import { pathToFileURL } from "node:url";

import { AdapterRegistry, ContinuityError, LaneStore } from "../lane/index.js";
import type { AgentAdapter } from "../lane/index.js";
import type { DispatchOutcome, DispatchRequest, LaneRecord } from "../types/lane.js";
import { isLaneCliInvocation, runLaneCli } from "./lane-commands.js";
import type { LaneCliDeps } from "./lane-commands.js";

interface CaptureWriter {
  chunks: string[];
  write(chunk: string): boolean;
  lines(): string[];
  json(index: number): Record<string, unknown>;
  lastJson(): Record<string, unknown>;
}

function capture(): CaptureWriter {
  const chunks: string[] = [];
  return {
    chunks,
    write(chunk: string): boolean {
      chunks.push(chunk);
      return true;
    },
    lines(): string[] {
      return chunks
        .join("")
        .split("\n")
        .filter((line) => line !== "");
    },
    json(index: number): Record<string, unknown> {
      const line = this.lines()[index];
      if (line === undefined) {
        throw new Error(`no stdout line at index ${index}`);
      }

      return JSON.parse(line) as Record<string, unknown>;
    },
    lastJson(): Record<string, unknown> {
      const lines = this.lines();
      const last = lines[lines.length - 1];
      if (last === undefined) {
        throw new Error("no stdout lines captured");
      }

      return JSON.parse(last) as Record<string, unknown>;
    },
  };
}

function completedOutcome(text: string): DispatchOutcome {
  return {
    status: "completed",
    delivery: "confirmed",
    nativeStatus: "completed",
    semanticOutcome: "unknown",
    result: { text },
  };
}

function blockedOutcome(): DispatchOutcome {
  return {
    status: "blocked",
    delivery: "confirmed",
    nativeStatus: "unknown",
    semanticOutcome: "unknown",
    blocked: {
      questions: [{ id: "q1", question: "Which database?", options: ["staging", "prod"] }],
    },
  };
}

interface StubBehavior {
  agent?: string;
  dispatch?: AgentAdapter["dispatch"];
  resume?: AgentAdapter["resume"];
}

function stubAdapter(behavior: StubBehavior = {}): AgentAdapter {
  const agent = behavior.agent ?? "stub";
  return {
    dispatch: behavior.dispatch ?? (() => Promise.resolve(completedOutcome("done"))),
    resume: behavior.resume ?? (() => Promise.resolve(completedOutcome("resumed"))),
    inspect: () => Promise.resolve({ nativeStatus: "unknown" as const }),
    capabilities: () => ({
      v: 1 as const,
      agent,
      capabilities: {
        resume: true,
        kill: true,
        questions: true,
        continuityMethods: ["session-id-match" as const],
      },
    }),
  };
}

describe("lane-commands CLI", () => {
  let orcaHome: string;
  let previousOrcaHome: string | undefined;

  beforeEach(async () => {
    previousOrcaHome = process.env.ORCA_HOME;
    orcaHome = await fs.mkdtemp(path.join(os.tmpdir(), "orca-lane-cli-test-"));
    process.env.ORCA_HOME = orcaHome;
  });

  afterEach(async () => {
    if (previousOrcaHome === undefined) {
      delete process.env.ORCA_HOME;
    } else {
      process.env.ORCA_HOME = previousOrcaHome;
    }

    await fs.rm(orcaHome, { recursive: true, force: true });
  });

  async function run(
    args: string[],
    deps: LaneCliDeps = {},
  ): Promise<{ exitCode: number | null; stdout: CaptureWriter; stderr: CaptureWriter }> {
    const stdout = capture();
    const stderr = capture();
    const exitCode = await runLaneCli(args, {
      registry: deps.registry ?? new AdapterRegistry(),
      stdout,
      stderr,
      pollIntervalMs: 10,
      loadAdapterModule: () => Promise.reject(new Error("no built-in adapters in tests")),
      ...deps,
    });

    return { exitCode, stdout, stderr };
  }

  describe("routing", () => {
    test("non-lane verbs fall through to the legacy CLI", async () => {
      expect(isLaneCliInvocation(["status"])).toBe(false);
      expect(await runLaneCli(["status"])).toBeNull();
    });

    test("answer/resume fall through unless the id starts with lane_", async () => {
      expect(isLaneCliInvocation(["answer", "run-123", "hi"])).toBe(false);
      expect(isLaneCliInvocation(["resume"])).toBe(false);
      expect(isLaneCliInvocation(["resume", "--run", "run-123"])).toBe(false);
      expect(await runLaneCli(["answer", "run-123", "hi"])).toBeNull();

      expect(isLaneCliInvocation(["answer", "lane_a3f8b901", "hi"])).toBe(true);
      expect(isLaneCliInvocation(["dispatch", "--agent", "stub", "task"])).toBe(true);
    });

    test("bare answer/resume help routes to the lane CLI and explains the routing", async () => {
      for (const verb of ["answer", "resume"]) {
        expect(isLaneCliInvocation([verb, "--help"])).toBe(true);
        const { exitCode, stdout } = await run([verb, "--help"]);
        expect(exitCode).toBe(0);
        const text = stdout.chunks.join("");
        expect(text).toContain("AGENTS:");
        expect(text).toContain(`orca ${verb} lane_a3f81c02`);
        // Lane-vs-legacy routing is stated in the verb description itself,
        // not buried in a footnote.
        expect(text).toContain("Lane vs legacy routing");
        expect(text).toContain("legacy answer/resume commands");
      }
    });

    test("invalid lane ids fail as usage errors before store access", async () => {
      for (const args of [
        ["inspect", "lane_bad"],
        ["answer", "lane_../../", "text"],
        ["resume", "lane_NOTHEX", "prompt"],
        ["kill", "lane_123456789"],
      ]) {
        const { exitCode, stdout } = await run(args);
        expect(exitCode).toBe(2);
        expect(stdout.lastJson().code).toBe("usage_error");
        expect((stdout.lastJson().error as { message: string }).message).toContain(
          "lane_[0-9a-f]{8}",
        );
      }
    });
  });

  describe("dispatch", () => {
    test("happy path: handle line first, one envelope last, exit 0", async () => {
      const registry = new AdapterRegistry();
      let received: DispatchRequest | undefined;
      registry.register(
        stubAdapter({
          dispatch: (req) => {
            received = req;
            return Promise.resolve(completedOutcome("all tests pass"));
          },
        }),
      );

      const { exitCode, stdout } = await run(
        ["dispatch", "--agent", "stub", "--cwd", "/tmp", "--label", "fix", "do the thing"],
        { registry },
      );

      expect(exitCode).toBe(0);
      const lines = stdout.lines();
      expect(lines).toHaveLength(2);

      const handle = stdout.json(0);
      expect(handle.kind).toBe("handle");
      expect(handle.agent).toBe("stub");
      expect(handle.laneId).toMatch(/^lane_[0-9a-f]{8}$/);

      const envelope = stdout.lastJson();
      expect(envelope.v).toBe(1);
      expect(envelope.kind).toBe("lane");
      expect(envelope.ok).toBe(true);
      expect(envelope.status).toBe("completed");
      expect(envelope.delivery).toBe("confirmed");
      expect(envelope.nativeStatus).toBe("completed");
      expect(envelope.semanticOutcome).toBe("unknown");
      expect((envelope.result as { text: string }).text).toBe("all tests pass");
      expect((envelope.lane as { id: string }).id).toBe(handle.laneId as string);
      expect(typeof (envelope.timing as { wallMs: number }).wallMs).toBe("number");

      expect(received?.prompt).toBe("do the thing");
      expect(received?.cwd).toBe(path.resolve("/tmp"));

      const store = new LaneStore();
      const lane = await store.loadLane(handle.laneId as string);
      expect(lane?.status).toBe("completed");
      const events = await store.readEvents(handle.laneId as string);
      expect(events.map((event) => event.event)).toEqual(["created", "result"]);
    });

    test("adapter onEvent streams into the lane event log", async () => {
      const registry = new AdapterRegistry();
      registry.register(
        stubAdapter({
          dispatch: async (req) => {
            await req.onEvent?.({ event: "agent_started", data: {} });
            await req.onEvent?.({ event: "progress", data: { note: "halfway" } });
            return completedOutcome("done");
          },
        }),
      );

      const { exitCode, stdout } = await run(["dispatch", "--agent", "stub", "task"], {
        registry,
      });

      expect(exitCode).toBe(0);
      const laneId = stdout.json(0).laneId as string;
      const events = await new LaneStore().readEvents(laneId);
      expect(events.map((event) => event.event)).toEqual([
        "created",
        "agent_started",
        "progress",
        "result",
      ]);
    });

    test("persists process identity and does not duplicate an adapter-emitted result", async () => {
      const registry = new AdapterRegistry();
      registry.register(
        stubAdapter({
          dispatch: async (req) => {
            await req.onEvent?.({
              event: "agent_started",
              data: { pid: 41_001, pgid: 41_001 },
            });
            await req.onEvent?.({
              event: "result",
              data: { text: "done", delivery: "confirmed", nativeStatus: "completed" },
            });
            return completedOutcome("done");
          },
        }),
      );

      const { exitCode, stdout } = await run(["dispatch", "--agent", "stub", "task"], {
        registry,
      });

      expect(exitCode).toBe(0);
      const laneId = stdout.json(0).laneId as string;
      const store = new LaneStore();
      expect((await store.loadLane(laneId))?.process).toMatchObject({
        pid: 41_001,
        pgid: 41_001,
      });
      const events = await store.readEvents(laneId);
      expect(events.filter((event) => event.event === "result")).toHaveLength(1);
    });

    test("rejects malformed or non-leader process-group identity", async () => {
      for (const data of [
        { pid: "not-a-pid", pgid: 41_001 },
        { pid: 41_001, pgid: 41_002 },
      ]) {
        const registry = new AdapterRegistry();
        registry.register(
          stubAdapter({
            dispatch: async (req) => {
              await req.onEvent?.({ event: "agent_started", data });
              return completedOutcome("unreachable");
            },
          }),
        );

        const { exitCode, stdout } = await run(["dispatch", "--agent", "stub", "task"], {
          registry,
        });
        expect(exitCode).toBe(3);
        expect(stdout.lastJson().code).toBe("adapter_error");
        const laneId = stdout.json(0).laneId as string;
        const store = new LaneStore();
        expect((await store.loadLane(laneId))?.process).toBeUndefined();
        expect((await store.readEvents(laneId)).at(-1)?.event).toBe("failed");
      }
    });

    test("terminal event/status mismatches fail loud with matching durable evidence", async () => {
      const registry = new AdapterRegistry();
      registry.register(
        stubAdapter({
          dispatch: async (req) => {
            await req.onEvent?.({
              event: "failed",
              data: { code: "agent_failed", message: "native failed" },
            });
            return completedOutcome("contradictory result");
          },
        }),
      );

      const dispatched = await run(["dispatch", "--agent", "stub", "task"], { registry });
      expect(dispatched.exitCode).toBe(3);
      expect(dispatched.stdout.lastJson().status).toBe("failed");
      expect(dispatched.stdout.lastJson().code).toBe("adapter_error");

      const laneId = dispatched.stdout.json(0).laneId as string;
      const inspected = await run(["inspect", laneId], { registry });
      expect(inspected.exitCode).toBe(3);
      expect(inspected.stdout.lastJson().status).toBe("failed");
      expect(inspected.stdout.lastJson().code).toBe("adapter_error");
      expect((inspected.stdout.lastJson().error as { message: string }).message).toContain(
        "returned status completed",
      );
    });

    test("threads --timeout and clamps adapter semantic claims to unknown", async () => {
      const registry = new AdapterRegistry();
      let timeoutMs: number | undefined;
      registry.register(
        stubAdapter({
          dispatch: (req) => {
            timeoutMs = req.timeoutMs;
            return Promise.resolve({
              ...completedOutcome("claimed validation"),
              semanticOutcome: "validated_pass" as const,
            });
          },
        }),
      );

      const { exitCode, stdout } = await run(
        ["dispatch", "--agent", "stub", "--timeout", "1234", "task"],
        { registry },
      );

      expect(exitCode).toBe(0);
      expect(timeoutMs).toBe(1234);
      expect(stdout.lastJson().semanticOutcome).toBe("unknown");
    });

    test("missing --agent is a usage error: envelope on stdout, exit 2", async () => {
      const { exitCode, stdout } = await run(["dispatch", "prompt only"]);

      expect(exitCode).toBe(2);
      const envelope = stdout.lastJson();
      expect(envelope.ok).toBe(false);
      expect(envelope.code).toBe("usage_error");
      expect((envelope.error as { message: string }).message).toContain("--agent");
    });

    test("--detach is rejected in v0 with remediation", async () => {
      const { exitCode, stdout } = await run(["dispatch", "--agent", "stub", "--detach", "task"]);

      expect(exitCode).toBe(2);
      const envelope = stdout.lastJson();
      expect(envelope.code).toBe("usage_error");
      expect((envelope.error as { remediation?: string }).remediation).toContain("--follow");
    });

    test("unknown agent: agent_unavailable, exit 3, no handle line, no lane", async () => {
      const { exitCode, stdout } = await run(["dispatch", "--agent", "nope", "task"]);

      expect(exitCode).toBe(3);
      expect(stdout.lines()).toHaveLength(1);
      const envelope = stdout.lastJson();
      expect(envelope.ok).toBe(false);
      expect(envelope.code).toBe("agent_unavailable");
      expect((envelope.error as { remediation: string }).remediation).toContain(
        "Known agents: claude, codex, cursor",
      );

      expect(await new LaneStore().listLanes()).toHaveLength(0);
    });

    test("adapter throwing AdapterError(timeout) exits 5 and fails the lane", async () => {
      const registry = new AdapterRegistry();
      registry.register(
        stubAdapter({
          dispatch: () =>
            Promise.resolve({
              status: "failed" as const,
              delivery: "confirmed" as const,
              nativeStatus: "failed" as const,
              semanticOutcome: "unknown" as const,
              code: "timeout" as const,
              error: { message: "agent hit the 30s deadline" },
            }),
        }),
      );

      const { exitCode, stdout } = await run(["dispatch", "--agent", "stub", "task"], {
        registry,
      });

      expect(exitCode).toBe(5);
      const envelope = stdout.lastJson();
      expect(envelope.ok).toBe(false);
      expect(envelope.code).toBe("timeout");
      expect(envelope.status).toBe("failed");
    });
  });

  describe("blocked flow", () => {
    test("dispatch -> blocked (exit 0) -> answer -> resume completes", async () => {
      const registry = new AdapterRegistry();
      let resumedWith: { laneId: string; prompt: string } | undefined;
      registry.register(
        stubAdapter({
          dispatch: () => Promise.resolve(blockedOutcome()),
          resume: (lane: LaneRecord, prompt: string) => {
            resumedWith = { laneId: lane.id, prompt };
            return Promise.resolve(completedOutcome("resumed and finished"));
          },
        }),
      );

      const dispatch = await run(["dispatch", "--agent", "stub", "pick a database"], {
        registry,
      });
      expect(dispatch.exitCode).toBe(0);
      const laneId = dispatch.stdout.json(0).laneId as string;
      const blockedEnvelope = dispatch.stdout.lastJson();
      expect(blockedEnvelope.ok).toBe(true);
      expect(blockedEnvelope.status).toBe("blocked");
      const questions = (blockedEnvelope.blocked as { questions: { id: string }[] }).questions;
      expect(questions).toHaveLength(1);
      expect(questions[0]?.id).toBe("q1");
      expect(blockedEnvelope.next as string[]).toContain(`orca answer ${laneId} "<your answer>"`);

      const answer = await run(["answer", laneId, "staging"], { registry });
      expect(answer.exitCode).toBe(0);
      const answerEnvelope = answer.stdout.lastJson();
      expect(answerEnvelope.ok).toBe(true);
      expect(answerEnvelope.status).toBe("blocked");
      expect(answerEnvelope.next).toEqual([`orca resume ${laneId} "continue"`]);

      const store = new LaneStore();
      expect(await store.readAnswer(laneId)).toBe("staging");
      const events = await store.readEvents(laneId);
      expect(events.map((event) => event.event)).toEqual(["created", "question", "answered"]);

      const resume = await run(["resume", laneId, "continue with staging"], { registry });
      expect(resume.exitCode).toBe(0);
      const resumeEnvelope = resume.stdout.lastJson();
      expect(resumeEnvelope.ok).toBe(true);
      expect(resumeEnvelope.status).toBe("completed");
      expect(resumedWith).toEqual({ laneId, prompt: "continue with staging" });

      expect((await store.loadLane(laneId))?.status).toBe("completed");
    });

    test("resume forwards events and timeout options", async () => {
      const registry = new AdapterRegistry();
      let resumeTimeout: number | undefined;
      registry.register(
        stubAdapter({
          dispatch: () => Promise.resolve(blockedOutcome()),
          resume: async (_lane, _prompt, opts) => {
            resumeTimeout = opts?.timeoutMs;
            await opts?.onEvent?.({ event: "answered", data: { requestId: "q1" } });
            await opts?.onEvent?.({ event: "progress", data: { note: "resuming" } });
            return completedOutcome("finished");
          },
        }),
      );

      const dispatch = await run(["dispatch", "--agent", "stub", "task"], { registry });
      const laneId = dispatch.stdout.json(0).laneId as string;
      await run(["answer", laneId, "staging"], { registry });
      const resumed = await run(["resume", laneId, "--timeout", "4321", "continue"], {
        registry,
      });

      expect(resumed.exitCode).toBe(0);
      expect(resumeTimeout).toBe(4321);
      const store = new LaneStore();
      expect(await store.readAnswer(laneId)).toBeNull();
      const events = await store.readEvents(laneId);
      expect(events.map((event) => event.event)).toContain("progress");
      expect(events.map((event) => event.event)).toContain("resume_started");
    });

    test("resume is rejected while the latest question is live and the poller is alive", async () => {
      const registry = new AdapterRegistry();
      let resumeCalled = false;
      registry.register(
        stubAdapter({
          dispatch: async (req) => {
            // The recorded lane process stands in for the polling dispatch;
            // this test process is provably alive.
            await req.onEvent?.({
              event: "agent_started",
              data: { pid: process.pid, pgid: process.pid },
            });
            await req.onEvent?.({
              event: "question",
              data: {
                live: true,
                questions: [{ id: "q1", question: "Which database?" }],
              },
            });
            return blockedOutcome();
          },
          resume: () => {
            resumeCalled = true;
            return Promise.resolve(completedOutcome("must not run"));
          },
        }),
      );

      const dispatch = await run(["dispatch", "--agent", "stub", "task"], { registry });
      const laneId = dispatch.stdout.json(0).laneId as string;

      const resumed = await run(["resume", laneId, "continue"], { registry });
      expect(resumed.exitCode).toBe(4);
      const envelope = resumed.stdout.lastJson();
      expect(envelope.ok).toBe(false);
      expect(envelope.code).toBe("invalid_state");
      expect(envelope.status).toBe("blocked");
      expect((envelope.error as { message: string }).message).toContain("question is live");
      expect((envelope.error as { remediation: string }).remediation).toContain(
        `orca inspect ${laneId} --wait-for done`,
      );
      expect(resumeCalled).toBe(false);

      const store = new LaneStore();
      expect((await store.loadLane(laneId))?.status).toBe("blocked");
      const events = await store.readEvents(laneId);
      expect(events.some((event) => event.event === "resume_started")).toBe(false);
    });

    test("a live question with a dead recorded poller can be resumed", async () => {
      const deadChild = Bun.spawn(["sleep", "0"]);
      await deadChild.exited;

      const registry = new AdapterRegistry();
      registry.register(
        stubAdapter({
          dispatch: async (req) => {
            await req.onEvent?.({
              event: "question",
              data: {
                live: true,
                questions: [{ id: "q1", question: "Which database?" }],
              },
            });
            return blockedOutcome();
          },
          resume: () => Promise.resolve(completedOutcome("resumed after poller death")),
        }),
      );

      const dispatch = await run(["dispatch", "--agent", "stub", "task"], { registry });
      const laneId = dispatch.stdout.json(0).laneId as string;
      // The dispatch process that owned the live question is gone.
      const store = new LaneStore();
      await store.updateLane(laneId, {
        process: { pid: deadChild.pid, startedAt: new Date().toISOString() },
      });

      const resumed = await run(["resume", laneId, "continue"], { registry });
      expect(resumed.exitCode).toBe(0);
      expect(resumed.stdout.lastJson().status).toBe("completed");
      const events = await store.readEvents(laneId);
      expect(events.some((event) => event.event === "resume_started")).toBe(true);
    });

    test("resume of a completed lane succeeds end to end (terminal carve-out)", async () => {
      const registry = new AdapterRegistry();
      let resumedWith: { laneId: string; prompt: string } | undefined;
      registry.register(
        stubAdapter({
          resume: (lane: LaneRecord, prompt: string) => {
            resumedWith = { laneId: lane.id, prompt };
            return Promise.resolve(completedOutcome("second turn done"));
          },
        }),
      );

      const dispatch = await run(["dispatch", "--agent", "stub", "first turn"], { registry });
      expect(dispatch.exitCode).toBe(0);
      const laneId = dispatch.stdout.json(0).laneId as string;
      expect(dispatch.stdout.lastJson().status).toBe("completed");

      const resumed = await run(["resume", laneId, "one more thing"], { registry });
      expect(resumed.exitCode).toBe(0);
      const envelope = resumed.stdout.lastJson();
      expect(envelope.ok).toBe(true);
      expect(envelope.status).toBe("completed");
      expect((envelope.result as { text: string }).text).toBe("second turn done");
      expect(resumedWith).toEqual({ laneId, prompt: "one more thing" });

      const store = new LaneStore();
      expect((await store.loadLane(laneId))?.status).toBe("completed");
      const events = await store.readEvents(laneId);
      expect(events.map((event) => event.event)).toEqual([
        "created",
        "result",
        "resume_started",
        "result",
      ]);
    });

    test("resume of failed, killed, and lost lanes is invalid_state with dispatch remediation", async () => {
      const registry = new AdapterRegistry();
      registry.register(stubAdapter());
      const store = new LaneStore();

      for (const terminal of ["failed", "killed", "lost"] as const) {
        const lane = await store.createLane({ agent: "stub", cwd: "/tmp" });
        await store.transitionLane(lane.id, { from: ["queued"], to: terminal });

        const resumed = await run(["resume", lane.id, "continue"], { registry, store });
        expect(resumed.exitCode).toBe(4);
        const envelope = resumed.stdout.lastJson();
        expect(envelope.code).toBe("invalid_state");
        expect(envelope.status).toBe(terminal);
        expect((envelope.error as { remediation: string }).remediation).toContain("orca dispatch");
        expect((await store.loadLane(lane.id))?.status).toBe(terminal);
      }
    });

    test("answer suggests inspect while a live parked dispatch consumes the answer", async () => {
      const registry = new AdapterRegistry();
      registry.register(
        stubAdapter({
          dispatch: async (req) => {
            await req.onEvent?.({
              event: "question",
              data: {
                live: true,
                questions: [{ id: "q1", question: "Which database?" }],
              },
            });
            return blockedOutcome();
          },
        }),
      );

      const dispatch = await run(["dispatch", "--agent", "stub", "task"], { registry });
      const laneId = dispatch.stdout.json(0).laneId as string;
      const answer = await run(["answer", laneId, "staging"], { registry });

      expect(answer.exitCode).toBe(0);
      expect(answer.stdout.lastJson().next).toEqual([
        `orca inspect ${laneId} --wait-for done --timeout 120000`,
      ]);
    });

    test("answer on a non-blocked lane is invalid_state (exit 4)", async () => {
      const registry = new AdapterRegistry();
      registry.register(stubAdapter());

      const dispatch = await run(["dispatch", "--agent", "stub", "task"], { registry });
      const laneId = dispatch.stdout.json(0).laneId as string;

      const { exitCode, stdout } = await run(["answer", laneId, "too late"], { registry });
      expect(exitCode).toBe(4);
      const envelope = stdout.lastJson();
      expect(envelope.code).toBe("invalid_state");
      expect((envelope.error as { message: string }).message).toContain("not blocked");
      expect((envelope.error as { remediation: string }).remediation).toContain(
        "dispatch a new lane",
      );
    });

    test("resume surfaces ContinuityError as continuity_unverified (exit 4)", async () => {
      const registry = new AdapterRegistry();
      registry.register(
        stubAdapter({
          dispatch: () => Promise.resolve(blockedOutcome()),
          resume: () =>
            Promise.reject(
              new ContinuityError("native session thread id mismatch", {
                remediation: "Dispatch a fresh lane instead.",
              }),
            ),
        }),
      );

      const dispatch = await run(["dispatch", "--agent", "stub", "task"], { registry });
      const laneId = dispatch.stdout.json(0).laneId as string;

      const { exitCode, stdout } = await run(["resume", laneId, "keep going"], { registry });
      expect(exitCode).toBe(4);
      const envelope = stdout.lastJson();
      expect(envelope.ok).toBe(false);
      expect(envelope.code).toBe("continuity_unverified");
      expect(envelope.status).toBe("blocked");

      expect((await new LaneStore().loadLane(laneId))?.status).toBe("blocked");
    });
  });

  describe("answer generations", () => {
    test("a replacement answer survives consumption of the older generation", async () => {
      const registry = new AdapterRegistry();
      registry.register(
        stubAdapter({
          dispatch: () => Promise.resolve(blockedOutcome()),
          resume: async (_lane, _prompt, opts) => {
            // The adapter echoes the generation it actually consumed (A = 1),
            // not the current one (B = 2).
            await opts?.onEvent?.({
              event: "answered",
              data: { requestId: "q1", generation: 1 },
            });
            return completedOutcome("consumed generation 1");
          },
        }),
      );

      const dispatch = await run(["dispatch", "--agent", "stub", "task"], { registry });
      const laneId = dispatch.stdout.json(0).laneId as string;

      const first = await run(["answer", laneId, "answer A"], { registry });
      expect(first.exitCode).toBe(0);
      expect((first.stdout.lastJson().result as { text: string }).text).toContain("generation 1");

      const second = await run(["answer", laneId, "answer B"], { registry });
      expect(second.exitCode).toBe(0);
      expect((second.stdout.lastJson().result as { text: string }).text).toContain("generation 2");

      const resumed = await run(["resume", laneId, "continue"], { registry });
      expect(resumed.exitCode).toBe(0);

      // Answer B (generation 2) is still pending: it must survive the
      // consumption of generation 1 for redelivery.
      const store = new LaneStore();
      expect(await store.readAnswer(laneId)).toBe("answer B");

      const events = await store.readEvents(laneId);
      const submissions = events.filter(
        (event) => event.event === "answered" && event.data.consumed !== true,
      );
      expect(submissions.map((event) => event.data.generation)).toEqual([1, 2]);
      const consumption = events.find(
        (event) => event.event === "answered" && event.data.consumed === true,
      );
      expect(consumption?.data.generation).toBe(1);
    });

    test("consumption echoing the current generation deletes the answer", async () => {
      const registry = new AdapterRegistry();
      registry.register(
        stubAdapter({
          dispatch: () => Promise.resolve(blockedOutcome()),
          resume: async (_lane, _prompt, opts) => {
            await opts?.onEvent?.({
              event: "answered",
              data: { requestId: "q1", generation: 1 },
            });
            return completedOutcome("consumed the current answer");
          },
        }),
      );

      const dispatch = await run(["dispatch", "--agent", "stub", "task"], { registry });
      const laneId = dispatch.stdout.json(0).laneId as string;
      await run(["answer", laneId, "answer A"], { registry });

      const resumed = await run(["resume", laneId, "continue"], { registry });
      expect(resumed.exitCode).toBe(0);
      expect(await new LaneStore().readAnswer(laneId)).toBeNull();
    });
  });

  describe("inspect", () => {
    test("unknown lane: lane_not_found, exit 4", async () => {
      const { exitCode, stdout } = await run(["inspect", "lane_deadbeef"]);

      expect(exitCode).toBe(4);
      const envelope = stdout.lastJson();
      expect(envelope.ok).toBe(false);
      expect(envelope.code).toBe("lane_not_found");
    });

    test("prints stored events after --since, then the final envelope", async () => {
      const registry = new AdapterRegistry();
      registry.register(stubAdapter());
      const dispatch = await run(["dispatch", "--agent", "stub", "task"], { registry });
      const laneId = dispatch.stdout.json(0).laneId as string;

      const { exitCode, stdout } = await run(["inspect", laneId, "--since", "1"], { registry });

      expect(exitCode).toBe(0);
      const lines = stdout.lines();
      expect(lines).toHaveLength(2);
      const event = stdout.json(0);
      expect(event.event).toBe("result");
      expect(event.seq).toBe(2);

      const envelope = stdout.lastJson();
      expect(envelope.ok).toBe(true);
      expect(envelope.status).toBe("completed");
      expect(envelope.delivery).toBe("confirmed");
      expect(envelope.nativeStatus).toBe("completed");
      expect((envelope.result as { text: string }).text).toBe("done");
    });

    test("inspect of a failed lane mirrors the failure (exit 3)", async () => {
      const registry = new AdapterRegistry();
      registry.register(
        stubAdapter({
          dispatch: () =>
            Promise.resolve({
              status: "failed" as const,
              delivery: "confirmed" as const,
              nativeStatus: "failed" as const,
              semanticOutcome: "unknown" as const,
              code: "agent_failed" as const,
              error: { message: "exit code 1" },
            }),
        }),
      );
      const dispatch = await run(["dispatch", "--agent", "stub", "task"], { registry });
      const laneId = dispatch.stdout.json(0).laneId as string;

      const { exitCode, stdout } = await run(["inspect", laneId], { registry });
      expect(exitCode).toBe(3);
      const envelope = stdout.lastJson();
      expect(envelope.ok).toBe(false);
      expect(envelope.code).toBe("agent_failed");
      expect((envelope.error as { message: string }).message).toBe("exit code 1");
    });

    test("--wait-for done times out with code timeout and exit 5", async () => {
      const store = new LaneStore();
      const lane = await store.createLane({ agent: "stub", cwd: "/tmp" });
      await store.transitionLane(lane.id, { from: ["queued"], to: "running" });

      const { exitCode, stdout } = await run([
        "inspect",
        lane.id,
        "--wait-for",
        "done",
        "--timeout",
        "50",
      ]);

      expect(exitCode).toBe(5);
      const envelope = stdout.lastJson();
      expect(envelope.ok).toBe(false);
      expect(envelope.code).toBe("timeout");
      expect(envelope.status).toBe("running");
      expect((envelope.lane as { id: string }).id).toBe(lane.id);
    });

    test("--follow streams new events until the lane is terminal", async () => {
      const store = new LaneStore();
      const lane = await store.createLane({ agent: "stub", cwd: "/tmp" });
      await store.transitionLane(lane.id, { from: ["queued"], to: "running" });

      const following = run(["inspect", lane.id, "--follow", "--timeout", "5000"]);

      await Bun.sleep(30);
      await store.appendEvent(lane.id, { event: "progress", data: { note: "halfway" } });
      await Bun.sleep(30);
      await store.transitionLaneWithEvent(
        lane.id,
        { from: ["running"], to: "completed" },
        {
          event: "result",
          data: { text: "done", delivery: "confirmed", nativeStatus: "completed" },
        },
      );

      const { exitCode, stdout } = await following;
      expect(exitCode).toBe(0);

      const lines = stdout.lines();
      const kinds = lines.slice(0, -1).map((line) => (JSON.parse(line) as { event: string }).event);
      expect(kinds).toEqual(["created", "progress", "result"]);

      const envelope = stdout.lastJson();
      expect(envelope.ok).toBe(true);
      expect(envelope.status).toBe("completed");
      expect(envelope.delivery).toBe("confirmed");
      expect((envelope.result as { text: string }).text).toBe("done");
    });

    test("invalid --since is a usage error (exit 2)", async () => {
      const { exitCode, stdout } = await run(["inspect", "lane_deadbeef", "--since", "abc"]);

      expect(exitCode).toBe(2);
      expect(stdout.lastJson().code).toBe("usage_error");
    });

    test("terminal lanes report the usage/timing persisted at settlement", async () => {
      const registry = new AdapterRegistry();
      registry.register(
        stubAdapter({
          dispatch: () =>
            Promise.resolve({
              ...completedOutcome("done"),
              usage: { inputTokens: 321, outputTokens: 42, costUsd: 0.05 },
              timing: { wallMs: 1234, startupMs: 200 },
            }),
        }),
      );

      const dispatch = await run(["dispatch", "--agent", "stub", "task"], { registry });
      expect(dispatch.exitCode).toBe(0);
      const laneId = dispatch.stdout.json(0).laneId as string;

      // The settling process is gone; a later inspect still reports them.
      const inspected = await run(["inspect", laneId], { registry });
      expect(inspected.exitCode).toBe(0);
      const envelope = inspected.stdout.lastJson();
      expect(envelope.usage).toEqual({ inputTokens: 321, outputTokens: 42, costUsd: 0.05 });
      expect(envelope.timing).toEqual({ wallMs: 1234, startupMs: 200 });

      const lane = await new LaneStore().loadLane(laneId);
      expect(lane?.usage).toEqual({ inputTokens: 321, outputTokens: 42, costUsd: 0.05 });
      expect(lane?.timing).toEqual({ wallMs: 1234, startupMs: 200 });
    });

    test("a running lane whose recorded process is dead carries a stale-running warning", async () => {
      const store = new LaneStore();
      const lane = await store.createLane({ agent: "stub", cwd: "/tmp" });
      await store.transitionLane(lane.id, { from: ["queued"], to: "running" });
      await store.updateLane(lane.id, {
        process: { pid: 41_001, pgid: 41_001, startedAt: new Date().toISOString() },
      });

      const stale = await run(["inspect", lane.id], { store, isPidAlive: () => false });
      expect(stale.exitCode).toBe(0);
      const envelope = stale.stdout.lastJson();
      expect(envelope.ok).toBe(true);
      // The status is reported as-is: warnings never auto-transition.
      expect(envelope.status).toBe("running");
      const warnings = envelope.warnings as string[];
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("Stale running");
      expect(warnings[0]).toContain("pid 41001");

      const alive = await run(["inspect", lane.id], { store, isPidAlive: () => true });
      expect(alive.stdout.lastJson().warnings).toBeUndefined();
      expect((await store.loadLane(lane.id))?.status).toBe("running");
    });
  });

  describe("answer/resume/kill on unknown lanes", () => {
    test("all report lane_not_found with exit 4", async () => {
      for (const args of [
        ["answer", "lane_deadbeef", "text"],
        ["resume", "lane_deadbeef", "prompt"],
        ["kill", "lane_deadbeef"],
      ]) {
        const { exitCode, stdout } = await run(args);
        expect(exitCode).toBe(4);
        expect(stdout.lastJson().code).toBe("lane_not_found");
      }
    });
  });

  describe("lanes", () => {
    test("lists lane records newest first in a list envelope", async () => {
      const registry = new AdapterRegistry();
      registry.register(stubAdapter());
      await run(["dispatch", "--agent", "stub", "first"], { registry });

      const { exitCode, stdout } = await run(["lanes"], { registry });

      expect(exitCode).toBe(0);
      const envelope = stdout.lastJson();
      expect(envelope.kind).toBe("list");
      expect(envelope.ok).toBe(true);
      const lanes = envelope.lanes as { id: string; status: string }[];
      expect(lanes).toHaveLength(1);
      expect(lanes[0]?.status).toBe("completed");
    });
  });

  describe("kill", () => {
    test("kills a blocked lane, is idempotent, and rejects terminal lanes", async () => {
      const registry = new AdapterRegistry();
      registry.register(stubAdapter({ dispatch: () => Promise.resolve(blockedOutcome()) }));
      const dispatch = await run(["dispatch", "--agent", "stub", "task"], { registry });
      const laneId = dispatch.stdout.json(0).laneId as string;

      const kill = await run(["kill", laneId], { registry });
      expect(kill.exitCode).toBe(0);
      expect(kill.stdout.lastJson().status).toBe("killed");

      const again = await run(["kill", laneId], { registry });
      expect(again.exitCode).toBe(0);
      expect(again.stdout.lastJson().status).toBe("killed");
      expect(again.stdout.lastJson().delivery).toBe(kill.stdout.lastJson().delivery);

      const store = new LaneStore();
      expect((await store.loadLane(laneId))?.status).toBe("killed");
      const events = await store.readEvents(laneId);
      expect(events.filter((event) => event.event === "killed")).toHaveLength(1);

      const completed = await store.createLane({ agent: "stub", cwd: "/tmp" });
      await store.transitionLane(completed.id, { from: ["queued"], to: "completed" });
      const rejected = await run(["kill", completed.id], { registry });
      expect(rejected.exitCode).toBe(4);
      expect(rejected.stdout.lastJson().code).toBe("invalid_state");
    });

    test("signals and verifies a recorded process group before claiming native interruption", async () => {
      const store = new LaneStore();
      const lane = await store.createLane({ agent: "stub", cwd: "/tmp" });
      await store.transitionLane(lane.id, { from: ["queued"], to: "blocked" });
      await store.updateLane(lane.id, {
        process: { pid: 41_001, pgid: 41_001, startedAt: new Date().toISOString() },
      });

      let alive = true;
      const signals: NodeJS.Signals[] = [];
      const killed = await run(["kill", lane.id], {
        store,
        killGraceMs: 5,
        isProcessGroupAlive: () => alive,
        signalProcessGroup: (_pgid, signal) => {
          signals.push(signal);
          alive = false;
        },
      });

      expect(killed.exitCode).toBe(0);
      expect(signals).toEqual(["SIGTERM"]);
      expect(killed.stdout.lastJson().nativeStatus).toBe("interrupted");
      expect((killed.stdout.lastJson().result as { text: string }).text).toContain(
        "terminated after SIGTERM",
      );
    });

    test("process identity reported after kill terminates the spawned group and settles killed", async () => {
      const store = new LaneStore();
      const registry = new AdapterRegistry();
      const signalled: { pgid: number; signal: NodeJS.Signals }[] = [];
      let alive = true;
      registry.register(
        stubAdapter({
          dispatch: async (req) => {
            // The kill decision lands before the adapter reports its child.
            const killed = await run(["kill", req.laneId], { registry: new AdapterRegistry() });
            expect(killed.exitCode).toBe(0);
            await req.onEvent?.({ event: "agent_started", data: { pid: 54_321, pgid: 54_321 } });
            return completedOutcome("unreachable");
          },
        }),
      );

      const { exitCode, stdout } = await run(["dispatch", "--agent", "stub", "task"], {
        registry,
        store,
        killGraceMs: 5,
        isProcessGroupAlive: () => alive,
        signalProcessGroup: (pgid, signal) => {
          signalled.push({ pgid, signal });
          alive = false;
        },
      });

      // The dispatch settles honestly against the stored killed lane and the
      // just-spawned process group is terminated instead of surviving.
      expect(exitCode).toBe(0);
      expect(stdout.lastJson().status).toBe("killed");
      expect(signalled).toEqual([{ pgid: 54_321, signal: "SIGTERM" }]);

      const laneId = stdout.json(0).laneId as string;
      const lane = await store.loadLane(laneId);
      expect(lane?.status).toBe("killed");
      expect(lane?.process).toBeUndefined();
      const events = await store.readEvents(laneId);
      expect(events.some((event) => event.event === "agent_started")).toBe(false);
      expect(events.filter((event) => event.event === "killed")).toHaveLength(1);
      expect(events.some((event) => event.event === "result")).toBe(false);
    });

    test("a second process kill wins over the dispatch process settlement", async () => {
      const laneCommandsUrl = pathToFileURL(path.resolve("src/cli/lane-commands.ts")).href;
      const laneIndexUrl = pathToFileURL(path.resolve("src/lane/index.ts")).href;
      const workerPath = path.join(orcaHome, "dispatch-race-worker.ts");
      await fs.writeFile(
        workerPath,
        `
          import { runLaneCli } from ${JSON.stringify(laneCommandsUrl)};
          import { AdapterRegistry } from ${JSON.stringify(laneIndexUrl)};

          const registry = new AdapterRegistry();
          registry.register({
            dispatch: async () => {
              await Bun.sleep(300);
              return {
                status: "completed",
                delivery: "confirmed",
                nativeStatus: "completed",
                semanticOutcome: "unknown",
                result: { text: "too late" },
              };
            },
            resume: async () => { throw new Error("unused"); },
            inspect: async () => ({ nativeStatus: "unknown" }),
            capabilities: () => ({
              v: 1,
              agent: "stub",
              capabilities: {
                resume: false,
                kill: false,
                questions: false,
                continuityMethods: [],
              },
            }),
          });

          const exitCode = await runLaneCli(
            ["dispatch", "--agent", "stub", "slow task"],
            { registry },
          );
          process.exitCode = exitCode ?? 1;
        `,
      );

      const child = spawn(process.execPath, [workerPath], {
        cwd: process.cwd(),
        env: { ...process.env, ORCA_HOME: orcaHome },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let childStdout = "";
      let childStderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        childStderr += chunk;
      });
      const handle = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`worker handle timeout: ${childStderr}`)),
          2_000,
        );
        child.stdout.on("data", (chunk: string) => {
          childStdout += chunk;
          const firstLine = childStdout.split("\n")[0];
          if (firstLine !== undefined && firstLine !== "") {
            clearTimeout(timer);
            resolve(JSON.parse(firstLine) as Record<string, unknown>);
          }
        });
      });

      const laneId = handle.laneId as string;
      const killed = await run(["kill", laneId]);
      expect(killed.exitCode).toBe(0);
      const [childExit] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
      expect(childExit).toBe(0);

      const childLines = childStdout
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(childLines.at(-1)?.status).toBe("killed");
      expect((await new LaneStore().loadLane(laneId))?.status).toBe("killed");
      const events = await new LaneStore().readEvents(laneId);
      expect(events.some((event) => event.event === "result")).toBe(false);
    });
  });

  describe("agents", () => {
    test("failing adapter loads still exit 0 and are reported as caveats", async () => {
      const registry = new AdapterRegistry();
      registry.register(stubAdapter());

      const { exitCode, stdout, stderr } = await run(["agents"], {
        registry,
        loadAdapterModule: () => Promise.reject(new Error("Cannot find module boom")),
      });

      expect(exitCode).toBe(0);
      const envelope = stdout.lastJson();
      expect(envelope.kind).toBe("agents");
      expect(envelope.ok).toBe(true);
      const manifests = envelope.agents as { agent: string }[];
      expect(manifests.map((manifest) => manifest.agent)).toEqual(["stub"]);
      expect((envelope.result as { text: string }).text).toContain("Unavailable adapters");
      expect((envelope.result as { text: string }).text).toContain("Cannot find module boom");
      expect(stderr.chunks.join("")).toContain("Cannot find module boom");
    });
  });

  describe("contract", () => {
    test("prints the full contract payload as one parseable envelope", async () => {
      const { exitCode, stdout } = await run(["contract"]);

      expect(exitCode).toBe(0);
      expect(stdout.lines()).toHaveLength(1);
      const envelope = stdout.lastJson();
      expect(envelope.kind).toBe("contract");
      expect(envelope.ok).toBe(true);

      const contract = envelope.contract as {
        contractVersion: string;
        schemas: Record<string, unknown>;
        exitCodes: unknown[];
        verbs: { verb: string }[];
      };
      expect(contract.contractVersion).toBe("orca/v1");
      expect(Object.keys(contract.schemas).sort()).toEqual([
        "envelope",
        "event",
        "handle",
        "manifest",
      ]);
      expect(contract.verbs.map((verb) => verb.verb)).toContain("dispatch");
    });

    test("--schema envelope prints only that schema subset", async () => {
      const { exitCode, stdout } = await run(["contract", "--schema", "envelope"]);

      expect(exitCode).toBe(0);
      const contract = stdout.lastJson().contract as {
        contractVersion: string;
        schemas: Record<string, unknown>;
      };
      expect(contract.contractVersion).toBe("orca/v1");
      expect(Object.keys(contract.schemas)).toEqual(["envelope"]);
    });

    test("an invalid --schema value is a usage error (exit 2)", async () => {
      const { exitCode, stdout } = await run(["contract", "--schema", "bogus"]);

      expect(exitCode).toBe(2);
      expect(stdout.lastJson().code).toBe("usage_error");
    });
  });

  describe("help", () => {
    test("verb --help exits 0 and includes an AGENTS section", async () => {
      const { exitCode, stdout } = await run(["dispatch", "--help"]);

      expect(exitCode).toBe(0);
      const text = stdout.chunks.join("");
      expect(text).toContain("AGENTS:");
      expect(text).toContain("Exit codes:");
      expect(text).toContain("orca dispatch --agent codex");
    });
  });
});
