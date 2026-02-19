import type { RunStore } from "../state/store.js";
import type { RunStatus } from "../types/index.js";

export async function getLastRun(store: RunStore): Promise<RunStatus | null> {
  const runs = await store.listRuns();
  if (runs.length === 0) {
    return null;
  }

  return runs.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0] ?? null;
}
