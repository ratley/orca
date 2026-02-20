<p align="center">
  <img src="assets/orca-banner.jpg" alt="Orca" width="380" />
  <br/><br/>
  <a href="https://orcastrator.dev">orcastrator.dev</a>
</p>

# Orca

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

Orca will create a run, plan tasks, run a pre-execution review/improvement pass on the task graph, execute the reviewed graph, and persist run state.

### Pre-execution review-improvement stage

After planning, Orca runs a structured review pass that can edit the task graph before execution starts. The review output is schema-validated and supports concrete graph operations:

- update task fields (`name`, `description`, `acceptance_criteria`)
- add/remove task
- add/remove dependency

The edited graph is re-validated as a DAG. If review output is invalid, Orca fails with an actionable error by default. You can configure `review.plan.onInvalid: "warn_skip"` to log a warning and continue with the original planner graph.

### Post-execution review / fix cycles

After task execution, Orca can run deterministic validation commands, then ask Codex to review findings and optionally auto-fix issues in bounded cycles.

- `review.execution.enabled` (default `true`)
- `review.execution.maxCycles` (default `2`)
- `review.execution.onFindings`:
  - `auto_fix` (default): apply fixes and continue until clean or max cycles
  - `report_only`: report findings and stop
  - `fail`: mark run failed when findings exist
- `review.execution.validator.auto` (default `true`): auto-detect validator commands from `package.json`
- `review.execution.validator.commands` (optional explicit command list)
- `review.execution.prompt` (optional custom reviewer instruction)

When using the Codex executor, Orca prints a final post-execution review summary.

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
orca status                  # list all runs (summary table)
orca status --last           # status of the most recent run
orca status --run <run-id>   # status of a specific run

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

