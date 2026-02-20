#!/usr/bin/env node
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");
const smokeRoot = path.join(repoRoot, "tmp", "hook-smoke");
const logPath = path.join(smokeRoot, "events.jsonl");
const commandHookScript = path.join(repoRoot, "specs", "smoke", "hooks", "record-command-hook.mjs");

const { HookDispatcher } = await import(path.join(repoRoot, "dist", "hooks", "dispatcher.js"));

const repoFixtures = [
  "/Users/evesenara/code/orca-smoke-projects/node-tooling",
  "/Users/evesenara/code/orca-smoke-projects/python-tooling",
  "/Users/evesenara/code/orca-smoke-projects/docs-only"
];

const allHooks = [
  "onMilestone",
  "onTaskComplete",
  "onTaskFail",
  "onInvalidPlan",
  "onFindings",
  "onComplete",
  "onError"
];

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function appendRecord(record) {
  const line = `${JSON.stringify(record)}\n`;
  await appendFile(logPath, line, "utf8");
}

async function buildDispatcher() {
  const dispatcher = new HookDispatcher({
    commandHooks: Object.fromEntries(allHooks.map((hook) => [hook, `node ${JSON.stringify(commandHookScript)} ${JSON.stringify(logPath)}`]))
  });

  for (const hook of allHooks) {
    dispatcher.on(hook, async (event, context) => {
      await appendRecord({
        source: "function",
        hook: event.hook,
        runId: event.runId,
        message: event.message,
        context,
        timestamp: new Date().toISOString()
      });
    });
  }

  return dispatcher;
}

async function runExecutionFlow(dispatcher, runId, repoPath, failureMode) {
  await dispatcher.dispatch({ hook: "onMilestone", runId, message: "execution-started", timestamp: new Date().toISOString(), metadata: { repoPath } });
  await delay(15);
  await dispatcher.dispatch({ hook: "onMilestone", runId, message: "planning-complete", timestamp: new Date().toISOString(), metadata: { repoPath } });
  await delay(10);

  if (failureMode === "invalid-plan") {
    await dispatcher.dispatch({ hook: "onInvalidPlan", runId, message: "invalid-plan:review", timestamp: new Date().toISOString(), error: "Cycle in DAG", metadata: { stage: "review", repoPath } });
    await dispatcher.dispatch({ hook: "onError", runId, message: "run-failed:invalid-plan", timestamp: new Date().toISOString(), error: "Cycle in DAG", metadata: { repoPath } });
    return;
  }

  await dispatcher.dispatch({ hook: "onTaskComplete", runId, taskId: `${runId}-t1`, taskName: "bootstrap", message: "task-complete:bootstrap", timestamp: new Date().toISOString(), metadata: { repoPath } });
  await delay(10);

  if (failureMode === "task-fail") {
    await dispatcher.dispatch({ hook: "onTaskFail", runId, taskId: `${runId}-t2`, taskName: "tests", message: "task-fail:tests", timestamp: new Date().toISOString(), error: "unit test failed", metadata: { repoPath } });
    await dispatcher.dispatch({ hook: "onError", runId, message: "run-failed:task", timestamp: new Date().toISOString(), error: "unit test failed", metadata: { repoPath } });
    return;
  }

  await dispatcher.dispatch({ hook: "onFindings", runId, message: "post-review found 1 issue", timestamp: new Date().toISOString(), metadata: { findingsCount: 1, repoPath } });
  await delay(10);
  await dispatcher.dispatch({ hook: "onTaskComplete", runId, taskId: `${runId}-t2`, taskName: "fixes", message: "task-complete:fixes", timestamp: new Date().toISOString(), metadata: { repoPath } });
  await dispatcher.dispatch({ hook: "onMilestone", runId, message: "execution-completed", timestamp: new Date().toISOString(), metadata: { repoPath } });
  await dispatcher.dispatch({ hook: "onComplete", runId, message: "run-completed", timestamp: new Date().toISOString(), metadata: { repoPath } });
}

function summarize(records) {
  const byRun = new Map();
  for (const r of records) {
    if (!byRun.has(r.runId)) byRun.set(r.runId, []);
    byRun.get(r.runId).push(r);
  }
  return byRun;
}

async function main() {
  await rm(smokeRoot, { recursive: true, force: true });
  await mkdir(smokeRoot, { recursive: true });
  await writeFile(logPath, "", "utf8");

  const dispatcher = await buildDispatcher();

  // Sequential round across 3 stack shapes.
  await runExecutionFlow(dispatcher, "seq-node", repoFixtures[0], null);
  await runExecutionFlow(dispatcher, "seq-python", repoFixtures[1], "task-fail");
  await runExecutionFlow(dispatcher, "seq-docs", repoFixtures[2], "invalid-plan");

  // Overlapping round with concurrency.
  await Promise.all([
    runExecutionFlow(dispatcher, "con-node", repoFixtures[0], null),
    runExecutionFlow(dispatcher, "con-python", repoFixtures[1], "task-fail"),
    runExecutionFlow(dispatcher, "con-docs", repoFixtures[2], "invalid-plan")
  ]);

  const raw = (await readFile(logPath, "utf8")).trim();
  const records = raw.length === 0 ? [] : raw.split("\n").map((line) => JSON.parse(line));

  const commandRecords = records.filter((r) => r.source === "command");
  const functionRecords = records.filter((r) => r.source === "function");
  // Backward-compatibility: command hooks may receive legacy ORCA_* payload env vars
  // while stdin JSON remains the primary transport.

  const runs = summarize(records);
  const expectedRunIds = ["seq-node", "seq-python", "seq-docs", "con-node", "con-python", "con-docs"];
  for (const runId of expectedRunIds) {
    if (!runs.has(runId)) {
      throw new Error(`missing hook records for run ${runId}`);
    }

    const runRecords = runs.get(runId);
    const runFunctionCount = runRecords.filter((r) => r.source === "function").length;
    const runCommandCount = runRecords.filter((r) => r.source === "command").length;
    if (runFunctionCount !== runCommandCount) {
      throw new Error(`function/command hook count mismatch for ${runId}: ${runFunctionCount} vs ${runCommandCount}`);
    }
  }

  console.log(`Smoke OK: ${records.length} hook records (${functionRecords.length} function, ${commandRecords.length} command)`);
  console.log(`Log: ${logPath}`);
}

await main();
