import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

import { CodexClient } from "@happycatlabs/codex-client";
import type {
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
} from "@happycatlabs/codex-client";

import { AdapterError, ContinuityError } from "../../../lane/adapter";
import { LaneStore } from "../../../lane/store";
import { AgentManifestSchema } from "../../../types/lane";
import type { LaneEventInput, LaneRecord } from "../../../types/lane";
import { CodexAdapter } from "../adapter";
import type {
  CodexAdapterOptions,
  CodexClientLaunchOptions,
  CodexDispatchRequest,
} from "../adapter";
import { CODEX_DECLARED_FACTS } from "../manifest";

const THREAD_ID = "thread_test_1";
const TURN_ID = "turn_test_1";

/** In-memory TransportLike: scripted request responders + server-push emits. */
class MockTransport {
  readonly sent: JsonRpcMessage[] = [];
  readonly requests: Array<{ method: string; params?: unknown }> = [];
  processInfo: { pid: number; pgid?: number } | undefined = { pid: 4242, pgid: 4242 };
  closed = false;
  /** Simulates a wedged app-server that withholds exit forever on close. */
  neverResolveClose = false;

  private readonly messageHandlers = new Set<(message: JsonRpcMessage) => void>();
  private readonly errorHandlers = new Set<(error: Error) => void>();
  private readonly responders = new Map<string, (params?: unknown) => unknown>();

  send(message: JsonRpcMessage): void {
    this.sent.push(message);
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    const responder = this.responders.get(method);
    if (!responder) {
      return {};
    }

    return responder(params);
  }

  onMessage(handler: (message: JsonRpcMessage) => void): () => void {
    this.messageHandlers.add(handler);
    return () => {
      this.messageHandlers.delete(handler);
    };
  }

  onError(handler: (error: Error) => void): () => void {
    this.errorHandlers.add(handler);
    return () => {
      this.errorHandlers.delete(handler);
    };
  }

  onStderr(): () => void {
    return () => undefined;
  }

  close(): Promise<void> {
    if (this.neverResolveClose) {
      return new Promise<void>(() => undefined);
    }

    this.closed = true;
    return Promise.resolve();
  }

  setResponder(method: string, responder: (params?: unknown) => unknown): void {
    this.responders.set(method, responder);
  }

  emitNotification(method: string, params?: unknown): void {
    const message: JsonRpcNotification = { jsonrpc: "2.0", method, params };
    for (const handler of this.messageHandlers) {
      handler(message);
    }
  }

  emitRequest(method: string, id: string | number, params?: unknown): void {
    const message: JsonRpcRequest = { jsonrpc: "2.0", method, id, params };
    for (const handler of this.messageHandlers) {
      handler(message);
    }
  }

  emitError(error: Error): void {
    for (const handler of this.errorHandlers) {
      handler(error);
    }
  }

  responseWithId(id: string | number): JsonRpcResponse | undefined {
    return this.sent.find(
      (message): message is JsonRpcResponse =>
        "id" in message && !("method" in message) && message.id === id,
    );
  }
}

interface Fixture {
  store: LaneStore;
  lane: LaneRecord;
  transport: MockTransport;
  adapter: CodexAdapter;
  launches: CodexClientLaunchOptions[];
}

const tempDirs: string[] = [];
const stubChildPids: number[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  for (const pid of stubChildPids.splice(0)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // already gone — the expected case
    }
  }
});

/**
 * Spawns a real detached child standing in for the app-server so force-kill
 * behavior is verified hermetically against a live process. detached:true
 * makes the child its own POSIX process-group leader (pgid === pid).
 * Retries transient spawn failures (EAGAIN under full-suite load).
 */
