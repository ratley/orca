import { EnvelopeSchema, HandleLineSchema } from "../types/lane.js";
import type {
  AgentManifest,
  BlockedInfo,
  ContinuityInfo,
  Delivery,
  Envelope,
  EnvelopeKind,
  ErrorCode,
  HandleLine,
  LaneRecord,
  LaneStatus,
  NativeStatus,
  ResultInfo,
  SemanticOutcome,
  TimingInfo,
  UsageInfo,
} from "../types/lane.js";

/**
 * Exit-code contract, enforced in exactly one place (exitCodeForEnvelope):
 * 0 ok (including status "blocked" — blocked is a successful outcome),
 * 2 usage error (malformed command line only), 3 adapter/agent failure,
 * 4 not-found, continuity failure, or invalid lane state for the verb,
 * 5 timeout. An envelope with ok:false NEVER exits 0.
 */
export const EXIT_CODES = {
  ok: 0,
  usageError: 2,
  adapterFailure: 3,
  notFound: 4,
  timeout: 5,
} as const;

export const ERROR_CODE_EXIT_CODES: Record<ErrorCode, number> = {
  usage_error: EXIT_CODES.usageError,
  invalid_state: EXIT_CODES.notFound,
  lane_not_found: EXIT_CODES.notFound,
  continuity_unverified: EXIT_CODES.notFound,
  agent_unavailable: EXIT_CODES.adapterFailure,
  adapter_error: EXIT_CODES.adapterFailure,
  agent_failed: EXIT_CODES.adapterFailure,
  timeout: EXIT_CODES.timeout,
};

export function exitCodeForEnvelope(envelope: Envelope): number {
  if (envelope.ok) {
    return EXIT_CODES.ok;
  }

  return envelope.code !== undefined
    ? ERROR_CODE_EXIT_CODES[envelope.code]
    : EXIT_CODES.adapterFailure;
}

export interface OkEnvelopeInit {
  kind: Exclude<EnvelopeKind, "error">;
  status?: LaneStatus;
  lane?: LaneRecord;
  delivery?: Delivery;
  nativeStatus?: NativeStatus;
  semanticOutcome?: SemanticOutcome;
  blocked?: BlockedInfo;
  result?: ResultInfo;
  usage?: UsageInfo;
  timing?: TimingInfo;
  continuity?: ContinuityInfo;
  next?: string[];
  warnings?: string[];
  lanes?: LaneRecord[];
  agents?: AgentManifest[];
  contract?: Record<string, unknown>;
}

/** Builds a validated ok:true envelope. Blocked lanes are still ok:true. */
export function okEnvelope(init: OkEnvelopeInit): Envelope {
  return EnvelopeSchema.parse({
    v: 1,
    kind: init.kind,
    ok: true,
    status: init.status ?? "completed",
    delivery: init.delivery ?? "not_sent",
    nativeStatus: init.nativeStatus ?? "unknown",
    semanticOutcome: init.semanticOutcome ?? "unknown",
    lane: init.lane,
    blocked: init.blocked,
    result: init.result,
    usage: init.usage,
    timing: init.timing,
    continuity: init.continuity,
    next: init.next,
    warnings: init.warnings,
    lanes: init.lanes,
    agents: init.agents,
    contract: init.contract,
  });
}

export interface ErrorEnvelopeInit {
  code: ErrorCode;
  message: string;
  remediation?: string;
  kind?: EnvelopeKind;
  status?: LaneStatus;
  lane?: LaneRecord;
  delivery?: Delivery;
  nativeStatus?: NativeStatus;
  semanticOutcome?: SemanticOutcome;
  blocked?: BlockedInfo;
  result?: ResultInfo;
  usage?: UsageInfo;
  timing?: TimingInfo;
  continuity?: ContinuityInfo;
  next?: string[];
  warnings?: string[];
}

/** Builds a validated ok:false envelope carrying a machine-readable code. */
export function errorEnvelope(init: ErrorEnvelopeInit): Envelope {
  return EnvelopeSchema.parse({
    v: 1,
    kind: init.kind ?? "error",
    ok: false,
    status: init.status ?? "failed",
    code: init.code,
    delivery: init.delivery ?? "not_sent",
    nativeStatus: init.nativeStatus ?? "unknown",
    semanticOutcome: init.semanticOutcome ?? "unknown",
    lane: init.lane,
    blocked: init.blocked,
    result: init.result,
    usage: init.usage,
    timing: init.timing,
    continuity: init.continuity,
    next: init.next,
    warnings: init.warnings,
    error: {
      message: init.message,
      remediation: init.remediation,
    },
  });
}

interface WritableLike {
  write(chunk: string): unknown;
}

/**
 * Validates and prints an envelope as a single JSON line, and returns the
 * process exit code mandated by the contract. Every CLI verb must route its
 * final stdout line through this helper.
 */
export function printEnvelope(stream: WritableLike, envelope: Envelope): number {
  const validated = EnvelopeSchema.parse(envelope);
  stream.write(`${JSON.stringify(validated)}\n`);
  return exitCodeForEnvelope(validated);
}

/**
 * Prints the dispatch handle line: emitted immediately after lane creation,
 * before any agent work and before the final envelope line.
 */
export function printHandle(
  stream: WritableLike,
  handle: { laneId: string; agent: string },
): HandleLine {
  const validated = HandleLineSchema.parse({
    v: 1,
    kind: "handle",
    laneId: handle.laneId,
    agent: handle.agent,
  });

  stream.write(`${JSON.stringify(validated)}\n`);
  return validated;
}
