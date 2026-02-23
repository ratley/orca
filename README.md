<p align="center">
  <img src="assets/orca-banner.jpg" alt="Orca" width="380" />
  <br/><br/>
  <a href="https://orcastrator.dev">orcastrator.dev</a>
</p>

# Orca

Coordinated agent run harness. Breaks down a task into a task graph, then executes it end-to-end via a persistent [Codex](https://github.com/ratley/codex-client) session with full context across tasks.

## Install

```bash
npm install -g orcastrator
```

## Run A Task

Start with a plain-language task:

```bash
orca "add auth to the app"
```

Orca will create a run, plan tasks, run a pre-execution review/improvement pass on the task graph, execute the reviewed graph, and persist run state.

### Pre-execution review-improvement stage

After planning, Orca runs a structured review pass that can edit the task graph before execution starts. The review output is schema-validated and supports concrete graph operations:

- update task fields (`name`, `description`, `acceptance_criteria`)
- add/remove task
- add/remove dependency

By default, Orca applies valid review improvements and continues execution. The edited graph is re-validated as a DAG. If the review stage output is invalid, Orca fails with an actionable error (`review.plan.onInvalid: "fail"`). Set `review.plan.onInvalid: "warn_skip"` to log a warning and continue with the original planner graph instead.

### Post-execution review / fix cycles

After task execution, Orca can run deterministic validation commands, then ask Codex to review findings and optionally auto-fix issues in bounded cycles.

- `review.execution.enabled` (default `true`)
- `review.execution.maxCycles` (default `2`)
- `review.execution.onFindings`:
  - `auto_fix` (default): apply fixes and continue until clean or max cycles
  - `report_only`: report findings and stop
  - `fail`: mark run failed when findings exist
- `review.execution.validator.auto` (default `true`): auto-detect validator commands from `package.json`
  - Caveat: `ORCA_SKIP_VALIDATORS=1` forces this to `false` at runtime
- `review.execution.validator.commands` (optional explicit command list)
- `review.execution.prompt` (optional custom reviewer instruction)

When using the Codex executor, Orca enforces a strict reviewer JSON schema (`{summary, findings, fixed}`) as the primary path. If the first response is malformed, Orca issues one deterministic repair prompt (max 2 attempts total); if still invalid, it emits an `onFindings` event with an explicit parse error and stops auto-fix progression for that cycle.

Run the dedicated integration coverage for this JSON retry/validation path with `npm run test:postexec-json`.

Orca then prints a final post-execution review summary.

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

orca pr publish --last
orca pr publish --config ./orca.config.js   # accepted, currently unused by PR command resolution

# Non-TTY requires explicit run selection
orca pr publish --run <run-id>
orca pr publish --last
```

## Config

Orca auto-discovers config in this order:

1. Global config: `~/.orca/config.ts` (preferred when both exist) or `~/.orca/config.js`
2. Project config: `./orca.config.ts` (preferred when both exist) or `./orca.config.js`
3. `--config <path>` (if passed)

Later entries override earlier ones.

```ts
// orca.config.ts
import { defineOrcaConfig } from "orcastrator";

export default defineOrcaConfig({
  executor: "codex",  openaiApiKey: process.env.OPENAI_API_KEY,
  runsDir: "./.orca/runs",
  sessionLogs: "./session-logs",
  skills: ["./.orca/skills"],
  maxRetries: 1,

  codex: {
    enabled: true,
    model: "gpt-5.3-codex",
    effort: "medium",
    command: "codex",
    timeoutMs: 300000,
    multiAgent: false,
    perCwdExtraUserRoots: [
      { cwd: process.cwd(), extraUserRoots: ["/tmp/shared-skills"] }
    ]
  },
  hooks: {
    onTaskComplete: async (event, context) => {
      console.log(`task done: ${event.taskId} (${event.taskName}) from pid ${context.pid}`);
    },
    onError: async (event) => {
      console.error(event.error);
    }
  },
  hookCommands: {
    onTaskComplete: "node ./scripts/on-task-complete.mjs",
    onComplete: "echo run complete",
    onError: "echo run failed"
  },
  pr: {
    enabled: true,
    requireConfirmation: true
  },
  review: {
    // Deprecated compatibility aliases (prefer review.plan.*):
    // enabled: true,
    // onInvalid: "fail",
    plan: {
      enabled: true,
      onInvalid: "fail"
    },
    execution: {
      enabled: true,
      maxCycles: 2,
      onFindings: "auto_fix",
      validator: {
        auto: true,
        // commands: ["npm run validate"]
      },
      // prompt: "Prefer minimal safe fixes"
    }
  }
});
```

### Config field reference (OrcaConfig)

Top-level: `executor`, `openaiApiKey`, `runsDir`, `sessionLogs`, `skills`, `maxRetries`, `hooks`, `hookCommands`, `pr`, `review`, `codex`.

- `pr.enabled`, `pr.requireConfirmation`
- `maxRetries` is part of `OrcaConfig`; current planner-generated task retries remain fixed in task graph contracts
- `codex.enabled`, `codex.model`, `codex.effort`, `codex.command`, `codex.timeoutMs`, `codex.multiAgent`, `codex.perCwdExtraUserRoots`
- `review.plan.enabled`, `review.plan.onInvalid`
- `review.execution.enabled`, `review.execution.maxCycles`, `review.execution.onFindings`, `review.execution.validator.auto`, `review.execution.validator.commands`, `review.execution.prompt`
- Deprecated compatibility aliases: `review.enabled`, `review.onInvalid` (still accepted; prefer `review.plan.*`)

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

- positional: `[task]`
- also works: `--task <text>`, `-p, --prompt <text>`
- `--spec <path>`
- `--plan <path>`
- `--config <path>`
- `--codex-only` (force Codex executor for this run)
- `--codex-effort <low|medium|high>`
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
- `--codex-only`
- `--codex-effort <low|medium|high>`

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
- `--config <path>` (accepted for compatibility; currently unused by PR command run resolution)

`orca pr publish`:

- `--run <run-id>`
- `--last`
- `--config <path>` (accepted for compatibility; currently unused by PR command run resolution)
- If neither `--run` nor `--last` is provided: interactive run picker in TTY; non-TTY requires `--run` or `--last`

`orca skills`:

- `--config <path>`

`orca setup`:

- auto-detect is default
- `--openai-key <key>` — override OpenAI API key (written to config)
- `--executor <codex>` — explicitly set executor in written config
- `--ts` — write TS config output (`~/.orca/config.ts` / `./orca.config.ts`)
- `--global` — save to global config (`~/.orca/config.js` by default, or `.ts` with `--ts`)
- `--project` — save to project config (`./orca.config.js` by default, or `.ts` with `--ts`)
- `--project-config-template` / `--skip-project-config` removed

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
- `onError` (fires on run failures and hook-dispatch failures)

Run hooks from CLI with `--on-...` flags or from config via `hooks` / `hookCommands`.
Unknown hook keys in config are rejected at load time with an explicit allowed-hook list.

Hook contract:
- Function hooks (`config.hooks`) are the primary path and are strongly typed per hook event.
- Every function hook receives `(event, context)` where `context` is deterministic: `{ cwd, pid, invokedAt }`.
- Command hooks (`--on-...` and `config.hookCommands`) receive the full event payload as JSON over stdin.
- Orca no longer injects hook payload via `ORCA_*` env vars.

Smoke-test the hook contract (function + command + concurrency): `npm run smoke:hooks`.

### Run ID Format

Run IDs are generated as:

- `<slug>-<unix-ms>-<hex4>`
- Example: `feature-auth-1766228123456-1a2b`

### Config File Locations

- Global: `~/.orca/config.ts` (preferred when both exist) or `~/.orca/config.js`
- Project: `./orca.config.ts` (preferred when both exist) or `./orca.config.js`
- Explicit: `--config <path>`

### Project Instruction Files

During planning, Orca automatically injects project instruction files when present:

1. `AGENTS.md`
2. `CLAUDE.md`

Files are discovered from the project root (nearest `.git` from the spec/task context) and injected in that order.

If both filenames resolve to the same underlying file (for example, `CLAUDE.md` symlinked to `AGENTS.md`), Orca injects that content only once and keeps the first entry in order (`AGENTS.md`).

### Project Skills

Orca auto-loads skills in this precedence order (first matching skill name wins):

1. `config.skills[]`
2. `./.orca/skills/` (project-local, from current working directory)
3. `~/.orca/skills/` (global)
4. Bundled defaults from the Orca package: `<orca package root>/.orca/skills/`

This repo ships a bundled default `code-simplifier` skill at `./.orca/skills/code-simplifier/SKILL.md`, and it loads even when Orca runs in arbitrary target repositories. Project/global/config skills can still override it by reusing the same skill name. Planner/reviewer/executor prompts explicitly apply `code-simplifier` guidance for all code-writing and code-review steps while keeping behavior unchanged unless a task explicitly requires behavior changes.

When Orca uses the Codex executor, each turn is sent with both:
- a text input item (`{ type: "text", text: ... }`), and
- explicit skill input items (`{ type: "skill", name, path }`) for every loaded skill in the same precedence order above.

At session startup, Orca also calls Codex app-server `skills/list` with `forceReload: true` (and optional `codex.perCwdExtraUserRoots`) so additional app-server-visible skills can be appended deterministically without overriding Orca-local precedence.

This keeps Codex skill loading deterministic instead of relying only on prompt/context pickup.

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
bun run src/cli/index.ts "your task here"
bun test src
npm run test:postexec-json
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

## GitHub release tracking (tags only)

Orca includes a lightweight GitHub Actions workflow at `.github/workflows/release.yml`:

- Trigger: push a tag matching `v*` (workflow only releases SemVer tags like `v0.4.0` or `v0.4.0-rc.1`)
- Behavior: create or update the matching GitHub Release
- Notes: auto-generated by GitHub (`generate_release_notes: true`)

This workflow is for release tracking/changelogs only. It does not publish to npm.

## npm publish automation (GitHub Actions)

Orca includes a publish workflow at `.github/workflows/publish.yml`.

- Primary trigger: push a tag matching `v*` (for example `v1.2.3` or `v1.2.3-rc.1`)
- Optional fallback: manual `workflow_dispatch`
- Required secret: `NPM_TOKEN`
- Behavior: checkout → Node setup (npm registry auth) → safety checks → `npm ci` → `npm run validate` → publish if version is not already on npm

Safety checks enforced before publish:

1. Tag must be SemVer-like (`vX.Y.Z` with optional prerelease/build metadata)
2. Release commit must be reachable from the repository default branch
3. `package.json` version must match the tag version (without the leading `v`)
4. If the version already exists on npm, publish is skipped as a safe no-op

### Safe setup

1. In GitHub, open **Settings → Secrets and variables → Actions** for this repository.
2. Add a repository secret named `NPM_TOKEN`.
   - Create this token in npm as a granular automation/publish token scoped only to `orcastrator`.
3. Use least privilege, avoid reusing broad account tokens, and rotate the token periodically.

### Safe run flow

1. Bump `package.json` to the intended release version.
2. Create and push a matching tag, for example: `git tag v1.2.3 && git push origin v1.2.3`.
3. Verify the package on npm after the workflow completes.
4. If needed, run the same workflow manually from **Actions → npm Publish → Run workflow** as a fallback (use an existing tag so the workflow publishes that exact tagged commit).

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
