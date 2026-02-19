---
date: 2026-02-19T06:00:00Z
session: cli-prompt-alias
agent: eve
---

## Built
- Added `-p, --prompt <text>` as aliases for `--task` in `orca run`
- All three flags (`--task`, `--prompt`, `-p`) are equivalent; mutually exclusive with `--spec`

## Changed
- `src/cli/commands/run.ts` | Added `prompt?: string` to RunCommandOptions; normalize `task ?? prompt` into `inlineTask` in handler and action validator; added `-p, --prompt <text>` commander option

## Verification
- Unit tests: 37 pass, 0 fail

## Decisions
- Normalize at handler entry rather than duplicating checks; single `inlineTask` var used throughout
- Validation messages updated to mention all three flags

## Next
- Update codex-client remote to ratley/codex-client (transfer accepted)
- Update orca package.json dep reference from eve-senara to ratley

## Blockers
- None
