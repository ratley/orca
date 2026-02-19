# Orca TODO

## Skills System
- ✅ Shipped in v0.2.6 — skill loader, frontmatter parsing, injection into planner + task-runner
- Skill discovery: config.skills[] > .orca/skills/ > ~/.orca/skills/ (first name wins)
- Future: `orca skills list` command to show what's loaded

## Codex-as-Executor
- ✅ Shipped in v0.2.7 — Codex is now default executor; persistent session per run; Claude fallback on init failure
- config: executor?: "claude" | "codex" in OrcaConfig (default: "codex")

## Multi-Agent
- ✅ Shipped: opt-in via `codex: { multiAgent: true }` in orca.config.js — writes to `~/.codex/config.toml`
- Smoke test once Bradley has a real project to run it against (watch for "spawning sub-agents" in codex output)

## Validation Hardening
- ✅ Shipped in v0.2.8 — executor config validation, symlink guard, EACCES/EPERM resilience, parseTaskArray field defaults, Codex session leak fix, claude session unit tests (19 new), shared PlanResult/TaskExecutionResult types

## Remaining
- Fix `orca setup` showing ANTHROPIC_API_KEY "not set" (key is in gateway env, not shell)
- Zod v3→v4 upgrade (peer dep conflict with @anthropic-ai/claude-agent-sdk@0.2.47)
- `orca skills list` command — show loaded skills from all discovery paths
- Model flags: `--codex-only` / `--claude-only` CLI flags for per-run executor override
- Review → improvement step: pre-execution review that modifies the task graph
- AGENTS.md / CLAUDE.md injection into planning context
