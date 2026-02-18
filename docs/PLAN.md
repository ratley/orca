# Orca Engineering Plan

## 1. Purpose and Scope

Orca is a TypeScript CLI harness for coordinated agent work:
- Input: a spec markdown file.
- Output: an executable, tracked, hookable task run.
- Positioning: infrastructure layer, not a TUI and not tied to one agent vendor.

Core principle: standardize the agent loop (plan, decompose, execute, track, notify) so personal and commercial agents can plug into a common harness.

## 2. Goals and Non-Goals

### Goals
- Provide a stable CLI for planning and execution.
- Use Claude as orchestrator for decomposition and coordination.
- Use Codex as a consultation oracle (read-only guidance), not primary implementer.
- Support robust hooks for milestones, task outcomes, completion, and errors.
- Persist run state to disk (`status.json`) with resumable visibility.
- Keep runtime cross-platform via Node.js and strict TypeScript.

### Non-Goals
- Building a visual terminal UI.
- Hard-coding OpenClaw behavior as a required dependency.
- Fully autonomous PR creation/push without human/agent confirmation.
- Replacing underlying coding agents; Orca coordinates them.

## 3. High-Level Architecture

```text
+--------------------------+
|        User / CI         |
|  orca run/plan/status/pr |
+------------+-------------+
             |
             v
+--------------------------+
|        CLI Layer         |
| - args parsing           |
| - command dispatch       |
+------------+-------------+
             |
             v
+--------------------------+
|     Application Core     |
| - run lifecycle          |
| - planning pipeline      |
| - execution pipeline     |
+---+------------------+---+
    |                  |
    |                  v
    |      +--------------------------+
    |      |     Hook Dispatcher      |
    |      | onMilestone/onComplete.. |
    |      +------------+-------------+
    |                   |
    |                   v
    |      +--------------------------+
    |      | Hook Targets             |
    |      | - OpenClaw default cmd   |
    |      | - stdout fallback        |
    |      | - user handlers/CLI cmd  |
    |      +--------------------------+
    |
    v
+------------------------------+
| Agent Orchestration Layer    |
| - Claude session (SDK v2)    |
| - spec -> task decomposition |
| - coordination prompts       |
+-----+-------------------+----+
      |                   |
      |                   v
      |      +--------------------------+
      |      | Codex Consultation Tool  |
      |      | codex exec -s read-only  |
      |      +--------------------------+
      |
      v
+------------------------------+
| Task Runner + State Store    |
| - dependency-aware queue     |
| - retry policy               |
| - status.json persistence    |
+------------------------------+
```

## 4. Key Design Decisions and Rationale

1. Node.js runtime over Bun.
- Rationale: reliability and portability for CLI tooling across developer machines and CI.
- Consequence: use Node-native APIs and avoid Bun-specific features.

2. Strict TypeScript everywhere.
- Rationale: orchestration systems become state-heavy quickly; strict types reduce runtime drift.
- Consequence: explicit discriminated unions for state transitions and hook events.

3. `oxlint` for lint + `tsgolint` for type checking.
- Rationale: fast feedback loop with modern Oxc stack.
- Consequence: CI and local commands should enforce both checks before release.

4. Claude as orchestrator (SDK v2 preview).
- Rationale: leverage `unstable_v2_createSession`, `send`, and `stream` for iterative planning/execution loops.
- Consequence: isolate SDK usage behind an adapter so future API changes are contained.

5. Codex consultation as an explicit tool call pattern.
- Rationale: keeps primary orchestration centered in Claude while enabling targeted coding guidance.
- Consequence: bounded interface for questions/answers; read-only and auditable prompts.

6. Hook-first extensibility.
- Rationale: notifications and side effects vary by environment/team.
- Consequence: hook execution must be fault-tolerant, observable, and non-blocking by default.

7. File-backed status (`status.json`) as source of truth.
- Rationale: transparent, inspectable state with minimal operational burden.
- Consequence: define atomic writes and versioned schema to prevent corruption.

8. Manual confirmation for PR finalize.
- Rationale: safety and trust; avoid accidental pushes/PRs.
- Consequence: `orca pr finalize` is explicit and confirmation-gated.

## 5. Proposed Directory Structure

```text
orca/
  docs/
    PLAN.md
  specs/
    .gitkeep
  runs/
    <run-id>/
      status.json
      tasks.json
      events.log
      artifacts/
  src/
    cli/
      index.ts
      commands/
        run.ts
        plan.ts
        status.ts
        pr-finalize.ts
    core/
      app.ts
      run-manager.ts
      planner.ts
      task-runner.ts
      dependency-graph.ts
      retry-policy.ts
    agents/
      claude/
        client.ts
        prompts.ts
        session.ts
      codex/
        consultation.ts
    hooks/
      dispatcher.ts
      adapters/
        stdout.ts
        openclaw.ts
        shell-command.ts
      types.ts
    state/
      store.ts
      schema.ts
      migrations.ts
    pr/
      draft.ts
      finalize.ts
      gh.ts
    config/
      loader.ts
      defaults.ts
    types/
      spec.ts
      task.ts
      run.ts
      hook.ts
      config.ts
    utils/
      logger.ts
      fs-atomic.ts
      clock.ts
      ids.ts
  orca.config.ts (optional, user project)
  package.json
  tsconfig.json
  oxlintrc.json
```

