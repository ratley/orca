import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import type { Dirent, Stats } from "node:fs";

import {
  isTerminalLaneStatus,
  LaneEventSchema,
  LaneProcessInfoSchema,
  LaneRecordSchema,
} from "../types/lane.js";
import type {
  LaneEvent,
  LaneEventInput,
  LaneProcessInfo,
  LaneRecord,
  LaneStatus,
} from "../types/lane.js";
import { assertValidLaneId, isValidLaneId } from "./lane-id.js";

/** Resolves the orca home directory; ORCA_HOME overrides ~/.orca. */
export function resolveOrcaHome(): string {
  const override = process.env.ORCA_HOME;
  if (override !== undefined && override !== "") {
    return override;
  }

  return path.join(os.homedir(), ".orca");
}

export class LaneNotFoundError extends Error {
  readonly code = "lane_not_found";

  constructor(laneId: string) {
    super(`Lane not found: ${laneId}`);
    this.name = "LaneNotFoundError";
  }
}

/**
 * Thrown when a mutation finishes and its lane.lock no longer carries this
 * acquisition's owner token: the holder went stale (e.g. a suspended or
 * descheduled process) and a waiter legitimately took the lock over. The
 * resumed stale holder must treat its mutation as FAILED — a concurrent owner
 * may have interleaved writes — and it must never touch the lock file, which
 * now belongs to the new owner.
 */
export class LaneLockLostError extends Error {
  readonly code = "lane_lock_lost";

  constructor(lockPath: string) {
    super(
      `Lane lock lost: ${lockPath} no longer carries this process's owner token. ` +
        "The lock went stale and was taken over by another process; this mutation " +
        "is not trustworthy and the current lock holder's file was left untouched.",
    );
    this.name = "LaneLockLostError";
  }
}

/** A compare-and-swap status transition for LaneStore.transitionLane. */
export interface LaneTransition {
  /** Statuses the lane must currently be in for the transition to apply. */
  from: LaneStatus[];
  to: LaneStatus;
}

/**
 * Thrown by transitionLane when the lane's current status is not in the
 * transition's `from` list, or when the lane is already in a terminal status
 * (completed|failed|killed|lost) — terminal statuses are immutable. At
 * settlement this means someone else settled the lane first (e.g. kill); the
 * dispatch process must then emit the STORE's status, not its own.
 */
export class TransitionConflictError extends Error {
  readonly laneId: string;
  readonly expectedFrom: LaneStatus[];
  readonly to: LaneStatus;
  readonly actualStatus: LaneStatus;

  constructor(
    laneId: string,
    transition: LaneTransition,
    actualStatus: LaneStatus,
    detail?: string,
  ) {
    super(
      `Lane ${laneId} cannot transition to "${transition.to}": ` +
        `status is "${actualStatus}", expected one of [${transition.from.join(", ")}]` +
        (isTerminalLaneStatus(actualStatus) ? " (terminal statuses are immutable)" : "") +
        (detail === undefined ? "" : ` — ${detail}`),
    );
    this.name = "TransitionConflictError";
    this.laneId = laneId;
    this.expectedFrom = [...transition.from];
    this.to = transition.to;
    this.actualStatus = actualStatus;
  }
}

export interface CreateLaneInput {
  agent: string;
  cwd: string;
  model?: string;
  label?: string;
}

export interface ReadEventsOptions {
  /** Return only events with seq strictly greater than this value. */
  sinceSeq?: number;
}

/** Mutable lane metadata. Identity, status, timestamps, and seq are store-owned. */
export type LaneMetadataPatch = Partial<
  Pick<LaneRecord, "agentSessionId" | "process" | "model" | "label" | "usage" | "timing">
>;

/** Result of readAnswerWithGeneration: the pending answer and its generation. */
export interface AnswerWithGeneration {
  text: string;
  /** The lane's current answerGeneration, read under the same lane lease. */
  generation: number;
}

/** Result of submitAnswer: the persisted generation identifies this submission. */
export interface SubmitAnswerResult {
  lane: LaneRecord;
  event: LaneEvent;
  /** Store-assigned generation of this submission, persisted as lane.answerGeneration. */
  generation: number;
}

export interface ConsumeAnswerOptions {
  /**
   * The submission generation the adapter reports having consumed (echoed
   * from the `answered` submission event). answer.txt is deleted only when it
   * matches the lane's current answerGeneration, so a replacement answer
   * submitted after the adapter read the previous one survives. Omitting the
   * generation preserves the legacy unconditional delete.
   */
  generation?: number;
}

export interface ConsumeAnswerResult {
  lane: LaneRecord;
  event: LaneEvent;
  /** False when a generation mismatch preserved a newer pending answer. */
  answerDeleted: boolean;
}

export interface BeginResumeResult {
  lane: LaneRecord;
  event: LaneEvent;
}

export interface RecordProcessIdentityResult {
  lane: LaneRecord;
  /**
   * True when the lane had already settled terminally (killed, or any other
   * terminal status) before the identity arrived: nothing was persisted and
   * the caller MUST terminate the process it just spawned.
   */
  laneKilled: boolean;
  /** The agent_started evidence event, present iff identity was persisted. */
  event?: LaneEvent;
}

export interface LaneStoreOptions {
  /**
   * Milliseconds without an mtime refresh after which another process may
   * take over a lane.lock file (crashed-holder recovery). Default 10s.
   */
  lockStaleMs?: number;
  /** Max total time to wait for a lane.lock acquisition. Default 30s. */
  lockTimeoutMs?: number;
}