orca pr publish --config ./orca.config.js
```

## Config

Orca auto-discovers config in this order:

1. `~/.orca/config.js`
2. `./orca.config.js` or `./orca.config.ts`
3. `--config <path>` (if passed)

Later entries override earlier ones.

```ts
// orca.config.ts
export default {
  runsDir: "./.orca/runs",
  sessionLogs: "./session-logs",

  // Function hooks are first-class and strongly typed per hook.
  hooks: {
    onTaskComplete: async (event, context) => {
      console.log(`task done: ${event.taskId} (${event.taskName}) from pid ${context.pid}`);
    },
    onError: async (event) => {
      console.error(event.error);
    }
  },

  // Command hooks remain supported; payload is sent as stdin JSON.
  hookCommands: {
    onTaskComplete: "node -e 'let s=\"\";process.stdin.on(\"data\",d=>s+=d);process.stdin.on(\"end\",()=>{const p=JSON.parse(s);console.log(`task done: ${p.taskId}`);})'",
    onComplete: "echo run complete",
    onError: "echo run failed"
  },
  codex: {
    model: "gpt-5.3-codex",       // override the codex model
    multiAgent: true,              // enable codex multi-agent (see below)
  },
  review: {
    plan: {
      enabled: true,               // default true
      onInvalid: "fail"           // or "warn_skip"
    },
    execution: {
      enabled: true,               // default true
      maxCycles: 2,                // default 2
      onFindings: "auto_fix",     // "auto_fix" | "report_only" | "fail"
      validator: {
        auto: true,                // default true
        // commands: ["npm run validate"]
      },
      // prompt: "Prefer minimal safe fixes"
    }
  }
};
```

### Multi-agent mode

Codex supports experimental [multi-agent workflows](https://developers.openai.com/codex/multi-agent) where it can spawn parallel sub-agents for complex tasks.

To enable it in Orca, set `codex.multiAgent: true` in your config:

```js
export default {
  codex: { multiAgent: true }
};
```

When enabled, Orca adds `multi_agent = true` to your global `~/.codex/config.toml`. If you already have multi-agent enabled in your Codex config, it will work automatically without setting anything in Orca.

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
- `--codex-only` (force Codex executor for this run)
- `--claude-only` (force Claude executor for this run)
- `--codex-effort <low|medium|high>`
- `--claude-effort <low|medium|high|max>`
- `--on-milestone <cmd>`
- `--on-task-complete <cmd>`
- `--on-task-fail <cmd>`
- `--on-invalid-plan <cmd>`
- `--on-findings <cmd>`
- `--on-complete <cmd>`
- `--on-error <cmd>`

`orca plan`:

- `--spec <path>`
- `--config <path>`

`orca status`:

- `--run <run-id>`
- `--last`
- `--config <path>`

`orca resume`:

- `--run <run-id>`
- `--last`
- `--config <path>`
- `--codex-only`
- `--claude-only`
- `--codex-effort <low|medium|high>`
- `--claude-effort <low|medium|high|max>`

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

`orca pr publish`:

- `--config <path>`

`orca setup`:

- `--anthropic-key <key>`
- `--openai-key <key>`
- `--check` (API key lookup order: CLI flag → process env → `~/.openclaw/openclaw.json` `env.vars` → `~/.claude/.env` → `~/.config/claude/.env`)
- `--global`
- `--project`
- `--project-config-template`
- `--skip-project-config`

`orca help`:

- positional: `[command]` — show help for a specific command (e.g. `orca help plan`)
- no flags; also works as `orca --help` or `orca <command> --help`

### Hooks

Hook names:

- `onMilestone`
- `onTaskComplete`
- `onTaskFail`
- `onInvalidPlan`
- `onFindings`
- `onComplete`
- `onError`

Run hooks from CLI with `--on-...` flags or from config via `hooks` / `hookCommands`.
Unknown hook keys in config are rejected at load time with an explicit allowed-hook list.

Hook contract:
- Function hooks (`config.hooks`) are the primary path and are strongly typed per hook event.
- Every function hook receives `(event, context)` where `context` is deterministic: `{ cwd, pid, invokedAt }`.
- Command hooks (`--on-...` and `config.hookCommands`) receive the full event payload as JSON over stdin.
- Orca no longer injects hook payload via `ORCA_*` env vars.

Migration note:
- If your hook commands previously read any `ORCA_*` hook env payload (`ORCA_HOOK_PAYLOAD_JSON`, `ORCA_MSG`, `ORCA_RUN_ID`, etc.), switch them to parse stdin JSON instead.
- Existing CLI hook flags are preserved (`--on-milestone`, `--on-error`, etc.); only payload transport changed.
- Smoke-test the hook contract (function + command + concurrency): `npm run smoke:hooks`.

### Run ID Format

Run IDs are generated as:

- `<slug>-<unix-ms>-<hex4>`
- Example: `feature-auth-1766228123456-1a2b`

### Config File Locations

- Global: `~/.orca/config.js`
- Project: `./orca.config.js` or `./orca.config.ts`
- Explicit: `--config <path>`

### Project Instruction Files

During planning, Orca automatically injects project instruction files when present:

1. `AGENTS.md`
2. `CLAUDE.md`

Files are discovered from the project root (nearest `.git` from the spec/task context) and injected in that order.

### Run State Locations

- Run status: `<runsDir>/<run-id>/status.json`
- Answer payloads: `<runsDir>/<run-id>/answer.txt`
- `runsDir` defaults to `~/.orca/runs` unless overridden by `ORCA_RUNS_DIR`.

## Development

Install dependencies with npm (primary lockfile):

```bash
npm install
```

Run local development and tests with Bun (faster runtime for this project):

```bash
bun run src/cli/index.ts "your goal here"
bun test src
```

## Validation pipeline

Use the full validation gate before opening/publishing changes:

```bash
npm run validate
```

This runs, in order:

1. `npm run lint` (Oxlint syntax/style/static rules)
2. `npm run lint:type-aware` (Oxlint + tsgolint alpha type-aware + type-check diagnostics)
3. `npm run typecheck` (TypeScript Native Preview via `tsgo --noEmit`, with environment fallback to `tsc --noEmit`)
4. `npm run test`
5. `npm run build`

`npm run build` remains `tsc` because the native preview compiler is used here as a fast typecheck gate; production JS emission stays on stable `typescript` for predictable package output.

## Package manager + lockfile policy

Orca uses a mixed runtime/tooling model on purpose:

- **npm is canonical for dependency resolution, release builds, and deterministic installs**.
- **Bun is used as a runtime/test runner in local workflows** (`dev`, `start`, `test`).

Commit both lockfiles:

- `package-lock.json` — canonical dependency graph for npm/CI/publish
- `bun.lock` — Bun runtime resolution parity for local Bun commands

When dependencies change, update both lockfiles in the same PR:

```bash
npm install
bun install
```

This keeps npm and Bun behavior aligned without forcing a disruptive full migration.
