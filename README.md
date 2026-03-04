<p align="center">
  <img src="assets/orca-banner.jpg" alt="Orca" width="380" />
  <br/><br/>
  <a href="https://orcastrator.dev">orcastrator.dev</a>
</p>

# Orca

Coordinated agent run harness. Breaks a task into a graph, then executes it end-to-end via a persistent [Codex](https://github.com/ratley/codex-client) session.

## Install

```bash
npm install -g orcastrator
```

## Quick Start

```bash
# 1. Go into a git repo
cd /path/to/repo

# 2. Run a task
orca "add input validation to the signup form in src/auth/signup.ts"

# 3. Check status
orca status --last

# 4. Once done, open a PR
orca pr create --last
```

**Write specific goals.** Orca passes your task to a planner — vague input produces vague plans.

- Bad: `"fix the bug"`
- Good: `"Fix the TypeError thrown on logout with an expired token in src/auth/session.ts. Ensure existing tests pass and add a regression test."`

---

## Common Workflows

### Status & monitoring

```bash
orca status                  # list all runs
orca status --last           # most recent run
orca status --run <run-id>   # specific run
orca list                    # alias for status
```

Run states: `planning` → `running` → `completed` | `failed` | `cancelled` | `waiting_for_answer`

### Answering questions

If a run hits `waiting_for_answer`, it's blocked until you respond:

```bash
orca status --last                          # read the question
orca answer <run-id> "yes, use migration A"  # unblock it
```

### Spec / plan files

Use a markdown spec instead of an inline task:

```bash
orca --spec ./specs/feature.md   # plan + execute
orca plan --spec ./specs/feature.md  # plan only, no execution
```

### Failure & recovery

```bash
orca resume --last   # retry from last checkpoint
orca cancel --last   # abort
```

Common failures:
- `auth error` → re-auth Codex (`codex auth`) or set `OPENAI_API_KEY` / `ORCA_OPENAI_API_KEY`
- `no git repo` → `cd` into a git repo
- `plan invalid` → goal too vague; cancel and restate
- Session logs: `./session-logs/` (or `sessionLogs` config path)

### PR workflow

```bash
orca pr draft --last     # open a draft PR (won't trigger CI)
orca pr publish --last   # un-draft it
orca pr create --last    # draft + publish in one step
orca pr status --last    # check PR and CI status
```

Orca always works on a branch — never pushes directly to main/master.

---

## Config

Orca loads config in this order (later overrides earlier):

1. `~/.orca/config.ts` or `~/.orca/config.js` (global)
2. `./orca.config.ts` or `./orca.config.js` (project)
3. `--config <path>` (explicit)

`.ts` is preferred over `.js` when both exist.

```ts
// orca.config.ts
import { defineOrcaConfig } from "orcastrator";

export default defineOrcaConfig({
  executor: "codex",              // only supported value
  runsDir: "./.orca/runs",        // default: ~/.orca/runs
  sessionLogs: "./session-logs",
  skills: ["./.orca/skills"],
  maxRetries: 1,

  codex: {
    model: "gpt-5.3-codex",
    effort: "medium",             // "low" | "medium" | "high" — applies to all Codex turns
    timeoutMs: 300000,
    multiAgent: false,      // see Multi-agent section
    perCwdExtraUserRoots: [
      { cwd: process.cwd(), extraUserRoots: ["/tmp/shared-skills"] }
    ],
  },

  review: {
    plan: {
      enabled: true,
      onInvalid: "fail",    // "fail" | "warn_skip"
    },
    execution: {
      enabled: true,
      maxCycles: 2,
      onFindings: "auto_fix",  // "auto_fix" | "report_only" | "fail"
      validator: {
        auto: true,            // auto-detect validators from package.json
        // commands: ["npm run validate"]  // explicit override
      },
      // prompt: "Prefer minimal safe fixes"
    },
  },

  pr: {
    enabled: true,
    requireConfirmation: true,
  },

  hooks: {
    onTaskComplete: async (event, context) => {
      console.log(`task done: ${event.taskId} from pid ${context.pid}`);
    },
    onError: async (event) => { console.error(event.error); },
  },

  hookCommands: {
    onComplete: "echo run complete",
    onError: "echo run failed",
    onTaskComplete: "node ./scripts/on-task-complete.mjs",
  },
});
```

### Review cycle

After planning, Orca runs a pre-execution review that can edit the task graph (add/remove tasks, update fields, adjust dependencies) before execution starts.

After execution, Orca runs validation commands and asks Codex to review findings. With `onFindings: "auto_fix"`, it applies fixes and retries up to `maxCycles` times, then reports. Set `ORCA_SKIP_VALIDATORS=1` to skip validator auto-detection at runtime.

### Multi-agent mode

Set `codex.multiAgent: true` to spawn parallel Codex agents per task. Faster for large refactors with independent subtasks; higher token cost. **Note:** this writes `multi_agent = true` to your global `~/.codex/config.toml`.

### Skills

Orca auto-loads skills in this precedence order (first name wins):

1. `config.skills[]`
2. `./.orca/skills/` (project-local)
3. `~/.orca/skills/` (global)
4. Bundled defaults (includes `code-simplifier`)

Inject additional app-server-visible skills via `codex.perCwdExtraUserRoots`.

---

## CLI Reference

```
orca <task>                              Start a run
orca --spec <path>                       Run from a spec file
orca plan --spec <path>                  Plan only, no execution

orca status [--last | --run <id>]        Run status
orca list                                List all runs
orca resume [--last | --run <id>]        Retry from checkpoint
orca cancel [--last | --run <id>]        Abort a run
orca answer <run-id> "<text>"            Answer a waiting question

orca pr draft [--last | --run <id>]      Open draft PR
orca pr create [--last | --run <id>]     Create and publish PR
orca pr publish [--last | --run <id>]    Un-draft an existing PR
orca pr status [--last | --run <id>]     PR and CI status
                                         (non-TTY: --run or --last required)

orca skills                              List loaded skills
orca setup                               Interactive setup wizard
```

**Key flags for `orca` (run):**

- `--codex-only` — force Codex executor
- `--codex-effort <low|medium|high>` — override effort for this run
- `--config <path>` — explicit config file
- `--on-complete <cmd>`, `--on-error <cmd>`, `--on-task-complete <cmd>`, `--on-findings <cmd>`, etc.

**Key flags for `orca resume`:**

- `--codex-only`, `--codex-effort <low|medium|high>`, `--config <path>`, `--run <id>`, `--last`

**`orca setup` flags:**

- `--openai-key <key>` — write key to config
- `--executor <codex>` — set executor
- `--ts` — write TypeScript config
- `--global` — write to `~/.orca/config.js`
- `--project` — write to `./orca.config.js`

### Hooks

Available hook names: `onMilestone`, `onTaskComplete`, `onTaskFail`, `onInvalidPlan`, `onFindings`, `onComplete`, `onError`.

- Function hooks (`config.hooks`): receive `(event, context)` where `context = { cwd, pid, invokedAt }`
- Command hooks (`config.hookCommands` / `--on-*` flags): receive full event JSON over stdin
- Unknown hook keys in config are rejected at load time

### Run ID format

`<slug>-<unix-ms>-<hex4>` — e.g. `feature-auth-1766228123456-1a2b`

### Run state locations

- Status: `<runsDir>/<run-id>/status.json`
- Answer payloads: `<runsDir>/<run-id>/answer.txt`
- `runsDir` defaults to `~/.orca/runs` (override with `ORCA_RUNS_DIR`)

### Project instruction files

Orca injects `AGENTS.md` into planning context when found at the project root.

---

## Development

```bash
npm install        # canonical install (use npm for deps)
bun run src/cli/index.ts "task"   # local dev
bun test src
npm run test:postexec-json
```

Full validation gate (runs lint → type-check → tests → build):

```bash
npm run validate
```

### Package manager policy

- **npm** — canonical for deps, CI, and publish (`package-lock.json`)
- **Bun** — used as runtime/test runner locally (`bun.lock`)

Commit both lockfiles. When changing deps: `npm install && bun install`.

---

## License

MIT — see [LICENSE](./LICENSE).
