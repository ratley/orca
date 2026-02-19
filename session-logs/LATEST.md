---
date: 2026-02-19T05:56:27Z
session: cli-task-flag
agent: eve
---

## Built
- Added `--task <text>` as an inline alternative to `--spec <path>` for `orca run`
- Enforced `--spec`/`--task` mutual exclusivity and required-one validation at CLI action level and handler level
- Implemented temp-spec lifecycle for inline tasks using `os.tmpdir()` + unique filename with cleanup in `finally`

## Changed
- `src/cli/commands/run.ts` | Added `task?: string` to `RunCommandOptions`; made `spec` optional; added inline-task temp file write/read/cleanup flow; updated command options and action validation

## Verification
- `bun test` | 78 passing, 0 failing

## Decisions
- Preserve planner/task-runner/agent behavior; implement entirely in CLI layer by materializing `--task` into a temporary markdown file
- Keep validation in both commander `.action()` and `runCommandHandler` for direct-handler call safety

## Next
- Add targeted CLI tests for `--task` path and mutual-exclusion validation

## Blockers
- None
