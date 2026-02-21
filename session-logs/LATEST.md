---
date: 2026-02-20T16:20:00-08:00
session: auto-npm-publish-on-tag
agent: subagent
---

## Task
Implement secure automatic npm publish on `v*` tag push with manual dispatch fallback.

## Scope lock
- No package/runtime code changes.
- Keep release tracking workflow behavior intact.

## Checks run
- `npm run validate`
- Codex diff review (`No actionable issues found.`)
