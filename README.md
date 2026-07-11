<p align="center">
  <img src="assets/orca-banner.jpg" alt="Orca" width="380" />
  <br/><br/>
  <a href="https://orcastrator.dev">orcastrator.dev</a>
</p>

# Orca

Coordinated agent run harness. Breaks a task into a graph, then executes it end-to-end via a persistent [Codex](https://github.com/happycatlabs/codex-client) session.

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

## For agents

Orca's lane primitive is a machine-readable substrate for delegating work to other agents. Run `orca contract` to get the full orca/v1 contract — JSON Schemas for the envelope, event, and manifest shapes, plus exit codes and verb synopses. Every lane command prints exactly one JSON envelope as its final stdout line (success and failure alike) and never exits 0 on failure; the one documented exemption is `--help`/`-h`, which stays human-readable and prints no envelope. Lane ids look like `lane_a3f81c02` and are validated against `^lane_[0-9a-f]{8}$` before any filesystem path is built from them. `dispatch` and `resume` accept `--timeout <ms>`.

Follow each envelope's literal `next[]` commands, especially after answering a question: a live native turn continues inside the original dispatch, while a parked question requires `resume`. Resume accepts blocked lanes (a parked question, or a live question whose recorded poller process is dead), completed lanes (the documented terminal carve-out — a resume is a new user turn), and running lanes whose recorded resumer pid is dead; `failed`/`killed`/`lost` lanes are never reopened — dispatch a new lane instead. All three built-in adapter manifests declare `kill:true`; process-group kill is explicitly POSIX-only in v0. Codex emits its detached app-server `pid`/`pgid` in `agent_started`; the lane CLI persists that process identity and owns process-group signaling and termination verification. Design doc and AX rules: [docs/LANES.md](./docs/LANES.md).

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
orca answer <run-id> "yes, use migration A"  # answer and resume the live run
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

Stale executor values from older configs are ignored and coerced to `codex`. Orca no longer supports alternate executors.

```ts
// orca.config.ts
import { defineOrcaConfig, defineOrcaFlow } from "orcastrator";

const linearTicketFlow = defineOrcaFlow({
  description: "Implement a ticket with parallel task lanes, per-task review, and final validation.",
  baseline: {
    prompt: [
      "Treat the ticket/spec as the source of truth.",
      "Inspect AGENTS.md, git status, and the relevant files before planning.",
      "Keep edits scoped and preserve unrelated user work."
    ].join("\n"),
    // Add project-local skill roots here when they exist, for example:
    // skills: ["./.orca/skills/orchestrate", "./.orca/skills/critique"],
  },
  planning: {
    prompt: "Turn the ticket into independent implementation, test, docs, and review tasks. Make dependencies explicit.",
    review: { enabled: true, onInvalid: "fail" },
  },
  execution: {
    prompt: "Own the smallest file set that completes the task. Leave clear verification evidence before marking work done.",
    codex: { multiAgent: true, maxParallelTasks: 3 },
    review: { enabled: true, maxCycles: 2, onFindings: "auto_fix" },
  },
  review: {
    execution: {
      enabled: true,
      maxCycles: 2,
      onFindings: "auto_fix",
      validator: { auto: true },
    },
  },
  overrides: {
    maxRetries: 1,
  },
  summary: {
    prompt: "Write a PR-style handoff: changes, checks run, risks, and follow-ups.",
  },
});

export default defineOrcaConfig({
  executor: "codex",              // only supported value
  runsDir: "./.orca/runs",        // default: ~/.orca/runs
  sessionLogs: "./session-logs",
  skills: ["./.orca/skills"],
  maxRetries: 1,

  flow: {
    default: "linear-ticket",
    presets: {
      "linear-ticket": linearTicketFlow,
    },
  },

  codex: {
    model: "gpt-5.3-codex",
    effort: "medium",             // fallback for all Codex turns unless overridden below
    thinkingLevel: {
      decision: "low",            // planning gate / quick routing decisions
      planning: "xhigh",          // task graph generation
      review: "high",             // task graph consultation + post-execution review prompts
      execution: "medium",        // task execution turns
    },
    timeoutMs: 300000,
    multiAgent: false,      // see Multi-agent section
    maxParallelTasks: 4,    // runner-level concurrency when multi-agent is active
    perCwdExtraUserRoots: [
      { cwd: process.cwd(), extraUserRoots: ["/tmp/shared-skills"] }
    ],
  },

  review: {
    plan: {
      enabled: true,
      onInvalid: "fail",    // "fail" | "warn_skip"
    },
    task: {
      enabled: true,
      maxCycles: 2,
      onFindings: "auto_fix",  // "auto_fix" | "report_only" | "fail"
      // prompt: "Check each completed task against the original spec"
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

### Flows

Flows are named presets for common run shapes. Configure them with `flow.presets`, optionally set `flow.default`, list them with `orca flows`, and select one per run with `--flow`:

```bash
orca flows
orca flows --json
orca --flow linear-ticket "audit the auth changes"
orca plan --spec ./specs/auth-review.md --flow linear-ticket
```

Use `defineOrcaFlow(...)` for typed presets in `orca.config.ts`. `orca flows --json` is intended for agents and automation: each entry includes copyable `usage` commands plus resolved `effects` for parallel agents, skills, task review, final review, and validators.

For a Linear ticket or similar issue handoff, the shortest agent loop is:

```bash
mkdir -p specs
# Save the ticket title/body and acceptance criteria here.
$EDITOR specs/PROJ-123.md

orca flows --json                         # choose the right preset
orca --flow linear-ticket --spec specs/PROJ-123.md
orca status --last                         # copy the run id if it asks a question
orca answer <run-id> "scope answer here"   # only when status is waiting_for_answer
orca resume --last                         # retry after fixing an external blocker
orca pr draft --last
```

- `baseline` - shared starting instructions and extra skills for the run.
- `planning` - planner instructions plus pre-execution plan-review settings.
- `execution` - execution instructions plus Codex and per-task review settings.
- `review` - full review config overrides, including post-execution validators.
- `overrides` - final config overrides such as skills, retries, Codex, hooks, and PR settings.
- `summary` - instructions for summary/reporting output.

### Review cycle

After planning, Orca runs a pre-execution review that can edit the task graph (add/remove tasks, update fields, adjust dependencies) before execution starts.

During execution, Orca carries the original spec and current task graph into every task prompt. After each task, `review.task` asks Codex to check the completed work against the original spec, task graph, and acceptance criteria. With `onFindings: "auto_fix"`, Orca lets the reviewer fix issues and reruns the check up to `maxCycles`; unresolved findings fail that task instead of silently drifting forward.

After execution, Orca runs validation commands and asks Codex to review findings. With `onFindings: "auto_fix"`, it applies fixes and retries up to `maxCycles` times, then reports. Set `ORCA_SKIP_VALIDATORS=1` to skip validator auto-detection at runtime.

Use `codex.thinkingLevel` when you want different reasoning levels for different stages instead of a single global `codex.effort`.

### Multi-agent mode

Set `codex.multiAgent: true` to spawn parallel Codex agents for independent runnable tasks in the dependency graph. Orca runs each dependency-ready wave concurrently, keeps per-task review inside each task lifecycle, and only unlocks downstream tasks after their dependencies are reviewed and marked done. This is faster for large refactors with independent subtasks and costs more tokens. **Note:** this writes `multi_agent = true` to your global `~/.codex/config.toml`.

Orca runs up to `codex.maxParallelTasks` independent runnable tasks at once when multi-agent mode is active. The default is `4`; set it to `1` to keep execution sequential while leaving Codex multi-agent prompting enabled.

If `~/.codex/config.toml` already enables `[features].multi_agent = true`, Orca also treats the run as multi-agent-aware for planning, review, consultation, and execution prompts even when `codex.multiAgent` is not set in Orca config.

### Codex binary and MCP diagnostics

When `ORCA_CODEX_PATH` is unset, Orca auto-selects the newest installed Codex CLI/app-server it can find instead of blindly trusting the first `codex` binary on `PATH`. This avoids talking to an older global install when a newer desktop build is present.

If configured Codex MCP servers are enabled but not logged in, Orca now summarizes that once and continues without them instead of streaming raw app-server auth noise throughout the run.

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
orca --flow <name> <task>                Run with a flow preset
orca plan --spec <path>                  Plan only, no execution
orca plan --spec <path> --flow <name>    Plan with a flow preset

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

orca flows [--json]                      List configured flow presets and resolved effects
orca skills                              List loaded skills
orca setup                               Interactive setup wizard
```

**Key flags for `orca` (run):**

- `--codex-only` — force Codex executor
- `--codex-effort <low|medium|high>` — override effort for this run
- `--config <path>` — explicit config file
- `--flow <name>` — use a configured flow preset instead of `flow.default`
- `--on-complete <cmd>`, `--on-error <cmd>`, `--on-task-complete <cmd>`, `--on-findings <cmd>`, etc.

**Key flags for `orca plan`:**

- `--config <path>` — explicit config file
- `--flow <name>` — use a configured flow preset for planning

**Key flags for `orca resume`:**

- `--codex-only`, `--codex-effort <low|medium|high>`, `--config <path>`, `--run <id>`, `--last`

**`orca setup` flags:**

- `--openai-key <key>` — write key to config
- `--executor <codex>` — set executor
- `--ts` — write TypeScript config
- `--global` — write to `~/.orca/config.js`
- `--project` — write to `./orca.config.js`

### Hooks

Available hook names: `onMilestone`, `onQuestion`, `onTaskComplete`, `onTaskFail`, `onInvalidPlan`, `onFindings`, `onComplete`, `onError`.

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
npm test           # package script: bun test src ./__tests__
bun test src ./__tests__
npm run test:integration
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
