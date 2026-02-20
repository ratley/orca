#!/usr/bin/env node
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

const logPath = process.argv[2];
if (!logPath) {
  console.error("usage: record-command-hook.mjs <log-path>");
  process.exit(2);
}

let stdin = "";
for await (const chunk of process.stdin) {
  stdin += chunk.toString();
}

const payload = JSON.parse(stdin);
const payloadEnvKeys = [
  "ORCA_HOOK",
  "ORCA_MSG",
  "ORCA_RUN_ID",
  "ORCA_TASK_ID",
  "ORCA_TASK_NAME",
  "ORCA_ERROR"
].filter((key) => process.env[key] !== undefined);

const record = {
  source: "command",
  hook: payload.hook,
  runId: payload.runId,
  message: payload.message,
  hasPayloadEnv: payloadEnvKeys.length > 0,
  payloadEnvKeys,
  timestamp: new Date().toISOString()
};

await mkdir(path.dirname(logPath), { recursive: true });
await appendFile(logPath, `${JSON.stringify(record)}\n`, "utf8");
