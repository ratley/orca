# Orca TODO

## Skills System
- Add skill loader (scan `.orca/skills/`, `~/.orca/skills/`, explicit config paths)
- Inject skill manifest (name + description) into planning and execution system context
- Follow agentskills.io SKILL.md frontmatter format for cross-platform compatibility
- Add `skills` field to OrcaConfig type
- Document: `.orca/skills/<name>/SKILL.md` convention

## Multi-Agent
- ✅ Shipped: opt-in via `codex: { multiAgent: true }` in orca.config.js — writes to `~/.codex/config.toml`
- Smoke test once Bradley has a real project to run it against (watch for "spawning sub-agents" in codex output)

## Housekeeping
- Update GOALS.md Phase 4 entry (done, not NEXT)
- Update agent-state.json to reflect current orca state
- Fix `orca setup` showing ANTHROPIC_API_KEY "not set" (key is in gateway env, not shell)
- Zod v3→v4 peer dep warning (low priority)
