import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { PendingAnswerChannel, RunId } from "../types/index.js";

function getSecretAnswerChannelsDir(): string {
  return path.join(os.homedir(), ".orca", "runtime", "answer-channels");
}

function getSecretAnswerChannelFilePath(runId: RunId): string {
  return path.join(getSecretAnswerChannelsDir(), `${runId}.json`);
}

export async function writeSecretAnswerChannel(runId: RunId, channel: PendingAnswerChannel): Promise<void> {
  const channelsDir = getSecretAnswerChannelsDir();
  const channelFile = getSecretAnswerChannelFilePath(runId);
  const tempFile = `${channelFile}.${process.pid}.${Date.now()}.tmp`;
  const payload = JSON.stringify(channel);

  await mkdir(channelsDir, { recursive: true, mode: 0o700 });
  await writeFile(tempFile, payload, { encoding: "utf8", mode: 0o600 });
  await rename(tempFile, channelFile);
}

export async function readSecretAnswerChannel(runId: RunId): Promise<PendingAnswerChannel | null> {
  const channelFile = getSecretAnswerChannelFilePath(runId);

  let raw: string;
  try {
    raw = await readFile(channelFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw error;
  }

  const parsed = JSON.parse(raw) as Partial<PendingAnswerChannel>;
  if (
    parsed.transport !== "ipc" ||
    typeof parsed.path !== "string" ||
    parsed.path.length === 0 ||
    typeof parsed.token !== "string" ||
    parsed.token.length === 0
  ) {
    throw new Error(`invalid secret answer channel metadata for run ${runId}`);
  }

  return {
    transport: "ipc",
    path: parsed.path,
    token: parsed.token,
  };
}

export async function clearSecretAnswerChannel(runId: RunId): Promise<void> {
  await rm(getSecretAnswerChannelFilePath(runId), { force: true });
}