## 6. Core Data Types (TypeScript)

```ts
export interface Spec {
  id: string; // derived from file name or hash
  path: string;
  title: string;
  rawMarkdown: string;
  createdAt: string; // ISO timestamp
}

export type TaskStatus = "pending" | "in_progress" | "done" | "failed";

export interface Task {
  id: string;
  name: string;
  description: string;
  dependencies: string[];
  acceptance_criteria: string[];
  status: TaskStatus;
  retries: number;
  maxRetries: number;
  startedAt?: string;
  finishedAt?: string;
  lastError?: string;
}

export interface RunStatus {
  schemaVersion: number;
  runId: string;
  mode: "plan" | "run";
  specPath: string;
  createdAt: string;
  updatedAt: string;
  overallStatus: "planning" | "running" | "completed" | "failed";
  tasks: Task[];
  milestones: string[];
  errors: Array<{ at: string; message: string; taskId?: string }>;
  pr?: {
    draftTitle?: string;
    draftBody?: string;
    readyForFinalize: boolean;
    finalizedAt?: string;
    url?: string;
  };
}

export type HookName =
  | "onMilestone"
  | "onTaskComplete"
  | "onTaskFail"
  | "onComplete"
  | "onError";

export interface HookEvent {
  runId: string;
  hook: HookName;
  message: string;
  timestamp: string;
  taskId?: string;
  taskName?: string;
  error?: string;
  metadata?: Record<string, string | number | boolean | null>;
}

export type HookHandler = (event: HookEvent) => Promise<void>;

export interface OrcaConfig {
  maxRetries?: number;
  claude?: {
    model?: string;
    useV2Preview?: boolean;
    maxTurnsPerTask?: number;
  };
  codex?: {
    enabled?: boolean;
    command?: string; // default: codex exec -s read-only
    timeoutMs?: number;
  };
  hooks?: Partial<Record<HookName, HookHandler>>;
  hookCommands?: Partial<Record<HookName, string>>; // shell command templates
  pr?: {
    enabled?: boolean;
    requireConfirmation?: boolean;
  };
}
```

## 7. Hook System (Detailed)

### Trigger Points
- `onMilestone`: planning completed, execution started, retry threshold reached, PR draft ready.
- `onTaskComplete`: each task transitions to `done`.
- `onTaskFail`: each task transitions to `failed` (including retry exhaustion).
- `onComplete`: run finishes successfully.
- `onError`: unrecoverable run-level errors (parse failure, Claude session error, state corruption).

### Configuration Inputs
- `orca.config.ts` programmatic handlers (`async (event) => { ... }`).
- CLI command hooks: e.g. `--on-milestone 'curl -X POST $WEBHOOK_URL -d {msg}'`.
- Both can coexist; execution order should be deterministic (programmatic first, CLI second).

### Default Routing Behavior
1. If OpenClaw env is detected, default hook action:
- `openclaw system event --text {msg} --mode now`
2. Otherwise:
- log structured event to stdout.

Detection strategy should be explicit and configurable (e.g., env presence + binary availability check), with graceful fallback to stdout.

### Reliability Rules
- Hook failures never mutate task outcomes.
- Each hook invocation is wrapped in timeout + error capture.
- Hook errors emit `onError` (guarded to avoid recursion loops).
- Shell hooks receive a sanitized payload (`{msg}`, `{runId}`, `{taskId}`).

## 8. Codex Consultation Pattern

### Role Definition
- Codex is a specialized read-only advisor used by Claude subagents for implementation questions.
- It is never the run orchestrator and never executes repo writes as part of consultation.

### Invocation Contract
- Claude subagent decides a question needs external implementation guidance.
- Orca executes configured command (default `codex exec -s read-only`) with a bounded prompt.
- Returned answer is attached to task context as advisory material.

### Guardrails
- Prompt includes current task, acceptance criteria, and relevant files list.
- Response size limits and timeout are enforced.
- Consultation transcript is logged in run artifacts for audit.
- If Codex fails/unavailable, task continues with degraded mode (Claude-only) unless strict mode is enabled.

## 9. Pre-Planning Flow (Codex Bulletproofing)

`orca plan --spec ...` and `orca run --spec ...` share this front-loaded validation:

1. Load and parse spec markdown.
2. Claude creates initial structured task JSON.
3. Codex pre-planning review validates:
- missing dependencies
- ambiguous acceptance criteria
- over-broad tasks
- ordering/risk issues
4. Orca merges feedback into a revised plan prompt for Claude.
5. Claude emits final task graph.
6. Validate graph integrity (unique IDs, no missing deps, no cycles).
7. Persist plan (`runs/<id>/tasks.json`, `status.json`) and emit milestone hook.

Execution starts only after step 7 succeeds.

