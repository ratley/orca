---
date: 2026-02-20T06:30:00Z
session: orca-setup-cosmetic-fix
agent: subagent
---

## Task
Fix `orca setup` status reporting so `ANTHROPIC_API_KEY` is shown as set when available via OpenClaw gateway env config (including 1Password refs), not only shell env.

## Files changed
- `src/cli/commands/setup.ts`
- `src/cli/commands/setup.test.ts`

## What changed
- Located existing env lookup in `resolveApiKey(...)` inside `src/cli/commands/setup.ts`.
- Extended key resolution precedence to:
  1) CLI flag
  2) shell env (`process.env`)
  3) OpenClaw config env vars (`~/.openclaw/openclaw.json` → `env.vars.<KEY>`)
- Added OpenClaw env parser that treats non-empty values as configured, including 1Password-style references (e.g. `op://...`).
- Updated setup check wording for missing keys to consistently show `not set`.
- Added/updated tests covering OpenClaw fallback detection.

## Commands run + outcomes
1. `bun test src/cli/commands/setup.test.ts`
   - First run: failed (2 tests) due to HOME-based path assumption in tests.
   - After refactor to injectable config path: pass.
2. `bun test`
   - Fails due to unrelated pre-existing repository test issues outside this change (e.g. `run.test`, stdout hook tests, and dist test import issues).
3. `bun run build`
   - Pass (`tsc` + postbuild chmod).

## Result
- `orca setup` now treats `ANTHROPIC_API_KEY` as **set** when it is available through OpenClaw-configured gateway env vars / 1Password ref (even if not exported in shell env).
- It shows **not set** only when missing from all checked sources.