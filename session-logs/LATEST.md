---
date: 2026-02-19T14:58:00Z
session: review-fixes
agent: eve
---
## Built
- Executor config validation in coerceConfig
- Skill-loader: symlink guard, EACCES/EPERM resilience
- Task-runner: Codex session leak fix (try/finally scope)
- Claude session: parseTaskArray field validation + defaults
- planSpec config parameter threading
- Shared PlanResult/TaskExecutionResult types
- 19 new claude session unit tests + skill-loader tests
## Changed
- src/core/config-loader.ts + test
- src/utils/skill-loader.ts + test
- src/core/task-runner.ts
- src/agents/claude/session.ts + NEW session.test.ts
- src/agents/codex/session.ts
- src/core/planner.ts
- src/types/index.ts
