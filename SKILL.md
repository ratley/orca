---
name: orca
description: "Orchestrate multi-step AI coding tasks via the Orca CLI. Use when: running multi-file code changes, spawning background agents, planning and executing complex coding tasks end-to-end. NOT for: simple single-file edits, reading code, or any work in ~/clawd workspace."
---

# Orca — Operator Guide

Orca (`orcastrator`) breaks a goal into a task graph and executes it end-to-end via Codex. Codex plans and executes; a reviewer catches regressions and can auto-fix.

---

## Prerequisites

- Must be run inside a git repo (or pass `--skip-git-repo-check`)
- Codex executor (default): requires `~/.codex/auth.json` (Codex OAuth)
- Install: `npm install -g orcastrator`

---

## Executor Selection

| Executor | When to use |
|---|---|
| `codex` (default) | Most tasks. Persistent Codex session, fast, integrates with app-server skills |

Override in config: `executor: "codex"` (default and only supported executor).

---

## Fast-Start Runbook

```sh
# 1. Navigate into the target repo
cd /path/to/repo

# 2. Start a run
orca "your goal here"

# 3. Check status (run ID printed on start, also available via --last)
orca status --last

# 4. If the agent asks a question, answer it
orca answer --last "your answer"

# 5. Once complete, open a PR
orca pr draft --last    # opens draft PR
orca pr create --last   # creates + publishes PR
```

---

## Writing Good Goals

Be specific. Orca passes your goal to a planner that generates a task graph — vague goals produce vague plans.

**Bad:** `"fix the bug"`  
**Good:** `"Fix the TypeError thrown when user logs out with an expired token in src/auth/session.ts. Ensure existing tests pass and add a regression test."`

Include:
- What to change and where
- Acceptance criteria or test expectations
- What NOT to touch (if relevant)

---

## Status Monitoring

```sh
orca status --last        # status of most recent run
orca status --run <id>    # status of a specific run
```

**Run states:**
- `planning` — generating task graph
- `running` — executing tasks
- `waiting_for_answer` — agent raised a question, needs `orca answer`
- `reviewing` — post-exec review cycle
- `complete` — done, branch ready
- `failed` — run errored; check session logs

**Poll pattern:** check every 30–60s. Don't busy-poll. If `waiting_for_answer`, respond immediately.

**Run ID format:** `<slug>-<unix-ms>-<hex4>` (e.g. `cobalt-summit-1708123456789-a3f2`)

---

## Handling Questions

If `orca status` shows `waiting_for_answer`:

```sh
orca status --last        # read the question
orca answer --last "yes"  # unblock the run
```

Answer concisely. The agent is waiting synchronously.

---

## Failure Handling

```sh
orca status --last        # check error message
orca resume --last        # retry from last checkpoint
orca cancel --last        # abort if unrecoverable
```

**Common failures:**
- `auth error` → re-auth Codex (`codex auth`) or check `ANTHROPIC_API_KEY`
- `no git repo` → `cd` into a git repo or use `--skip-git-repo-check`
- `plan invalid` → goal was too vague; cancel and restate with more specificity
- `review cycle exceeded` → reviewer found persistent issues; inspect branch manually
- session logs: check `./session-logs/` (or configured `sessionLogs` path)

---

## PR Workflow

```sh
orca pr draft --last      # open draft PR (safe — won't trigger CI)
orca pr status --last     # check PR + CI status
orca pr publish --last    # un-draft and publish
orca pr create --last     # create + publish in one step
```

Never push directly to main/master. Orca always works on a branch.

---

## Review Cycle

Orca's post-exec reviewer checks the output and can auto-fix findings:

```ts
review: {
  execution: {
    enabled: true,
    maxCycles: 2,
    onFindings: "auto_fix",   // auto_fix | report_only | fail
    validator: { auto: true }
  }
}
```

If `maxCycles` is hit, the run completes with findings reported. Inspect the branch manually.

---

## Key Commands

```
orca <goal>                          Start a new run
orca status [--last] [--run <id>]    Check run status
orca answer [--last] [--run <id>] <answer>  Answer a waiting question
orca resume [--last]                 Resume a paused/failed run
orca cancel [--last]                 Cancel a run
orca pr draft [--last]               Open a draft PR
orca pr create [--last]              Create and publish PR
orca pr publish [--last]             Un-draft an existing PR
orca pr status [--last]              Check PR and CI status
```

---

## Config Reference

Config locations (later entries override earlier): `~/.orca/config.ts` (preferred when both exist) or `~/.orca/config.js`, then `./orca.config.ts` (preferred when both exist) or `./orca.config.js`, then `--config <path>`

```ts
export default {
  executor: "codex",              // "codex"
  sessionLogs: "./session-logs",  // where to write session logs

  hooks: {
    onFindings: async (event, context) => { /* fires after reviewer */ },
    onComplete: async (event, context) => { /* fires on success */ },
    onError: async (event, context) => { /* fires on failure */ },
  },

  hookCommands: {
    onComplete: "your-notify-command",  // reads event JSON from stdin
    onError: "your-error-command",
  },

  review: {
    plan: { enabled: true, onInvalid: "fail" },
    execution: {
      enabled: true,
      maxCycles: 2,
      onFindings: "auto_fix",
      validator: { auto: true }
    }
  },

  codex: {
    multiAgent: false,
    perCwdExtraUserRoots: [
      { cwd: process.cwd(), extraUserRoots: ["/tmp/shared-skills"] }
    ]
  },
};
```

---

## Multi-Agent Mode

Set `codex.multiAgent: true` to spawn parallel Codex agents per task. Faster for independent tasks; higher token cost. Use for large refactors with clearly separable subtasks.

---

## Skills

Orca ships a bundled `code-simplifier` skill that's applied in planner, reviewer, and executor prompts automatically. Extra skills can be injected via `codex.perCwdExtraUserRoots` (scoped per cwd).

---

## Done Criteria

A run is complete when:
1. `orca status --last` shows `complete`
2. A branch exists with the committed changes
3. `orca pr status --last` shows CI passing (if applicable)

Don't consider a run done until these are verified.
