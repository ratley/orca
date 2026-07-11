import { z } from "zod";

import {
  AgentManifestSchema,
  EnvelopeSchema,
  HandleLineSchema,
  LANE_CONTRACT_VERSION,
  LaneEventSchema,
} from "../types/lane.js";
import type { ErrorCode } from "../types/lane.js";
import { ERROR_CODE_EXIT_CODES, EXIT_CODES } from "./envelope.js";

export type JsonSchema = Record<string, unknown>;

export type ContractSchemaName = "envelope" | "event" | "manifest";

export interface ContractExitCode {
  exitCode: number;
  meaning: string;
  /** Envelope `code` values that map to this exit code (empty for 0). */
  errorCodes: ErrorCode[];
}

export interface ContractVerb {
  verb: string;
  synopsis: string;
  example: string;
  description: string;
}

export interface ContractPayload {
  contractVersion: typeof LANE_CONTRACT_VERSION;
  schemas: {
    envelope: JsonSchema;
    event: JsonSchema;
    manifest: JsonSchema;
    handle: JsonSchema;
  };
  exitCodes: ContractExitCode[];
  verbs: ContractVerb[];
  notes: string[];
}

const EXIT_CODE_MEANINGS: ReadonlyArray<{ exitCode: number; meaning: string }> = [
  {
    exitCode: EXIT_CODES.ok,
    meaning: 'success, including status "blocked" — blocked is a successful outcome',
  },
  { exitCode: EXIT_CODES.usageError, meaning: "usage error (malformed command line only)" },
  { exitCode: EXIT_CODES.adapterFailure, meaning: "adapter or agent failure" },
  {
    exitCode: EXIT_CODES.notFound,
    meaning:
      "lane not found, continuity failure, or invalid lane state for the verb " +
      "(e.g. resume of a failed/killed/lost or live-blocked lane, answer on a non-blocked lane)",
  },
  { exitCode: EXIT_CODES.timeout, meaning: "timeout" },
];

const VERBS: ReadonlyArray<ContractVerb> = [
  {
    verb: "dispatch",
    synopsis:
      "orca dispatch --agent <agent> [--model <model>] [--cwd <dir>] [--label <label>] " +
      "[--timeout <ms>] <prompt>",
    example: 'orca dispatch --agent codex --cwd . "Fix the flaky store test"',
    description:
      "Create a lane and hand the prompt to the agent. Prints a handle line " +
      '({"v":1,"kind":"handle",...}) immediately after lane creation, ' +
      "then one final envelope when the run reaches a terminal or blocked state.",
  },
  {
    verb: "inspect",
    synopsis:
      "orca inspect <laneId> [--follow] [--since <seq>] [--wait-for blocked|done] [--timeout <ms>]",
    example: "orca inspect lane_a3f81c02 --since 7",
    description:
      "Report lane state and events. --since returns events with seq greater " +
      "than the given value; --wait-for blocks until the lane is blocked or done.",
  },
  {
    verb: "answer",
    synopsis: "orca answer <laneId> <text>",
    example: 'orca answer lane_a3f81c02 "Use the staging database"',
    description:
      "Deliver an answer to a blocked lane's pending question. Answering a " +
      "lane that is not blocked fails with code invalid_state (exit 4).",
  },
  {
    verb: "resume",
    synopsis: "orca resume <laneId> [--timeout <ms>] <prompt>",
    example: 'orca resume lane_a3f81c02 "Now add tests for the edge cases"',
    description:
      "Continue a blocked (non-live) or completed lane with a follow-up " +
      "prompt; completed->running is the documented carve-out from terminal " +
      "immutability (a resume is a user-initiated new turn). Continuity is " +
      "verified or the command fails with code continuity_unverified (exit 4). " +
      "Resuming a failed/killed/lost lane, or a blocked lane whose live " +
      "question is still being polled by a living dispatch, fails with code " +
      "invalid_state (exit 4).",
  },
  {
    verb: "lanes",
    synopsis: "orca lanes",
    example: "orca lanes",
    description: 'List known lanes as a kind:"list" envelope.',
  },
  {
    verb: "kill",
    synopsis: "orca kill <laneId>",
    example: "orca kill lane_a3f81c02",
    description:
      "Terminate a queued, running, or blocked lane. Killing an already-" +
      "killed lane is idempotent (exit 0); killing a completed/failed/lost " +
      "lane fails with code invalid_state (exit 4).",
  },
  {
    verb: "agents",
    synopsis: "orca agents",
    example: "orca agents",
    description: 'Print static agent manifests as a kind:"agents" envelope.',
  },
  {
    verb: "contract",
    synopsis: "orca contract [--schema envelope|event|manifest]",
    example: "orca contract --schema envelope",
    description: "Print this machine-readable contract, or a single JSON Schema with --schema.",
  },
];

const NOTES: ReadonlyArray<string> = [
  "Every command prints exactly one JSON envelope as the FINAL stdout line, success and failure alike.",
  "--help/-h output is human-readable usage text, not an envelope; it is the DOCUMENTED exemption to the one-envelope-per-command rule.",
  "dispatch additionally prints a handle line FIRST, immediately after lane creation and before any agent work.",
  "A command NEVER exits 0 with ok:false.",
  'code "usage_error" (exit 2) means the command LINE was malformed; a well-formed command against a lane in the wrong state reports "invalid_state" (exit 4).',
  "delivery, nativeStatus, and semanticOutcome are independent axes and are never conflated.",
  "semanticOutcome is set only by an explicit validator (none in v0); it is never inferred from agent prose.",
  'The verbs "answer" and "resume" share their names with legacy orca commands: lane handling engages when the first argument starts with "lane_" (all lane ids do), or when the next argument is --help/-h; other values fall through to the legacy commands.',
];

export function buildContractPayload(): ContractPayload {
  return {
    contractVersion: LANE_CONTRACT_VERSION,
    schemas: {
      envelope: getContractSchema("envelope"),
      event: getContractSchema("event"),
      manifest: getContractSchema("manifest"),
      handle: toJsonSchema(HandleLineSchema),
    },
    exitCodes: buildExitCodeTable(),
    verbs: [...VERBS],
    notes: [...NOTES],
  };
}

export function getContractSchema(name: ContractSchemaName): JsonSchema {
  switch (name) {
    case "envelope":
      return toJsonSchema(EnvelopeSchema);
    case "event":
      return toJsonSchema(LaneEventSchema);
    case "manifest":
      return toJsonSchema(AgentManifestSchema);
  }
}

function buildExitCodeTable(): ContractExitCode[] {
  return EXIT_CODE_MEANINGS.map(({ exitCode, meaning }) => ({
    exitCode,
    meaning,
    errorCodes: (Object.keys(ERROR_CODE_EXIT_CODES) as ErrorCode[])
      .filter((code) => ERROR_CODE_EXIT_CODES[code] === exitCode)
      .sort(),
  }));
}

function toJsonSchema(schema: z.ZodType): JsonSchema {
  return z.toJSONSchema(schema) as JsonSchema;
}
