import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

import { InvalidLaneIdError } from "../lane-id";
import {
  LaneLockLostError,
  LaneNotFoundError,
  LaneStore,
  resolveOrcaHome,
  TransitionConflictError,
} from "../store";
import type { LaneStatus } from "../../types/lane";

describe("LaneStore", () => {
  let orcaHome: string;
  let store: LaneStore;
  let previousOrcaHome: string | undefined;

  beforeEach(async () => {
    previousOrcaHome = process.env.ORCA_HOME;
    orcaHome = await fs.mkdtemp(path.join(os.tmpdir(), "orca-lane-store-test-"));
    process.env.ORCA_HOME = orcaHome;
    store = new LaneStore();
  });

  afterEach(async () => {
    if (previousOrcaHome === undefined) {
      delete process.env.ORCA_HOME;
    } else {
      process.env.ORCA_HOME = previousOrcaHome;
    }

    await fs.rm(orcaHome, { recursive: true, force: true });
  });

  test("ORCA_HOME hermeticity: all lane files live under the override", async () => {
    const lane = await store.createLane({ agent: "codex", cwd: "/tmp/project" });

    const laneDir = store.getLaneDir(lane.id);
    expect(laneDir).toBe(path.join(orcaHome, "lanes", lane.id));
    expect(laneDir.startsWith(orcaHome)).toBe(true);

    const entries = await fs.readdir(laneDir);
    expect(entries.sort()).toEqual(["artifacts", "events.ndjson", "lane.json"]);
  });

  test("resolveOrcaHome falls back to ~/.orca when unset or empty", () => {
    const fallback = path.join(os.homedir(), ".orca");

    delete process.env.ORCA_HOME;
    expect(resolveOrcaHome()).toBe(fallback);

    process.env.ORCA_HOME = "";
    expect(resolveOrcaHome()).toBe(fallback);

    process.env.ORCA_HOME = orcaHome;
    expect(resolveOrcaHome()).toBe(orcaHome);
  });

  test("createLane writes a queued lane record and a created event at seq 1", async () => {
    const lane = await store.createLane({
      agent: "codex",
      cwd: "/tmp/project",
      model: "gpt-5.5",
      label: "fix-tests",
    });

    expect(lane.id).toMatch(/^lane_[0-9a-f]{8}$/);
    expect(lane.status).toBe("queued");
    expect(lane.seq).toBe(1);
    expect(lane.model).toBe("gpt-5.5");
    expect(lane.label).toBe("fix-tests");

    const events = await store.readEvents(lane.id);
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe("created");
    expect(events[0]?.seq).toBe(1);
    expect(events[0]?.laneId).toBe(lane.id);
  });

  test("loadLane returns null for an unknown lane", async () => {
    expect(await store.loadLane("lane_missing0")).toBeNull();
  });

  test("updateLane merges atomically, preserves id, and refreshes updatedAt", async () => {
    const lane = await store.createLane({ agent: "codex", cwd: "/tmp/project" });
    await store.transitionLane(lane.id, { from: ["queued"], to: "running" });

    await new Promise((resolve) => setTimeout(resolve, 2));
    const updated = await store.updateLane(lane.id, {
      agentSessionId: "thread_123",
    });

    expect(updated.id).toBe(lane.id);
    expect(updated.status).toBe("running");
    expect(updated.agentSessionId).toBe("thread_123");
    expect(updated.updatedAt > lane.updatedAt).toBe(true);

    const laneDirEntries = await fs.readdir(store.getLaneDir(lane.id));
    expect(laneDirEntries.some((entry) => entry.endsWith(".tmp"))).toBe(false);
  });

  test("updateLane throws LaneNotFoundError for an unknown lane", async () => {
    expect(
      store.updateLane("lane_0badc0de", { agentSessionId: "thread_123" }),
    ).rejects.toBeInstanceOf(LaneNotFoundError);
  });

  test("updateLane rejects store-owned status and sequence fields at runtime", async () => {
    const lane = await store.createLane({ agent: "codex", cwd: "/tmp/project" });

    await expect(store.updateLane(lane.id, { status: "completed" } as never)).rejects.toThrow(
      /store-owned field.*status/,
    );
    await expect(store.updateLane(lane.id, { seq: 99 } as never)).rejects.toThrow(
      /store-owned field.*seq/,
    );
    expect((await store.loadLane(lane.id))?.status).toBe("queued");
    expect((await store.loadLane(lane.id))?.seq).toBe(1);
  });

  test("appendEvent throws LaneNotFoundError for an unknown lane", async () => {
    expect(store.appendEvent("lane_missing0", { event: "progress" })).rejects.toBeInstanceOf(
      LaneNotFoundError,
    );
  });

  test("concurrent appendEvent calls produce unique, gap-free, monotonic seqs", async () => {
    const lane = await store.createLane({ agent: "codex", cwd: "/tmp/project" });

    const appended = await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        store.appendEvent(lane.id, { event: "progress", data: { index } }),
      ),
    );

    const seqs = appended.map((event) => event.seq).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: 25 }, (_, index) => index + 2));

    const events = await store.readEvents(lane.id);
    expect(events.map((event) => event.seq)).toEqual(
      Array.from({ length: 26 }, (_, index) => index + 1),
    );

    const reloaded = await store.loadLane(lane.id);
    expect(reloaded?.seq).toBe(26);
  });

  test("seq stays monotonic across store instances", async () => {
    const lane = await store.createLane({ agent: "codex", cwd: "/tmp/project" });
    await store.appendEvent(lane.id, { event: "agent_started" });

    const secondStore = new LaneStore(orcaHome);
    const event = await secondStore.appendEvent(lane.id, { event: "progress" });

    expect(event.seq).toBe(3);
  });

  test("seq derives from the events file even when lane.json lags behind", async () => {
    const lane = await store.createLane({ agent: "codex", cwd: "/tmp/project" });
    await store.appendEvent(lane.id, { event: "agent_started" });
    await store.appendEvent(lane.id, { event: "progress" });

    // Simulate a writer that crashed after appending seq 3 but before
    // mirroring it onto lane.json: rewind the mirrored seq.
    const lanePath = store.getLanePath(lane.id);
    const record = JSON.parse(await fs.readFile(lanePath, "utf8")) as { seq: number };
    record.seq = 1;
    await fs.writeFile(lanePath, `${JSON.stringify(record, null, 2)}\n`, "utf8");

    const event = await store.appendEvent(lane.id, { event: "progress" });
    expect(event.seq).toBe(4);
  });

  test("readEvents filters with sinceSeq and returns [] for missing files", async () => {
    const lane = await store.createLane({ agent: "codex", cwd: "/tmp/project" });
    await store.appendEvent(lane.id, { event: "agent_started" });
    await store.appendEvent(lane.id, { event: "progress", data: { message: "step" } });

    const since = await store.readEvents(lane.id, { sinceSeq: 2 });
    expect(since.map((event) => event.seq)).toEqual([3]);
    expect(since[0]?.event).toBe("progress");

    expect(await store.readEvents("lane_missing0")).toEqual([]);
  });

  test("readEvents rejects malformed complete records", async () => {
    const lane = await store.createLane({ agent: "codex", cwd: "/tmp/project" });
    await fs.appendFile(store.getEventsPath(lane.id), "not-json\n", "utf8");

    await expect(store.readEvents(lane.id)).rejects.toThrow();
  });

  test("listLanes returns lanes sorted by createdAt descending", async () => {
    const first = await store.createLane({ agent: "codex", cwd: "/tmp/a" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await store.createLane({ agent: "claude", cwd: "/tmp/b" });

    const lanes = await store.listLanes();
    expect(lanes.map((lane) => lane.id)).toEqual([second.id, first.id]);
  });

  test("listLanes returns [] when the lanes directory does not exist", async () => {
    const emptyStore = new LaneStore(path.join(orcaHome, "does-not-exist"));
    expect(await emptyStore.listLanes()).toEqual([]);
  });

  test("submitAnswer verifies blocked state and records the file plus evidence atomically", async () => {
    const lane = await store.createLane({ agent: "codex", cwd: "/tmp/project" });
    await expect(store.submitAnswer(lane.id, "too early")).rejects.toBeInstanceOf(
      TransitionConflictError,
    );

    await store.transitionLane(lane.id, { from: ["queued"], to: "blocked" });
    const submitted = await store.submitAnswer(lane.id, "use staging");

    expect(submitted.lane.status).toBe("blocked");
    expect(submitted.event.event).toBe("answered");
    expect(submitted.event.data.text).toBe("use staging");
    expect(await store.readAnswer(lane.id)).toBe("use staging");
    expect(submitted.lane.seq).toBe(submitted.event.seq);
    await expect(store.submitAnswer("lane_0badc0de", "nope")).rejects.toBeInstanceOf(
      LaneNotFoundError,
    );
  });

  test("consumeAnswerWithEvent records consumption before clearing and returning to running", async () => {
    const lane = await store.createLane({ agent: "codex", cwd: "/tmp/project" });
    await store.transitionLane(lane.id, { from: ["queued"], to: "blocked" });
    await store.submitAnswer(lane.id, "use staging");

    const consumed = await store.consumeAnswerWithEvent(lane.id, {
      event: "answered",
      data: { requestId: "q1" },
    });

    expect(consumed.lane.status).toBe("running");
    expect(consumed.event.event).toBe("answered");
    expect(await store.readAnswer(lane.id)).toBeNull();
    expect((await store.readEvents(lane.id)).at(-1)).toEqual(consumed.event);
    await expect(store.consumeAnswerWithEvent(lane.id, { event: "progress" })).rejects.toThrow(
      /requires event/,
    );
  });

  describe("transitionLane", () => {
    test("applies a CAS status change when the current status is in from", async () => {
      const lane = await store.createLane({ agent: "codex", cwd: "/tmp/project" });

      const running = await store.transitionLane(lane.id, { from: ["queued"], to: "running" });
      expect(running.status).toBe("running");
      expect(running.id).toBe(lane.id);

      expect((await store.loadLane(lane.id))?.status).toBe("running");
    });

    test("throws TransitionConflictError when the current status is not in from", async () => {
      const lane = await store.createLane({ agent: "codex", cwd: "/tmp/project" });

      try {
        await store.transitionLane(lane.id, { from: ["running", "blocked"], to: "completed" });
        throw new Error("expected transitionLane to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(TransitionConflictError);
        const conflict = error as TransitionConflictError;
        expect(conflict.laneId).toBe(lane.id);
        expect(conflict.actualStatus).toBe("queued");
        expect(conflict.expectedFrom).toEqual(["running", "blocked"]);
        expect(conflict.to).toBe("completed");
      }

      expect((await store.loadLane(lane.id))?.status).toBe("queued");
    });

    test("terminal statuses are immutable, even when listed in from", async () => {
      const terminals: LaneStatus[] = ["completed", "failed", "killed", "lost"];

      for (const terminal of terminals) {
        const lane = await store.createLane({ agent: "codex", cwd: "/tmp/project" });
        await store.transitionLane(lane.id, { from: ["queued"], to: terminal });

        await expect(
          store.transitionLane(lane.id, { from: [terminal], to: "running" }),
        ).rejects.toBeInstanceOf(TransitionConflictError);

        expect((await store.loadLane(lane.id))?.status).toBe(terminal);
      }
    });

    test("a settle-after-kill race surfaces as TransitionConflictError", async () => {
      const lane = await store.createLane({ agent: "codex", cwd: "/tmp/project" });
      await store.transitionLane(lane.id, { from: ["queued"], to: "running" });

      // Another process (kill) settles first...
      await store.transitionLane(lane.id, { from: ["running"], to: "killed" });

      // ...so the dispatcher's own settlement must conflict and re-read the store.
      try {
        await store.transitionLane(lane.id, { from: ["running"], to: "completed" });
        throw new Error("expected transitionLane to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(TransitionConflictError);
        expect((error as TransitionConflictError).actualStatus).toBe("killed");
      }
    });

    test("terminal lanes reject late events so stored evidence cannot be overwritten", async () => {
      const lane = await store.createLane({ agent: "codex", cwd: "/tmp/project" });
      await store.transitionLaneWithEvent(
        lane.id,
        { from: ["queued"], to: "killed" },
        { event: "killed", data: { nativeStatus: "interrupted" } },
      );

      await expect(
        store.appendEvent(lane.id, {
          event: "progress",
          data: { nativeStatus: "completed", delivery: "confirmed", text: "too late" },
        }),
      ).rejects.toBeInstanceOf(TransitionConflictError);
      expect((await store.readEvents(lane.id)).at(-1)?.event).toBe("killed");
    });

    test("loadLane recovers a terminal event fsynced before lane.json", async () => {
      const lane = await store.createLane({ agent: "codex", cwd: "/tmp/project" });
      await store.transitionLane(lane.id, { from: ["queued"], to: "running" });
      const terminalEvent = {
        v: 1,
        seq: lane.seq + 1,
        ts: new Date().toISOString(),
        laneId: lane.id,
        event: "result",
        data: { text: "done", delivery: "confirmed", nativeStatus: "completed" },
      };
      await fs.appendFile(
        store.getEventsPath(lane.id),
        `${JSON.stringify(terminalEvent)}\n`,
        "utf8",
      );

      const recovered = await store.loadLane(lane.id);
      expect(recovered?.status).toBe("completed");
      expect(recovered?.seq).toBe(terminalEvent.seq);
      await expect(
        store.appendEvent(lane.id, { event: "progress", data: { text: "too late" } }),
      ).rejects.toBeInstanceOf(TransitionConflictError);
    });

    test("transitionLaneWithEvent writes evidence before the terminal lane record", async () => {
      const lane = await store.createLane({ agent: "codex", cwd: "/tmp/project" });
      await store.transitionLane(lane.id, { from: ["queued"], to: "running" });

      const settled = await store.transitionLaneWithEvent(
        lane.id,
        { from: ["running"], to: "completed" },
        {
          event: "result",
          data: { text: "done", delivery: "confirmed", nativeStatus: "completed" },
        },
      );

      expect(settled.lane.status).toBe("completed");
      expect(settled.lane.seq).toBe(settled.event.seq);
      expect(settled.event.event).toBe("result");
      expect((await store.readEvents(lane.id)).at(-1)).toEqual(settled.event);
    });

    test("transitionLaneWithEvent holds the CAS lock through an async evidence factory", async () => {
      const lane = await store.createLane({ agent: "codex", cwd: "/tmp/project" });
      await store.transitionLane(lane.id, { from: ["queued"], to: "running" });
      const competingStore = new LaneStore(orcaHome);

      let releaseFactory: (() => void) | undefined;
      let markFactoryStarted: (() => void) | undefined;
      const factoryStarted = new Promise<void>((resolve) => {
        markFactoryStarted = resolve;
      });
      const factoryRelease = new Promise<void>((resolve) => {
        releaseFactory = resolve;
      });
      const killing = store.transitionLaneWithEvent(
        lane.id,
        { from: ["running"], to: "killed" },
        async () => {
          markFactoryStarted?.();
          await factoryRelease;
          return { event: "killed", data: { nativeStatus: "interrupted" } };
        },
      );
      await factoryStarted;

      let competitorFinished = false;
      const competingSettlement = competingStore
        .transitionLane(lane.id, { from: ["running"], to: "completed" })
        .finally(() => {
          competitorFinished = true;
        });
      await Bun.sleep(25);
      expect(competitorFinished).toBe(false);

      releaseFactory?.();
      await killing;
      expect(competingSettlement).rejects.toBeInstanceOf(TransitionConflictError);
      expect((await store.loadLane(lane.id))?.status).toBe("killed");
    });

    test("unknown and invalid lane ids throw LaneNotFoundError", async () => {
      await expect(
        store.transitionLane("lane_0badc0de", { from: ["queued"], to: "running" }),
      ).rejects.toBeInstanceOf(LaneNotFoundError);

      await expect(
        store.transitionLane("lane_../../..", { from: ["queued"], to: "running" }),
      ).rejects.toBeInstanceOf(LaneNotFoundError);
    });
  });

  describe("lane id defense", () => {
    const traversal = "lane_../../..";

    test("reads treat invalid ids as not found without building paths", async () => {
      expect(await store.loadLane(traversal)).toBeNull();
      expect(await store.readEvents(traversal)).toEqual([]);
      expect(await store.readAnswer(traversal)).toBeNull();
    });

    test("writes refuse invalid ids with LaneNotFoundError", async () => {
      await expect(store.appendEvent(traversal, { event: "progress" })).rejects.toBeInstanceOf(
        LaneNotFoundError,
      );
      await expect(
        store.updateLane(traversal, { agentSessionId: "thread_123" }),
      ).rejects.toBeInstanceOf(LaneNotFoundError);
      await expect(store.submitAnswer(traversal, "nope")).rejects.toBeInstanceOf(LaneNotFoundError);
    });

    test("path getters refuse invalid ids with InvalidLaneIdError", () => {
      for (const method of [
        "getLaneDir",
        "getLanePath",
        "getEventsPath",
        "getAnswerPath",
        "getArtifactsDir",
      ] as const) {
        expect(() => store[method](traversal)).toThrow(InvalidLaneIdError);
        expect(() => store[method]("lane_a3f8b901/answer.txt")).toThrow(InvalidLaneIdError);
      }
    });

    test("listLanes skips directory entries that are not valid lane ids", async () => {
      const lane = await store.createLane({ agent: "codex", cwd: "/tmp/project" });
      await fs.mkdir(path.join(orcaHome, "lanes", "not-a-lane"), { recursive: true });

      const lanes = await store.listLanes();
      expect(lanes.map((entry) => entry.id)).toEqual([lane.id]);
    });
  });

  describe("interprocess lockfile", () => {
    test("writes release lane.lock afterwards", async () => {
      const lane = await store.createLane({ agent: "codex", cwd: "/tmp/project" });
      const lockPath = path.join(store.getLaneDir(lane.id), "lane.lock");

      await store.appendEvent(lane.id, { event: "progress" });
      await store.transitionLane(lane.id, { from: ["queued"], to: "running" });
      await store.transitionLane(lane.id, { from: ["running"], to: "blocked" });

      await expect(fs.access(lockPath)).rejects.toThrow();
    });

    test("a held lock blocks writers until it is released", async () => {
      const lane = await store.createLane({ agent: "codex", cwd: "/tmp/project" });
      const lockPath = path.join(store.getLaneDir(lane.id), "lane.lock");
      await fs.writeFile(lockPath, "424242\n", "utf8");

      const pending = store.appendEvent(lane.id, { event: "progress" });
      let settled = false;
      pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );

      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(settled).toBe(false);

      await fs.unlink(lockPath);
      const event = await pending;
      expect(event.seq).toBe(2);
    });

    test("a stale lock (no mtime refresh) is taken over", async () => {
      const lane = await store.createLane({ agent: "codex", cwd: "/tmp/project" });
      const lockPath = path.join(store.getLaneDir(lane.id), "lane.lock");
      await fs.writeFile(lockPath, "424242\n", "utf8");
      const past = new Date(Date.now() - 60_000);
      await fs.utimes(lockPath, past, past);

      const event = await store.appendEvent(lane.id, { event: "progress" });
      expect(event.seq).toBe(2);
      await expect(fs.access(lockPath)).rejects.toThrow();
    });

    test("acquisition times out after lockTimeoutMs while a fresh lock is held", async () => {
      const impatient = new LaneStore(orcaHome, { lockTimeoutMs: 250 });
      const lane = await impatient.createLane({ agent: "codex", cwd: "/tmp/project" });
      const lockPath = path.join(impatient.getLaneDir(lane.id), "lane.lock");
      await fs.writeFile(lockPath, "424242\n", "utf8");

      await expect(impatient.appendEvent(lane.id, { event: "progress" })).rejects.toThrow(
        /Timed out after 250ms/,
      );

      await fs.unlink(lockPath);
    });

    test("two stores in one process interleave appends with gap-free monotonic seqs", async () => {
      const lane = await store.createLane({ agent: "codex", cwd: "/tmp/project" });
      const other = new LaneStore(orcaHome);

      // Separate LaneStore instances share no in-process mutex; only the
      // lane.lock file serializes them.
      const appended = await Promise.all([
        ...Array.from({ length: 10 }, (_, index) =>
          store.appendEvent(lane.id, { event: "progress", data: { via: "a", index } }),
        ),
        ...Array.from({ length: 10 }, (_, index) =>
          other.appendEvent(lane.id, { event: "progress", data: { via: "b", index } }),
        ),
      ]);

      const seqs = appended.map((event) => event.seq).sort((a, b) => a - b);
      expect(seqs).toEqual(Array.from({ length: 20 }, (_, index) => index + 2));

      // File order must equal seq order: gap-free and monotonic.
      const events = await store.readEvents(lane.id);
      expect(events.map((event) => event.seq)).toEqual(
        Array.from({ length: 21 }, (_, index) => index + 1),
      );

      expect((await store.loadLane(lane.id))?.seq).toBe(21);
    }, 20_000);
  });

  describe("stale-lock recovery gate (finding 11)", () => {
    const staleMtime = async (filePath: string) => {
      const past = new Date(Date.now() - 60_000);
      await fs.utimes(filePath, past, past);
    };

    test("real multi-process simultaneous takeover: every writer survives with gap-free seqs", async () => {
      const lane = await store.createLane({ agent: "codex", cwd: "/tmp/project" });
      const lockPath = path.join(store.getLaneDir(lane.id), "lane.lock");
      await fs.writeFile(lockPath, "424242\n", "utf8");
      await staleMtime(lockPath);

      const worker = path.join(import.meta.dir, "fixtures", "lock-takeover-worker.ts");
      const children = Array.from({ length: 4 }, () =>
        Bun.spawn(["bun", worker, lane.id], {
          env: { ...process.env, ORCA_HOME: orcaHome },
          stdout: "pipe",
          stderr: "pipe",
        }),
      );

      const results = await Promise.all(
        children.map(async (child) => ({
          exitCode: await child.exited,
          stdout: await new Response(child.stdout).text(),
          stderr: await new Response(child.stderr).text(),
        })),
      );

      for (const result of results) {
        expect(result.stderr).toBe("");
        expect(result.exitCode).toBe(0);
      }

      const seqs = results
        .map((result) => (JSON.parse(result.stdout.trim()) as { seq: number }).seq)
        .sort((a, b) => a - b);
      expect(seqs).toEqual([2, 3, 4, 5]);

      const events = await store.readEvents(lane.id);
      expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5]);

      // Both the lock and the recovery gate were cleaned up.
      await expect(fs.access(lockPath)).rejects.toThrow();
      await expect(fs.access(`${lockPath}.recovery`)).rejects.toThrow();
    }, 30_000);

    test("a recovery gate held by a living process blocks takeover until timeout", async () => {
      const impatient = new LaneStore(orcaHome, { lockTimeoutMs: 300 });
      const lane = await impatient.createLane({ agent: "codex", cwd: "/tmp/project" });
      const lockPath = path.join(impatient.getLaneDir(lane.id), "lane.lock");
      const gatePath = `${lockPath}.recovery`;

      await fs.writeFile(lockPath, "424242\n", "utf8");
      await staleMtime(lockPath);
      // The gate records THIS live process and is stale by mtime: liveness
      // must still veto removal (a suspended recoverer is not a crashed one).
      await fs.writeFile(gatePath, `${process.pid}\n`, "utf8");
      await staleMtime(gatePath);

      await expect(impatient.appendEvent(lane.id, { event: "progress" })).rejects.toThrow(
        /Timed out after 300ms/,
      );

      // Only a gate holder may unlink the stale lock, so it must survive.
      await fs.access(lockPath);
      await fs.access(gatePath);

      await fs.rm(lockPath, { force: true });
      await fs.rm(gatePath, { force: true });
    });

    test("an abandoned gate (stale mtime, dead pid) is cleared and takeover proceeds", async () => {
      const lane = await store.createLane({ agent: "codex", cwd: "/tmp/project" });
      const lockPath = path.join(store.getLaneDir(lane.id), "lane.lock");
      const gatePath = `${lockPath}.recovery`;

      const deadChild = Bun.spawn(["sleep", "0"]);
      await deadChild.exited;

      await fs.writeFile(lockPath, "424242\n", "utf8");
      await staleMtime(lockPath);
      await fs.writeFile(gatePath, `${deadChild.pid}\n`, "utf8");
      await staleMtime(gatePath);

      const event = await store.appendEvent(lane.id, { event: "progress" });
      expect(event.seq).toBe(2);
      await expect(fs.access(lockPath)).rejects.toThrow();
      await expect(fs.access(gatePath)).rejects.toThrow();
    });
  });

  describe("lock ownership tokens (finding 11 residual)", () => {
    test("lane.lock records the holder pid and a per-acquisition owner token", async () => {
      const lane = await store.createLane({ agent: "codex", cwd: "/tmp/project" });
      const lockPath = path.join(store.getLaneDir(lane.id), "lane.lock");

      let heldContent: string | undefined;
      await store.transitionLaneWithEvent(
        lane.id,
        { from: ["queued"], to: "running" },
        async () => {
          heldContent = await fs.readFile(lockPath, "utf8");
          return { event: "progress", data: {} };
        },
      );

      const lines = (heldContent ?? "").split("\n");
      expect(lines[0]).toBe(String(process.pid));
      expect(lines[1]).toMatch(/^[0-9a-f]{32}$/);
    });

    test("a resumed stale holder fails loud without deleting the new owner's lock", async () => {
      const lane = await store.createLane({ agent: "codex", cwd: "/tmp/project" });
      const lockPath = path.join(store.getLaneDir(lane.id), "lane.lock");
      const foreignContent = "999999\nffffffffffffffffffffffffffffffff\n";

      let markHeld: (() => void) | undefined;
      const held = new Promise<void>((resolve) => {
        markHeld = resolve;
      });
      let releaseFactory: (() => void) | undefined;
      const factoryGate = new Promise<void>((resolve) => {
        releaseFactory = resolve;
      });

      // The mutation is suspended mid-critical-section (the factory stands in
      // for a descheduled process). A waiter takes the stale lock over:
      // unlink + O_EXCL recreate with ITS OWN pid and token.
      const takeover = async () => {
        await fs.rm(lockPath, { force: true });
        await fs.writeFile(lockPath, foreignContent, "utf8");
      };

      const mutation = store.transitionLaneWithEvent(
        lane.id,
        { from: ["queued"], to: "running" },
        async () => {
          markHeld?.();
          await factoryGate;
          return { event: "progress", data: {} };
        },
      );
      await held;
      await takeover();
      releaseFactory?.();

      // The stale holder resumes, finds a foreign token, and must fail loud
      // instead of reporting success...
      await expect(mutation).rejects.toBeInstanceOf(LaneLockLostError);

      // ...and the new owner's lock must survive, byte for byte.
      expect(await fs.readFile(lockPath, "utf8")).toBe(foreignContent);

      await fs.rm(lockPath, { force: true });
    });

    test("a task error is not masked by a lost lock at release", async () => {
      const lane = await store.createLane({ agent: "codex", cwd: "/tmp/project" });
      const lockPath = path.join(store.getLaneDir(lane.id), "lane.lock");

      const failing = store.transitionLaneWithEvent(
        lane.id,
        { from: ["queued"], to: "running" },
        async () => {
          await fs.rm(lockPath, { force: true });
          await fs.writeFile(lockPath, "999999\nfeedfacefeedfacefeedfacefeedface\n", "utf8");
          throw new Error("factory exploded");
        },
      );

      await expect(failing).rejects.toThrow("factory exploded");
      await fs.rm(lockPath, { force: true });
    });
  });

  describe("truncated-tail repair (finding 12)", () => {
    test("crash-torn corrupt fragment: append truncates the fragment, then lands cleanly", async () => {
      const lane = await store.createLane({ agent: "codex", cwd: "/tmp/project" });
      await store.appendEvent(lane.id, { event: "progress", data: { index: 1 } });
      await fs.appendFile(store.getEventsPath(lane.id), '{"v":1,"seq":3,"ts":"TORN', "utf8");

      const event = await store.appendEvent(lane.id, { event: "progress", data: { index: 2 } });
      expect(event.seq).toBe(3);

      const events = await store.readEvents(lane.id);
      expect(events.map((entry) => entry.seq)).toEqual([1, 2, 3]);

      const raw = await fs.readFile(store.getEventsPath(lane.id), "utf8");
      expect(raw).not.toContain("TORN");
      expect(raw.endsWith("\n")).toBe(true);
    });

    test("a complete valid unterminated tail event is preserved with a delimiter on append", async () => {
      const lane = await store.createLane({ agent: "codex", cwd: "/tmp/project" });
      const tailEvent = {
        v: 1,
        seq: 2,
        ts: new Date().toISOString(),
        laneId: lane.id,
        event: "progress",
        data: { marker: "kept" },
      };
      await fs.appendFile(store.getEventsPath(lane.id), JSON.stringify(tailEvent), "utf8");

      const appended = await store.appendEvent(lane.id, { event: "progress" });
      expect(appended.seq).toBe(3);

      const events = await store.readEvents(lane.id);
      expect(events.map((entry) => entry.seq)).toEqual([1, 2, 3]);
      expect(events[1]?.data.marker).toBe("kept");
    });

    test("readEvents repairs a corrupt tail in place instead of failing loud", async () => {
      const lane = await store.createLane({ agent: "codex", cwd: "/tmp/project" });
      await fs.appendFile(store.getEventsPath(lane.id), '{"v":1,"seq":2,"ts', "utf8");

      const events = await store.readEvents(lane.id);
      expect(events.map((entry) => entry.seq)).toEqual([1]);

      const raw = await fs.readFile(store.getEventsPath(lane.id), "utf8");
      expect(raw).not.toContain('"seq":2');
      expect(raw.endsWith("\n")).toBe(true);
    });

    test("readEvents adds the delimiter for a valid unterminated tail and keeps the event", async () => {
      const lane = await store.createLane({ agent: "codex", cwd: "/tmp/project" });
      const tailEvent = {
        v: 1,
        seq: 2,
        ts: new Date().toISOString(),
        laneId: lane.id,
        event: "progress",
        data: { marker: "kept" },
      };
      await fs.appendFile(store.getEventsPath(lane.id), JSON.stringify(tailEvent), "utf8");

      const events = await store.readEvents(lane.id);
      expect(events.map((entry) => entry.seq)).toEqual([1, 2]);
      expect(events[1]?.data.marker).toBe("kept");

      const raw = await fs.readFile(store.getEventsPath(lane.id), "utf8");
      expect(raw.endsWith("\n")).toBe(true);
    });
  });

  describe("answer generations (finding 13)", () => {
    const blockedLane = async () => {
      const lane = await store.createLane({ agent: "codex", cwd: "/tmp/project" });
      await store.transitionLane(lane.id, { from: ["queued"], to: "blocked" });
      return lane;
    };

    test("submitAnswer assigns monotonic generations persisted on the lane and event", async () => {
      const lane = await blockedLane();

      const first = await store.submitAnswer(lane.id, "A");
      expect(first.generation).toBe(1);
      expect(first.lane.answerGeneration).toBe(1);
      expect(first.event.data.generation).toBe(1);

      const second = await store.submitAnswer(lane.id, "B");
      expect(second.generation).toBe(2);
      expect(second.lane.answerGeneration).toBe(2);
      expect(await store.readAnswer(lane.id)).toBe("B");
      expect((await store.loadLane(lane.id))?.answerGeneration).toBe(2);
    });

    test("A/read, B/replace, A/consume: the replacement answer survives", async () => {
      const lane = await blockedLane();

      const first = await store.submitAnswer(lane.id, "A");
      // The adapter reads A (and will later echo generation 1)...
      expect(await store.readAnswer(lane.id)).toBe("A");
      // ...but the caller replaces it with B before consumption lands.
      await store.submitAnswer(lane.id, "B");

      const consumed = await store.consumeAnswerWithEvent(
        lane.id,
        { event: "answered", data: { requestId: "q1" } },
        { generation: first.generation },
      );
      expect(consumed.answerDeleted).toBe(false);
      expect(consumed.lane.status).toBe("running");
      expect(consumed.event.data.consumed).toBe(true);
      expect(consumed.event.data.generation).toBe(1);
      expect(await store.readAnswer(lane.id)).toBe("B");

      const second = await store.consumeAnswerWithEvent(
        lane.id,
        { event: "answered", data: { requestId: "q2" } },
        { generation: 2 },
      );
      expect(second.answerDeleted).toBe(true);
      expect(await store.readAnswer(lane.id)).toBeNull();
    });

    test("consumption without a generation keeps the legacy unconditional delete", async () => {
      const lane = await blockedLane();
      await store.submitAnswer(lane.id, "only");

      const consumed = await store.consumeAnswerWithEvent(lane.id, {
        event: "answered",
        data: { requestId: "q1" },
      });
      expect(consumed.answerDeleted).toBe(true);
      expect(await store.readAnswer(lane.id)).toBeNull();
    });
  });

  describe("readAnswerWithGeneration (findings 13 + 19 residuals)", () => {
    const blockedLane = async () => {
      const lane = await store.createLane({ agent: "codex", cwd: "/tmp/project" });
      await store.transitionLane(lane.id, { from: ["queued"], to: "blocked" });
      return lane;
    };

    const appendRawEvent = async (laneId: string, seq: number, data: Record<string, unknown>) => {
      const event = { v: 1, seq, ts: new Date().toISOString(), laneId, event: "answered", data };
      await fs.appendFile(store.getEventsPath(laneId), `${JSON.stringify(event)}\n`, "utf8");
    };

    test("returns the answer text and its generation read under one lease", async () => {
      const lane = await blockedLane();
      await store.submitAnswer(lane.id, "A");
      const second = await store.submitAnswer(lane.id, "B");

      const read = await store.readAnswerWithGeneration(lane.id);
      expect(read).toEqual({ text: "B", generation: second.generation });
    });

    test("returns null for missing answers, unknown lanes, and invalid ids", async () => {
      const lane = await blockedLane();
      expect(await store.readAnswerWithGeneration(lane.id)).toBeNull();
      expect(await store.readAnswerWithGeneration("lane_0badc0de")).toBeNull();
      expect(await store.readAnswerWithGeneration("lane_../../..")).toBeNull();
    });

    test("consumption-evidence-then-crash leaves no resurrectable answer", async () => {
      const lane = await blockedLane();
      const submitted = await store.submitAnswer(lane.id, "A");

      // Crash simulation: consumeAnswerWithEvent fsynced its consumed:true
      // evidence for the CURRENT generation, then died before deleting
      // answer.txt and before the lane.json update.
      await appendRawEvent(lane.id, submitted.event.seq + 1, {
        requestId: "q1",
        consumed: true,
        generation: submitted.generation,
      });
      expect(await store.readAnswer(lane.id)).toBe("A");

      // Replay finishes the deletion instead of redelivering the answer.
      expect(await store.readAnswerWithGeneration(lane.id)).toBeNull();
      expect(await store.readAnswer(lane.id)).toBeNull();
    });

    test("consumption evidence for an OLDER generation never deletes the replacement", async () => {
      const lane = await blockedLane();
      const first = await store.submitAnswer(lane.id, "A");
      const second = await store.submitAnswer(lane.id, "B");

      await appendRawEvent(lane.id, second.event.seq + 1, {
        requestId: "q1",
        consumed: true,
        generation: first.generation,
      });

      const read = await store.readAnswerWithGeneration(lane.id);
      expect(read).toEqual({ text: "B", generation: second.generation });
      expect(await store.readAnswer(lane.id)).toBe("B");
    });

    test("legacy consumption evidence without a generation is left for redelivery", async () => {
      const lane = await blockedLane();
      const submitted = await store.submitAnswer(lane.id, "A");

      await appendRawEvent(lane.id, submitted.event.seq + 1, { requestId: "q1", consumed: true });

      expect(await store.readAnswerWithGeneration(lane.id)).toEqual({
        text: "A",
        generation: submitted.generation,
      });
    });
  });

  describe("beginResume (finding 14)", () => {
    const blockWithQuestion = async (live: boolean) => {
      const lane = await store.createLane({ agent: "codex", cwd: "/tmp/project" });
      await store.transitionLane(lane.id, { from: ["queued"], to: "running" });
      await store.transitionLaneWithEvent(
        lane.id,
        { from: ["running", "blocked"], to: "blocked" },
        { event: "question", data: { id: "q1", question: "which env?", live } },
      );
      return lane;
    };

    test("resumes a blocked lane whose latest question is parked (not live)", async () => {
      const lane = await blockWithQuestion(false);

      const resumed = await store.beginResume(lane.id);
      expect(resumed.lane.status).toBe("running");
      expect(resumed.event.event).toBe("resume_started");
      expect(resumed.lane.seq).toBe(resumed.event.seq);
      expect((await store.readEvents(lane.id)).at(-1)?.event).toBe("resume_started");
      expect((await store.loadLane(lane.id))?.status).toBe("running");
    });

    test("resume_started evidence records the resuming pid", async () => {
      const lane = await blockWithQuestion(false);

      const resumed = await store.beginResume(lane.id);
      expect(resumed.event.data.pid).toBe(process.pid);
    });

    test("rejects resume while the latest question is live and the poller is alive", async () => {
      const lane = await blockWithQuestion(true);
      // The recorded lane process stands in for the polling dispatch; this
      // test process is provably alive.
      await store.updateLane(lane.id, {
        process: { pid: process.pid, pgid: process.pid, startedAt: new Date().toISOString() },
      });

      await expect(store.beginResume(lane.id)).rejects.toThrow(/latest question is live/);
      await expect(store.beginResume(lane.id)).rejects.toBeInstanceOf(TransitionConflictError);
      expect((await store.loadLane(lane.id))?.status).toBe("blocked");
      expect(
        (await store.readEvents(lane.id)).some((event) => event.event === "resume_started"),
      ).toBe(false);
    });

    test("a live question with a DEAD recorded process resumes (poller provably gone)", async () => {
      const lane = await blockWithQuestion(true);
      const deadChild = Bun.spawn(["sleep", "0"]);
      await deadChild.exited;
      await store.updateLane(lane.id, {
        process: { pid: deadChild.pid, startedAt: new Date().toISOString() },
      });

      const resumed = await store.beginResume(lane.id);
      expect(resumed.lane.status).toBe("running");
      expect(resumed.event.event).toBe("resume_started");
    });

    test("a live question with NO recorded process resumes (no poller to double-drive)", async () => {
      const lane = await blockWithQuestion(true);

      const resumed = await store.beginResume(lane.id);
      expect(resumed.lane.status).toBe("running");
    });

    test("the LATEST question decides: a later parked question re-enables resume", async () => {
      const lane = await blockWithQuestion(true);
      await store.updateLane(lane.id, {
        process: { pid: process.pid, pgid: process.pid, startedAt: new Date().toISOString() },
      });
      await store.transitionLaneWithEvent(
        lane.id,
        { from: ["running", "blocked"], to: "blocked" },
        { event: "question", data: { id: "q2", question: "still there?", live: false } },
      );

      const resumed = await store.beginResume(lane.id);
      expect(resumed.lane.status).toBe("running");
    });

    test("resumes a completed lane: the documented terminal carve-out", async () => {
      const lane = await store.createLane({ agent: "codex", cwd: "/tmp/project" });
      await store.transitionLane(lane.id, { from: ["queued"], to: "running" });
      await store.transitionLaneWithEvent(
        lane.id,
        { from: ["running"], to: "completed" },
        {
          event: "result",
          data: { text: "done", delivery: "confirmed", nativeStatus: "completed" },
        },
      );

      const resumed = await store.beginResume(lane.id);
      expect(resumed.lane.status).toBe("running");
      expect(resumed.event.event).toBe("resume_started");
      expect(resumed.event.data.pid).toBe(process.pid);
      expect((await store.loadLane(lane.id))?.status).toBe("running");
    });

    test("failed, killed, and lost lanes stay non-resumable", async () => {
      for (const terminal of ["failed", "killed", "lost"] as const) {
        const lane = await store.createLane({ agent: "codex", cwd: "/tmp/project" });
        await store.transitionLane(lane.id, { from: ["queued"], to: terminal });

        await expect(store.beginResume(lane.id)).rejects.toBeInstanceOf(TransitionConflictError);
        expect((await store.loadLane(lane.id))?.status).toBe(terminal);
      }
    });

    test("reclaims a running lane whose recorded resumer pid is dead", async () => {
      const lane = await store.createLane({ agent: "codex", cwd: "/tmp/project" });
      await store.transitionLane(lane.id, { from: ["queued"], to: "running" });
      const deadChild = Bun.spawn(["sleep", "0"]);
      await deadChild.exited;
      // A resumer crashed after its CAS: resume_started is durable, the
      // recorded pid is gone, and the lane sits running with no owner.
      await store.appendEvent(lane.id, { event: "resume_started", data: { pid: deadChild.pid } });

      const reclaimed = await store.beginResume(lane.id);
      expect(reclaimed.lane.status).toBe("running");
      expect(reclaimed.event.data.pid).toBe(process.pid);
    });

    test("rejects reclaim while the recorded resumer is alive", async () => {
      const lane = await store.createLane({ agent: "codex", cwd: "/tmp/project" });
      await store.transitionLane(lane.id, { from: ["queued"], to: "running" });
      await store.appendEvent(lane.id, { event: "resume_started", data: { pid: process.pid } });

      await expect(store.beginResume(lane.id)).rejects.toThrow(/still alive/);
    });

    test("rejects queued lanes and running lanes with no recorded resumer", async () => {
      const lane = await store.createLane({ agent: "codex", cwd: "/tmp/project" });
      await expect(store.beginResume(lane.id)).rejects.toBeInstanceOf(TransitionConflictError);

      await store.transitionLane(lane.id, { from: ["queued"], to: "running" });
      await expect(store.beginResume(lane.id)).rejects.toThrow(/no recorded resumer/);

      await expect(store.beginResume("lane_0badc0de")).rejects.toBeInstanceOf(LaneNotFoundError);
    });
  });

  describe("recordProcessIdentity (finding 15)", () => {
    const identity = { pid: 4242, pgid: 4242, startedAt: "2026-07-11T00:00:00.000Z" };

    test("persists identity and agent_started evidence on a live lane", async () => {
      const lane = await store.createLane({ agent: "codex", cwd: "/tmp/project" });
      await store.transitionLane(lane.id, { from: ["queued"], to: "running" });

      const result = await store.recordProcessIdentity(lane.id, identity);
      expect(result.laneKilled).toBe(false);
      expect(result.lane.process).toEqual(identity);
      expect(result.event?.event).toBe("agent_started");
      expect(result.event?.data).toEqual({ pid: 4242, pgid: 4242, startedAt: identity.startedAt });
      expect(result.lane.seq).toBe(result.event?.seq ?? -1);

      expect((await store.loadLane(lane.id))?.process).toEqual(identity);
    });

    test("persists identity on a still-queued lane (spawn beats the running CAS)", async () => {
      const lane = await store.createLane({ agent: "codex", cwd: "/tmp/project" });

      const result = await store.recordProcessIdentity(lane.id, {
        pid: 77,
        startedAt: identity.startedAt,
      });
      expect(result.laneKilled).toBe(false);
      expect((await store.loadLane(lane.id))?.process?.pid).toBe(77);
    });

    test("returns laneKilled on an already-killed lane without persisting anything", async () => {
      const lane = await store.createLane({ agent: "codex", cwd: "/tmp/project" });
      await store.transitionLaneWithEvent(
        lane.id,
        { from: ["queued"], to: "killed" },
        { event: "killed", data: { nativeStatus: "interrupted" } },
      );

      const result = await store.recordProcessIdentity(lane.id, identity);
      expect(result.laneKilled).toBe(true);
      expect(result.event).toBeUndefined();
      expect((await store.readEvents(lane.id)).at(-1)?.event).toBe("killed");
      expect((await store.loadLane(lane.id))?.process).toBeUndefined();
    });

    test("rejects malformed identity and unknown lanes", async () => {
      const lane = await store.createLane({ agent: "codex", cwd: "/tmp/project" });
      await expect(
        store.recordProcessIdentity(lane.id, { pid: 0, startedAt: identity.startedAt }),
      ).rejects.toThrow();
      await expect(store.recordProcessIdentity("lane_0badc0de", identity)).rejects.toBeInstanceOf(
        LaneNotFoundError,
      );
    });
  });

  describe("question/blocked crash replay (finding 19)", () => {
    const appendRawEvent = async (
      laneId: string,
      seq: number,
      kind: string,
      data: Record<string, unknown>,
    ) => {
      const event = { v: 1, seq, ts: new Date().toISOString(), laneId, event: kind, data };
      await fs.appendFile(store.getEventsPath(laneId), `${JSON.stringify(event)}\n`, "utf8");
    };

    test("a question fsynced before the status write replays as blocked and stays answerable", async () => {
      const lane = await store.createLane({ agent: "codex", cwd: "/tmp/project" });
      const running = await store.transitionLane(lane.id, { from: ["queued"], to: "running" });

      // Crash simulation: the question event is durable, lane.json is not.
      await appendRawEvent(lane.id, running.seq + 1, "question", { id: "q1", live: false });

      const recovered = await store.loadLane(lane.id);
      expect(recovered?.status).toBe("blocked");
      expect(recovered?.seq).toBe(running.seq + 1);

      // The replayed status is real: the lane accepts an answer, and the
      // healed status survives the seq-mirroring write.
      const submitted = await store.submitAnswer(lane.id, "recovered answer");
      expect(submitted.generation).toBe(1);
      expect((await store.loadLane(lane.id))?.status).toBe("blocked");
      expect(await store.readAnswer(lane.id)).toBe("recovered answer");
    });

    test("consumption evidence fsynced before the status write replays as running", async () => {
      const lane = await store.createLane({ agent: "codex", cwd: "/tmp/project" });
      await store.transitionLane(lane.id, { from: ["queued"], to: "blocked" });
      const submitted = await store.submitAnswer(lane.id, "A");

      await appendRawEvent(lane.id, submitted.event.seq + 1, "answered", {
        requestId: "q1",
        consumed: true,
        generation: 1,
      });

      const recovered = await store.loadLane(lane.id);
      expect(recovered?.status).toBe("running");
      expect(recovered?.seq).toBe(submitted.event.seq + 1);
    });

    test("resume_started fsynced before the status write replays as running", async () => {
      const lane = await store.createLane({ agent: "codex", cwd: "/tmp/project" });
      const blocked = await store.transitionLane(lane.id, { from: ["queued"], to: "blocked" });

      await appendRawEvent(lane.id, blocked.seq + 1, "resume_started", {});

      expect((await store.loadLane(lane.id))?.status).toBe("running");
    });

    test("an answer SUBMISSION event alone never changes the blocked status", async () => {
      const lane = await store.createLane({ agent: "codex", cwd: "/tmp/project" });
      const blocked = await store.transitionLane(lane.id, { from: ["queued"], to: "blocked" });

      // A durable submission (no consumed flag) with a seq ahead of lane.json.
      await appendRawEvent(lane.id, blocked.seq + 1, "answered", { text: "A", generation: 1 });

      expect((await store.loadLane(lane.id))?.status).toBe("blocked");
    });

    test("an already-consistent blocked lane is returned unchanged", async () => {
      const lane = await store.createLane({ agent: "codex", cwd: "/tmp/project" });
      await store.transitionLane(lane.id, { from: ["queued"], to: "running" });
      const { lane: blocked } = await store.transitionLaneWithEvent(
        lane.id,
        { from: ["running"], to: "blocked" },
        { event: "question", data: { id: "q1" } },
      );

      const loaded = await store.loadLane(lane.id);
      expect(loaded?.status).toBe("blocked");
      expect(loaded?.seq).toBe(blocked.seq);
    });
  });
});
