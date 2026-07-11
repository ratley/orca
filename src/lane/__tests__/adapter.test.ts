import { describe, expect, test } from "bun:test";

import type {
  AgentManifest,
  DispatchOutcome,
  InspectSnapshot,
  LaneEventInput,
  LaneRecord,
} from "../../types/lane";
import { AdapterError, AdapterRegistry, ContinuityError } from "../adapter";
import type { AgentAdapter, ResumeOptions } from "../adapter";

function stubAdapter(agent: string): AgentAdapter {
  const manifest: AgentManifest = {
    v: 1,
    agent,
    capabilities: {
      resume: true,
      kill: true,
      questions: true,
      continuityMethods: ["thread-id-match"],
    },
  };

  const outcome: DispatchOutcome = {
    status: "completed",
    delivery: "confirmed",
    nativeStatus: "completed",
    semanticOutcome: "unknown",
    result: { text: "done" },
  };

  const snapshot: InspectSnapshot = { nativeStatus: "completed" };

  return {
    dispatch: () => Promise.resolve(outcome),
    resume: () => Promise.resolve(outcome),
    inspect: () => Promise.resolve(snapshot),
    capabilities: () => manifest,
  };
}

describe("adapter registry", () => {
  test("registers and resolves adapters by manifest agent name", () => {
    const registry = new AdapterRegistry();
    const codex = stubAdapter("codex");

    registry.register(codex);

    expect(registry.get("codex")).toBe(codex);
    expect(registry.require("codex")).toBe(codex);
    expect(registry.get("claude")).toBeUndefined();
  });

  test("rejects duplicate registrations", () => {
    const registry = new AdapterRegistry();
    registry.register(stubAdapter("codex"));

    expect(() => registry.register(stubAdapter("codex"))).toThrow(AdapterError);
  });

  test("require throws agent_unavailable with remediation for unknown agents", () => {
    const registry = new AdapterRegistry();
    registry.register(stubAdapter("codex"));

    try {
      registry.require("claude");
      throw new Error("expected require() to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AdapterError);
      expect((error as AdapterError).code).toBe("agent_unavailable");
      expect((error as AdapterError).remediation).toContain("codex");
    }
  });

  test("list returns manifests sorted by agent name", () => {
    const registry = new AdapterRegistry();
    registry.register(stubAdapter("codex"));
    registry.register(stubAdapter("claude"));

    expect(registry.list().map((manifest) => manifest.agent)).toEqual(["claude", "codex"]);
  });
});

describe("adapter resume signature", () => {
  test("resume accepts optional ResumeOptions with the dispatch event-hook semantics", async () => {
    const lane: LaneRecord = {
      id: "lane_a3f8b901",
      agent: "codex",
      cwd: "/tmp/project",
      status: "blocked",
      createdAt: "2026-07-11T00:00:00.000Z",
      updatedAt: "2026-07-11T00:01:00.000Z",
      seq: 3,
    };
    const outcome: DispatchOutcome = {
      status: "completed",
      delivery: "confirmed",
      nativeStatus: "completed",
      semanticOutcome: "unknown",
    };

    const adapter: AgentAdapter = {
      dispatch: () => Promise.resolve(outcome),
      resume: async (_lane, prompt, opts?: ResumeOptions) => {
        await opts?.onEvent?.({ event: "progress", data: { prompt } });
        return outcome;
      },
      inspect: () => Promise.resolve({ nativeStatus: "completed" }),
      capabilities: () => stubAdapter("codex").capabilities(),
    };

    const seen: LaneEventInput[] = [];
    const result = await adapter.resume(lane, "keep going", {
      timeoutMs: 1_000,
      onEvent: (event) => {
        seen.push(event);
      },
    });

    expect(result).toEqual(outcome);
    expect(seen).toEqual([{ event: "progress", data: { prompt: "keep going" } }]);

    // Two-argument callers remain valid: opts is optional.
    expect(await adapter.resume(lane, "again")).toEqual(outcome);
  });
});

describe("adapter errors", () => {
  test("ContinuityError always carries the continuity_unverified code", () => {
    const error = new ContinuityError("thread id mismatch", {
      detail: "expected thread_123, found thread_456",
      remediation: "Dispatch a fresh lane instead of resuming.",
    });

    expect(error.code).toBe("continuity_unverified");
    expect(error.name).toBe("ContinuityError");
    expect(error.detail).toBe("expected thread_123, found thread_456");
    expect(error.remediation).toBe("Dispatch a fresh lane instead of resuming.");
  });

  test("AdapterError exposes its machine code and cause", () => {
    const cause = new Error("spawn ENOENT");
    const error = new AdapterError("agent_unavailable", "codex binary not found", {
      remediation: "Install the codex CLI.",
      cause,
    });

    expect(error.code).toBe("agent_unavailable");
    expect(error.name).toBe("AdapterError");
    expect(error.remediation).toBe("Install the codex CLI.");
    expect(error.cause).toBe(cause);
  });
});
