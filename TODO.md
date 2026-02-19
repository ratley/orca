# Orca TODO

## Skills System
- ✅ Shipped in v0.2.6 — skill loader, frontmatter parsing, injection into planner + task-runner
- Skill discovery: config.skills[] > .orca/skills/ > ~/.orca/skills/ (first name wins)
- Future: `orca skills list` command to show what's loaded

## Codex-as-Executor
- task-runner currently imports executeTask from claude/session.ts — all task execution uses Claude
- Codex has a full executeTask in codex/session.ts (persistent thread!) that's never called
- Fix: add `executor: "claude" | "codex"` to OrcaConfig, default to "codex" for coding tasks
- Why: Claude = 8 API calls/run → rate limits. Codex runs local, no rate limit.

## Multi-Agent
- ✅ Shipped: opt-in via `codex: { multiAgent: true }` in orca.config.js — writes to `~/.codex/config.toml`
- Smoke test once Bradley has a real project to run it against (watch for "spawning sub-agents" in codex output)

## Housekeeping
- Update GOALS.md Phase 4 entry (done, not NEXT)
- Update agent-state.json to reflect current orca state
- Fix `orca setup` showing ANTHROPIC_API_KEY "not set" (key is in gateway env, not shell)
- Zod v3→v4 peer dep warning (low priority)