const DEFAULT_LOCK_STALE_MS = 10_000;
const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
const LOCK_RETRY_MIN_MS = 5;
const LOCK_RETRY_MAX_MS = 50;
const SEQ_TAIL_WINDOW_BYTES = 64 * 1024;
const TERMINAL_EVENT_KINDS = new Set(["result", "failed", "killed"]);

/**
 * Filesystem lane store over <orcaHome>/lanes/<laneId>/:
 * lane.json (atomic temp+rename writes), events.ndjson (append-only,
 * fsync-safe, monotonic seq), answer.txt, artifacts/, lane.lock.
 *
 * Writes are serialized on two levels: an in-process mutex per lane (fast
 * path) plus an interprocess lane.lock file (O_EXCL create with the holder's
 * pid and a random per-acquisition owner token; the holder refreshes the
 * lock's mtime while held, and waiters take over a lock whose mtime has gone
 * stale — crashed-holder recovery). A stale holder that resumes after a
 * takeover finds a foreign token, leaves the new owner's lock untouched, and
 * fails its mutation with LaneLockLostError (see makeLockRelease, including
 * the honestly-documented residual verify-then-act TOCTOU).
 */
export class LaneStore {
  private readonly lanesDir: string;
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly lockStaleMs: number;
  private readonly lockTimeoutMs: number;

  constructor(orcaHome = resolveOrcaHome(), options: LaneStoreOptions = {}) {
    this.lanesDir = path.join(orcaHome, "lanes");
    this.lockStaleMs = options.lockStaleMs ?? DEFAULT_LOCK_STALE_MS;
    this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  }

  async createLane(input: CreateLaneInput): Promise<LaneRecord> {
    const now = new Date().toISOString();
    const lane = LaneRecordSchema.parse({
      id: generateLaneId(),
      agent: input.agent,
      cwd: input.cwd,
      model: input.model,
      label: input.label,
      status: "queued",
      createdAt: now,
      updatedAt: now,
      seq: 0,
    });

    await fs.mkdir(this.getArtifactsDir(lane.id), { recursive: true });
    await this.writeJsonAtomic(this.getLanePath(lane.id), lane);

    await this.appendEvent(lane.id, {
      event: "created",
      data: { agent: lane.agent, cwd: lane.cwd },
    });

    const created = await this.loadLane(lane.id);
    if (!created) {
      throw new LaneNotFoundError(lane.id);
    }

    return created;
  }

  async loadLane(laneId: string): Promise<LaneRecord | null> {
    if (!isValidLaneId(laneId)) {
      return null;
    }

    const lane = await this.loadLaneRaw(laneId);
    if (lane === null || isTerminalLaneStatus(lane.status)) {
      return lane;
    }

    // If a process crashed after fsyncing a status-bearing event but before
    // the lane.json rename, replay the status implied by the durable log:
    // terminal evidence (result|failed|killed), question -> blocked,
    // adapter-confirmed answer consumption -> running, resume_started ->
    // running. Answer SUBMISSION events carry no status change. Reads must
    // not take the lane lock, so the lenient (non-repairing) parse is used.
    const { events } = await this.readEventsLenient(laneId, {});
    const replay = findLastStatusBearingEvent(events);
    if (replay === undefined) {
      return lane;
    }

    const recovered = {
      ...lane,
      status: replay.status,
      seq: Math.max(lane.seq, replay.event.seq),
      updatedAt: replay.event.ts > lane.updatedAt ? replay.event.ts : lane.updatedAt,
    };

    // Terminal evidence always wins. A non-terminal replay is adopted only
    // when lane.json demonstrably lags the event (mirror seq is behind);
    // otherwise the stored status already reflects or supersedes the event.
    if (isTerminalLaneStatus(replay.status)) {
      return LaneRecordSchema.parse(recovered);
    }
    if (replay.event.seq <= lane.seq || replay.status === lane.status) {
      return lane;
    }
    return LaneRecordSchema.parse(recovered);
  }

