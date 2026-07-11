import type { AgentCaveat, AgentManifest } from "../../types/lane.js";

export const CODEX_AGENT_NAME = "codex";
export const CODEX_ADAPTER_VERSION = "0.1.0";

/**
 * Declared/measured facts about the codex agent that have no slot in
 * AgentManifestSchema (v0 schema gap): structured output support, browser use,
 * sandbox modes, and prompt token overhead. Measured 2026-07-11 against
 * codex-cli 0.144.1 (app-server protocol).
 */
export const CODEX_DECLARED_FACTS = {
  measuredAt: "2026-07-11",
  measuredOn: "codex-cli 0.144.1",
  /** Median wall time from spawn to a bound thread, measured locally. */
  startupMs: 7500,
  /** Approximate baseline prompt tokens consumed before any user prompt. */
  inputTokenOverhead: 24000,
  /** turn/start accepts an outputSchema for structured output. */
  structuredOutput: true,
  /** Browser use is available when enabled via codex config. */
  browserUse: "available via config",
  sandboxModes: ["read-only", "workspace-write", "danger-full-access"],
  processIdentity: "detached app-server pid/pgid, emitted at spawn",
} as const;

/** Known adapter limitations surfaced by `orca agents`. */
export const CODEX_CAVEATS: AgentCaveat[] = [
  {
    code: "process_group_signalling_cli_owned",
    note: "The adapter emits the detached app-server pid/pgid in agent_started immediately after spawn; the owning CLI is responsible for persisting that identity and for kill-verb signalling and verification. The one exception: when a post-verb disconnect exceeds its cleanup grace, the adapter force-terminates the app-server it spawned (SIGTERM group, grace, SIGKILL, verify) and reports the outcome.",
  },
  {
    code: "process_identity_spawn_window",
    note: "pid/pgid come from the spawned app-server transport and are emitted in agent_started before protocol initialization, so pre-protocol hangs are killable. Residual honesty: a kill landing in the short window between spawn and identity persistence relies on the CLI's late-identity handling, and custom transports that expose no process info yield an agent_started with no identity at all.",
  },
  {
    code: "answer_file_polling",
    note: "Blocking questions use CLI-owned answer.txt polling via the store's locked read-answer-with-generation, which pairs the text with its submission generation (and clears a crash-leftover already-consumed file under the same lock). The adapter itself never writes or replaces answers.",
  },
  {
    code: "semantic_outcome_unknown",
    note: "The adapter reports native protocol status only; without an explicit validator, semanticOutcome remains unknown.",
  },
];

/**
 * P-POSIX: v0 kill relies on POSIX process-group signalling of the detached
 * app-server. The caveat is always declared; capabilities.kill flips to false
 * at runtime on platforms without POSIX process groups.
 */
export const CODEX_POSIX_KILL_CAVEAT: AgentCaveat = {
  code: "posix_only",
  note: "v0 process-group kill is POSIX-only: capabilities.kill is true only on POSIX platforms, where the CLI signals the detached app-server's negative pgid; on other platforms kill is reported false at runtime.",
};

/** Static manifest for the codex adapter: declared capabilities + overhead. */
export function buildCodexManifest(platform: NodeJS.Platform = process.platform): AgentManifest {
  const posixKill = platform !== "win32";

  return {
    v: 1,
    agent: CODEX_AGENT_NAME,
    displayName: "Codex (app-server)",
    adapterVersion: CODEX_ADAPTER_VERSION,
    capabilities: {
      resume: true,
      kill: posixKill,
      questions: true,
      continuityMethods: ["thread-id-match"],
    },
    overhead: {
      startupMsP50: CODEX_DECLARED_FACTS.startupMs,
      measuredAt: CODEX_DECLARED_FACTS.measuredAt,
    },
    caveats: [...CODEX_CAVEATS, CODEX_POSIX_KILL_CAVEAT],
    declared: { ...CODEX_DECLARED_FACTS },
  };
}