async function spawnStubAppServer(
  command: string[] = ["sleep", "300"],
): Promise<{ pid: number; pgid: number }> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const child = spawn(command[0] as string, command.slice(1), {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    const pid = child.pid;
    if (pid !== undefined) {
      // A spawn that fails asynchronously (error event) never reaches the
      // adapter assertions anyway; swallow it so it cannot crash the run.
      child.on("error", () => undefined);
      stubChildPids.push(pid);
      return { pid, pgid: pid };
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error("failed to spawn stub app-server child after 20 attempts");
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function createFixture(
  adapterOverrides: Partial<CodexAdapterOptions> = {},
): Promise<Fixture> {
  const orcaHome = await fs.mkdtemp(path.join(os.tmpdir(), "orca-codex-adapter-test-"));
  tempDirs.push(orcaHome);

  const store = new LaneStore(orcaHome);
  const lane = await store.createLane({ agent: "codex", cwd: "/tmp/project" });

  const transport = new MockTransport();
  transport.setResponder("initialize", () => ({ userAgent: "codex-test" }));
  transport.setResponder("thread/start", () => ({ thread: { id: THREAD_ID } }));

  const launches: CodexClientLaunchOptions[] = [];
  const adapter = new CodexAdapter({
    store,
    answerPollMs: 5,
    clientFactory: (launch) => {
      launches.push(launch);
      return new CodexClient({ transportFactory: () => transport });
    },
    ...adapterOverrides,
  });

  return { store, lane, transport, adapter, launches };
}

function scriptCompletedTurn(transport: MockTransport, agentText: string): void {
  transport.setResponder("turn/start", () => {
    queueMicrotask(() => {
      transport.emitNotification("item/agentMessage/delta", {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        itemId: "item_msg",
        delta: agentText.slice(0, 5),
      });
      transport.emitNotification("item/completed", {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        item: { type: "agentMessage", id: "item_msg", text: agentText },
      });
      transport.emitNotification("thread/tokenUsage/updated", {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        tokenUsage: {
          total: {
            totalTokens: 100,
            inputTokens: 80,
            cachedInputTokens: 0,
            outputTokens: 20,
            reasoningOutputTokens: 0,
          },
          last: {
            totalTokens: 100,
            inputTokens: 80,
            cachedInputTokens: 0,
            outputTokens: 20,
            reasoningOutputTokens: 0,
          },
          modelContextWindow: null,
        },
      });
      transport.emitNotification("turn/completed", {
        threadId: THREAD_ID,
        turn: { id: TURN_ID, status: "completed", items: [] },
      });
    });

    return { turn: { id: TURN_ID, status: "inProgress", items: [] } };
  });
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  throw new Error("waitFor timed out");
}

describe("CodexAdapter dispatch", () => {
  test("emits each hook event once and performs no lane-store writes", async () => {
    const { store, lane, transport, adapter, launches } = await createFixture();
    scriptCompletedTurn(transport, "Hello world");

    const received: LaneEventInput[] = [];
    const outcome = await adapter.dispatch({
      laneId: lane.id,
      prompt: "do the thing",
      cwd: "/tmp/project",
      onEvent: (event) => {
        received.push(event);
      },
    });

    expect(outcome.status).toBe("completed");
    expect(outcome.nativeStatus).toBe("completed");
    expect(outcome.delivery).toBe("confirmed");
    expect(outcome.semanticOutcome).toBe("unknown");
    expect(outcome.result?.text).toBe("Hello world");
    expect(outcome.agentSessionId).toBe(THREAD_ID);
    expect(outcome.usage).toEqual({ inputTokens: 80, outputTokens: 20 });
    expect(outcome.timing?.wallMs).toBeGreaterThanOrEqual(0);
    expect(outcome.code).toBeUndefined();

    const record = await store.loadLane(lane.id);
    expect(record?.agentSessionId).toBeUndefined();
    expect(record?.status).toBe("queued");
    expect(record?.seq).toBe(1);

    const events = await store.readEvents(lane.id);
    expect(events.map((event) => event.event)).toEqual(["created"]);

    expect(received.map((event) => event.event)).toEqual([
      "agent_started",
      "progress",
      "progress",
      "progress",
    ]);
    expect(received.filter((event) => event.event === "agent_started")).toHaveLength(1);
    const started = received.find((event) => event.event === "agent_started");
    expect(started?.data.pid).toBe(4242);
    expect(started?.data.pgid).toBe(4242);
    expect(typeof started?.data.startedAt).toBe("string");
    // Identity is emitted at spawn, before the thread exists; session
    // metadata arrives separately once the protocol is up.
    expect(started?.data.threadId).toBeUndefined();
    const bound = received.find(
      (event) => event.event === "progress" && event.data.type === "thread_bound",
    );
    expect(bound?.data.threadId).toBe(THREAD_ID);
    expect(
      received.filter(
        (event) => event.event === "progress" && event.data.type === "agent_message_delta",
      ),
    ).toHaveLength(1);
    expect(
      received.filter(
        (event) => event.event === "progress" && event.data.type === "item_completed",
      ),
    ).toHaveLength(1);
    // Terminal evidence is returned in the outcome; parent settlement owns
    // the durable result event.
    expect(received.some((event) => event.event === "result")).toBe(false);

    // Prompt actually went over the wire, and the client was shut down.
    const turnStart = transport.requests.find((request) => request.method === "turn/start");
    expect(turnStart?.params).toMatchObject({
      threadId: THREAD_ID,
      input: [{ type: "text", text: "do the thing" }],
    });
    expect(transport.closed).toBe(true);

    // Sandbox mapping: default dispatch is workspace-write, approvals never.
    expect(launches[0]).toMatchObject({
      cwd: "/tmp/project",
      sandbox: "workspace-write",
      approvalPolicy: "never",
      detached: true,
    });
  });

  test("readOnly dispatch maps to the read-only sandbox", async () => {
    const { lane, transport, adapter, launches } = await createFixture();
    scriptCompletedTurn(transport, "ok");

    const req: CodexDispatchRequest = {
      laneId: lane.id,
      prompt: "look around",
      cwd: "/tmp/project",
      readOnly: true,
    };
    await adapter.dispatch(req);

    expect(launches[0]).toMatchObject({
      sandbox: "read-only",
      approvalPolicy: "never",
      detached: true,
    });
  });

  test("protocol turn failure maps to nativeStatus failed and code agent_failed", async () => {
    const { store, lane, transport, adapter } = await createFixture();
    transport.setResponder("turn/start", () => {
      queueMicrotask(() => {
        transport.emitNotification("turn/completed", {
          threadId: THREAD_ID,
          turn: {
            id: TURN_ID,
            status: "failed",
            items: [],
            error: { message: "boom", codexErrorInfo: "internalServerError" },
          },
        });
      });

      return { turn: { id: TURN_ID, status: "inProgress", items: [] } };
    });

    const outcome = await adapter.dispatch({
      laneId: lane.id,
      prompt: "explode",
      cwd: "/tmp/project",
    });

    expect(outcome.status).toBe("failed");
    expect(outcome.nativeStatus).toBe("failed");
    expect(outcome.delivery).toBe("confirmed");
    expect(outcome.code).toBe("agent_failed");
    expect(outcome.error?.message).toContain("boom");

    expect((await store.readEvents(lane.id)).map((event) => event.event)).toEqual(["created"]);
  });

  test("interrupted turn maps to killed with nativeStatus interrupted", async () => {
    const { store, lane, transport, adapter } = await createFixture();
    transport.setResponder("turn/start", () => {
      queueMicrotask(() => {
        transport.emitNotification("turn/completed", {
          threadId: THREAD_ID,
          turn: { id: TURN_ID, status: "interrupted", items: [] },
        });
      });

      return { turn: { id: TURN_ID, status: "inProgress", items: [] } };
    });

    const outcome = await adapter.dispatch({
      laneId: lane.id,
      prompt: "stop me",
      cwd: "/tmp/project",
    });

    expect(outcome.status).toBe("killed");
    expect(outcome.nativeStatus).toBe("interrupted");
    expect(outcome.code).toBeUndefined();

    expect((await store.readEvents(lane.id)).map((event) => event.event)).toEqual(["created"]);
  });

  test("mid-turn transport failure maps to adapter_error with nativeStatus unknown", async () => {
    const { lane, transport, adapter } = await createFixture();
    transport.setResponder("turn/start", () => {
      queueMicrotask(() => {
        transport.emitError(new Error("codex app-server exited unexpectedly with code 1"));
      });

      return { turn: { id: TURN_ID, status: "inProgress", items: [] } };
    });

    const outcome = await adapter.dispatch({
      laneId: lane.id,
      prompt: "crash",
      cwd: "/tmp/project",
    });

    expect(outcome.status).toBe("failed");
    expect(outcome.nativeStatus).toBe("unknown");
    expect(outcome.code).toBe("adapter_error");
    expect(outcome.error?.message).toContain("exited unexpectedly");
  });

  test("timeout interrupts the turn and maps to code timeout", async () => {
    const { lane, transport, adapter } = await createFixture();
    transport.setResponder("turn/start", () => ({
      turn: { id: TURN_ID, status: "inProgress", items: [] },
    }));

    const outcome = await adapter.dispatch({
      laneId: lane.id,
      prompt: "never finishes",
      cwd: "/tmp/project",
      timeoutMs: 30,
    });

    expect(outcome.status).toBe("failed");
    expect(outcome.code).toBe("timeout");
    expect(outcome.nativeStatus).toBe("unknown");
    expect(outcome.delivery).toBe("confirmed");
    expect(transport.requests.some((request) => request.method === "turn/interrupt")).toBe(true);
  });

  test("timeout bounds an unacknowledged turn/start request", async () => {
    const { lane, transport, adapter } = await createFixture();
    transport.setResponder("turn/start", () => new Promise(() => undefined));
    const startedAt = Date.now();

    const outcome = await adapter.dispatch({
      laneId: lane.id,
      prompt: "start never acknowledges",
      cwd: "/tmp/project",
      timeoutMs: 20,
    });

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(outcome.status).toBe("failed");
    expect(outcome.code).toBe("timeout");
    expect(outcome.delivery).toBe("unknown");
    expect(outcome.error?.message).toContain("turn/start was not acknowledged");
    expect(transport.requests.some((request) => request.method === "turn/interrupt")).toBe(false);
  });

  test("synchronous onEvent failure aborts before turn/start and disconnects", async () => {
    const { lane, transport, adapter } = await createFixture();
    let deliveries = 0;

    let thrown: unknown;
    try {
      await adapter.dispatch({
        laneId: lane.id,
        prompt: "do not start",
        cwd: "/tmp/project",
        onEvent: () => {
          deliveries += 1;
          throw new Error("store append failed");
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AdapterError);
    expect((thrown as AdapterError).code).toBe("adapter_error");
    expect((thrown as AdapterError).message).toContain("agent_started");
    expect((thrown as AdapterError).message).toContain("store append failed");
    expect(deliveries).toBe(1);
    expect(transport.requests.some((request) => request.method === "turn/start")).toBe(false);
    expect(transport.closed).toBe(true);
  });

  test("async onEvent rejection interrupts the live turn and suppresses later events", async () => {
    const { lane, transport, adapter } = await createFixture();
    transport.setResponder("turn/start", () => {
      queueMicrotask(() => {
        transport.emitNotification("item/agentMessage/delta", {
          threadId: THREAD_ID,
          turnId: TURN_ID,
          itemId: "item_msg",
          delta: "hello",
        });
        transport.emitNotification("item/completed", {
          threadId: THREAD_ID,
          turnId: TURN_ID,
          item: { type: "agentMessage", id: "item_msg", text: "hello" },
        });
      });
      return { turn: { id: TURN_ID, status: "inProgress", items: [] } };
    });

    const delivered: LaneEventInput[] = [];
    let thrown: unknown;
    try {
      await adapter.dispatch({
        laneId: lane.id,
        prompt: "stream",
        cwd: "/tmp/project",
        onEvent: async (event) => {
          delivered.push(event);
          if (event.event === "progress" && event.data.type === "agent_message_delta") {
            throw new Error("async persistence failed");
          }
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AdapterError);
    expect((thrown as AdapterError).code).toBe("adapter_error");
    expect((thrown as AdapterError).message).toContain("async persistence failed");
    expect(delivered.map((event) => event.event)).toEqual([
      "agent_started",
      "progress",
      "progress",
    ]);
    expect(delivered.some((event) => event.data.type === "item_completed")).toBe(false);
    expect(transport.requests.some((request) => request.method === "turn/interrupt")).toBe(true);
    expect(transport.closed).toBe(true);
  });

  test("never-resolving connect times out within budget with delivery unknown", async () => {
    const { lane, transport, adapter } = await createFixture();
    transport.setResponder("initialize", () => new Promise(() => undefined));

    const received: LaneEventInput[] = [];
    const startedAt = Date.now();
    const outcome = await adapter.dispatch({
      laneId: lane.id,
      prompt: "hi",
      cwd: "/tmp/project",
      timeoutMs: 30,
      onEvent: (event) => {
        received.push(event);
      },
    });

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(outcome.status).toBe("failed");
    expect(outcome.code).toBe("timeout");
    expect(outcome.delivery).toBe("unknown");
    expect(outcome.nativeStatus).toBe("unknown");
    expect(outcome.error?.message).toContain("connect");
    // No fake claims: no turn ever existed, so nothing was interrupted.
    expect(outcome.error?.message).not.toContain("interrupt");
    expect(transport.requests.some((request) => request.method === "thread/start")).toBe(false);
    expect(transport.requests.some((request) => request.method === "turn/start")).toBe(false);
    expect(transport.requests.some((request) => request.method === "turn/interrupt")).toBe(false);

    // Process identity was still emitted at spawn, before the hang, so the
    // CLI can kill the wedged app-server (finding 15).
    const started = received.find((event) => event.event === "agent_started");
    expect(started?.data.pid).toBe(4242);
    expect(started?.data.pgid).toBe(4242);
    expect(typeof started?.data.startedAt).toBe("string");

    expect(transport.closed).toBe(true);
  });

  test("deadline exhaustion mid-thread-start returns timeout with delivery unknown", async () => {
    const { lane, transport, adapter } = await createFixture();
    transport.setResponder("thread/start", () => new Promise(() => undefined));

    const startedAt = Date.now();
    const outcome = await adapter.dispatch({
      laneId: lane.id,
      prompt: "hi",
      cwd: "/tmp/project",
      timeoutMs: 30,
    });

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(outcome.status).toBe("failed");
    expect(outcome.code).toBe("timeout");
    expect(outcome.delivery).toBe("unknown");
    expect(outcome.nativeStatus).toBe("unknown");
    expect(outcome.error?.message).toContain("thread/start");
    expect(outcome.error?.message).not.toContain("interrupt");
    expect(transport.requests.some((request) => request.method === "turn/start")).toBe(false);
    expect(transport.requests.some((request) => request.method === "turn/interrupt")).toBe(false);
    expect(transport.closed).toBe(true);
  });

  test("connect failure throws AdapterError agent_unavailable", async () => {
    const { lane, transport, adapter } = await createFixture();
    transport.setResponder("initialize", () => {
      throw new Error("spawn codex ENOENT");
    });

    try {
      await adapter.dispatch({ laneId: lane.id, prompt: "hi", cwd: "/tmp/project" });
      throw new Error("expected dispatch to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AdapterError);
      expect((error as AdapterError).code).toBe("agent_unavailable");
    }
  });
});

describe("CodexAdapter abandoned-disconnect force-kill", () => {
  test("never-resolving disconnect leaves no process and emits verified termination evidence", async () => {
    const { lane, transport, adapter } = await createFixture({ cleanupGraceMs: 40 });
    const stub = await spawnStubAppServer();
    transport.processInfo = stub;
    transport.neverResolveClose = true;
    scriptCompletedTurn(transport, "done");

    const received: LaneEventInput[] = [];
    const outcome = await adapter.dispatch({
      laneId: lane.id,
      prompt: "finish, then wedge on shutdown",
      cwd: "/tmp/project",
      onEvent: (event) => {
        received.push(event);
      },
    });

    // Cleanup honesty never rewrites a successful verb outcome...
    expect(outcome.status).toBe("completed");
    expect(outcome.result?.text).toBe("done");
    expect(outcome.error).toBeUndefined();

    // ...but the wedged app-server stand-in must be dead by the time the
    // verb returns: an expired lane never leaves a live app-server process.
    expect(isPidAlive(stub.pid)).toBe(false);

    const termination = received.find(
      (event) => event.event === "progress" && event.data.type === "app_server_termination",
    );
    expect(termination?.data.verified).toBe(true);
    expect(String(termination?.data.detail)).toContain("termination verified");
    expect(String(termination?.data.detail)).toContain(`process group ${stub.pgid}`);
  });

  test("deadline-expired dispatch reports verified termination in the failure envelope detail", async () => {
    const { lane, transport, adapter } = await createFixture({ cleanupGraceMs: 40 });
    const stub = await spawnStubAppServer();
    transport.processInfo = stub;
    transport.neverResolveClose = true;
    transport.setResponder("turn/start", () => new Promise(() => undefined));

    const outcome = await adapter.dispatch({
      laneId: lane.id,
      prompt: "hang forever",
      cwd: "/tmp/project",
      timeoutMs: 30,
    });

    expect(outcome.status).toBe("failed");
    expect(outcome.code).toBe("timeout");
    expect(outcome.error?.message).toContain("termination verified");
    expect(outcome.error?.message).toContain(`process group ${stub.pgid}`);
    expect(isPidAlive(stub.pid)).toBe(false);
  });

  test("escalates to SIGKILL when the app-server ignores SIGTERM", async () => {
    const readyDir = await fs.mkdtemp(path.join(os.tmpdir(), "orca-codex-sigterm-stub-"));
    tempDirs.push(readyDir);
    const readyPath = path.join(readyDir, "ready");

    const { lane, transport, adapter } = await createFixture({ cleanupGraceMs: 40 });
    const stub = await spawnStubAppServer([
      "bash",
      "-c",
      `trap '' TERM; : > ${readyPath}; sleep 300`,
    ]);
    // Only start once the trap is provably installed, so SIGTERM cannot win.
    await waitFor(async () =>
      fs.access(readyPath).then(
        () => true,
        () => false,
      ),
    );
    transport.processInfo = stub;
    transport.neverResolveClose = true;
    transport.setResponder("turn/start", () => new Promise(() => undefined));

    const outcome = await adapter.dispatch({
      laneId: lane.id,
      prompt: "hang forever",
      cwd: "/tmp/project",
      timeoutMs: 30,
    });

    expect(outcome.code).toBe("timeout");
    expect(outcome.error?.message).toContain("termination verified");
    expect(outcome.error?.message).toContain("exited after SIGKILL");
    expect(isPidAlive(stub.pid)).toBe(false);
  });

  test("reports unverified termination honestly when no process identity was recorded", async () => {
    const { lane, transport, adapter } = await createFixture({ cleanupGraceMs: 40 });
    transport.processInfo = undefined;
    transport.neverResolveClose = true;
    transport.setResponder("turn/start", () => new Promise(() => undefined));

    const received: LaneEventInput[] = [];
    const outcome = await adapter.dispatch({
      laneId: lane.id,
      prompt: "hang forever",
      cwd: "/tmp/project",
      timeoutMs: 30,
      onEvent: (event) => {
        received.push(event);
      },
    });

    expect(outcome.status).toBe("failed");
    expect(outcome.code).toBe("timeout");
    expect(outcome.error?.message).toContain("termination unverified");
    expect(outcome.error?.message).toContain("no process identity");

    const termination = received.find(
      (event) => event.event === "progress" && event.data.type === "app_server_termination",
    );
    expect(termination?.data.verified).toBe(false);
  });

  test("resume shares the same force-kill guarantee", async () => {
    const { store, lane, transport, adapter } = await createFixture({ cleanupGraceMs: 40 });
    await store.updateLane(lane.id, { agentSessionId: THREAD_ID });
    const stub = await spawnStubAppServer();
    transport.processInfo = stub;
    transport.neverResolveClose = true;
    transport.setResponder("thread/resume", () => ({ thread: { id: THREAD_ID } }));
    scriptCompletedTurn(transport, "resumed fine");

    const record = (await store.loadLane(lane.id)) as LaneRecord;
    const outcome = await adapter.resume(record, "continue please");

    expect(outcome.status).toBe("completed");
    expect(isPidAlive(stub.pid)).toBe(false);
  });
});

describe("CodexAdapter question parking", () => {
  test("requestUserInput emits live state and reads answer.txt without mutating it", async () => {
    const { store, lane, transport, adapter } = await createFixture();
    transport.setResponder("turn/start", () => {
      queueMicrotask(() => {
        transport.emitRequest("item/tool/requestUserInput", 42, {
          itemId: "item_q",
          threadId: THREAD_ID,
          turnId: TURN_ID,
          questions: [
            {
              header: "Deploy",
              id: "q1",
              question: "Proceed?",
              options: [
                { label: "yes", description: "ship it" },
                { label: "no", description: "abort" },
              ],
            },
          ],
        });
      });

      return { turn: { id: TURN_ID, status: "inProgress", items: [] } };
    });

    const received: LaneEventInput[] = [];
    const dispatchPromise = adapter.dispatch({
      laneId: lane.id,
      prompt: "deploy",
      cwd: "/tmp/project",
      onEvent: (event) => {
        received.push(event);
      },
    });

    await waitFor(() => received.some((event) => event.event === "question"));
    const question = received.find((event) => event.event === "question");
    expect(question?.data.questions).toEqual([
      { id: "q1", question: "Deploy: Proceed?", options: ["yes", "no"] },
    ]);
    expect(question?.data.live).toBe(true);
    expect((await store.loadLane(lane.id))?.status).toBe("queued");
    expect((await store.readEvents(lane.id)).map((event) => event.event)).toEqual(["created"]);

    // `orca answer` writes answer.txt; the adapter polls, parses, and replies.
    await fs.writeFile(store.getAnswerPath(lane.id), "yes", "utf8");
    await waitFor(() => transport.responseWithId(42) !== undefined);
    expect(transport.responseWithId(42)?.result).toEqual({
      answers: { q1: { answers: ["yes"] } },
    });
    await waitFor(() => received.some((event) => event.event === "answered"));
    // A raw answer.txt write has no generational submission behind it; the
    // echo is 0, which the store treats the same as its legacy delete.
    expect(received.find((event) => event.event === "answered")?.data.generation).toBe(0);

    // The adapter is read-only; answer lifecycle/cleanup remains CLI-owned.
    expect(await store.readAnswer(lane.id)).toBe("yes");

    transport.emitNotification("item/completed", {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      item: { type: "agentMessage", id: "item_msg", text: "Deployed." },
    });
    transport.emitNotification("turn/completed", {
      threadId: THREAD_ID,
      turn: { id: TURN_ID, status: "completed", items: [] },
    });

    const outcome = await dispatchPromise;
    expect(outcome.status).toBe("completed");
    expect(outcome.result?.text).toBe("Deployed.");

    expect(received.filter((event) => event.event === "question")).toHaveLength(1);
    expect(received.filter((event) => event.event === "answered")).toHaveLength(1);
    expect(received.findIndex((event) => event.event === "question")).toBeLessThan(
      received.findIndex((event) => event.event === "answered"),
    );
    expect((await store.readEvents(lane.id)).map((event) => event.event)).toEqual(["created"]);
  });

  test("invalid answers are rejected and the adapter keeps waiting", async () => {
    const { store, lane, transport, adapter } = await createFixture();
    transport.setResponder("turn/start", () => {
      queueMicrotask(() => {
        transport.emitRequest("item/tool/requestUserInput", 7, {
          itemId: "item_q",
          threadId: THREAD_ID,
          turnId: TURN_ID,
          questions: [
            { header: "A", id: "qa", question: "First?" },
            { header: "B", id: "qb", question: "Second?" },
          ],
        });
      });

      return { turn: { id: TURN_ID, status: "inProgress", items: [] } };
    });

    const received: LaneEventInput[] = [];
    const dispatchPromise = adapter.dispatch({
      laneId: lane.id,
      prompt: "two questions",
      cwd: "/tmp/project",
      onEvent: (event) => {
        received.push(event);
      },
    });

    await waitFor(() => received.some((event) => event.event === "question"));

    // Plain text is invalid for multiple questions: reported once and left
    // untouched until the CLI/user replaces it.
    await fs.writeFile(store.getAnswerPath(lane.id), "just one answer", "utf8");
    expect(transport.responseWithId(7)).toBeUndefined();
    await waitFor(() =>
      received.some((event) => event.event === "progress" && event.data.type === "invalid_answer"),
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(
      received.filter(
        (event) => event.event === "progress" && event.data.type === "invalid_answer",
      ),
    ).toHaveLength(1);
    expect(await store.readAnswer(lane.id)).toBe("just one answer");

    // A JSON payload answering both questions gets through.
    await fs.writeFile(
      store.getAnswerPath(lane.id),
      JSON.stringify({ qa: "one", qb: ["two"] }),
      "utf8",
    );
    await waitFor(() => transport.responseWithId(7) !== undefined);
    expect(transport.responseWithId(7)?.result).toEqual({
      answers: { qa: { answers: ["one"] }, qb: { answers: ["two"] } },
    });
    expect(await store.readAnswer(lane.id)).toBe(JSON.stringify({ qa: "one", qb: ["two"] }));

    transport.emitNotification("turn/completed", {
      threadId: THREAD_ID,
      turn: { id: TURN_ID, status: "completed", items: [] },
    });
    await dispatchPromise;
  });

  test("answered events echo the store-assigned answer generation", async () => {
    const { store, lane, transport, adapter } = await createFixture();
    transport.setResponder("turn/start", () => {
      queueMicrotask(() => {
        transport.emitRequest("item/tool/requestUserInput", 11, {
          itemId: "item_q",
          threadId: THREAD_ID,
          turnId: TURN_ID,
          questions: [{ header: "Deploy", id: "q1", question: "Proceed?" }],
        });
      });

      return { turn: { id: TURN_ID, status: "inProgress", items: [] } };
    });

    const received: LaneEventInput[] = [];
    const dispatchPromise = adapter.dispatch({
      laneId: lane.id,
      prompt: "deploy",
      cwd: "/tmp/project",
      onEvent: (event) => {
        received.push(event);
      },
    });

    await waitFor(() => received.some((event) => event.event === "question"));

    // Block the lane the way the CLI would, then submit generationally so
    // the store assigns lane.answerGeneration.
    await store.transitionLane(lane.id, { from: ["queued"], to: "running" });
    await store.transitionLane(lane.id, { from: ["running"], to: "blocked" });
    const submitted = await store.submitAnswer(lane.id, "yes");
    expect(submitted.generation).toBe(1);

    await waitFor(() => received.some((event) => event.event === "answered"));
    const answered = received.find((event) => event.event === "answered");
    expect(answered?.data.generation).toBe(1);
    expect(answered?.data.answers).toEqual({ q1: { answers: ["yes"] } });
    expect(transport.responseWithId(11)?.result).toEqual({
      answers: { q1: { answers: ["yes"] } },
    });

    // The adapter stays read-only: the file survives until the CLI's
    // generation-checked consumption deletes it.
    expect(await store.readAnswer(lane.id)).toBe("yes");

    transport.emitNotification("turn/completed", {
      threadId: THREAD_ID,
      turn: { id: TURN_ID, status: "completed", items: [] },
    });
    await dispatchPromise;
  });

  test("replace-answer-mid-poll pairs text and generation from one atomic read", async () => {
    const transport = new MockTransport();
    transport.setResponder("initialize", () => ({ userAgent: "codex-test" }));
    transport.setResponder("thread/start", () => ({ thread: { id: THREAD_ID } }));
    transport.setResponder("turn/start", () => {
      queueMicrotask(() => {
        transport.emitRequest("item/tool/requestUserInput", 21, {
          itemId: "item_q",
          threadId: THREAD_ID,
          turnId: TURN_ID,
          questions: [
            { header: "A", id: "qa", question: "First?" },
            { header: "B", id: "qb", question: "Second?" },
          ],
        });
      });

      return { turn: { id: TURN_ID, status: "inProgress", items: [] } };
    });

    // Scripted atomic reads standing in for the locked store read: the first
    // submission is invalid for two questions; its mid-poll replacement
    // arrives as ONE text+generation pair, exactly as readAnswerWithGeneration
    // returns it under the lane lease. There is no separate loadLane call
    // left for a replacement to race — the pairing window is structurally gone.
    const reads: Array<{ text: string; generation: number } | null> = [
      null,
      { text: "just one answer", generation: 1 },
      { text: '{"qa":"one","qb":"two"}', generation: 2 },
    ];
    const laneIdsSeen: string[] = [];
    const answerReader = {
      readAnswerWithGeneration: (laneId: string) => {
        laneIdsSeen.push(laneId);
        return Promise.resolve(reads.length > 0 ? (reads.shift() ?? null) : null);
      },
    };

    const adapter = new CodexAdapter({
      store: answerReader,
      answerPollMs: 5,
      clientFactory: () => new CodexClient({ transportFactory: () => transport }),
    });

    const received: LaneEventInput[] = [];
    const dispatchPromise = adapter.dispatch({
      laneId: "lane_atomic",
      prompt: "two questions",
      cwd: "/tmp/project",
      onEvent: (event) => {
        received.push(event);
      },
    });

    await waitFor(() => transport.responseWithId(21) !== undefined);
    expect(transport.responseWithId(21)?.result).toEqual({
      answers: { qa: { answers: ["one"] }, qb: { answers: ["two"] } },
    });

    await waitFor(() => received.some((event) => event.event === "answered"));
    const answered = received.find((event) => event.event === "answered");
    // The echoed generation is the one read atomically WITH the consumed
    // text: generation 2, never the invalid submission's generation 1.
    expect(answered?.data.generation).toBe(2);
    expect(answered?.data.answers).toEqual({
      qa: { answers: ["one"] },
      qb: { answers: ["two"] },
    });
    expect(
      received.filter(
        (event) => event.event === "progress" && event.data.type === "invalid_answer",
      ),
    ).toHaveLength(1);
    expect(new Set(laneIdsSeen)).toEqual(new Set(["lane_atomic"]));

    transport.emitNotification("turn/completed", {
      threadId: THREAD_ID,
      turn: { id: TURN_ID, status: "completed", items: [] },
    });
    await dispatchPromise;
  });

  test("blocked timeout emits a final question update with live false", async () => {
    const { lane, transport, adapter } = await createFixture();
    transport.setResponder("turn/start", () => {
      queueMicrotask(() => {
        transport.emitRequest("item/tool/requestUserInput", 99, {
          itemId: "item_q",
          threadId: THREAD_ID,
          turnId: TURN_ID,
          questions: [{ header: "Deploy", id: "q1", question: "Proceed?" }],
        });
      });

      return { turn: { id: TURN_ID, status: "inProgress", items: [] } };
    });

    const received: LaneEventInput[] = [];
    const outcome = await adapter.dispatch({
      laneId: lane.id,
      prompt: "deploy",
      cwd: "/tmp/project",
      timeoutMs: 30,
      onEvent: (event) => {
        received.push(event);
      },
    });

    expect(outcome.status).toBe("blocked");
    expect(outcome.delivery).toBe("confirmed");
    expect(outcome.nativeStatus).toBe("unknown");
    const questions = received.filter((event) => event.event === "question");
    expect(questions.map((event) => event.data.live)).toEqual([true, false]);
    expect(questions[1]?.data.questions).toEqual([{ id: "q1", question: "Deploy: Proceed?" }]);
    expect(questions[1]?.data.delivery).toBe("confirmed");
    expect(questions[1]?.data.nativeStatus).toBe("unknown");
  });
});

describe("CodexAdapter resume", () => {
  test("verifies continuity via thread-id-match and runs the turn", async () => {
    const { store, lane, transport, adapter } = await createFixture();
    await store.updateLane(lane.id, { agentSessionId: THREAD_ID });
    transport.setResponder("thread/resume", () => ({ thread: { id: THREAD_ID } }));
    scriptCompletedTurn(transport, "resumed fine");

    const record = await store.loadLane(lane.id);
    const outcome = await adapter.resume(record as LaneRecord, "continue please");

    expect(outcome.status).toBe("completed");
    expect(outcome.continuity).toEqual({
      verified: true,
      method: "thread-id-match",
      detail: `thread/resume returned ${THREAD_ID}`,
    });
    expect(outcome.agentSessionId).toBe(THREAD_ID);

    const resume = transport.requests.find((request) => request.method === "thread/resume");
    expect(resume?.params).toMatchObject({ threadId: THREAD_ID, cwd: "/tmp/project" });
  });

  test("resumes a completed lane that beginResume returned to running (resume-of-completed)", async () => {
    const { store, lane, transport, adapter } = await createFixture();
    await store.updateLane(lane.id, { agentSessionId: THREAD_ID });
    await store.transitionLane(lane.id, { from: ["queued"], to: "running" });
    await store.transitionLaneWithEvent(
      lane.id,
      { from: ["running"], to: "completed" },
      { event: "result", data: { text: "first turn done" } },
    );

    // The store's documented completed->running carve-out: a user-initiated
    // resume of a finished lane arrives at the adapter as status "running".
    const begun = await store.beginResume(lane.id);
    expect(begun.lane.status).toBe("running");
    expect(begun.event.event).toBe("resume_started");
    expect(begun.event.data.pid).toBe(process.pid);

    transport.setResponder("thread/resume", () => ({ thread: { id: THREAD_ID } }));
    scriptCompletedTurn(transport, "second turn done");

    const outcome = await adapter.resume(begun.lane, "one more thing");

    expect(outcome.status).toBe("completed");
    expect(outcome.result?.text).toBe("second turn done");
    expect(outcome.agentSessionId).toBe(THREAD_ID);
    expect(outcome.continuity).toEqual({
      verified: true,
      method: "thread-id-match",
      detail: `thread/resume returned ${THREAD_ID}`,
    });

    const resume = transport.requests.find((request) => request.method === "thread/resume");
    expect(resume?.params).toMatchObject({ threadId: THREAD_ID, cwd: "/tmp/project" });
  });

  test("threads resume onEvent and timeoutMs without settling the lane", async () => {
    const { store, lane, transport, adapter, launches } = await createFixture();
    await store.updateLane(lane.id, { agentSessionId: THREAD_ID });
    transport.setResponder("thread/resume", () => ({ thread: { id: THREAD_ID } }));
    transport.setResponder("turn/start", () => ({
      turn: { id: TURN_ID, status: "inProgress", items: [] },
    }));

    const record = (await store.loadLane(lane.id)) as LaneRecord;
    const received: LaneEventInput[] = [];
    const outcome = await adapter.resume(record, "continue please", {
      timeoutMs: 30,
      onEvent: (event) => {
        received.push(event);
      },
    });

    expect(outcome.status).toBe("failed");
    expect(outcome.code).toBe("timeout");
    expect(outcome.error?.remediation).toContain("--timeout");
    expect(received.filter((event) => event.event === "agent_started")).toHaveLength(1);
    const started = received.find((event) => event.event === "agent_started");
    expect(started?.data.resumed).toBe(true);
    expect(started?.data.pid).toBe(4242);
    expect(started?.data.pgid).toBe(4242);
    expect(launches[0]?.detached).toBe(true);
    expect(transport.requests.some((request) => request.method === "turn/interrupt")).toBe(true);

    const unchanged = await store.loadLane(lane.id);
    expect(unchanged?.status).toBe("queued");
    expect(unchanged?.agentSessionId).toBe(THREAD_ID);
  });

  test("throws ContinuityError when the resumed thread id does not match", async () => {
    const { store, lane, transport, adapter } = await createFixture();
    await store.updateLane(lane.id, { agentSessionId: "thread_expected" });
    transport.setResponder("thread/resume", () => ({ thread: { id: "thread_other" } }));

    const record = await store.loadLane(lane.id);
    try {
      await adapter.resume(record as LaneRecord, "continue");
      throw new Error("expected resume to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ContinuityError);
      expect((error as ContinuityError).code).toBe("continuity_unverified");
      expect((error as ContinuityError).detail).toContain("thread_expected");
      expect((error as ContinuityError).detail).toContain("thread_other");
    }

    // Never silently rebinds: no turn was started, and the client shut down.
    expect(transport.requests.some((request) => request.method === "turn/start")).toBe(false);
    expect(transport.closed).toBe(true);
  });

  test("throws ContinuityError when the lane never bound a native session", async () => {
    const { lane, transport, adapter } = await createFixture();

    await expect(adapter.resume(lane, "continue")).rejects.toBeInstanceOf(ContinuityError);
    expect(transport.requests.length).toBe(0);
  });

  test("throws ContinuityError when thread/resume itself fails", async () => {
    const { store, lane, transport, adapter } = await createFixture();
    await store.updateLane(lane.id, { agentSessionId: THREAD_ID });
    transport.setResponder("thread/resume", () => {
      throw new Error("thread not found");
    });

    const record = await store.loadLane(lane.id);
    await expect(adapter.resume(record as LaneRecord, "continue")).rejects.toBeInstanceOf(
      ContinuityError,
    );
  });
});

describe("CodexAdapter inspect", () => {
  test("returns unknown when the lane has no bound session", async () => {
    const { lane, adapter } = await createFixture();

    const snapshot = await adapter.inspect(lane);
    expect(snapshot.nativeStatus).toBe("unknown");
    expect(snapshot.detail).toContain("no bound codex thread");
  });

  test("maps an active thread to running", async () => {
    const { store, lane, transport, adapter } = await createFixture();
    await store.updateLane(lane.id, { agentSessionId: THREAD_ID });
    transport.setResponder("thread/read", () => ({
      thread: {
        id: THREAD_ID,
        status: { type: "active", activeFlags: ["waitingOnUserInput"] },
        updatedAt: 1_770_000_000,
      },
    }));

    const record = await store.loadLane(lane.id);
    const snapshot = await adapter.inspect(record as LaneRecord);

    expect(snapshot.nativeStatus).toBe("running");
    expect(snapshot.agentSessionId).toBe(THREAD_ID);
    expect(snapshot.detail).toContain("waitingOnUserInput");
    expect(snapshot.lastActivityAt).toBe(new Date(1_770_000_000 * 1000).toISOString());
  });

  test("maps an idle thread's last turn status", async () => {
    const { store, lane, transport, adapter } = await createFixture();
    await store.updateLane(lane.id, { agentSessionId: THREAD_ID });
    transport.setResponder("thread/read", () => ({
      thread: {
        id: THREAD_ID,
        status: { type: "idle" },
        turns: [
          { id: "turn_a", status: "completed", items: [] },
          { id: "turn_b", status: "failed", items: [], error: { message: "sandbox denied" } },
        ],
      },
    }));

    const record = await store.loadLane(lane.id);
    const snapshot = await adapter.inspect(record as LaneRecord);

    expect(snapshot.nativeStatus).toBe("failed");
    expect(snapshot.detail).toBe("sandbox denied");
  });

  test("reports unknown with detail when thread/read fails", async () => {
    const { store, lane, transport, adapter } = await createFixture();
    await store.updateLane(lane.id, { agentSessionId: THREAD_ID });
    transport.setResponder("thread/read", () => {
      throw new Error("no such thread");
    });

    const record = await store.loadLane(lane.id);
    const snapshot = await adapter.inspect(record as LaneRecord);

    expect(snapshot.nativeStatus).toBe("unknown");
    expect(snapshot.detail).toContain("no such thread");
  });
});

describe("CodexAdapter manifest", () => {
  test("capabilities() returns a schema-valid manifest", async () => {
    const { adapter } = await createFixture();

    const manifest = AgentManifestSchema.parse(adapter.capabilities());
    expect(manifest.agent).toBe("codex");
    expect(manifest.capabilities.questions).toBe(true);
    // P-POSIX: process-group kill is POSIX-only and reported platform-aware.
    expect(manifest.capabilities.kill).toBe(process.platform !== "win32");
    expect(manifest.capabilities.continuityMethods).toEqual(["thread-id-match"]);
    expect(manifest.overhead?.startupMsP50).toBe(7500);
    expect(manifest.overhead?.measuredAt).toBe("2026-07-11");
    expect(manifest.declared).toEqual(expect.objectContaining(CODEX_DECLARED_FACTS));
    expect(manifest.caveats?.map((caveat) => caveat.code)).toContain(
      "process_group_signalling_cli_owned",
    );
    expect(manifest.caveats?.map((caveat) => caveat.code)).not.toContain(
      "process_identity_unavailable",
    );
  });
});
