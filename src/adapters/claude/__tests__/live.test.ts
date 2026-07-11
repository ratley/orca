import { describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

import type { LaneEventInput, LaneRecord } from "../../../types/lane";
import { ClaudeAdapter } from "../adapter";
import {
  resolveClaudeConfigDir,
  resolveProjectCwd,
  statTranscript,
  transcriptPath,
} from "../transcript";

/**
 * OPTIONAL live smoke against the real claude CLI. Costs real money (one
 * haiku call); enable with ORCA_LIVE_CLAUDE=1.
 */
const LIVE = process.env.ORCA_LIVE_CLAUDE === "1";

describe("claude adapter live smoke", () => {
  test.skipIf(!LIVE)(
    "dispatches a trivial prompt and binds a real session",
    async () => {
      const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "orca-claude-live-"));
      try {
        const adapter = new ClaudeAdapter();
        const events: LaneEventInput[] = [];

        const outcome = await adapter.dispatch({
          laneId: "lane_live0001",
          prompt: "Reply with exactly the word: pong",
          cwd,
          model: "haiku",
          timeoutMs: 120_000,
          onEvent: (event) => void events.push(event),
        });

        expect(outcome.status).toBe("completed");
        expect(outcome.nativeStatus).toBe("completed");
        expect(outcome.delivery).toBe("confirmed");
        expect(outcome.result?.text).toContain("pong");
        expect(outcome.agentSessionId).toBeString();
        expect(events.some((event) => event.event === "agent_started")).toBe(true);

        // Validates the project-key rule against the real native store.
        const transcript = transcriptPath(
          resolveClaudeConfigDir(),
          await resolveProjectCwd(cwd),
          outcome.agentSessionId ?? "",
        );
        expect((await statTranscript(transcript)).exists).toBe(true);

        // Resume the same session through the adapter to exercise the full
        // continuity verification path against the real native store.
        const now = new Date().toISOString();
        const lane: LaneRecord = {
          id: "lane_live0001",
          agent: "claude",
          model: "haiku",
          cwd,
          status: "running",
          createdAt: now,
          updatedAt: now,
          seq: 2,
          agentSessionId: outcome.agentSessionId ?? "",
        };
        const resumed = await adapter.resume(lane, "Reply with exactly the word: pong-again");

        expect(resumed.status).toBe("completed");
        expect(resumed.agentSessionId).toBe(outcome.agentSessionId ?? "");
        expect(resumed.continuity?.verified).toBe(true);
        expect(resumed.continuity?.method).toBe("session-id-match");
      } finally {
        await fs.rm(cwd, { recursive: true, force: true });
      }
    },
    180_000,
  );
});
