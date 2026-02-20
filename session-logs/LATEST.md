---
date: 2026-02-20T14:41:00-08:00
session: release-0.2.17-metadata
agent: subagent
---

## Task
Finalize pending patch release and add package metadata pointers (`homepage`, `bugs.url`) before publish.

## Planned release scope
- Keep to existing verified commits on `master`.
- Add minimal npm metadata in `package.json`.
- Run release gates (`npm run validate`, `npm run smoke:hooks`, Codex review) before publish.
