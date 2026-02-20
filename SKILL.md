---
name: orca
description: "Orchestrate multi-step AI coding tasks via the Orca CLI. Use when: running multi-file code changes, spawning background agents, planning and executing complex tasks end-to-end. NOT for: simple single-file edits, reading code."
---

# Orca

Orca (orcastrator) is a CLI that breaks a goal into a task graph and executes it end-to-end via Codex or Claude.

## Install

```sh
npm install -g orcastrator
```

## Run a Goal

```sh
orca "your goal here"
```

## Key Commands

```
orca <goal>              Start a new run
orca status [--last]     Check run status
orca answer [--run <id>] [answer]    Answer a question the agent raised
orca resume [--last]     Resume a paused run
orca cancel [--last]     Cancel a run
orca pr draft [--last]   Open a draft PR for the run's branch
orca pr create [--last]  Create and publish a PR
orca pr publish [--last] Publish (un-draft) an existing draft PR
orca pr status [--last]  Check PR and CI status
```

## Config (~/.orca/config.js, ./orca.config.js, or ./orca.config.ts)

```ts
export default {
  executor: "codex",           // "codex" (default) or "claude"
  sessionLogs: "./session-logs",
  hooks: {
    onFindings: async (event) => {
      console.log(`findings:${event.metadata?.findingsCount} cycle:${event.metadata?.cycleIndex}`);
    }
  },
  hookCommands: {
    onComplete: "your-notify-command", // reads event JSON from stdin
    onError: "your-error-command",
  },
  review: {
    plan: { enabled: true, onInvalid: "fail" },
    execution: {
      enabled: true,
      maxCycles: 2,
      onFindings: "auto_fix",   // auto_fix | report_only | fail
      validator: { auto: true }
    }
  },
  codex: { multiAgent: false },
};
```

## Notes

- Codex executor requires `~/.codex/auth.json`
- Must be run inside a git repo
- Function hooks are primary (`hooks`) and receive `(event, context)` with deterministic context `{ cwd, pid, invokedAt }`
- Hook commands still work, but they now receive structured event JSON on stdin (no `ORCA_*` hook env payload)
- Post-exec reviewer uses strict JSON schema (`summary`, `findings[]`, `fixed`) with one bounded repair retry on malformed output
- Hook smoke harness: run `npm run smoke:hooks`
- Run ID format: `<slug>-<unix-ms>-<hex4>`  (e.g. cobalt-summit-1708123456789-a3f2)
- Bundled default skill: `<orca package root>/.orca/skills/code-simplifier/SKILL.md` (shipped with Orca and applied explicitly in planner/reviewer/executor prompts for all code-writing and code-review steps)
- Use `orca answer` to unblock a waiting run
