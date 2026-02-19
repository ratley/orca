---
date: 2026-02-19T09:10:00Z
session: run-last-flag
agent: codex
---

## Built
- Added `--last` support to all run-scoped CLI commands and PR subcommands.
- Added reusable `getLastRun(store)` utility for resolving the newest run by `createdAt`.

## Changed
- `src/utils/last-run.ts` | New helper to return newest run or `null`.
- `src/utils/last-run.test.ts` | Added tests for empty store and newest-run selection.
- `src/cli/commands/pr/shared.ts` | Added `last?: boolean`; `resolveRunIdOrExit` now prioritizes `--last`.
- `src/cli/commands/pr/draft.ts` | Added `.option('--last', 'Use the most recent run')`.
- `src/cli/commands/pr/create.ts` | Added `.option('--last', 'Use the most recent run')`.
- `src/cli/commands/pr/publish.ts` | Added `.option('--last', 'Use the most recent run')`.
- `src/cli/commands/pr/status.ts` | Added `.option('--last', 'Use the most recent run')`.
- `src/cli/commands/status.ts` | Added `last?: boolean`, `--last` option, and handler resolution logic.
- `src/cli/commands/resume.ts` | Added `last?: boolean`, `--last` option, and handler resolution logic.
- `src/cli/commands/cancel.ts` | Added `last?: boolean`, `--last` option, and handler resolution logic.

## Tests
- `bun test` | 104 pass, 0 fail.

## Decisions
- Kept `pr/index.ts` no-subcommand interactive behavior unchanged; `--last` remains subcommand-scoped.
- Printed `No runs found.` and exited with code 1 when `--last` is used with no runs.

## Next
1. Add command-level tests for `--last` paths in `status`, `resume`, and `cancel` handlers.

## Blockers
- none
