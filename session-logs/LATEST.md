---
date: 2026-02-20T02:12:00-08:00
session: hook-contract-no-env-regression-fix
agent: subagent
---

## Task
Fix dispatcher regression that reintroduced legacy `ORCA_*` hook payload env vars, keep command-hook payload transport stdin JSON only, and align tests/smoke/docs with that contract.

## Files changed
- `src/hooks/dispatcher.ts`
- `src/hooks/dispatcher.test.ts`
- `specs/smoke/hooks/record-command-hook.mjs`
- `session-logs/LATEST.md`

## Hook contract (current)
- Function hooks remain primary typed path.
- Command hooks receive full payload via stdin JSON only.
- Dispatcher does **not** inject hook payload env vars (`ORCA_HOOK`, `ORCA_MSG`, `ORCA_RUN_ID`, `ORCA_TASK_ID`, `ORCA_TASK_NAME`, `ORCA_ERROR`).

## Verification run
- `npm run validate` ✅
- `npm run smoke:hooks` ✅
- `npm run smoke:hooks` ✅
- Codex review on final diff: no significant issues; contract upheld.
