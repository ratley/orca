---
date: 2026-02-20T06:32:00Z
session: orca-remove-project-env-key-source
agent: subagent
---

## Task
Update `orca setup --check` key detection so project-local `./.env` is not used for `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`.

## Files changed
- `src/cli/commands/setup.ts`
- `src/cli/commands/setup.test.ts`
- `README.md`
- `session-logs/LATEST.md`

## What changed
- Removed project-local `./.env` from `resolveApiKey` fallback order.
- Kept only global-scope fallback files in `readDotEnvFallback`:
  - `~/.claude/.env`
  - `~/.config/claude/.env`
- Updated tests:
  - replaced project-local fallback test with `ignores project-local .env` and now expects `undefined`.
  - updated precedence test wording to "supported sources".
  - removed `cwd` plumbing from test call sites.
- Updated README lookup-order docs to remove `./.env`.

## Commands run + outcomes
1. `bun test src/cli/commands/setup.test.ts`
   - Pass (`16 pass, 0 fail`).
2. `npm run build`
   - Pass (`tsc`, then `chmod +x dist/cli/index.js`).

## Final API key resolution order
1. CLI flag value
2. Environment variable (`process.env[KEY]`)
3. OpenClaw env vars from `~/.openclaw/openclaw.json` (`env.vars[KEY]`, including object/ref forms)
4. `~/.claude/.env`
5. `~/.config/claude/.env`
6. `undefined` if still not found
