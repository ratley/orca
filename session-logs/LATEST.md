---
date: 2026-02-20T17:09:46-08:00
session: planner-instruction-realpath-dedupe
agent: subagent
---

## Task
Deduplicate AGENTS.md and CLAUDE.md project-instruction injection when both resolve to the same underlying file.

## Scope lock
- Preserve AGENTS-first deterministic order for distinct files.
- Preserve nearest-.git project-root resolution and truncation marker behavior.

## Checks run
- `bun test src/core/planner.test.ts`
- `npm run lint`
- `codex exec` diff review (`No correctness issues found.`)
