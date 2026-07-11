import { z } from "zod";

/**
 * orca/v1 lane contract.
 *
 * These Zod schemas ARE the contract: every CLI verb prints exactly one
 * envelope as the final stdout line (success and failure alike), `dispatch`
 * additionally prints a handle line first, and the lane store persists lane
 * records plus append-only event lines in exactly these shapes.
 */

export const LANE_CONTRACT_VERSION = "orca/v1";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const LaneStatusSchema = z.enum([
  "queued",
  "running",
  "blocked",
  "completed",
  "failed",
  "killed",
  "lost",
]);
export type LaneStatus = z.infer<typeof LaneStatusSchema>;

/**
 * Terminal lane statuses are immutable: once a lane reaches one of these, no
 * status transition away from it may succeed (see LaneStore.transitionLane),
 * with ONE documented carve-out: LaneStore.beginResume may take a `completed`
 * lane back to `running` — a user-initiated resume is a new turn, not a
 * conflicting settlement of the finished one. `failed`, `killed`, and `lost`
 * remain fully immutable.
 */
export const TERMINAL_LANE_STATUSES: readonly LaneStatus[] = [
  "completed",
  "failed",
  "killed",
  "lost",
] as const;

export function isTerminalLaneStatus(status: LaneStatus): boolean {
  return TERMINAL_LANE_STATUSES.includes(status);
}

/**
 * Machine-readable failure codes. Present on an envelope iff `ok` is false.
 * `usage_error` is reserved for malformed command lines; a well-formed command
 * against a lane in the wrong state (resume on failed/killed/lost or
 * live-blocked, answer on non-blocked, kill on completed/failed) reports
 * `invalid_state` instead.
 */
