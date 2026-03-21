import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "bun:test";

import type { Task } from "../../types/index.js";

const CODEX_PATHS = [
  "/Applications/Codex.app/Contents/Resources/codex",
  Bun.which("codex"),
  "/opt/homebrew/bin/codex",
  "/usr/local/bin/codex",
].filter(Boolean) as string[];

const codexPath = CODEX_PATHS.find((candidate) => existsSync(candidate)) ?? null;
const sessionModulePath = path.resolve(import.meta.dir, "session.ts");

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    name: "Write test marker file",
    description:
      "Write the string 'orca-codex-integration-test' to /tmp/orca-codex-test-marker.txt. " +
      "Use any available shell command (e.g. echo or printf). " +
      "Verify the file was written by reading it back. " +
      "When complete, output your result JSON on the final line.",
    dependencies: [],
    acceptance_criteria: [
      "File /tmp/orca-codex-test-marker.txt exists",
      "File contains the string 'orca-codex-integration-test'",
    ],
    status: "pending",
    retries: 0,
    maxRetries: 3,
    ...overrides,
  };
}

function runCodexIntegrationSnippet(snippet: string): { exitCode: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync({
    cmd: ["bun", "--eval", snippet],
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      ORCA_CODEX_PATH: codexPath ?? "",
    },
  });

  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString("utf8"),
    stderr: proc.stderr.toString("utf8"),
  };
}

if (!codexPath) {
  test("codex adapter integration skipped (codex binary not found)", () => {
    expect(codexPath).toBeNull();
  });
} else {
  describe("Codex adapter integration (createCodexSession)", () => {
    test("creates session, executes a simple task, and disconnects", () => {
      const task = JSON.stringify(makeTask());
      const { exitCode, stdout, stderr } = runCodexIntegrationSnippet(`
        import { createCodexSession } from ${JSON.stringify(sessionModulePath)};
        const task = ${task};
        const session = await createCodexSession("/tmp");
        try {
          const result = await session.executeTask(task, "test-run-id");
          console.log(JSON.stringify({
            threadId: session.threadId,
            outcome: result.outcome,
            rawLength: result.rawResponse.length,
          }));
        } finally {
          await session.disconnect();
        }
      `);

      expect(exitCode).toBe(0);
      expect(stderr).toBe("");

      const parsed = JSON.parse(stdout.trim()) as {
        threadId: string;
        outcome: string;
        rawLength: number;
      };
      expect(parsed.threadId.length).toBeGreaterThan(0);
      expect(parsed.outcome === "done" || parsed.outcome === "failed").toBe(true);
      expect(parsed.rawLength).toBeGreaterThan(0);
    }, 300_000);

    test("consultTaskGraph returns valid ConsultationResult", () => {
      const tasks = JSON.stringify([
        makeTask({ id: "task-1", name: "Create file", dependencies: [] }),
        makeTask({ id: "task-2", name: "Read file", dependencies: ["task-1"] }),
      ]);
      const { exitCode, stdout, stderr } = runCodexIntegrationSnippet(`
        import { createCodexSession } from ${JSON.stringify(sessionModulePath)};
        const tasks = ${tasks};
        const session = await createCodexSession("/tmp");
        try {
          const result = await session.consultTaskGraph(tasks);
          console.log(JSON.stringify(result));
        } finally {
          await session.disconnect();
        }
      `);

      expect(exitCode).toBe(0);
      expect(stderr).toBe("");

      const parsed = JSON.parse(stdout.trim()) as {
        issues: unknown[];
        ok: boolean;
      };
      expect(Array.isArray(parsed.issues)).toBe(true);
      expect(typeof parsed.ok).toBe("boolean");
    }, 300_000);
  });
}
