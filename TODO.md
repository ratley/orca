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

## Recent Ships
- ✅ `orca skills list` command shipped
- ✅ Executor override flags shipped: `--codex-only` / `--claude-only`
- ✅ Claude planner/executor deterministic structured-output path shipped (text JSON fallback gated)
- ✅ Effort controls shipped: `--codex-effort <low|medium|high>`, `--claude-effort <low|medium|high|max>`
- ✅ `orca setup --check` key detection improved (OpenClaw env + cross-platform `.env` fallbacks)
- ✅ Dedicated post-exec reviewer JSON hardening integration target shipped (`npm run test:postexec-json`)

## Remaining
- Zod v3→v4 upgrade (peer dep conflict with @anthropic-ai/claude-agent-sdk@0.2.47)
- Review → improvement step: pre-execution review that modifies the task graph
- AGENTS.md / CLAUDE.md injection into planning context
- Review cycle depth: `maxReviewCycles` config property + `--max-review-cycles <n>` CLI flag
  - Controls how many back-and-forth exchanges between executor and reviewer are allowed
  - Always ends with a review (reviewer has last word)
  - Default: 1 (one exchange, one final review)
  - Example: maxReviewCycles=2 means executor→reviewer→executor→reviewer
