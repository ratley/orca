---
date: 2026-02-22T04:59:00-08:00
session: docs-accuracy-wrap
agent: eve
---

## Task
Finalize README accuracy to match current CLI/config behavior before commit/push.

## What changed
- Added missing command-flag documentation from latest audits.
- Clarified `orca pr publish` run-selection behavior for TTY vs non-TTY.
- Kept `pr-finalize` out of docs (publish is canonical).
- Clarified config precedence (`orca.config.ts` over `orca.config.js` when both exist).
- Expanded config reference coverage and added caveats (`ORCA_SKIP_VALIDATORS=1`, `onError` hook-dispatch behavior).
- Clarified PR `--config` flag as accepted for compatibility and currently unused by PR run resolution.

## Verification run
- `npm run build` ✅
- Codex final review on uncommitted README diff: `no issues found` ✅

## Notes
- Commit intentionally docs-only; no runtime behavior changes.
