---
date: 2026-02-20T06:45:00Z
session: orca-agents-claude-injection
agent: subagent
---

## Task
Implement automatic `AGENTS.md` / `CLAUDE.md` injection into planner system context (bounded + deterministic), with tests, build, and smoke verification.

## Files changed
- `src/core/planner.ts`
- `src/core/planner.test.ts`
- `session-logs/LATEST.md`

## What changed
- Added project-instruction discovery and injection to planner context:
  - Detects project root from `specPath` by walking up to nearest `.git` directory (falls back to spec directory if no git root found).
  - Loads project instruction files in deterministic order:
    1. `AGENTS.md`
    2. `CLAUDE.md`
- Added bounded "Project Instructions" section to system context when files are present.
- Added per-file cap for token safety:
  - `PROJECT_INSTRUCTION_CHAR_CAP = 4000`
  - truncation marker appended when file exceeds cap.
- Added explicit path headers per file in injected section.
- Kept existing skills injection; context order is now:
  1. default planner context
  2. project instructions (if any)
  3. skills (if any)

## Exact injection format + ordering
Injected section header:
- `## Project Instructions`

Per file block (for each present file in fixed order AGENTS then CLAUDE):
- `### <FILE_NAME> (<ABSOLUTE_PATH>)`
- fenced markdown block:
  - ````md
    <capped file content>
    ````
- optional truncation line when needed:
  - `(truncated to 4000 characters)`

## Tests added/updated
In `src/core/planner.test.ts`:
- `injects AGENTS.md when present`
- `injects CLAUDE.md when present`
- `injects AGENTS.md before CLAUDE.md when both are present`
- `does not inject project instructions when neither file is present`
- `caps and marks truncated project instruction content`
- Existing skills-injection and DAG validation tests remain and pass.

## Commands run + outcomes
1. `bun test src/core/planner.test.ts`
   - Pass (`9 pass, 0 fail`).
2. `npm run build`
   - Initial fail due to strict TS in test fixture (`baseTasks[0]` inferred as possibly undefined).
3. Edited test fixtures to use `baseTask: Task` constant.
4. `bun test src/core/planner.test.ts && npm run build`
   - Pass (`9 pass, 0 fail`; `tsc` pass; postbuild chmod pass).
5. Smoke test:
   - Command:
     - `bun --eval '<inline script creating temp git repo + AGENTS.md, stubbing planner call, asserting context>'`
   - Output:
     - `SMOKE_OK: AGENTS injected`
