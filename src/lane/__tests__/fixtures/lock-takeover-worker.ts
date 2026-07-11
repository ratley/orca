/**
 * Multi-process stale-lock takeover worker (finding 11 regression).
 *
 * Appends one progress event to the lane named by argv[2] using a fresh
 * LaneStore (ORCA_HOME comes from the environment), then prints the assigned
 * seq as a single JSON line. Several of these run simultaneously against a
 * planted stale lane.lock to exercise recovery-gate serialization for real,
 * across process boundaries.
 */
import { LaneStore } from "../../store";

async function main(): Promise<void> {
  const laneId = process.argv[2];
  if (laneId === undefined) {
    throw new Error("usage: lock-takeover-worker.ts <laneId>");
  }

  const store = new LaneStore();
  const event = await store.appendEvent(laneId, {
    event: "progress",
    data: { workerPid: process.pid },
  });
  process.stdout.write(`${JSON.stringify({ seq: event.seq })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${String(error)}\n`);
  process.exit(1);
});
