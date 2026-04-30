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

If a run hits `waiting_for_answer`, execution pauses until a response is submitted to the live run:

```bash
orca status --last                          # read the question
orca answer <run-id> "yes, use migration A"  # answer and resume the same run
```

For multi-question prompts, pass JSON mapping question IDs to answers:

```bash
orca answer <run-id> '{"answers":{"q1":{"answers":["yes"]},"q2":{"answers":["option-a"]}}}'
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

Orca is Codex-only. Stale executor values from older configs are coerced to `codex`.
Planning can be routed separately: by default Orca asks a lightweight Codex router whether Claude or Codex should generate the task graph, then Codex executes the resulting tasks.

```ts
// orca.config.ts
import { defineOrcaConfig } from "orcastrator";

export default defineOrcaConfig({
  executor: "codex", // only supported value
  runsDir: "./.orca/runs", // default: ~/.orca/runs
  sessionLogs: "./session-logs",
  skills: ["./.orca/skills"],
  maxRetries: 1,

  planner: {
    agent: "auto", // "auto" | "claude" | "codex"
    router: {
      model: "gpt-5.3-codex-spark",
    },
  },

  claude: {
    command: "claude", // uses `claude -p` for planning
    model: "claude-opus-4-7",
    effort: "high",
    timeoutMs: 300000,
  },

  codex: {
    model: "gpt-5.5",
    effort: "high", // fallback for all Codex turns unless overridden below
    thinkingLevel: {
      decision: "low", // planning gate / quick routing decisions
      planning: "xhigh", // task graph generation
      review: "high", // task graph consultation + post-execution review prompts
      execution: "medium", // task execution turns
    },
    timeoutMs: 300000,
    multiAgent: false, // see Multi-agent section
    perCwdExtraUserRoots: [{ cwd: process.cwd(), extraUserRoots: ["/tmp/shared-skills"] }],
  },

  review: {
    plan: {
      enabled: true,
      onInvalid: "fail", // "fail" | "warn_skip"
    },
    execution: {
      enabled: true,
      maxCycles: 2,
      onFindings: "auto_fix", // "auto_fix" | "report_only" | "fail"
      validator: {
        auto: true, // auto-detect validators from package.json
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
    onError: async (event) => {
      console.error(event.error);
    },
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

Use `codex.thinkingLevel` when you want per-step reasoning levels instead of a single global `codex.effort`. Supported steps: `decision`, `planning`, `review`, `execution`.

### Planner routing

Set `planner.agent: "claude"` to always use the local Claude Code CLI for task graph generation, or `planner.agent: "codex"` to keep planning in Codex. The default `planner.agent: "auto"` asks Codex using `planner.router.model` and routes broad, creative, ambiguous work to Claude while keeping narrow implementation-heavy planning in Codex.

`planner.router` is only valid with `planner.agent: "auto"`:

```ts
// Automatic routing
planner: {
  agent: "auto",
  router: { model: "gpt-5.3-codex-spark" },
}

// Forced planning agent; no router is used
planner: {
  agent: "claude",
}
```

The same rule is easiest to read as JSON shapes:

```json
[
  { "planner": { "agent": "auto", "router": { "model": "gpt-5.3-codex-spark" } } },
  { "planner": { "agent": "claude" } },
  { "planner": { "agent": "codex" } }
]
```

Do not include `router` with forced `claude` or forced `codex` planning; Orca rejects that config because the router is bypassed.

Claude planning shells out to the configured command with `-p` and passes the prompt on stdin. It does not replace Codex execution, task-graph review, or post-execution review.

Model IDs are typed for the documented OpenAI and Claude models Orca supports. Check the provider docs when updating those lists: [OpenAI models](https://platform.openai.com/docs/models), [Anthropic Claude models](https://docs.anthropic.com/en/docs/about-claude/models), and [Claude Code model config](https://docs.anthropic.com/en/docs/claude-code/model-config). If you need an unreleased, private, or provider-specific model, wrap it explicitly:

```ts
import { customModel, defineOrcaConfig } from "orcastrator";

export default defineOrcaConfig({
  codex: {
    model: customModel("private-openai-model"),
  },
  claude: {
    model: customModel("private-claude-model"),
  },
});
```

### Multi-agent mode

Set `codex.multiAgent: true` to enable multi-agent-aware prompt guidance. Orca's task runner stays sequential, but Codex can use subagents inside a task turn when work is independent. **Note:** this writes `multi_agent = true` to your global `~/.codex/config.toml`.

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

- `--codex-only` — compatibility flag; executor is already Codex-only
- `--codex-effort <low|medium|high|xhigh>` — override effort for this run
- `--config <path>` — explicit config file
- `--on-question <cmd>` — command hook when Codex requests user input
- `--on-complete <cmd>`, `--on-error <cmd>`, `--on-task-complete <cmd>`, `--on-findings <cmd>`, etc.

**Key flags for `orca resume`:**

- `--codex-only`, `--codex-effort <low|medium|high|xhigh>`, `--config <path>`, `--run <id>`, `--last`

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
- `onQuestion` includes request metadata (`requestId`, `threadId`, `turnId`, `itemId`) and `questions[]`
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

Full validation gate (runs Oxfmt check, Oxlint, type-check, tests, and build):

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
