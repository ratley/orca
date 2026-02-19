# orca

Orca is a TypeScript CLI harness for coordinated agent planning and execution. It takes a goal or spec file, uses Claude to decompose it into a task graph, runs a pre-execution review pass with Codex, then executes each task via a persistent Codex thread — keeping full context across the entire run.

**Pipeline:** Claude plans → Codex strengthens the plan → Codex executes (persistent thread) → Codex post-run review

## Install

```bash
npm install -g orcastrator
```

## Usage

### Inline goal (no file needed)

```bash
orca -p "add a settings screen to the iOS app"
orca --prompt "refactor the auth module to use JWTs"
orca --task "write unit tests for the payments service"
```

### Spec or plan file

```bash
orca run --spec ./specs/myfeature.md
orca run --plan ./specs/myfeature.md   # --plan is an alias for --spec
```

`run` is optional — the above is equivalent to:

```bash
orca --spec ./specs/myfeature.md
```

### Other commands

```bash
orca plan --spec ./specs/myfeature.md   # plan only, no execution
orca status --run <run-id>              # show status for a specific run
orca status                             # list all runs with status
orca list                               # list all runs
orca resume --run <run-id>             # resume an incomplete run
orca cancel --run <run-id>             # cancel an active run

# Pull request workflow
orca pr                                 # interactive — pick run + action
orca pr draft --run <run-id>           # create a draft PR
orca pr create --run <run-id>          # create a ready-for-review PR
orca pr publish --run <run-id>         # publish draft → ready for review
orca pr status --run <run-id>          # check PR state and CI status
```

### Hooks

```bash
orca -p "build X" \
  --on-task-complete "echo task done: $ORCA_TASK_NAME" \
  --on-complete "open -a Terminal" \
  --on-error "say orca failed"
```

Available hooks: `--on-milestone`, `--on-task-complete`, `--on-task-fail`, `--on-complete`, `--on-error`

## Run output

Run state is written to:

```text
~/.orca/runs/<run-id>/status.json
```

Run IDs follow the format:

```text
<spec-slug>-<timestamp-ms>-<4char-hex>
```

## Architecture

| Step | Model | What |
|------|-------|------|
| Planning | Claude | Spec → task graph (dependency-aware DAG) |
| Pre-execution review | Codex | Strengthens the plan — fills gaps, solidifies tasks |
| Execution | Codex | Persistent thread runs each task (full context across tasks) |
| Post-run review | Codex | Reviews all changes after execution completes |

## Development

Orca uses [orca-codex-client](https://github.com/ratley/codex-client) under the hood to manage persistent Codex sessions.

```bash
bun install           # install deps
bun test              # run tests
bun run src/cli/index.ts -p "your goal here"   # run without building
```
