# Orca TODO

## Skills System
- Add skill loader (scan `.orca/skills/`, `~/.orca/skills/`, explicit config paths)
- Inject skill manifest (name + description) into planning and execution system context
- Follow agentskills.io SKILL.md frontmatter format for cross-platform compatibility
- Add `skills` field to OrcaConfig type
- Document: `.orca/skills/<name>/SKILL.md` convention

## Multi-Agent
- See research notes — potential to enable `features.multi_agent = true` by default via project-scoped `.codex/config.toml` generation
- Decide: orca-managed config.toml, or user opt-in via `orca.config.js`

## Housekeeping
- Update GOALS.md Phase 4 entry (done, not NEXT)
- Update agent-state.json to reflect current orca state
- Fix `orca setup` showing ANTHROPIC_API_KEY "not set" (key is in gateway env, not shell)
- Zod v3→v4 peer dep warning (low priority)
