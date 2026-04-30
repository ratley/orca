import { select } from "@inquirer/prompts";

import type { RunStore } from "../state/store.js";

export async function selectRun(store: RunStore): Promise<string | null> {
  if (!process.stdout.isTTY) {
    return null;
  }

  const runs = await store.listRuns();
  if (runs.length === 0) {
    console.error("No runs found.");
    return null;
  }

  const sorted = [...runs].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const choices = sorted.map((run) => {
    const prStatus = run.pr?.url ? (run.pr.finalizedAt ? "published" : "draft PR") : "no PR";
    const label = `${run.runId}  [${run.overallStatus}]  ${prStatus}`;

    return { name: label, value: run.runId };
  });

  return select({ message: "Select a run:", choices });
}
