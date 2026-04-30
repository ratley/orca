import { describe, expect, mock, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { createRunCommandTestHarness } from "./run-command.test-harness.js";

const harness = createRunCommandTestHarness("orca-postexec-json-test-");
const { loadRunModule, parseRun, getTempDir } = harness;

describe("post-exec reviewer JSON hardening integration", () => {
  test("invalid reviewer JSON retries once and succeeds with structured output", async () => {
    const { runModule, createCodexSessionMock } = await loadRunModule();
    const runPromptMock = mock(async () => "not-json");
    runPromptMock.mockImplementationOnce(async () => "not-json");
    runPromptMock.mockImplementationOnce(async () => '{"summary":"clean","findings":[],"fixed":false}');

    createCodexSessionMock.mockImplementationOnce(async () => ({
      consultTaskGraph: async () => ({ issues: [], ok: true }),
      executeTask: async () => ({ outcome: "done" as const, rawResponse: '{"outcome":"done"}' }),
      runPrompt: runPromptMock,
      reviewChanges: async () => "review",
      disconnect: async () => {},
    }));

    const configPath = path.join(getTempDir(), "orca.config.js");
    await writeFile(
      configPath,
      "export default { review: { execution: { onFindings: 'report_only', validator: { auto: false } } } };\n",
      "utf8",
    );

    await parseRun(runModule, ["run", "--task", "x", "--config", configPath]);

    expect(runPromptMock).toHaveBeenCalledTimes(2);
    expect(runPromptMock).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("previous post-execution review response was invalid"),
      "review",
    );
  });

  test("schema-invalid reviewer payload retries once and succeeds", async () => {
    const { runModule, createCodexSessionMock } = await loadRunModule();
    const runPromptMock = mock(async () => '{"summary":"missing fixed","findings":[]}');
    runPromptMock.mockImplementationOnce(async () => '{"summary":"missing fixed","findings":[]}');
    runPromptMock.mockImplementationOnce(async () => '{"summary":"clean","findings":[],"fixed":false}');

    createCodexSessionMock.mockImplementationOnce(async () => ({
      consultTaskGraph: async () => ({ issues: [], ok: true }),
      executeTask: async () => ({ outcome: "done" as const, rawResponse: '{"outcome":"done"}' }),
      runPrompt: runPromptMock,
      reviewChanges: async () => "review",
      disconnect: async () => {},
    }));

    const configPath = path.join(getTempDir(), "orca.config.js");
    await writeFile(
      configPath,
      "export default { review: { execution: { onFindings: 'report_only', validator: { auto: false } } } };\n",
      "utf8",
    );

    await parseRun(runModule, ["run", "--task", "x", "--config", configPath]);

    expect(runPromptMock).toHaveBeenCalledTimes(2);
    expect(runPromptMock).toHaveBeenNthCalledWith(2, expect.stringContaining("Schema validation failed"), "review");
  });

  test("invalid reviewer JSON after bounded retries is treated as findings and dispatches onFindings", async () => {
    const { runModule, createCodexSessionMock, hookDispatchMock } = await loadRunModule();
    const runPromptMock = mock(async () => "still-not-json");
    createCodexSessionMock.mockImplementationOnce(async () => ({
      consultTaskGraph: async () => ({ issues: [], ok: true }),
      executeTask: async () => ({ outcome: "done" as const, rawResponse: '{"outcome":"done"}' }),
      runPrompt: runPromptMock,
      reviewChanges: async () => "review",
      disconnect: async () => {},
    }));

    const configPath = path.join(getTempDir(), "orca.config.js");
    await writeFile(
      configPath,
      "export default { review: { execution: { onFindings: 'report_only', validator: { auto: false } } } };\n",
      "utf8",
    );

    await parseRun(runModule, ["run", "--task", "x", "--config", configPath]);

    const findingsEvent = hookDispatchMock.mock.calls.find(
      (call) => (call[0] as { hook?: string })?.hook === "onFindings",
    )?.[0] as { message?: string; metadata?: { findingsCount?: number } } | undefined;

    expect(runPromptMock).toHaveBeenCalledTimes(2);
    expect(findingsEvent?.metadata?.findingsCount).toBe(1);
    expect(findingsEvent?.message).toContain("invalid JSON after 2 attempts");
  });
});
