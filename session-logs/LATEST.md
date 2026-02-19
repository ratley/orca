---
date: 2026-02-19T06:05:00Z
session: cli-default-command
agent: eve
---

## Built
- Made `run` the default commander subcommand — `orca -p "task"` now works without typing `run`
- `orca run -p "task"` still works (backwards compat)

## Changed
- `src/cli/commands/run.ts` | `.command("run")` → `.command("run", { isDefault: true })`

## Verification
- `orca -p "hello"` routed to run pipeline and started correctly (killed mid-run, routing confirmed)

## Decisions
- isDefault: true in commander routes unrecognized first args to the run command
- Backwards compat preserved — explicit `orca run` still works

## Next
- None — Orca CLI is in a solid state

## Blockers
- None
