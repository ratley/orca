---
date: 2026-02-20T15:20:00-08:00
session: github-release-tracking-workflow
agent: subagent
---

## Task
Add a lightweight GitHub Actions workflow to track GitHub Releases/changelogs on tag push.

## Scope lock
- Track releases only (no npm publish automation changes).
- Keep manual npm publish flow unchanged.

## Checks run
- `npm run validate`
- Codex staged-diff review
