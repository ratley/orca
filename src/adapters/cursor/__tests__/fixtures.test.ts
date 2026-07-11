/**
 * Fixtures recorded from the real Cursor CLI ("agent" 2026.07.09-a3815c0) on
 * 2026-07-11, macOS. The shapes are verbatim captures; only the bogus-model
 * "Available models" list is truncated (the real one lists ~180 models).
 */

export const SUCCESS_SESSION_ID = "be4a4bc2-bfcb-4acb-abeb-70762dd10dc4";

/**
 * agent -p --output-format json --trust --force --workspace <tmp>
 *   --model gpt-5-mini "Reply with exactly the word: pong"
 * -> exit 0, wall ~10.2s (warm), duration_ms 6751.
 */
export const SUCCESS_STDOUT = `{"type":"result","subtype":"success","is_error":false,"duration_ms":6751,"duration_api_ms":6751,"result":"pong","session_id":"${SUCCESS_SESSION_ID}","request_id":"beeeb1fc-7b31-4ce6-998d-c1d61ad254e8","usage":{"inputTokens":24312,"outputTokens":61,"cacheReadTokens":0,"cacheWriteTokens":0}}\n`;

/** Present on stderr for EVERY invocation, success and failure alike. */
export const BENIGN_STDERR = `cursor-retrieval: tracing to '/var/folders/9j/14s8h3fn0cx42hgz7my_jh3c0000gn/T/cursor_retrieval.0000001783780269.8787.log'\n`;

/**
 * agent -p --output-format json --trust --force --workspace <tmp>
 *   --model totally-bogus-model-xyz "hi"
 * -> exit 1, EMPTY stdout, diagnostic on stderr only.
 */
export const BOGUS_MODEL_STDERR = `${BENIGN_STDERR}Cannot use this model: totally-bogus-model-xyz. Available models: auto, gpt-5.3-codex, gpt-5.2, composer-2.5, claude-fable-5-high, gemini-3.1-pro, gpt-5-mini, glm-5.2-max\n`;

/**
 * agent -p --output-format json --workspace <untrusted tmp> "hi"
 * (no --trust) -> exit 1, EMPTY stdout.
 */
export const MISSING_TRUST_STDERR = `${BENIGN_STDERR}
⚠ Workspace Trust Required

  Cursor Agent can execute code and access files in this directory.
  Do you trust the contents of this directory?

    /private/tmp/example-workspace

  To proceed, you can either:
    • Run 'agent' interactively to decide
    • Pass --trust, --yolo, or -f if you trust this directory
`;

/** Banner that can precede the JSON result line when -w/--worktree is used. */
export const WORKTREE_BANNER = "Using worktree: /Users/example/.cursor/worktrees/orca/lane-test";

/**
 * Real on-disk meta.json shape from ~/.cursor/chats/<md5(cwd)>/<session_id>/,
 * captured 2026-07-11 (values anonymized).
 */
export function sessionMetaFixture(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    createdAtMs: 1783780270140,
    hasConversation: true,
    updatedAtMs: 1783780279051,
    ...overrides,
  };
}

/** Builds a result JSON line matching the recorded shape, with overrides. */
export function successLine(overrides: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 100,
    duration_api_ms: 100,
    result: "done",
    session_id: SUCCESS_SESSION_ID,
    request_id: "req-fixture-1",
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
    ...overrides,
  })}\n`;
}
