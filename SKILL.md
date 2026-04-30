---
name: orca
description: "Orchestrate multi-step AI coding tasks via the Orca CLI. Use when: running multi-file code changes, spawning background agents, planning and executing complex coding tasks end-to-end. NOT for: simple single-file edits, reading code, or any work in ~/clawd workspace."
---

# Orca - Operator Guide

Orca (`orcastrator`) breaks a goal into a task graph and executes it end-to-end via Codex. Planning can be skipped, routed to Codex, or routed to the local Claude Code CLI through `claude -p`; execution and review still run through Codex.

---

## Prerequisites

- Must be run inside a git repo (or pass `--skip-git-repo-check`)
- Codex executor (default): requires `~/.codex/auth.json` (Codex OAuth)
- Claude planning (optional): requires `claude` on PATH, or set `claude.command`
- Install: `npm install -g orcastrator`

---

## Planner Routing

| Planner config | When to use |
|---|---|
| `planner.agent: "auto"` (default) | Let a Codex router choose Claude or Codex for task graph generation |
| `planner.agent: "claude"` | Force broad or ambiguous planning through local Claude Code (`claude -p`) |
| `planner.agent: "codex"` | Force task graph generation to stay in Codex |

`planner.router` only applies to `planner.agent: "auto"`. Forced planner configs should be this simple:

```json
[
  { "planner": { "agent": "claude" } },
  { "planner": { "agent": "codex" } }
]
```

Automatic routing is the only shape that uses a router model:

```json
{
  "planner": {
    "agent": "auto",
    "router": { "model": "gpt-5.3-codex-spark" }
  }
}
```

Claude planning shells out to `claude -p` with the prompt on stdin. It does not replace Codex execution, task graph review, or post-execution review.

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

  planner: {
    agent: "auto",                // "auto" | "claude" | "codex"
    router: {
      model: "gpt-5.3-codex-spark", // only valid with agent: "auto"
    },
  },

  claude: {
    command: "claude",
    model: "claude-opus-4-7",
    effort: "high",
    timeoutMs: 300000,
  },

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
    model: "gpt-5.5",
    effort: "high",
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

When parallelizing, enforce lane ownership:
- one sub-agent lane per independent subsystem/file set
- avoid overlapping write scopes
- keep integration/merge steps sequential

---

## Skills

Orca ships a bundled `code-simplifier` skill that's applied in planner, reviewer, and executor prompts automatically. Extra skills can be injected via `codex.perCwdExtraUserRoots` (scoped per cwd).

Execution guardrails (especially for Codex):
- bias to the simplest implementation that works
- no compatibility fallbacks or dead code unless explicitly required
- run a simplification pass before final handoff

---

## Done Criteria

A run is complete when:
1. `orca status --last` shows `complete`
2. A branch exists with the committed changes
3. `orca pr status --last` shows CI passing (if applicable)

Don't consider a run done until these are verified.
