import { adapterRegistry } from "../../lane/adapter.js";
import type { AdapterRegistry } from "../../lane/adapter.js";
import { CursorAdapter } from "./adapter.js";
import type { CursorAdapterOptions } from "./adapter.js";

export {
  buildCursorManifest,
  CURSOR_AGENT_NAME,
  CursorAdapter,
  DEFAULT_CURSOR_BIN,
} from "./adapter.js";
export type { CursorAdapterCaveat, CursorAdapterOptions, CursorAgentManifest } from "./adapter.js";
export {
  getSessionDir,
  hashWorkspacePath,
  readSessionMeta,
  resolveCursorHome,
  resolveWorkspaceRealpath,
} from "./chats.js";
export type { SessionMeta } from "./chats.js";
export { ExecUnavailableError, spawnExec } from "./exec.js";
export type { ExecFn, ExecHandle, ExecRequest, ExecResult, TerminationProof } from "./exec.js";

/**
 * Creates a CursorAdapter and registers it under "cursor". Registration is
 * explicit (no import side effects); duplicate registration throws, per the
 * registry contract.
 */
export function registerCursorAdapter(
  registry: AdapterRegistry = adapterRegistry,
  options: CursorAdapterOptions = {},
): CursorAdapter {
  const adapter = new CursorAdapter(options);
  registry.register(adapter);
  return adapter;
}
