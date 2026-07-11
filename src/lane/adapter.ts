import type {
  AgentManifest,
  DispatchOutcome,
  ErrorCode,
  InspectSnapshot,
  LaneEventInput,
  LaneRecord,
} from "../types/lane.js";

/**
 * Thrown by resume() when native-session continuity cannot be verified.
 * Adapters must never silently rebind to a different native session.
 */
export class ContinuityError extends Error {
  readonly code: ErrorCode = "continuity_unverified";
  readonly detail?: string;
  readonly remediation?: string;

  constructor(
    message: string,
    options: { detail?: string; remediation?: string; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ContinuityError";
    if (options.detail !== undefined) {
      this.detail = options.detail;
    }
    if (options.remediation !== undefined) {
      this.remediation = options.remediation;
    }
  }
}

export type AdapterErrorCode = Extract<
  ErrorCode,
  "agent_unavailable" | "adapter_error" | "agent_failed" | "timeout"
>;

/** Adapter-layer failure with a machine code that maps onto envelope codes. */
export class AdapterError extends Error {
  readonly code: AdapterErrorCode;
  readonly remediation?: string;

  constructor(
    code: AdapterErrorCode,
    message: string,
    options: { remediation?: string; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AdapterError";
    this.code = code;
    if (options.remediation !== undefined) {
      this.remediation = options.remediation;
    }
  }
}

export interface DispatchRequest {
  laneId: string;
  prompt: string;
  cwd: string;
  model?: string;
  label?: string;
  timeoutMs?: number;
  /** Streaming event sink; the lane store assigns seq/ts when persisting. */
  onEvent?: (event: LaneEventInput) => void | Promise<void>;
}

/** Options for AgentAdapter.resume; same event hook semantics as dispatch. */
export interface ResumeOptions {
  timeoutMs?: number;
  /** Streaming event sink; the lane store assigns seq/ts when persisting. */
  onEvent?: (event: LaneEventInput) => void | Promise<void>;
}

/**
 * The per-agent integration surface. Adapters never interpret prose as
 * success: nativeStatus must come from protocol/exit-code evidence only, and
 * semanticOutcome stays "unknown" unless an explicit validator (none in v0)
 * sets it.
 */
export interface AgentAdapter {
  /**
   * Binds a native session, streams events via req.onEvent, and returns a
   * terminal or blocked outcome.
   */
  dispatch(req: DispatchRequest): Promise<DispatchOutcome>;

  /**
   * Continues an existing lane. MUST verify continuity (per the manifest's
   * continuityMethods) or throw ContinuityError; never silently rebind.
   * Event hook semantics for opts.onEvent match dispatch.
   */
  resume(lane: LaneRecord, prompt: string, opts?: ResumeOptions): Promise<DispatchOutcome>;

  /** Native-store liveness snapshot when the agent exposes one. */
  inspect(lane: LaneRecord): Promise<InspectSnapshot>;

  /** Static manifest: declared capabilities + measured overhead. */
  capabilities(): AgentManifest;
}

/** Registry of adapters keyed by their manifest `agent` name. */
export class AdapterRegistry {
  private readonly adapters = new Map<string, AgentAdapter>();

  register(adapter: AgentAdapter): void {
    const name = adapter.capabilities().agent;
    if (this.adapters.has(name)) {
      throw new AdapterError("adapter_error", `Adapter already registered: ${name}`);
    }

    this.adapters.set(name, adapter);
  }

  get(agent: string): AgentAdapter | undefined {
    return this.adapters.get(agent);
  }

  require(agent: string): AgentAdapter {
    const adapter = this.adapters.get(agent);
    if (!adapter) {
      const known = this.list().map((manifest) => manifest.agent);
      throw new AdapterError("agent_unavailable", `No adapter registered for agent: ${agent}`, {
        remediation:
          known.length > 0
            ? `Known agents: ${known.join(", ")}. Run "orca agents" for manifests.`
            : 'No adapters are registered. Run "orca agents" for manifests.',
      });
    }

    return adapter;
  }

  list(): AgentManifest[] {
    return [...this.adapters.values()]
      .map((adapter) => adapter.capabilities())
      .sort((a, b) => a.agent.localeCompare(b.agent));
  }
}

/** Shared default registry; concrete adapters self-register here. */
export const adapterRegistry = new AdapterRegistry();
