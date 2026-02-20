---
date: 2026-02-19T23:58:00-08:00
session: invalid-plan-hook
agent: subagent
---

## Task
Add an invalid-plan hook event for planner/review graph rejection, wire CLI/config hook surfaces, add deterministic tests, run smoke + validation.

## Files changed
- `src/types/index.ts`
- `src/core/planner.ts`
- `src/core/planner.test.ts`
- `src/cli/commands/run.ts`
- `src/cli/commands/run.test.ts`
- `src/hooks/dispatcher.ts`
- `src/hooks/dispatcher.test.ts`
- `README.md`
- `session-logs/LATEST.md`

## Hook added
- Name: `onInvalidPlan`
- Trigger semantics:
  - Emitted from `run` command when `runPlanner(...)` throws `InvalidPlanError`
  - `InvalidPlanError` is raised for:
    - invalid planner DAG (`stage: "planner"`)
    - invalid review payload / invalid reviewed DAG rejected with fail policy (`stage: "review"`)
- Event payload:
  - `hook: "onInvalidPlan"`
  - `message: invalid-plan:<stage>`
  - `error: <original validation/review error message>`
  - `metadata.stage: "planner" | "review"`

## Hook command/config surfaces wired
- CLI (`orca run`):
  - added `--on-invalid-plan <cmd>`
- Config:
  - `hookCommands.onInvalidPlan`
  - `hooks.onInvalidPlan`
- Dispatcher registration list updated to include `onInvalidPlan`.

## Env vars available to hook commands
Existing:
- `ORCA_MSG`
- `ORCA_RUN_ID`
- `ORCA_TASK_ID`

Added:
- `ORCA_HOOK`
- `ORCA_ERROR`
- `ORCA_STAGE` (from `event.metadata.stage` when present)

## Deterministic tests added/updated (value-add)
1. `src/core/planner.test.ts`
   - validates `InvalidPlanError` classification:
     - duplicate IDs => `stage: "planner"`
     - invalid reviewed graph (cycle) => `stage: "review"`
   - Value: proves trigger path classification is deterministic and stage-aware.

2. `src/cli/commands/run.test.ts`
   - `dispatches onInvalidPlan hook when planner rejects invalid graph`
   - Mocks planner invalid failure and verifies dispatched hook payload (`hook`, `message`, `error`, `metadata.stage`) and that execution does not proceed.
   - Value: direct coverage of new hook trigger path in CLI flow.

3. `src/hooks/dispatcher.test.ts`
   - extends command env-var test to assert `ORCA_HOOK`, `ORCA_ERROR`, `ORCA_STAGE` propagation.
   - Value: guarantees hook command surface receives expected context.

## Smoke / targeted simulation commands + outcomes
1) Review→improvement path uses reviewed graph:
- Command:
  - `bun test src/core/planner.test.ts -t "execution path uses reviewed graph from store"`
- Outcome:
  - pass
  - log includes review mutation summary (`update_task`) and `Plan complete`

2) Invalid plan triggers new hook:
- Command:
  - `bun test src/cli/commands/run.test.ts -t "dispatches onInvalidPlan hook when planner rejects invalid graph"`
- Outcome:
  - pass
  - output includes `Review output invalid. cycle`
  - assertions confirm `onInvalidPlan` dispatch + stage metadata

## Validation commands + outcomes
1) `npm run test --silent`
- ✅ pass (`140 pass, 0 fail`)

2) `npm run build --silent`
- ✅ pass

3) `npm run validate`
- ✅ feasible and passed (lint, type-aware lint, typecheck, tests, build)

## Notes
- Scope intentionally kept minimal to hook/event plumbing + deterministic coverage.
- No commit/push performed.
