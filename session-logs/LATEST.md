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

## Update: Claude fenced-JSON parsing fix (2026-02-19 PST)

### What changed
- Added robust shared JSON parser for agent responses:
  - `src/utils/agent-json.ts`
  - Handles:
    - raw JSON
    - fenced ` ```json ... ``` `
    - fenced ` ``` ... ``` `
    - prose-wrapped responses by extracting the first valid JSON object/array
- Updated Claude adapter parsing to use shared parser at both critical points:
  - `src/agents/claude/session.ts`
    - `parseTaskArray(...)`
    - `parseTaskExecution(...)`
- Added tests:
  - `src/utils/agent-json.test.ts`
  - `src/agents/claude/session.test.ts`

### Targeted validation
- `bun test src/utils/agent-json.test.ts src/agents/claude/session.test.ts` → pass (7/7)
- `npm run build` → pass

### Smoke tests (temp repo)
- Conflict guard:
  - `node dist/cli/index.js run --task spec.md --codex-only --claude-only`
  - Result: fast-fail with mutual-exclusion error (expected)
- Codex-only small task:
  - `node dist/cli/index.js run --task "Write a file named codex-smoke.txt containing exactly: codex-ok" --codex-only`
  - Result: completed
- Claude-only small task:
  - `node dist/cli/index.js run --task "Write a file named claude-smoke.txt containing exactly: claude-ok" --claude-only`
  - Result: completed

### Outcome
- `--claude-only` now passes smoke end-to-end in this environment, including the previously failing fenced/prose JSON response shape.

## Update: Claude structured-output hardening (2026-02-19 PST, deterministic contracts)

### What changed
- `src/agents/claude/session.ts`
  - Kept Claude planner/task execution on Agent SDK structured output path (`outputFormat: { type: 'json_schema', schema }`).
  - Split explicit JSON Schemas into named constants:
    - `PLAN_OUTPUT_SCHEMA` (task-array/plan graph payload)
    - `EXECUTION_OUTPUT_SCHEMA` (task execution payload)
  - Enforced zod validation at receipt boundary for both structured payloads (defense in depth).
  - Removed freeform JSON parsing from default critical path.
  - Freeform fallback now requires explicit opt-in:
    - config: `config.claude.allowTextJsonFallback = true`
    - env: `ORCA_CLAUDE_ALLOW_TEXT_JSON_FALLBACK=1|true`
  - If fallback is used, logs a warning.
- `src/types/index.ts`
  - Added `claude.allowTextJsonFallback?: boolean` config flag.
- `src/agents/claude/session.test.ts`
  - Added contract tests for:
    - valid structured schema output
    - invalid structured shape hard-fails
    - markdown-fenced assistant text does not trigger parser when structured output exists
    - missing structured output hard-fails by default
    - fallback path is explicitly gated and still zod-validates

### Commands run (exact) + key results
- `bun test src/agents/claude/session.test.ts src/cli/commands/run.test.ts`
  - Result: **12 pass, 0 fail**
- `npm run build`
  - Result: **pass** (`tsc` + `postbuild`)
- Smoke tests requested:
  - `bun test src/cli/commands/run.test.ts -t "parses --codex-only and overrides resolved executor"`
    - Result: **1 pass, 0 fail**
  - `bun test src/cli/commands/run.test.ts -t "parses --claude-only and overrides resolved executor"`
    - Result: **1 pass, 0 fail**
  - `bun test src/cli/commands/run.test.ts -t "throws on conflicting executor flags"`
    - Result: **2 pass, 0 fail** (run + resume conflict checks)

### Critical-path status
- Claude planner/execution critical path now **avoids arbitrary JSON parsing by default**.
- Arbitrary/freeform JSON parsing remains only behind explicit fallback flag, with warning log.

## Update: Claude structured output contract hardening (2026-02-19 PST)

### Code changes
- Reworked Claude planner/executor path to use SDK structured output contract first:
  - `src/agents/claude/session.ts`
    - Switched from `unstable_v2_createSession` + freeform assistant text parsing to `query(..., { outputFormat: json_schema })`.
    - Added deterministic JSON-schema contracts for:
      - planning payload: `{ tasks: [...] }`
      - task execution payload: `{ outcome, error? }` with done/failed refinements.
    - Added strict zod validation at boundaries (`.strict()`), with actionable schema error messages.
    - Retained text JSON parsing only as temporary guarded fallback when `structured_output` is absent, with explicit TODO and telemetry log (`console.warn`).
    - Removed silent coercion/defaulting behavior in parser (numeric IDs/default fields no longer silently coerced).
- Updated tests:
  - `src/agents/claude/session.test.ts`
    - valid structured payload
    - invalid schema payload hard-fails
    - fallback parser behavior retained and strict
    - invalid structured task payload hard-fails

### Commands run + outcomes
- `bun test src/agents/claude/session.test.ts`
  - Outcome: pass (4/4)
- `bun test src/agents/claude/session.test.ts src/cli/commands/run.test.ts`
  - Outcome: pass (10/10)
- `npm run build`
  - Outcome: pass (`tsc` clean)
- Smoke (CLI):
  - `node dist/cli/index.js run --task "Create a file named codex-structured-smoke.txt containing exactly codex-structured-ok" --codex-only`
    - Outcome: started, planned successfully, reached execution; terminated by command timeout (SIGTERM) in this environment.
  - `node dist/cli/index.js run --task "Create a file named claude-structured-smoke.txt containing exactly claude-structured-ok" --claude-only`
    - Outcome: started, planned successfully, reached execution; terminated by command timeout (SIGTERM) in this environment.
  - `node dist/cli/index.js run --task "x" --codex-only --claude-only`
    - Outcome: immediate fast-fail with expected mutual-exclusion error.

### Contract status
- Freeform JSON parsing in Claude planner/executor critical path is **not fully removed yet**.
- It is now **demoted to an explicit guarded fallback** used only when SDK `structured_output` is missing, with TODO + telemetry.
