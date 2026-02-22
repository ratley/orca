---
date: 2026-02-22T13:20:00-08:00
session: cli-auth-and-first-run-defaults
agent: orca
---

## Task
Implement Codex auth auto-detection in `orca setup` and first-run global config auto-init in `orca run`.

## What changed
- Added `~/.codex/auth.json` fallback for `OPENAI_API_KEY` in setup key resolution.
- Added `readCodexAuthJson(homedir)` helper and wired it after Claude dotenv fallbacks.
- Setup output now reports key source location (env/openclaw/dotenv/codex auth/prompt/flag).
- Added first-run bootstrap in run flow:
  - if `~/.orca/config.js`, `./orca.config.js`, and `./orca.config.ts` are all absent,
  - create `~/.orca/config.js` with:
    - `executor: "codex"`
  - log: `✓ Created ~/.orca/config.js (first run defaults)`.
- Added/updated tests for both features.

## Verification run
- `bun test` ✅
- `bun run build` ✅

## Notes
- No schema changes.
- API key precedence preserved: flag > env > openclaw > dotenv > codex auth json.