## 10. Task Runner and Status Tracking

### Queue Model
- Build DAG from `dependencies[]`.
- Select runnable tasks where all deps are `done`.
- Process tasks sequentially first (phase 1), with optional future controlled parallelism.

### Retry Semantics
- Per-task retry counter, default from config (`maxRetries`).
- Retry on transient orchestrator/tool errors.
- Fail fast on schema/validation errors.

### Status Persistence
- Update `status.json` at every transition:
- `pending -> in_progress -> done|failed`
- include timestamps, retries, and last error.

Use atomic write strategy (`write temp + rename`) to protect against partial writes.

## 11. CLI Interface

### `orca run`
```bash
orca run --spec ./specs/myfeature.md [--config ./orca.config.ts]
```
- Runs pre-planning then execution.
- Creates run directory and live status file.

### `orca plan`
```bash
orca plan --spec ./specs/myfeature.md [--config ./orca.config.ts]
```
- Runs pre-planning only.
- Outputs validated task graph without execution.

### `orca status`
```bash
orca status [--run <run-id>]
```
- Reads `status.json` and prints run summary + task table.
- Defaults to latest run when `--run` is omitted.

### `orca pr finalize`
```bash
orca pr finalize [--run <run-id>]
```
- Reads drafted PR title/body from run artifacts.
- Shows draft and asks for confirmation.
- On confirm, executes `gh pr create ...`.
- Never pushes changes automatically.

### Hook Flags (examples)
```bash
orca run --spec ./specs/myfeature.md \
  --on-milestone 'curl -X POST $WEBHOOK_URL -d {msg}'
```

## 12. PR Flow (Optional, Hook-Based)

1. At run completion, if PR flow enabled:
- Claude drafts title + description from run context.
2. Orca emits milestone: `PR draft ready`.
3. User/agent reviews draft text.
4. `orca pr finalize` confirmation gate.
5. On confirm, Orca calls `gh` and stores PR URL in `status.json`.

Safety constraints:
- No auto push.
- No auto merge.
- Explicit confirmation per finalize action.

## 13. Error Handling and Observability

- Structured logs with run ID and task ID correlation.
- `events.log` append-only timeline for major transitions.
- Failures categorized:
- user input/spec errors
- orchestration/provider errors
- tool invocation errors
- state IO errors
- Exit codes standardized for CLI automation.

## 14. Security and Trust Boundaries

- Shell hook commands are explicit opt-in and treated as untrusted side effects.
- Escape/sanitize substitution values before shell execution.
- Keep Codex consultation in read-only mode by default.
- Store minimal secrets in artifacts; redact known sensitive tokens in logs.

## 15. Open Questions

1. What exact OpenClaw detection contract should be used (env var names and precedence)?
2. Should hook failures support configurable hard-fail mode for compliance-sensitive teams?
3. Should task execution support parallel workers in v1, or defer to v2 after sequential stability?
4. How should Claude session transcripts be retained/redacted for privacy?
5. What retry classification rules are default (HTTP/network vs model refusal vs invalid JSON)?
6. Should `orca status` include machine-readable `--json` output in v1?
7. What is the long-term abstraction for non-Claude orchestrators?

## 16. Implementation Phases

### Phase 0: Project Bootstrap
- Initialize TS project with strict `tsconfig`.
- Add `oxlint` + `tsgolint` commands and CI checks.
- Add base CLI entrypoint and command scaffolding.

### Phase 1: Planning Backbone (MVP)
- Implement spec loader and planner pipeline.
- Integrate Claude SDK adapter (v2 preview methods).
- Generate and validate task JSON graph.
- Persist run artifacts (`tasks.json`, `status.json`).
- Implement `orca plan` command.

### Phase 2: Execution Engine
- Build dependency-aware task runner.
- Add retry policy and state transitions.
- Implement `orca run` and `orca status`.
- Add robust atomic status writes.

### Phase 3: Hook Framework
- Implement dispatcher + event types.
- Add stdout + OpenClaw default adapters.
- Add CLI hook command templating and config handlers.
- Add timeout/isolation and error telemetry around hooks.

### Phase 4: Codex Consultation Integration
- Add consultation adapter (`codex exec -s read-only`).
- Integrate into Claude subagent decision flow.
- Add transcript artifact logging and fallback behavior.

### Phase 5: PR Draft and Finalize
- Add on-complete draft generation.
- Implement confirmation UX and `gh` integration.
- Wire `orca pr finalize` and status persistence.

### Phase 6: Hardening and Extensibility
- Schema versioning + migrations.
- More integration tests (failure injection, retry behavior, hook failures).
- Optional JSON outputs and future orchestrator abstraction.

## 17. Build Order Recommendation

Start with `plan` before `run`:
1. Reliable decomposition + validation gives immediate product value.
2. It de-risks execution by enforcing high-quality task graphs first.
3. Hooks and PR flow can be layered without destabilizing core orchestration.

Immediate first milestone:
- `orca plan --spec ...` producing validated `tasks.json` + `status.json` with hook emission.

