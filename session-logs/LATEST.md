---
date: 2026-02-19T09:56:00Z
session: readme-cleanup
agent: eve
---

## Built
- nothing new — docs only

## Changed
- README.md | full rewrite — cleaner structure, removed pipeline blurb, codex-client link at top, config section added, no redundant flags in examples

## Tests
- no tests needed (docs change)

## Decisions
- removed "Pipeline" line from description — too technical/marketing-y
- codex-client link under main description
- config auto-discovery documented with example

## Next
1. positional arg support: `orca "goal"` without -p flag (discuss with Bradley)
2. orca answer command
3. model flags (--codex-only / --claude-only)
4. session logs config key
5. autonomous post-run review

## Blockers
- none
