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

## Config (~/.orca/config.js or ./orca.config.js)

```js
export default {
  executor: "codex",           // "codex" (default) or "claude"
  sessionLogs: "./session-logs",
  hooks: {
    onComplete: "your-notify-command",
    onError: "your-error-command",
  },
  codex: { multiAgent: false },
}
```

## Notes

- Codex executor requires `~/.codex/auth.json`
- Must be run inside a git repo
- Run ID format: `<slug>-<unix-ms>-<hex4>`  (e.g. cobalt-summit-1708123456789-a3f2)
- Use `orca answer` to unblock a waiting run
