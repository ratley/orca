import path from "node:path";
import { promises as fs } from "node:fs";

import { input } from "@inquirer/prompts";
import type { Command } from "commander";

import { RunStore } from "../../state/store.js";
import { selectRun } from "../../utils/select-run.js";

export interface AnswerCommandOptions {
  run?: string;
}

function createStore(): RunStore {
  const runsDir = process.env.ORCA_RUNS_DIR;
  return runsDir ? new RunStore(runsDir) : new RunStore();
}

function resolveRunId(positionalRunId: string | undefined, optionRunId: string | undefined): string | undefined {
  if (positionalRunId && optionRunId) {
    throw new Error("positional run-id and --run are mutually exclusive");
  }

  return positionalRunId ?? optionRunId;
}

async function resolveAnswer(answerArg: string | undefined): Promise<string> {
  if (answerArg) {
    return answerArg;
  }

  if (!process.stdout.isTTY) {
    throw new Error("no answer provided");
  }

  const value = await input({ message: "Answer:" });
  if (!value) {
    throw new Error("no answer provided");
  }

  return value;
}

export async function answerCommandHandler(
  positionalRunId: string | undefined,
  answerArg: string | undefined,
  options: AnswerCommandOptions
): Promise<void> {
  const store = createStore();
  let runId = resolveRunId(positionalRunId, options.run);

  if (!runId) {
    if (!process.stdout.isTTY) {
      throw new Error("no run id provided");
    }

    runId = await selectRun(store) ?? undefined;
    if (!runId) {
      console.error("No runs found.");
      process.exitCode = 1;
      return;
    }
  }

  const run = await store.getRun(runId);
  if (!run) {
    console.error(`Run not found: ${runId}`);
    process.exitCode = 1;
    return;
  }

  if (run.overallStatus !== "waiting_for_answer") {
    console.error(`Run ${runId} is not waiting for an answer (status: ${run.overallStatus}).`);
    process.exitCode = 1;
    return;
  }

  const answer = await resolveAnswer(answerArg);
  const answerPath = path.join(store.getRunDir(runId), "answer.txt");
  await fs.mkdir(path.dirname(answerPath), { recursive: true });
  await fs.writeFile(answerPath, `${answer}\n`, "utf8");

  await store.updateRun(runId, { overallStatus: "running" });
  console.log(`Answer submitted. Run ${runId} will resume shortly.`);
}

export function registerAnswerCommand(program: Command): void {
  program
    .command("answer [run-id] [answer]")
    .description("Submit an answer for a run waiting for input")
    .option("--run <id>", "Run ID waiting for answer")
    .action(async (runId: string | undefined, answer: string | undefined, options: AnswerCommandOptions) => {
      try {
        await answerCommandHandler(runId, answer, options);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    });
}