  private async loadLaneRaw(laneId: string): Promise<LaneRecord | null> {
    try {
      const raw = await fs.readFile(this.getLanePath(laneId), "utf8");
      return LaneRecordSchema.parse(JSON.parse(raw));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }

      throw error;
    }
  }

  async updateLane(laneId: string, patch: LaneMetadataPatch): Promise<LaneRecord> {
    this.refuseUnknownLaneId(laneId);
    assertMetadataPatch(patch);
    return this.withLaneLocks(laneId, () => this.updateLaneUnlocked(laneId, patch));
  }

  /**
   * Compare-and-swap status transition: applies `to` only when the lane's
   * current status is in `from`, atomically under the per-lane lockfile.
   * Throws TransitionConflictError otherwise. Terminal statuses
   * (completed|failed|killed|lost) are immutable: no transition FROM them
   * ever succeeds, even when listed in `from`.
   */
  async transitionLane(laneId: string, transition: LaneTransition): Promise<LaneRecord> {
    this.refuseUnknownLaneId(laneId);
    return this.withLaneLocks(laneId, async () => {
      const lane = await this.loadLane(laneId);
      if (!lane) {
        throw new LaneNotFoundError(laneId);
      }

      if (isTerminalLaneStatus(lane.status) || !transition.from.includes(lane.status)) {
        throw new TransitionConflictError(laneId, transition, lane.status);
      }

      return this.updateLaneUnlocked(laneId, { status: transition.to }, lane);
    });
  }

  /**
   * Performs a CAS status transition and appends its evidence event under one
   * interprocess lock. The event is written before lane.json, so lock-free
   * readers never observe a terminal status without its evidence.
   *
   * When a factory is supplied it runs while the lane lock is held. It must
   * not call back into this LaneStore; `orca kill` uses this narrow seam to
   * keep settlement blocked while it terminates and verifies a process group.
   */
  async transitionLaneWithEvent(
    laneId: string,
    transition: LaneTransition,
    input: LaneEventInput | ((lane: LaneRecord) => LaneEventInput | Promise<LaneEventInput>),
  ): Promise<{ lane: LaneRecord; event: LaneEvent }> {
    this.refuseUnknownLaneId(laneId);
    return this.withLaneLocks(laneId, async () => {
      const current = await this.loadLane(laneId);
      if (!current) {
        throw new LaneNotFoundError(laneId);
      }

      if (isTerminalLaneStatus(current.status) || !transition.from.includes(current.status)) {
        throw new TransitionConflictError(laneId, transition, current.status);
      }

      const eventInput = typeof input === "function" ? await input(current) : input;
      assertTransitionEvent(transition.to, eventInput);
      const event = await this.appendEventUnlocked(laneId, current, eventInput);
      const lane = await this.updateLaneUnlocked(
        laneId,
        { status: transition.to, seq: event.seq },
        current,
      );
      return { lane, event };
    });
  }

  /**
   * Appends one event line to events.ndjson with an fsync before rename-free
   * append completion, assigns the next monotonic seq, and mirrors the seq
   * onto lane.json. Appends to the same lane are serialized in-process and,
   * via lane.lock, across processes.
   */
  async appendEvent(laneId: string, input: LaneEventInput): Promise<LaneEvent> {
    this.refuseUnknownLaneId(laneId);
    if (TERMINAL_EVENT_KINDS.has(input.event)) {
      throw new TypeError(
        `Terminal event "${input.event}" must be committed with transitionLaneWithEvent`,
      );
    }
    return this.withLaneLocks(laneId, async () => {
      const lane = await this.loadLane(laneId);
      if (!lane) {
        throw new LaneNotFoundError(laneId);
      }
      if (isTerminalLaneStatus(lane.status)) {
        throw new TransitionConflictError(
          laneId,
          { from: ["queued", "running", "blocked"], to: lane.status },
          lane.status,
        );
      }

      const event = await this.appendEventUnlocked(laneId, lane, input);
      await this.updateLaneUnlocked(laneId, { seq: event.seq }, lane);

      return event;
    });
  }

  /**
   * Submits an answer only while the lane is blocked. The answer file and
   * submission evidence are written under one lane lease, closing the
   * status-check/write race with kill and settlement. Each submission gets a
   * monotonic generation (persisted as lane.answerGeneration and stamped into
   * the submission event) which adapters echo on consumption so
   * consumeAnswerWithEvent can compare-and-delete exactly that submission.
   */
  async submitAnswer(laneId: string, text: string): Promise<SubmitAnswerResult> {
    this.refuseUnknownLaneId(laneId);
    return this.withLaneLocks(laneId, async () => {
      const current = await this.loadLane(laneId);
      if (!current) {
        throw new LaneNotFoundError(laneId);
      }
      if (current.status !== "blocked") {
        throw new TransitionConflictError(
          laneId,
          { from: ["blocked"], to: "blocked" },
          current.status,
        );
      }

      // Generation ordering invariant: lane.answerGeneration is bumped
      // BEFORE the answer file lands, so the persisted generation is always
      // >= the generation of the file's content. A crash between the bump
      // and the file write can only make a stale-generation consumption
      // MISS the compare (answer survives for redelivery), never delete a
      // newer answer.
      const generation = (current.answerGeneration ?? 0) + 1;
      const bumped = await this.updateLaneUnlocked(
        laneId,
        { answerGeneration: generation },
        current,
      );
      // The answer lands before its evidence: a crash may leave an answer
      // available for consumption, but never evidence for a missing answer.
      await this.writeFileAtomic(this.getAnswerPath(laneId), text);
      const event = await this.appendEventUnlocked(laneId, bumped, {
        event: "answered",
        data: { text, generation },
      });
      const lane = await this.updateLaneUnlocked(laneId, { seq: event.seq }, bumped);
      return { lane, event, generation };
    });
  }

  /**
   * Records adapter-confirmed answer consumption, clears answer.txt, and
   * returns the lane to running under one lane lease. When the caller
   * supplies the consumed generation, answer.txt is deleted only if that
   * generation is still the lane's current one — a replacement answer
   * submitted after the adapter read the previous one survives. The event is
   * stamped data.consumed:true so crash replay can distinguish consumption
   * (running) from submission (no status change).
   */
  async consumeAnswerWithEvent(
    laneId: string,
    input: LaneEventInput,
    options: ConsumeAnswerOptions = {},
  ): Promise<ConsumeAnswerResult> {
    this.refuseUnknownLaneId(laneId);
    if (input.event !== "answered") {
      throw new TypeError('consumeAnswerWithEvent requires event:"answered"');
    }

    return this.withLaneLocks(laneId, async () => {
      const current = await this.loadLane(laneId);
      if (!current) {
        throw new LaneNotFoundError(laneId);
      }
      const transition: LaneTransition = {
        from: ["blocked", "running"],
        to: "running",
      };
      if (isTerminalLaneStatus(current.status) || !transition.from.includes(current.status)) {
        throw new TransitionConflictError(laneId, transition, current.status);
      }

      const answerDeleted =
        options.generation === undefined || options.generation === (current.answerGeneration ?? 0);

      // Consumption evidence precedes deletion, so a crash cannot erase the
      // answer without first recording why it disappeared.
      const event = await this.appendEventUnlocked(laneId, current, {
        event: input.event,
        data: {
          ...input.data,
          consumed: true,
          ...(options.generation === undefined ? {} : { generation: options.generation }),
        },
      });
      if (answerDeleted) {
        await fs.rm(this.getAnswerPath(laneId), { force: true });
      }
      const lane = await this.updateLaneUnlocked(
        laneId,
        { status: "running", seq: event.seq },
        current,
      );
      return { lane, event, answerDeleted };
    });
  }

  /**
   * Locked CAS entry point for `orca resume` (finding 14). Resumable states:
   *
   * - `blocked` with a parked (non-live) latest question: the normal case.
   * - `blocked` with a LIVE latest question, but only when the lane has no
   *   recorded process or its recorded pid is dead — the dispatch that was
   *   polling answer.txt is provably gone, so a resume cannot double-drive
   *   the agent. A live question with a living recorded process still
   *   rejects: the original dispatch is attached and polling.
   * - `completed`: the EXPLICIT documented carve-out from terminal
   *   immutability. A resume is a user-initiated new turn on a finished
   *   lane, not a conflicting settlement of the finished one; `failed`,
   *   `killed`, and `lost` stay non-resumable.
   * - `running` whose latest resume_started event records a resumer pid that
   *   is now dead: the resuming process crashed after the CAS but before
   *   settling, leaving the lane ownerless; a later resume may reclaim it.
   *   A running lane with a living (or unrecorded) owner still rejects.
   *
   * Transitions to running and appends resume_started evidence — stamped
   * with the resuming process's pid for the reclaim rule above — under one
   * lane lease; throws TransitionConflictError otherwise.
   */
  async beginResume(laneId: string): Promise<BeginResumeResult> {
    this.refuseUnknownLaneId(laneId);
    return this.withLaneLocks(laneId, async () => {
      const current = await this.loadLane(laneId);
      if (!current) {
        throw new LaneNotFoundError(laneId);
      }
      const transition: LaneTransition = {
        from: ["blocked", "completed", "running"],
        to: "running",
      };
      const { events } = await this.readEventsLenient(laneId, {});

      if (current.status === "blocked") {
        const latestQuestion = findLatestEventOfKind(events, "question");
        if (latestQuestion?.data.live === true) {
          const pollerPid = current.process?.pid;
          if (pollerPid !== undefined && isPidAlive(pollerPid)) {
            throw new TransitionConflictError(
              laneId,
              transition,
              current.status,
              "the latest question is live and the recorded lane process " +
                `(pid ${pollerPid}) is alive: the original dispatch is still polling for the answer`,
            );
          }
          // Live question but the poller is provably gone: resume is the only
          // way out of an otherwise-permanent lockout.
        }
      } else if (current.status === "running") {
        const latestResume = findLatestEventOfKind(events, "resume_started");
        const resumerPid =
          typeof latestResume?.data.pid === "number" ? latestResume.data.pid : undefined;
        if (resumerPid === undefined || isPidAlive(resumerPid)) {
          throw new TransitionConflictError(
            laneId,
            transition,
            current.status,
            resumerPid === undefined
              ? "the lane is running with no recorded resumer pid to reclaim from"
              : `the resuming process (pid ${resumerPid}) is still alive`,
          );
        }
        // The recorded resumer crashed into an ownerless running lane; reclaim.
      } else if (current.status !== "completed") {
        // queued, failed, killed, lost. completed falls through: the
        // documented completed->running resume carve-out.
        throw new TransitionConflictError(laneId, transition, current.status);
      }

      const event = await this.appendEventUnlocked(laneId, current, {
        event: "resume_started",
        data: { pid: process.pid },
      });
      const lane = await this.updateLaneUnlocked(
        laneId,
        { status: "running", seq: event.seq },
        current,
      );
      return { lane, event };
    });
  }

  /**
   * Persists spawn-time process identity immediately (finding 15): on a LIVE
   * lane (queued|running|blocked) it records lane.process and appends
   * agent_started evidence under one lane lease. On a lane that has already
   * settled terminally it persists nothing and returns laneKilled:true — the
   * caller must terminate the process it just spawned (kill-before-spawn).
   */
  async recordProcessIdentity(
    laneId: string,
    identity: LaneProcessInfo,
  ): Promise<RecordProcessIdentityResult> {
    this.refuseUnknownLaneId(laneId);
    const info = LaneProcessInfoSchema.parse(identity);
    return this.withLaneLocks(laneId, async () => {
      const current = await this.loadLane(laneId);
      if (!current) {
        throw new LaneNotFoundError(laneId);
      }
      if (isTerminalLaneStatus(current.status)) {
        return { lane: current, laneKilled: true };
      }

      // Evidence precedes state, matching the store's other write chains.
      const event = await this.appendEventUnlocked(laneId, current, {
        event: "agent_started",
        data: {
          pid: info.pid,
          ...(info.pgid === undefined ? {} : { pgid: info.pgid }),
          startedAt: info.startedAt,
        },
      });
      const lane = await this.updateLaneUnlocked(
        laneId,
        { process: info, seq: event.seq },
        current,
      );
      return { lane, laneKilled: false, event };
    });
  }

  /**
   * Reads events, repairing a crash-torn final fragment under the lane lock
   * when one is found: a complete valid event missing only its trailing
   * newline gets the delimiter appended; a corrupt partial fragment is
   * truncated back to the last complete line; either repair is fsynced.
   * Malformed COMPLETE records (newline-terminated lines that do not parse)
   * still fail loud — only the unterminated tail is a known crash artifact.
   */
  async readEvents(laneId: string, options: ReadEventsOptions = {}): Promise<LaneEvent[]> {
    if (!isValidLaneId(laneId)) {
      return [];
    }

    const first = await this.readEventsLenient(laneId, options);
    if (first.tail === "clean") {
      return first.events;
    }

    await this.withLaneLocks(laneId, () => this.repairEventsTail(laneId));
    return (await this.readEventsLenient(laneId, options)).events;
  }

  /**
   * Parses events without taking the lane lock and without repairing the
   * file. A final unterminated fragment that parses as a complete event is
   * durable data and is included ("unterminated" tail); a fragment that does
   * not parse is excluded ("corrupt" tail). Used internally wherever taking
   * the lane lock would deadlock (loadLane inside locked operations); the
   * public readEvents and every locked append repair the tail for real.
   */
  private async readEventsLenient(
    laneId: string,
    options: ReadEventsOptions,
  ): Promise<{ events: LaneEvent[]; tail: "clean" | "unterminated" | "corrupt" }> {
    const sinceSeq = options.sinceSeq ?? 0;

    let raw: string;
    try {
      raw = await fs.readFile(this.getEventsPath(laneId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { events: [], tail: "clean" };
      }

      throw error;
    }

    const endsWithNewline = raw.endsWith("\n");
    const lines = raw.split("\n");
    const events: LaneEvent[] = [];
    let tail: "clean" | "unterminated" | "corrupt" = "clean";
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line === undefined || line.trim() === "") {
        continue;
      }

      const isFinalFragment = !endsWithNewline && index === lines.length - 1;
      let event: LaneEvent;
      try {
        event = LaneEventSchema.parse(JSON.parse(line));
      } catch (error) {
        if (isFinalFragment) {
          // A crash mid-append tore the final write; no proper prefix of a
          // JSON document parses, so an unparseable fragment is incomplete.
          tail = "corrupt";
          break;
        }
        throw error;
      }

      if (isFinalFragment) {
        tail = "unterminated";
      }
      if (event.seq > sinceSeq) {
        events.push(event);
      }
    }

    return { events, tail };
  }

  /**
   * Repairs a crash-torn events.ndjson tail; the caller holds the lane lock.
   * A complete valid unterminated event gets its "\n" delimiter (preserving
   * durable data); anything else after the last newline is truncated away.
   * The repair is fsynced before any sequence derivation or append.
   */
  private async repairEventsTail(laneId: string): Promise<void> {
    const eventsPath = this.getEventsPath(laneId);

    let raw: Buffer;
    try {
      raw = await fs.readFile(eventsPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }

      throw error;
    }

    if (raw.length === 0 || raw[raw.length - 1] === 0x0a) {
      return;
    }

    const lastNewline = raw.lastIndexOf(0x0a);
    const fragment = raw.subarray(lastNewline + 1).toString("utf8");
    let fragmentIsCompleteEvent = false;
    try {
      LaneEventSchema.parse(JSON.parse(fragment));
      fragmentIsCompleteEvent = true;
    } catch {
      // Incomplete fragment; truncate below.
    }

    if (fragmentIsCompleteEvent) {
      await this.appendLineDurable(eventsPath, "\n");
      return;
    }

    const handle = await fs.open(eventsPath, "r+");
    try {
      await handle.truncate(lastNewline + 1);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async listLanes(): Promise<LaneRecord[]> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(this.lanesDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }

      throw error;
    }

    const lanes: LaneRecord[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const lane = await this.loadLane(entry.name);
      if (lane) {
        lanes.push(lane);
      }
    }

    lanes.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return lanes;
  }

  async readAnswer(laneId: string): Promise<string | null> {
    if (!isValidLaneId(laneId)) {
      return null;
    }

    try {
      return await fs.readFile(this.getAnswerPath(laneId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }

      throw error;
    }
  }

  /**
   * Reads the pending answer AND the lane's current answerGeneration under
   * one lane lease (finding 13's residual): submitAnswer bumps the
   * generation before the answer file lands, so reading both under the same
   * lock is the only way an adapter can echo a generation that provably
   * belongs to the text it read. Adapters should prefer this over the
   * lock-free readAnswer + loadLane pair.
   *
   * Also finishes crash-interrupted consumption (finding 19's residual):
   * when the latest consumed:true answered event carries a generation equal
   * to the lane's persisted answerGeneration, the answer file is a leftover
   * from a crash between consumption evidence and deletion — it is deleted
   * here (under the lock) instead of being resurrected and redelivered.
   *
   * Returns null when the lane does not exist or holds no pending answer.
   */
  async readAnswerWithGeneration(laneId: string): Promise<AnswerWithGeneration | null> {
    if (!isValidLaneId(laneId)) {
      return null;
    }

    try {
      return await this.withLaneLocks(laneId, async () => {
        const lane = await this.loadLane(laneId);
        if (!lane) {
          return null;
        }

        let text: string;
        try {
          text = await fs.readFile(this.getAnswerPath(laneId), "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return null;
          }
          throw error;
        }

        const generation = lane.answerGeneration ?? 0;
        const { events } = await this.readEventsLenient(laneId, {});
        const latestConsumption = findLatestConsumptionEvent(events);
        if (
          latestConsumption !== undefined &&
          typeof latestConsumption.data.generation === "number" &&
          latestConsumption.data.generation === generation
        ) {
          // Durable evidence says this exact generation was already consumed;
          // the file only survived because the deleter crashed first.
          await fs.rm(this.getAnswerPath(laneId), { force: true });
          return null;
        }

        return { text, generation };
      });
    } catch (error) {
      if (error instanceof LaneNotFoundError) {
        return null;
      }
      throw error;
    }
  }

  getLaneDir(laneId: string): string {
    assertValidLaneId(laneId);
    return path.join(this.lanesDir, laneId);
  }

  getLanePath(laneId: string): string {
    return path.join(this.getLaneDir(laneId), "lane.json");
  }

  getEventsPath(laneId: string): string {
    return path.join(this.getLaneDir(laneId), "events.ndjson");
  }

  getAnswerPath(laneId: string): string {
    return path.join(this.getLaneDir(laneId), "answer.txt");
  }

  getArtifactsDir(laneId: string): string {
    return path.join(this.getLaneDir(laneId), "artifacts");
  }

  /**
   * Merges a patch onto the lane record and writes it atomically; the caller
   * holds the lane lock. Locked mutators pass their already-loaded (crash-
   * replayed) record as `base` so a status recovered by loadLane's event
   * replay is durably healed into lane.json by the next write instead of
   * being clobbered with the stale raw status.
   */
  private async updateLaneUnlocked(
    laneId: string,
    patch: Partial<Omit<LaneRecord, "id">>,
    base?: LaneRecord,
  ): Promise<LaneRecord> {
    const existing = base ?? (await this.loadLaneRaw(laneId));
    if (!existing) {
      throw new LaneNotFoundError(laneId);
    }

    const next = LaneRecordSchema.parse({
      ...existing,
      ...patch,
      id: existing.id,
      updatedAt: new Date().toISOString(),
    });

    await this.writeJsonAtomic(this.getLanePath(laneId), next);
    return next;
  }

  /** Appends one validated event without mirroring lane.json; caller holds the lane lock. */
  private async appendEventUnlocked(
    laneId: string,
    lane: LaneRecord,
    input: LaneEventInput,
  ): Promise<LaneEvent> {
    // A crash-torn tail must be repaired (and the repair fsynced) BEFORE the
    // sequence is derived and the new line lands; appending onto a torn
    // fragment would permanently corrupt an otherwise-recoverable log.
    await this.repairEventsTail(laneId);
    const event = LaneEventSchema.parse({
      v: 1,
      seq: (await this.lastSeq(laneId, lane)) + 1,
      ts: new Date().toISOString(),
      laneId,
      event: input.event,
      data: input.data ?? {},
    });
    await this.appendLineDurable(this.getEventsPath(laneId), `${JSON.stringify(event)}\n`);
    return event;
  }

  /**
   * The highest seq issued so far, derived from the events file itself
   * (authoritative under the interprocess lock; lane.json may lag if a
   * writer crashed between the append and the mirror) with lane.json as a
   * monotonicity backstop.
   */
  private async lastSeq(laneId: string, lane: LaneRecord): Promise<number> {
    const tailSeq = await this.readLastSeqFromEvents(laneId);
    return Math.max(tailSeq, lane.seq);
  }

  /**
   * Reads the seq of the last complete event line via a bounded tail read,
   * falling back to a full scan when the tail window holds no parseable line.
   */
  private async readLastSeqFromEvents(laneId: string): Promise<number> {
    const eventsPath = this.getEventsPath(laneId);

    let handle;
    try {
      handle = await fs.open(eventsPath, "r");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return 0;
      }

      throw error;
    }

    try {
      const { size } = await handle.stat();
      if (size === 0) {
        return 0;
      }

      const window = Math.min(size, SEQ_TAIL_WINDOW_BYTES);
      const buffer = Buffer.alloc(window);
      await handle.read(buffer, 0, window, size - window);

      // Scan backward: the window's first line may be a partial one when the
      // window does not cover the whole file, so take the LAST parseable line.
      const lines = buffer.toString("utf8").split("\n");
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index]?.trim();
        if (line === undefined || line === "") {
          continue;
        }

        try {
          return LaneEventSchema.parse(JSON.parse(line)).seq;
        } catch {
          continue;
        }
      }
    } finally {
      await handle.close();
    }

    const { events } = await this.readEventsLenient(laneId, {});
    const lastEvent = events[events.length - 1];
    return lastEvent === undefined ? 0 : lastEvent.seq;
  }

  /** Invalid ids can never name an existing lane; refuse them defensively. */
  private refuseUnknownLaneId(laneId: string): void {
    if (!isValidLaneId(laneId)) {
      throw new LaneNotFoundError(laneId);
    }
  }

  /**
   * Serializes a write against a lane on both levels: the in-process mutex
   * (fast path) and the interprocess lane.lock file.
   *
   * Ownership is verified at release: when the lock file no longer carries
   * this acquisition's owner token (a waiter took over the stale lock while
   * this process was suspended), the mutation FAILS with LaneLockLostError
   * instead of reporting success, and the new owner's lock file is left
   * untouched. When the task itself failed, its own error wins and a lost
   * lock is swallowed.
   */
  private withLaneLocks<T>(laneId: string, task: () => Promise<T>): Promise<T> {
    return this.withLaneLock(laneId, async () => {
      const release = await this.acquireLockFile(laneId);
      let result: T;
      try {
        result = await task();
      } catch (error) {
        await release().catch(() => undefined);
        throw error;
      }
      await release();
      return result;
    });
  }

  private withLaneLock<T>(laneId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(laneId) ?? Promise.resolve();
    const run = previous.then(() => task());

    this.locks.set(
      laneId,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );

    return run;
  }

  private getLockPath(laneId: string): string {
    return path.join(this.getLaneDir(laneId), "lane.lock");
  }

  /**
   * Acquires <laneDir>/lane.lock via O_EXCL create (retrying with backoff),
   * writes the holder pid plus a random per-acquisition owner token, and
   * keeps the lock's mtime fresh while held. A lock whose mtime has not been
   * refreshed within lockStaleMs is presumed abandoned by a crashed process
   * and is taken over. The token lets a resumed stale holder detect the
   * takeover: refresh and release both re-read the file first and never
   * touch a lock carrying a foreign token (see makeLockRelease).
   */
  private async acquireLockFile(laneId: string): Promise<() => Promise<void>> {
    const lockPath = this.getLockPath(laneId);
    const deadline = Date.now() + this.lockTimeoutMs;
    let delayMs = LOCK_RETRY_MIN_MS;

    for (;;) {
      try {
        const handle = await fs.open(lockPath, "wx");
        const token = crypto.randomBytes(16).toString("hex");
        try {
          await handle.writeFile(`${process.pid}\n${token}\n`, "utf8");
        } finally {
          await handle.close();
        }

        return this.makeLockRelease(lockPath, token);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          // The lane directory itself is gone.
          throw new LaneNotFoundError(laneId);
        }
        if (code !== "EEXIST") {
          throw error;
        }
      }

      if (await this.tryTakeOverStaleLock(laneId)) {
        continue;
      }

      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out after ${this.lockTimeoutMs}ms waiting for lane lock: ${lockPath}`,
        );
      }

      await sleep(delayMs + Math.floor(Math.random() * delayMs));
      delayMs = Math.min(delayMs * 2, LOCK_RETRY_MAX_MS);
    }
  }

  /**
   * Returns the release function for a held lane.lock, and starts the mtime
   * refresher that keeps the lock from going stale while held.
   *
   * Both the refresher and the release first re-read the lock file and
   * verify it still carries this acquisition's owner token. Finding a
   * foreign token (or no file) means the lock went stale and was taken over:
   * the refresher stops without touching the file, and release throws
   * LaneLockLostError instead of unlinking the new owner's lock.
   *
   * Honest residual TOCTOU: verify-then-act is two syscalls, so a takeover
   * that lands BETWEEN this process's token re-read and its utimes/unlink
   * can still be touched by the old holder. That window is a few
   * microseconds AND requires the lock to have already gone stale
   * (lockStaleMs without a refresh) at that exact moment; closing it fully
   * needs OS advisory locking (flock/O_TMPFILE tricks), which v0 forgoes.
   */
  private makeLockRelease(lockPath: string, token: string): () => Promise<void> {
    const ownsLock = async (): Promise<boolean> => {
      try {
        const raw = await fs.readFile(lockPath, "utf8");
        return raw.split("\n")[1] === token;
      } catch {
        // Missing or unreadable: this process no longer owns the pathname.
        return false;
      }
    };

    let released = false;
    let lost = false;
    const refreshEveryMs = Math.max(50, Math.floor(this.lockStaleMs / 5));
    const refresher = setInterval(() => {
      void (async () => {
        if (released || lost) {
          return;
        }
        if (!(await ownsLock())) {
          lost = true;
          clearInterval(refresher);
          return;
        }
        const now = new Date();
        await fs.utimes(lockPath, now, now).catch(() => undefined);
      })();
    }, refreshEveryMs);
    refresher.unref();

    return async () => {
      if (released) {
        return;
      }

      released = true;
      clearInterval(refresher);
      if (lost || !(await ownsLock())) {
        throw new LaneLockLostError(lockPath);
      }
      await fs.rm(lockPath, { force: true }).catch(() => undefined);
    };
  }

  private getLockRecoveryPath(laneId: string): string {
    return `${this.getLockPath(laneId)}.recovery`;
  }

  /**
   * Attempts crashed-holder recovery of a stale lane.lock. Returns true when
   * the waiter should immediately retry acquisition (the lock disappeared or
   * this waiter removed it), false when it should keep backing off.
   *
   * All stale takeovers are serialized through a separate O_EXCL recovery
   * gate file (lane.lock.recovery): only the single gate holder may re-verify
   * and unlink the shared lane.lock pathname, so two waiters can never both
   * observe the same stale lock and have the slower unlink remove a fresh
   * replacement created behind the faster one's takeover (finding 11).
   *
   * Gate crash semantics: the gate critical section is only stat+unlink of
   * lane.lock — it never spans user work, lock waits, or holder-refresh
   * intervals — so a healthy recoverer holds the gate for milliseconds. A
   * gate is therefore presumed abandoned by a crashed recoverer, and may be
   * cleared by a waiter, only when ALL of the following hold: its mtime is
   * older than lockStaleMs, the pid recorded inside it is no longer alive,
   * and a re-stat confirms the same inode+mtime immediately before removal.
   * Clearing an abandoned gate never grants the gate; the waiter loops back
   * through O_EXCL acquisition so takeover stays serialized.
   *
   * Honest residual stat/unlink TOCTOU: the gate serializes RECOVERERS, not
   * the original holder. Between the gate holder's re-stat (still stale) and
   * its unlink, a suspended original holder could wake, refresh the mtime,
   * and proceed — the unlink then removes a just-refreshed lock and a waiter
   * can acquire alongside the woken holder. The per-acquisition owner token
   * (see makeLockRelease) turns that overlap from silent corruption into a
   * loud LaneLockLostError for the woken holder at refresh/release time, but
   * the microsecond window itself cannot be closed without OS advisory
   * locking (e.g. flock), which v0 deliberately forgoes.
   */
  private async tryTakeOverStaleLock(laneId: string): Promise<boolean> {
    const lockPath = this.getLockPath(laneId);

    let observed: Stats;
    try {
      observed = await fs.stat(lockPath);
    } catch (error) {
      // Holder released between our create attempt and this stat.
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    }

    if (Date.now() - observed.mtimeMs <= this.lockStaleMs) {
      return false;
    }

    const releaseGate = await this.tryAcquireRecoveryGate(laneId);
    if (releaseGate === null) {
      // Another process is recovering (or an abandoned gate was just
      // cleared); back off and let the acquisition loop retry.
      return false;
    }

    try {
      let current: Stats;
      try {
        current = await fs.stat(lockPath);
      } catch {
        // The lock vanished while we acquired the gate.
        return true;
      }

      if (
        current.ino !== observed.ino ||
        current.mtimeMs !== observed.mtimeMs ||
        Date.now() - current.mtimeMs <= this.lockStaleMs
      ) {
        // Replaced by a new holder or refreshed; not ours to remove.
        return true;
      }

      await fs.rm(lockPath, { force: true });
      return true;
    } finally {
      await releaseGate();
    }
  }

  /**
   * O_EXCL-acquires lane.lock.recovery, returning a release function, or
   * null when the gate is held elsewhere. An abandoned gate (stale mtime AND
   * dead recorded pid AND unchanged identity on re-stat) is cleared, but the
   * clearer still returns null and re-contends through O_EXCL.
   */
  private async tryAcquireRecoveryGate(laneId: string): Promise<(() => Promise<void>) | null> {
    const gatePath = this.getLockRecoveryPath(laneId);

    try {
      const handle = await fs.open(gatePath, "wx");
      try {
        await handle.writeFile(`${process.pid}\n`, "utf8");
      } finally {
        await handle.close();
      }

      return async () => {
        await fs.rm(gatePath, { force: true }).catch(() => undefined);
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        // The lane directory itself is gone.
        throw new LaneNotFoundError(laneId);
      }
      if (code !== "EEXIST") {
        throw error;
      }
    }

    await this.clearAbandonedRecoveryGate(gatePath);
    return null;
  }

  /** Best-effort removal of a gate abandoned by a crashed recoverer. */
  private async clearAbandonedRecoveryGate(gatePath: string): Promise<void> {
    try {
      const gate = await fs.stat(gatePath);
      if (Date.now() - gate.mtimeMs <= this.lockStaleMs) {
        return;
      }

      const holderPid = Number.parseInt((await fs.readFile(gatePath, "utf8")).trim(), 10);
      if (Number.isInteger(holderPid) && holderPid > 0 && isPidAlive(holderPid)) {
        // The recorded holder still exists (e.g. suspended); never remove a
        // living process's gate — acquisition will time out honestly instead.
        return;
      }

      const again = await fs.stat(gatePath);
      if (again.ino !== gate.ino || again.mtimeMs !== gate.mtimeMs) {
        return;
      }

      await fs.rm(gatePath, { force: true });
    } catch {
      // The gate vanished or was replaced mid-check; nothing to clear.
    }
  }

  private async appendLineDurable(filePath: string, line: string): Promise<void> {
    const handle = await fs.open(filePath, "a");
    try {
      await handle.writeFile(line, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
    await this.writeFileAtomic(filePath, `${JSON.stringify(data, null, 2)}\n`);
  }

  private async writeFileAtomic(filePath: string, payload: string): Promise<void> {
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;

    await fs.writeFile(tmpPath, payload, "utf8");
    await fs.rename(tmpPath, filePath);
  }
}

function generateLaneId(): string {
  return `lane_${crypto.randomBytes(4).toString("hex")}`;
}

const MUTABLE_METADATA_KEYS = new Set([
  "agentSessionId",
  "process",
  "model",
  "label",
  "usage",
  "timing",
]);

function assertMetadataPatch(patch: LaneMetadataPatch): void {
  const forbidden = Object.keys(patch).filter((key) => !MUTABLE_METADATA_KEYS.has(key));
  if (forbidden.length > 0) {
    throw new TypeError(
      `updateLane only accepts mutable metadata; store-owned field(s): ${forbidden.join(", ")}`,
    );
  }
}

/**
 * The lane status a durable event implies, for crash replay. Answer
 * submission and adapter-confirmed consumption share the "answered" kind;
 * only consumption (stamped data.consumed:true by consumeAnswerWithEvent)
 * returns the lane to running — a submission changes no status.
 */
function statusImpliedByEvent(event: LaneEvent): LaneStatus | undefined {
  switch (event.event) {
    case "result":
      return "completed";
    case "failed":
      return "failed";
    case "killed":
      return "killed";
    case "question":
      return "blocked";
    case "resume_started":
      return "running";
    case "answered":
      return event.data.consumed === true ? "running" : undefined;
    default:
      return undefined;
  }
}

/** The most recent event of the given kind, or undefined. */
function findLatestEventOfKind(events: LaneEvent[], kind: LaneEvent["event"]): LaneEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event !== undefined && event.event === kind) {
      return event;
    }
  }
  return undefined;
}

/** The most recent adapter-confirmed consumption event, or undefined. */
function findLatestConsumptionEvent(events: LaneEvent[]): LaneEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event !== undefined && event.event === "answered" && event.data.consumed === true) {
      return event;
    }
  }
  return undefined;
}

function findLastStatusBearingEvent(
  events: LaneEvent[],
): { event: LaneEvent; status: LaneStatus } | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event === undefined) {
      continue;
    }
    const status = statusImpliedByEvent(event);
    if (status !== undefined) {
      return { event, status };
    }
  }
  return undefined;
}

function assertTransitionEvent(status: LaneStatus, input: LaneEventInput): void {
  const expectedKind: LaneEvent["event"] | undefined =
    status === "completed"
      ? "result"
      : status === "failed"
        ? "failed"
        : status === "killed"
          ? "killed"
          : status === "blocked"
            ? "question"
            : undefined;
  if (expectedKind !== undefined && input.event !== expectedKind) {
    throw new TypeError(
      `Status "${status}" requires event "${expectedKind}", received "${input.event}"`,
    );
  }
}

/** Signal-0 liveness probe; EPERM (exists but unsignalable) counts as alive. */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