export const ErrorCodeSchema = z.enum([
  "usage_error",
  "invalid_state",
  "lane_not_found",
  "continuity_unverified",
  "agent_unavailable",
  "adapter_error",
  "agent_failed",
  "timeout",
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

/** Whether the prompt was delivered to the agent. Never inferred from prose. */
export const DeliverySchema = z.enum(["not_sent", "confirmed", "unknown"]);
export type Delivery = z.infer<typeof DeliverySchema>;

/** Agent-native run state, derived from protocol/exit-code evidence only. */
export const NativeStatusSchema = z.enum([
  "running",
  "completed",
  "failed",
  "interrupted",
  "unknown",
]);
export type NativeStatus = z.infer<typeof NativeStatusSchema>;

/**
 * Validated task outcome. In v0 this is almost always "unknown"; only an
 * explicit validator (none in v0) may set the other values. Never inferred
 * from agent prose.
 */
export const SemanticOutcomeSchema = z.enum(["unknown", "validated_pass", "validated_fail"]);
export type SemanticOutcome = z.infer<typeof SemanticOutcomeSchema>;

export const ContinuityMethodSchema = z.enum(["thread-id-match", "nonce-echo", "session-id-match"]);
export type ContinuityMethod = z.infer<typeof ContinuityMethodSchema>;

export const EnvelopeKindSchema = z.enum(["lane", "list", "agents", "contract", "error"]);
export type EnvelopeKind = z.infer<typeof EnvelopeKindSchema>;

export const LaneEventKindSchema = z.enum([
  "created",
  "agent_started",
  "progress",
  "question",
  "answered",
  "resume_started",
  "result",
  "failed",
  "killed",
  "heartbeat",
]);
export type LaneEventKind = z.infer<typeof LaneEventKindSchema>;

// ---------------------------------------------------------------------------
// Lane record
// ---------------------------------------------------------------------------

export const UsageInfoSchema = z.object({
  inputTokens: z.number().nonnegative().optional(),
  outputTokens: z.number().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
});
export type UsageInfo = z.infer<typeof UsageInfoSchema>;

export const TimingInfoSchema = z.object({
  wallMs: z.number().nonnegative(),
  apiMs: z.number().nonnegative().optional(),
  startupMs: z.number().nonnegative().optional(),
});
export type TimingInfo = z.infer<typeof TimingInfoSchema>;

/** The lane fields carried inside an envelope. */
export const LaneSummarySchema = z.object({
  id: z.string(),
  agent: z.string(),
  model: z.string().optional(),
  cwd: z.string(),
  label: z.string().optional(),
  agentSessionId: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  seq: z.number().int().nonnegative(),
});
export type LaneSummary = z.infer<typeof LaneSummarySchema>;

/**
 * Child-process identity persisted by the dispatching CLI once an adapter
 * reports {pid, pgid} in its agent_started event. pgid is what kill signals
 * (negative pgid = the whole process group).
 */
export const LaneProcessInfoSchema = z.object({
  pid: z.number().int().positive(),
  pgid: z.number().int().positive().optional(),
  startedAt: z.string(),
});
export type LaneProcessInfo = z.infer<typeof LaneProcessInfoSchema>;

/** The persisted lane.json record: envelope summary plus current status. */
export const LaneRecordSchema = LaneSummarySchema.extend({
  status: LaneStatusSchema,
  process: LaneProcessInfoSchema.optional(),
  /**
   * Monotonic counter of answer submissions (store-owned). Each successful
   * submitAnswer increments it; consumeAnswerWithEvent compare-and-deletes
   * answer.txt only when the adapter-echoed generation matches, so a
   * replacement answer submitted after the adapter read the previous one is
   * never erased as consumption of the older answer.
   */
  answerGeneration: z.number().int().nonnegative().optional(),
  /**
   * Adapter-reported usage/timing, persisted by the CLI at terminal
   * settlement so later `orca inspect` of a settled lane can still report
   * them (the settling process is long gone by then).
   */
  usage: UsageInfoSchema.optional(),
  timing: TimingInfoSchema.optional(),
});
export type LaneRecord = z.infer<typeof LaneRecordSchema>;

// ---------------------------------------------------------------------------
// Envelope sub-objects
// ---------------------------------------------------------------------------

export const BlockedQuestionSchema = z.object({
  id: z.string(),
  question: z.string(),
  options: z.array(z.string()).optional(),
});
export type BlockedQuestion = z.infer<typeof BlockedQuestionSchema>;

export const BlockedInfoSchema = z.object({
  questions: z.array(BlockedQuestionSchema),
});
export type BlockedInfo = z.infer<typeof BlockedInfoSchema>;

export const ResultInfoSchema = z.object({
  text: z.string(),
  artifacts: z.array(z.string()).optional(),
});
export type ResultInfo = z.infer<typeof ResultInfoSchema>;

export const ContinuityInfoSchema = z.object({
  verified: z.boolean(),
  method: ContinuityMethodSchema,
  detail: z.string().optional(),
});
export type ContinuityInfo = z.infer<typeof ContinuityInfoSchema>;

export const ErrorInfoSchema = z.object({
  message: z.string(),
  remediation: z.string().optional(),
});
export type ErrorInfo = z.infer<typeof ErrorInfoSchema>;

// ---------------------------------------------------------------------------
// Agent manifest
// ---------------------------------------------------------------------------

export const AgentCapabilitiesSchema = z.object({
  resume: z.boolean(),
  kill: z.boolean(),
  /** Whether the agent can surface blocking questions (status "blocked"). */
  questions: z.boolean(),
  continuityMethods: z.array(ContinuityMethodSchema),
  models: z.array(z.string()).optional(),
  /**
   * Browser-use support: true/false when the adapter knows definitively, or a
   * short string when availability is conditional (e.g. "available via
   * config"). Absent means undeclared.
   */
  browserUse: z.union([z.boolean(), z.string()]).optional(),
});
export type AgentCapabilities = z.infer<typeof AgentCapabilitiesSchema>;

export const AgentOverheadSchema = z.object({
  startupMsP50: z.number().nonnegative().optional(),
  startupMsP95: z.number().nonnegative().optional(),
  measuredAt: z.string().optional(),
});
export type AgentOverhead = z.infer<typeof AgentOverheadSchema>;

/** A declared adapter limitation: machine-readable code plus human note. */
export const AgentCaveatSchema = z.object({
  code: z.string(),
  note: z.string(),
});
export type AgentCaveat = z.infer<typeof AgentCaveatSchema>;

/** Static, declared description of an adapter: capabilities + measured overhead. */
export const AgentManifestSchema = z.object({
  v: z.literal(1),
  agent: z.string(),
  displayName: z.string().optional(),
  adapterVersion: z.string().optional(),
  capabilities: AgentCapabilitiesSchema,
  overhead: AgentOverheadSchema.optional(),
  /** Known limitations the adapter declares up front. */
  caveats: z.array(AgentCaveatSchema).optional(),
  /** Whether the adapter can run lanes in dedicated git worktrees. */
  worktrees: z.boolean().optional(),
  /** Adapter-specific declared extras that fit no first-class slot. */
  declared: z.record(z.string(), z.unknown()).optional(),
});
export type AgentManifest = z.infer<typeof AgentManifestSchema>;

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

/**
 * Structural shape of the envelope, without cross-field invariants.
 * `EnvelopeSchema` (below) adds them; use that for validation. This base is
 * exported so the contract can emit a JSON Schema of the structure.
 */
export const EnvelopeObjectSchema = z.object({
  v: z.literal(1),
  kind: EnvelopeKindSchema,
  ok: z.boolean(),
  status: LaneStatusSchema,
  code: ErrorCodeSchema.optional(),
  lane: LaneSummarySchema.optional(),
  delivery: DeliverySchema,
  nativeStatus: NativeStatusSchema,
  semanticOutcome: SemanticOutcomeSchema,
  blocked: BlockedInfoSchema.optional(),
  result: ResultInfoSchema.optional(),
  usage: UsageInfoSchema.optional(),
  timing: TimingInfoSchema.optional(),
  continuity: ContinuityInfoSchema.optional(),
  /** Literal follow-up commands, e.g. "orca inspect lane_a3f8 --since 7". */
  next: z.array(z.string()).optional(),
  /**
   * Non-fatal observations about lane health (e.g. status "running" while the
   * recorded lane process is gone). Warnings never change status or exit code.
   */
  warnings: z.array(z.string()).optional(),
  error: ErrorInfoSchema.optional(),
  /** Payload for kind:"list". */
  lanes: z.array(LaneRecordSchema).optional(),
  /** Payload for kind:"agents". */
  agents: z.array(AgentManifestSchema).optional(),
  /** Payload for kind:"contract". */
  contract: z.record(z.string(), z.unknown()).optional(),
});

export const EnvelopeSchema = EnvelopeObjectSchema.refine(
  (env) => env.ok || env.code !== undefined,
  { message: "an envelope with ok:false must carry a machine-readable code" },
)
  .refine((env) => !(env.ok && env.code !== undefined), {
    message: "an envelope with ok:true must not carry an error code",
  })
  .refine((env) => env.ok || env.error !== undefined, {
    message: "an envelope with ok:false must carry error.message",
  });
export type Envelope = z.infer<typeof EnvelopeSchema>;

/**
 * Handle line printed by `dispatch` immediately after lane creation, before
 * any agent work and before the final envelope line.
 */
export const HandleLineSchema = z.object({
  v: z.literal(1),
  kind: z.literal("handle"),
  laneId: z.string(),
  agent: z.string(),
});
export type HandleLine = z.infer<typeof HandleLineSchema>;

// ---------------------------------------------------------------------------
// Event lines (events.ndjson)
// ---------------------------------------------------------------------------

export const LaneEventSchema = z.object({
  v: z.literal(1),
  seq: z.number().int().positive(),
  ts: z.string(),
  laneId: z.string(),
  event: LaneEventKindSchema,
  data: z.record(z.string(), z.unknown()).default({}),
});
export type LaneEvent = z.infer<typeof LaneEventSchema>;

/** Adapter/CLI-facing event payload; the store assigns v/seq/ts/laneId. */
export interface LaneEventInput {
  event: LaneEventKind;
  data?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Adapter outcomes
// ---------------------------------------------------------------------------

/**
 * What an adapter's dispatch/resume returns: a terminal state or "blocked".
 * Adapters never interpret prose as success; nativeStatus comes from
 * protocol/exit-code evidence only.
 */
export const DispatchOutcomeSchema = z.object({
  status: z.enum(["blocked", "completed", "failed", "killed"]),
  delivery: DeliverySchema,
  nativeStatus: NativeStatusSchema,
  semanticOutcome: SemanticOutcomeSchema,
  /** Machine code for failures; maps to the envelope `code` field. */
  code: ErrorCodeSchema.optional(),
  agentSessionId: z.string().optional(),
  blocked: BlockedInfoSchema.optional(),
  result: ResultInfoSchema.optional(),
  usage: UsageInfoSchema.optional(),
  timing: TimingInfoSchema.optional(),
  continuity: ContinuityInfoSchema.optional(),
  error: ErrorInfoSchema.optional(),
});
export type DispatchOutcome = z.infer<typeof DispatchOutcomeSchema>;

/** Native-store liveness snapshot, when the agent exposes one. */
export const InspectSnapshotSchema = z.object({
  nativeStatus: NativeStatusSchema,
  agentSessionId: z.string().optional(),
  lastActivityAt: z.string().optional(),
  detail: z.string().optional(),
});
export type InspectSnapshot = z.infer<typeof InspectSnapshotSchema>;
