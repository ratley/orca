---
date: 2026-02-19T14:31:00Z
session: codex-as-executor
agent: eve
---

## Built
- Codex is now the default executor for task execution (was Claude, which was wrong)
- Persistent Codex session per run: one createCodexSession() at start, shared across all tasks, disconnected in finally block
- Claude fallback: if Codex session init fails, falls back to Claude with a warning
- executor?: "claude" | "codex" in OrcaConfig — opt-in to Claude via orca.config.js if needed
- Test mock path completely separated from real executor logic (null check on testExecuteTaskOverride before Codex session creation)

## Changed
- `src/core/task-runner.ts` | replaced executeTaskImpl module var with testExecuteTaskOverride (null default); added buildExecutor logic; Codex session created once per run; finally block disconnects session
- `src/types/index.ts` | executor?: "claude" | "codex" added to OrcaConfig
- `src/core/config-loader.ts` | executor added to TOP_LEVEL_SCALARS merge

## Auth clarification (important)
- Claude agent SDK uses Claude Code OAuth token (~/.claude/) — NOT ANTHROPIC_API_KEY
- Codex uses ~/.codex/auth.json — NOT OPENAI_API_KEY
- OpenClaw uses regular ANTHROPIC_API_KEY — separate pool
- No key conflict ever existed; rate limit was Claude Code subscription limits

## Notes
- 172 tests passing, 0 failures
- No test changes needed — test mocks bypass Codex session creation entirely
