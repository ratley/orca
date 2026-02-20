---
date: 2026-02-20T13:58:00-08:00
session: codex-explicit-skill-input-injection
agent: subagent
---

## Task
Implement explicit Codex app-server skill input injection so turns include deterministic `{ type: "skill", name, path }` items instead of relying only on prompt/context skill pickup.

## Files changed
- `src/agents/codex/session.ts`
- `src/agents/codex/session.unit.test.ts`
- `README.md`
- `TODO.md`
- `session-logs/LATEST.md`

## Behavior update
- Codex session now loads Orca skills once at session start using existing loader precedence: `config > project > global > bundled`.
- Every Codex `runTurn` path now sends:
  - one text input item, and
  - explicit skill input items for all loaded skills (`name` + `dirPath`).
- Existing explicit code-simplifier prompt directives remain intact.
- Added cleanup guard: if skill loading/thread start fails after connect, Codex client disconnects before rethrow.

## Verification run
- `bun test src/agents/codex/session.unit.test.ts src/utils/skill-loader.test.ts` ✅
- `npm run validate` ✅
- Codex review pass 1 found a session-init cleanup gap; fixed with disconnect-on-failure + new unit test.
- Codex re-review pass 2 reported no significant findings.
