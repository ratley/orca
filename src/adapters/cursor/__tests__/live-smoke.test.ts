import { describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

import type { LaneRecord } from "../../../types/lane";
import { CursorAdapter } from "../adapter";

/**
 * Live smoke against the real Cursor CLI. Costs tokens and 10-100s of wall
 * time, so it only runs when ORCA_LIVE_CURSOR === "1":
 *
 *   ORCA_LIVE_CURSOR=1 bun test src/adapters/cursor
 */
const live = process.env.ORCA_LIVE_CURSOR === "1";
const liveDescribe = live ? describe : describe.skip;

liveDescribe("cursor live smoke", () => {
  test("dispatch binds a session and resume verifies continuity", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "orca-cursor-live-"));
    const adapter = new CursorAdapter();

    try {
      const outcome = await adapter.dispatch({
        laneId: "lane_live0001",
        prompt: "Reply with exactly the word: pong",
        cwd,
        model: "gpt-5-mini",
        timeoutMs: 240_000,
      });

      expect(outcome.status).toBe("completed");
      expect(outcome.delivery).toBe("confirmed");
      expect(outcome.nativeStatus).toBe("completed");
      expect(outcome.semanticOutcome).toBe("unknown");
      expect(outcome.agentSessionId).toBeString();
      expect(outcome.timing?.wallMs).toBeGreaterThan(0);

      const lane: LaneRecord = {
        id: "lane_live0001",
        agent: "cursor",
        cwd,
        model: "gpt-5-mini",
        agentSessionId: outcome.agentSessionId as string,
        status: "running",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        seq: 1,
      };

      const resumed = await adapter.resume(lane, "Reply with exactly the word: pong");
      expect(resumed.status).toBe("completed");
      expect(resumed.agentSessionId).toBe(lane.agentSessionId);
      expect(resumed.continuity?.verified).toBe(true);
      expect(resumed.continuity?.method).toBe("session-id-match");
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  }, 600_000);
});
