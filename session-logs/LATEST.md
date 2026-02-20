---
date: 2026-02-20T04:32:23Z
session: orca-skills-list-dogfooding
agent: orca (orchestrated by eve)
---

## Implemented
- `orca skills list` command — lists all loaded skills from config/project/global discovery paths
- Shows: name, description, source, directory path in formatted table
- Proper source detection by checking config paths vs standard directories
- Empty skills case handled gracefully

## Changed
- src/cli/commands/skills.ts — new command handler with table formatting
- src/cli/commands/skills.test.ts — comprehensive test suite (empty case, multi-source detection, CLI option passing)
- src/cli/index.ts — registered skills command import and invocation
- TODO.md — marked feature as complete

## Tests
- 224 pass (was 222), 0 fail (bun test)
- Build: tsc clean (npm run build)

## Dogfooding Notes
- First feature implemented via orca itself (dogfooding the CLI)
- Codex review passed: type safety solid, ESM compliance correct, test coverage good
- Ready for version bump + npm publish (0.2.11)

## Next
- Model flags (--codex-only / --claude-only) — similar dogfooding approach
- Review cycles feature (maxReviewCycles config) — more complex, requires planner changes
