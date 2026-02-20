---
date: 2026-02-20T06:20:00Z
session: orca-effort-flags-strict-enums
agent: subagent
---

## Task
Implemented strict per-executor effort controls for Codex + Claude, including CLI overrides, config validation, wiring, and tests.

## Files changed
- `src/types/effort.ts` (new)
- `src/types/index.ts`
- `src/core/config-loader.ts`
- `src/core/config-loader.test.ts`
- `src/agents/codex/session.ts`
- `src/agents/codex/session.unit.test.ts` (new)
- `src/agents/claude/session.ts`
- `src/agents/claude/session.test.ts`
- `src/cli/commands/run.ts`
- `src/cli/commands/run.test.ts`
- `src/cli/commands/resume.ts`
- `src/cli/commands/help.ts`

## What changed
- Added strict enums and parsers:
  - Codex effort: `low | medium | high`
  - Claude effort: `low | medium | high | max`
- Added CLI flags:
  - `--codex-effort <value>`
  - `--claude-effort <value>`
  - available on both `run` and `resume`
- Validation behavior:
  - invalid values hard-fail with actionable errors
  - e.g. `Codex effort must be one of 'low', 'medium', 'high', got 'extreme'`
- Precedence/resolution:
  - per-run CLI effort overrides config for that executor
  - executor precedence remains: CLI executor override > config > default
  - both effort flags can be provided; active executor consumes its own effort
- Wiring:
  - Codex effort is now passed into `client.runTurn(...)`
  - Claude effort is now passed into query options (`effortValue`) when set
- Config hardening:
  - `config-loader` validates `config.codex.effort` and `config.claude.effort`

## Commands run + key outcomes
1. Targeted tests:
- `bun test src/cli/commands/run.test.ts src/core/config-loader.test.ts src/agents/claude/session.test.ts src/agents/codex/session.unit.test.ts`
- Outcome: **29 pass, 0 fail**

2. Build:
- `npm run build`
- Outcome: **pass** (`tsc` + postbuild)

3. Smoke tests (codex-only / claude-only effort usage paths):
- `bun test src/cli/commands/run.test.ts -t "both effort flags are accepted; active executor uses matching effort"`
- `bun test src/cli/commands/run.test.ts -t "applies --codex-effort to effective codex config"`
- `bun test src/cli/commands/run.test.ts -t "applies --claude-effort to effective claude config"`
- Outcome: **all pass**

## Compatibility caveats
- Claude SDK typing currently does not expose `effortValue` in the `options` type, so effort is added via a typed builder object before passing to `query(...)`. Runtime path is covered by test (`claude session effort wiring`).
- Codex client accepts `effort` as string; exact optional property typing required conditional inclusion (not `undefined`) when composing params.
