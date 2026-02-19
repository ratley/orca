# orca

Coordinated agent run harness. Breaks down a goal into a task graph, then executes it end-to-end via a persistent [Codex](https://github.com/ratley/codex-client) session with full context across tasks.

## Install

```bash
npm install -g orcastrator
```

## Run A Goal

Start with a plain-language goal:

```bash
orca "add auth to the app"
```

Orca will create a run, plan tasks, execute them, and persist run state.

## Spec And Plan Files

Use a spec/plan markdown file when you already have a written breakdown:

```bash
orca --spec ./specs/feature.md
orca --plan ./specs/feature.md
```

If you only want planning (no execution):

```bash
orca plan --spec ./specs/feature.md
```

## Run Management

```bash
orca status
orca status --last
orca status --run <run-id>

orca list

orca resume --last
orca resume --run <run-id>

orca cancel --last
orca cancel --run <run-id>

orca answer <run-id> "yes, use migration A"
```

## PR Workflow

```bash
orca pr
orca pr draft --run <run-id>
orca pr create --run <run-id>
orca pr publish --run <run-id>
orca pr status --run <run-id>

orca pr-finalize --config ./orca.config.js
```

## Config

Orca auto-discovers config in this order:

1. `~/.orca/config.js`
2. `./orca.config.js` or `./orca.config.ts`
3. `--config <path>` (if passed)

Later entries override earlier ones.

```js
// orca.config.js
export default {
  runsDir: "./.orca/runs",
  sessionLogs: "./session-logs",
  hookCommands: {
    onTaskComplete: "echo task done: $ORCA_TASK_NAME",
    onComplete: "echo run complete",
    onError: "echo run failed"
  },
  codex: {
    model: "gpt-5.3-codex",       // override the codex model
    multiAgent: true,              // enable codex multi-agent (see below)
  }
};
```

### Multi-agent mode

Codex supports experimental [multi-agent workflows](https://developers.openai.com/codex/multi-agent) where it can spawn parallel sub-agents for complex tasks.

To enable it in orca, set `codex.multiAgent: true` in your config:

```js
export default {
  codex: { multiAgent: true }
};
```

When enabled, orca adds `multi_agent = true` to your global `~/.codex/config.toml`. If you already have multi-agent enabled in your Codex config, it will work automatically without setting anything in orca.

> **Note:** Multi-agent is off by default because enabling it modifies your global Codex configuration. It is currently an experimental Codex feature.

## Reference

### Flags

Global:

- `-h, --help`
- `-V, --version`

`orca` / `orca run`:

- positional: `[goal]`
- also works: `--task <text>`, `-p, --prompt <text>`
- `--spec <path>`
- `--plan <path>`
- `--config <path>`
- `--on-milestone <cmd>`
- `--on-task-complete <cmd>`
- `--on-task-fail <cmd>`
- `--on-complete <cmd>`
- `--on-error <cmd>`

`orca plan`:

- `--spec <path>`
- `--config <path>`
- `--on-milestone <cmd>`
- `--on-error <cmd>`

`orca status`:

- `--run <run-id>`
- `--last`
- `--config <path>`

`orca resume`:

- `--run <run-id>`
- `--last`
- `--config <path>`

`orca cancel`:

- `--run <run-id>`
- `--last`
- `--config <path>`

`orca answer`:

- positional: `[run-id] [answer]`
- `--run <id>`

`orca list`:

- `--config <path>`

`orca pr draft|create|publish|status`:

- `--run <run-id>`
- `--last`
- `--config <path>`

`orca pr-finalize`:

- `--config <path>`

`orca setup`:

- `--anthropic-key <key>`
- `--openai-key <key>`
- `--check`
- `--global`
- `--project`

### Hooks

Hook names:

- `onMilestone`
- `onTaskComplete`
- `onTaskFail`
- `onComplete`
- `onError`

Run hooks from CLI with `--on-...` flags or from config via `hookCommands` / `hooks`.

### Run ID Format

Run IDs are generated as:

- `<slug>-<unix-ms>-<hex4>`
- Example: `feature-auth-1766228123456-1a2b`

### Config File Locations

- Global: `~/.orca/config.js`
- Project: `./orca.config.js` or `./orca.config.ts`
- Explicit: `--config <path>`

### Run State Locations

- Run status: `<runsDir>/<run-id>/status.json`
- Answer payloads: `<runsDir>/<run-id>/answer.txt`
- `runsDir` defaults to `~/.orca/runs` unless overridden by `ORCA_RUNS_DIR`.

## Development

```bash
bun install
bun test
bun run src/cli/index.ts "your goal here"
```
