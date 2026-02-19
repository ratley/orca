---
date: 2026-02-19T14:25:00Z
session: skills-system
agent: eve
---

## Built
- Skills system — load SKILL.md context from `.orca/skills/`, `~/.orca/skills/`, and `config.skills[]`
- Skills are injected into planner system context and task-runner system context for every run
- Fix: parseTaskArray now coerces numeric task IDs and dependency refs to strings (LLMs sometimes emit numbers)

## Changed
- `src/types/index.ts` | added `skills?: string[]` to OrcaConfig
- `src/core/config-loader.ts` | validate and array-merge skills across config layers (dedup by value)
- `src/utils/skill-loader.ts` | new — parseSkillFile, loadSkill, loadSkillsFromDir, loadSkills
  YAML frontmatter support (name, description); infers name from dir when absent; ~ expansion; dedup by name (first wins)
- `src/utils/skill-loader.test.ts` | new — 8 tests all passing
- `src/core/planner.ts` | runPlanner now accepts config; loads skills and appends to system context
- `src/core/planner.test.ts` | added: skills injection test
- `src/core/task-runner.ts` | loads skills at run start; passes skill context string to executeTask
- `src/agents/claude/session.ts` | coerce numeric IDs/deps in parseTaskArray; executeTask now accepts optional systemContext
- `src/agents/codex/session.ts` | minor: consistent systemContext param threading

## Notes
- Used orca itself to implement this feature (meta) — ran `orca --spec /tmp/orca-skills-spec.md` inside ~/code/orca
- 172 tests passing, 0 failures
- Skill discovery order: config.skills > .orca/skills/ > ~/.orca/skills/ (first name wins dedup)
