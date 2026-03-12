import { existsSync } from "node:fs";
import { describe, expect, test } from "bun:test";

import type { Task } from "../../types/index.js";
import { createCodexSession } from "./session.js";

// Try common locations for the codex binary
const CODEX_PATHS = [
  "/Applications/Codex.app/Contents/Resources/codex",
  Bun.which("codex"),
  "/opt/homebrew/bin/codex",
  "/usr/local/bin/codex",
].filter(Boolean) as string[];

const codexPath = CODEX_PATHS.find((p) => existsSync(p)) ?? null;

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

if (!codexPath) {
  test("codex adapter integration skipped (codex binary not found)", () => {
    // Guard: skip gracefully when codex is not installed
    expect(codexPath).toBeNull();
  });
} else {
  describe("Codex adapter integration (createCodexSession)", () => {
    test("creates session, executes a simple task, and disconnects", async () => {
      const session = await createCodexSession("/tmp");

      try {
        expect(typeof session.threadId).toBe("string");
        expect(session.threadId.length).toBeGreaterThan(0);

        const result = await session.executeTask(makeTask(), "test-run-id");

        expect(result.outcome === "done" || result.outcome === "failed").toBe(true);
        expect(typeof result.rawResponse).toBe("string");
        expect(result.rawResponse.length).toBeGreaterThan(0);

        console.log(`executeTask outcome: ${result.outcome}`);
        console.log(`rawResponse length: ${result.rawResponse.length}`);
      } finally {
        await session.disconnect();
      }
    }, 300_000);

    test("consultTaskGraph returns valid ConsultationResult", async () => {
      const session = await createCodexSession("/tmp");

      try {
        const tasks: Task[] = [
          makeTask({ id: "task-1", name: "Create file", dependencies: [] }),
          makeTask({ id: "task-2", name: "Read file", dependencies: ["task-1"] }),
        ];

        const result = await session.consultTaskGraph(tasks);

        expect(Array.isArray(result.issues)).toBe(true);
        expect(typeof result.ok).toBe("boolean");

        console.log(`Consultation ok: ${result.ok}`);
        console.log(`Issues: ${JSON.stringify(result.issues)}`);
      } finally {
        await session.disconnect();
      }
    }, 300_000);

    test("reviewChanges returns a string", async () => {
      const session = await createCodexSession("/tmp");

      try {
        const review = await session.reviewChanges();
        expect(typeof review).toBe("string");
        console.log(`Review length: ${review.length}`);
      } finally {
        await session.disconnect();
      }
    }, 300_000);
  });
}
