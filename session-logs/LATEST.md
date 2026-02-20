---
date: 2026-02-20T05:02:00Z
session: orca-task-1771562873742-1593c106-afbf-401d-8f4e-b52751348464-1771562873744-c331
agent: orca (orchestrated by eve)
---

## Implemented
- Added executor override flags on run entrypoints:
  - `--codex-only`
  - `--claude-only`
- Added early conflict validation:
  - Throws error if both flags are passed together.
- Wired override through planning pipeline:
  - Planner now selects planning adapter based on effective `executor` (`codex` default, `claude` when set).
- Wired override through execution pipeline:
  - `run` now uses effective per-run config for task execution.
  - Codex consultation/review path only runs when effective executor is `codex`.
  - `resume` now resolves config and applies the same override before execution.

## Changed
- `src/cli/commands/run.ts`
  - Added flag options, conflict checks, per-run effective executor override, and conditional codex-only execution path.
- `src/cli/commands/resume.ts`
  - Added flag options, conflict checks, config resolution, and per-run effective executor override passed to runner.
- `src/core/planner.ts`
  - Planner now resolves plan adapter by executor (`codex`/`claude`) with test override support preserved.
- `src/cli/commands/help.ts`
  - Added help entries for `--codex-only` and `--claude-only`.
- `src/cli/commands/run.test.ts`
  - Added/updated tests for parsing, conflict validation, override behavior, and config immutability.

## Flag Usage
- `orca run --spec ./spec.md --codex-only`
  - Forces codex for this run’s planning and execution.
- `orca run --spec ./spec.md --claude-only`
  - Forces claude for this run’s planning and execution.
- `orca resume --run <id> --codex-only`
  - Forces codex executor for resumed execution.
- `orca resume --run <id> --claude-only`
  - Forces claude executor for resumed execution.
- `--codex-only` and `--claude-only` are mutually exclusive.
- Override precedence:
  - CLI flag override > config file executor > default (`codex`).
- Scope:
  - Override is in-memory for the current command only.
  - No mutation of project/global config files.

## Validation
- `npm run build`: pass.
- Focused tests:
  - `bun test src/core/planner.test.ts`: pass.
  - `bun test src/core/task-runner.test.ts src/core/planner.test.ts`: pass.
  - `bun test src/cli/commands/run.test.ts`: pass.
- Full suite (`bun test`) currently has unrelated/unstable failures and warnings in this environment.

## Caveats / Notes
- Full `bun test` run still reports warnings and a few failures:
  - Network-dependent codex session integration tests may fail with stream disconnect.
  - Existing stdout adapter test instability observed in source test path.
  - One no-flag executor expectation in `run.test.ts` failed under full-suite conditions (passes in isolated run).
- Test runner executes both `src/**/*.test.ts` and `dist/**/*.test.js`, which can duplicate suites and increase flake/noise.
