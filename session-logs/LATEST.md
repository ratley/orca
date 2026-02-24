---
date: 2026-02-24T09:05:00-08:00
session: fix-master-red-publish-tag-version-mismatch
agent: eve-main
---

## Session: fix-master-red-publish-tag-version-mismatch

- Investigated failing `npm Publish` workflow for tag `v0.2.22` on master.
- Root cause: tag version and `package.json` version mismatch (`v0.2.22` vs `0.2.21`).
- Chose clean forward fix: bump package version to `0.2.23` (no tag rewrite).
- Plan: run full gates (`bun test`, `npm run build`, `npm run validate`), push commit to master, tag `v0.2.23`, and verify publish/release workflows succeed.
