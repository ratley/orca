import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { planSpec } from "./session.js";

describe("claude planner adapter", () => {
  let tempDir = "";

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "orca-claude-planner-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("runs claude print mode with prompt over stdin", async () => {
    const fakeClaudePath = path.join(tempDir, "claude");
    const argsPath = path.join(tempDir, "args.txt");
    const stdinPath = path.join(tempDir, "stdin.txt");
    const tasksJson = JSON.stringify([
      {
        id: "task-1",
        name: "Plan task",
        description: "Do the work",
        dependencies: [],
        acceptance_criteria: ["done"],
        status: "pending",
        retries: 0,
        maxRetries: 3,
      },
    ]);

    await writeFile(
      fakeClaudePath,
      [
        "#!/bin/sh",
        `printf '%s\\n' "$@" > ${JSON.stringify(argsPath)}`,
        `cat > ${JSON.stringify(stdinPath)}`,
        `printf '%s\\n' ${JSON.stringify(tasksJson)}`,
      ].join("\n"),
      "utf8",
    );
    await chmod(fakeClaudePath, 0o755);

    const result = await planSpec("Build the thing", "System context", {
      claude: { command: fakeClaudePath, model: "claude-opus-4-7", effort: "high", timeoutMs: 1_000 },
    });

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]?.id).toBe("task-1");
    const args = await readFile(argsPath, "utf8");
    expect(args).toContain("-p");
    expect(args).toContain("--model\nclaude-opus-4-7");
    expect(args).toContain("--effort\nhigh");
    await expect(readFile(stdinPath, "utf8")).resolves.toContain("Build the thing");
  });
});
