import { afterAll, describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

import { LaneStore } from "../../../lane/store";
import { CodexAdapter } from "../adapter";
import type { CodexDispatchRequest } from "../adapter";

/**
 * Optional live smoke test against a real `codex app-server`. Skipped unless
 * ORCA_LIVE_CODEX=1 (requires the codex CLI on PATH and an authenticated
 * account; spawns a real agent turn).
 */
const LIVE = process.env.ORCA_LIVE_CODEX === "1";

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("codex adapter live smoke", () => {
  test.skipIf(!LIVE)(
    "dispatches a trivial read-only prompt end to end",
    async () => {
      const orcaHome = await fs.mkdtemp(path.join(os.tmpdir(), "orca-codex-live-home-"));
      const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "orca-codex-live-cwd-"));
      tempDirs.push(orcaHome, cwd);

      const store = new LaneStore(orcaHome);
      const lane = await store.createLane({ agent: "codex", cwd });
      const adapter = new CodexAdapter({ store });

      // The CLI event sink owns persistence; driving the adapter directly
      // means events only flow through onEvent, so collect them here.
      const emitted: string[] = [];
      const req: CodexDispatchRequest = {
        laneId: lane.id,
        prompt: "Reply with exactly the word: ok",
        cwd,
        readOnly: true,
        timeoutMs: 150_000,
        onEvent: async (event) => {
          emitted.push(event.event);
        },
      };
      const outcome = await adapter.dispatch(req);

      expect(outcome.status).toBe("completed");
      expect(outcome.nativeStatus).toBe("completed");
      expect(outcome.delivery).toBe("confirmed");
      expect(outcome.semanticOutcome).toBe("unknown");
      expect(outcome.agentSessionId).toBeDefined();
      expect(outcome.result?.text.length).toBeGreaterThan(0);

      // Terminal events are the CLI settlement's to persist; the adapter
      // hook only carries non-terminal evidence plus the returned outcome.
      expect(emitted[0]).toBe("agent_started");
      expect(emitted).not.toContain("result");
      expect(emitted).not.toContain("failed");

      const persisted = await store.readEvents(lane.id);
      expect(persisted.map((event) => event.event)).toEqual(["created"]);
    },
    180_000,
  );
});
