# orca

Coordinated agent run harness. Breaks down a goal into a task graph, then executes it end-to-end via a persistent [Codex](https://github.com/ratley/codex-client) session with full context across tasks.

## Install

```bash
npm install -g orcastrator
```

## Usage

```bash
orca -p "add a settings screen to the iOS app"
orca -p "refactor the auth module to use JWTs"
orca -p "write unit tests for the payments service"
```

### From a spec or plan file

```bash
orca --spec ./specs/myfeature.md
orca --plan ./specs/myfeature.md   # --plan is an alias for --spec
```

### Other commands

```bash
orca plan --spec ./specs/myfeature.md   # plan only, no execution
orca status                             # list all runs
orca status --last                      # show most recent run
orca status --run <run-id>              # show run details
orca resume --last                      # resume most recent run
orca resume --run <id>                  # resume an incomplete run
orca cancel --run <id>                  # cancel an active run

# Pull request workflow
orca pr                                 # interactive — pick run + action
orca pr draft --run <id>               # create a draft PR
orca pr create --run <id>              # create a ready-for-review PR
orca pr publish --run <id>             # publish draft → ready for review
orca pr status --run <id>              # check PR state and CI
```

### Hooks

```bash
orca -p "build X" \
  --on-task-complete "echo task done: $ORCA_TASK_NAME" \
  --on-complete "open -a Terminal" \
  --on-error "say orca failed"
```

Available hooks: `--on-milestone`, `--on-task-complete`, `--on-task-fail`, `--on-complete`, `--on-error`

## Config

Orca auto-discovers config — no flags needed for standard setups:

- **Global:** `~/.orca/config.js`
- **Project:** `./orca.config.js` or `./orca.config.ts`

Merge order: global → project → `--config` flag (most specific wins).

```js
// orca.config.js
export default {
  hookCommands: {
    onComplete: 'say "orca done"',
    onError: 'say "orca failed"',
  },
}
```

## Run output

Run state is written to `~/.orca/runs/<run-id>/status.json`.

## Development

```bash
bun install           # install deps
bun test              # run tests
bun run src/cli/index.ts -p "your goal here"   # run without building
```
