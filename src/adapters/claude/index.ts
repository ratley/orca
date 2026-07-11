import { adapterRegistry } from "../../lane/adapter.js";
import type { AdapterRegistry } from "../../lane/adapter.js";
import { ClaudeAdapter } from "./adapter.js";
import type { ClaudeAdapterOptions } from "./adapter.js";

export { buildClaudeManifest, CLAUDE_PERMISSION_MODES, ClaudeAdapter } from "./adapter.js";
export type { ClaudeAdapterOptions, ClaudePermissionMode } from "./adapter.js";
export {
  ClaudeAssistantLineSchema,
  ClaudeInitLineSchema,
  ClaudeResultLineSchema,
  parseClaudeLine,
} from "./cli-output.js";
export type {
  ClaudeAssistantLine,
  ClaudeInitLine,
  ClaudeResultLine,
  ParsedClaudeLine,
} from "./cli-output.js";
export {
  createProcessClaudeExec,
  KILL_GRACE_MS,
  MAX_STDERR_BYTES,
  MAX_STDOUT_LINE_BYTES,
} from "./exec.js";
export type {
  ClaudeExec,
  ClaudeExecHandle,
  ClaudeExecRequest,
  ClaudeExecResult,
  ClaudeProcessExecOptions,
  ClaudeProcessInfo,
  TerminationProof,
} from "./exec.js";
export {
  claudeProjectKey,
  resolveClaudeConfigDir,
  resolveProjectCwd,
  statTranscript,
  transcriptPath,
} from "./transcript.js";
export type { TranscriptStat } from "./transcript.js";

/**
 * Constructs and explicitly registers a Claude adapter. Importing this module
 * alone has no registry side effect; the CLI calls this helper after loading
 * the built-in adapter module.
 */
export function registerClaudeAdapter(
  registry: AdapterRegistry = adapterRegistry,
  options: ClaudeAdapterOptions = {},
): ClaudeAdapter {
  const adapter = new ClaudeAdapter(options);
  registry.register(adapter);
  return adapter;
}
