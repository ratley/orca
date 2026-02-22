---
date: 2026-02-22T02:40:00-08:00
session: typing-hardening-hooks-exports
agent: subagent
---

## Task
Package-grade typing hardening for hook/event contracts and public type exports.

## Scope lock
- Remove duplicate drift-prone hook type declarations from setup template.
- Emit declarations and expose stable package type exports.
- Keep changes scoped to typing/contracts and related docs.

## Checks run
- `bun test`
- `npm run build`
- `npm run smoke:hooks`
