import path from "node:path";
import { promises as fs } from "node:fs";

import type { LaneRecord } from "../../../types/lane";
import { getSessionDir } from "../chats";
import type { ExecFn, ExecRequest, ExecResult } from "../exec";
import { BENIGN_STDERR, SUCCESS_STDOUT } from "./fixtures.test";

export interface FakeExec {
  exec: ExecFn;
  calls: ExecRequest[];
}

/** Fake exec layer that records calls and replays a handler's result. */
export function createFakeExec(
  handler: (req: ExecRequest) => ExecResult | Promise<ExecResult>,
): FakeExec {
  const calls: ExecRequest[] = [];
  const exec: ExecFn = async (req) => {
    calls.push(req);
    req.onSpawn?.({ pid: 1234, pgid: 1234, kill: async () => true });
    return handler(req);
  };

  return { exec, calls };
}

export function execResult(overrides: Partial<ExecResult> = {}): ExecResult {
  return {
    exitCode: 0,
    stdout: SUCCESS_STDOUT,
    stderr: BENIGN_STDERR,
    timedOut: false,
    killed: false,
    aborted: false,
    overCap: false,
    termination: "verified_gone",
    ...overrides,
  };
}

export function makeLane(overrides: Partial<LaneRecord> = {}): LaneRecord {
  return {
    id: "lane_deadbeef",
    agent: "cursor",
    cwd: "/tmp/fake-project",
    status: "running",
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z",
    seq: 1,
    ...overrides,
  };
}

/** Seeds a session dir + meta.json into a (temp) cursor home. */
export async function seedSession(
  cursorHome: string,
  cwd: string,
  sessionId: string,
  meta: Record<string, unknown>,
): Promise<void> {
  const dir = getSessionDir(cursorHome, cwd, sessionId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "meta.json"), JSON.stringify(meta), "utf8");
}

export async function rewriteSessionMeta(
  cursorHome: string,
  cwd: string,
  sessionId: string,
  meta: Record<string, unknown>,
): Promise<void> {
  await fs.writeFile(
    path.join(getSessionDir(cursorHome, cwd, sessionId), "meta.json"),
    JSON.stringify(meta),
    "utf8",
  );
}
