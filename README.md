<p align="center">
  <img src="assets/orca-banner.jpg" alt="Orca" width="380" />
  <br/><br/>
  <a href="https://orcastrator.dev">orcastrator.dev</a>
</p>

# Orca

Observable agent-lane harness. Orca dispatches Codex, Claude, or Cursor work and returns durable, machine-readable state through the versioned `orca/v1` contract.

Orca is a substrate for orchestrators. It does not plan, decompose, route, or judge delegated work; the caller owns those decisions.

## Install

```bash
npm install -g orcastrator
```

## Quick start

Discover the live contract and available adapters first:

```bash
orca contract
orca agents
```

Dispatch work from the checkout the agent should use:

```bash
orca dispatch --agent codex --cwd . "Review the current diff"
```

`dispatch` prints a handle immediately, then a final envelope when the lane blocks or finishes:

```json
{"v":1,"kind":"handle","laneId":"lane_a3f81c02","agent":"codex"}
{"v":1,"kind":"lane","ok":true,"status":"completed","delivery":"confirmed","nativeStatus":"completed","semanticOutcome":"unknown","lane":{"id":"lane_a3f81c02","agent":"codex","cwd":"/repo","createdAt":"2026-07-13T20:00:00.000Z","updatedAt":"2026-07-13T20:00:10.000Z","seq":4},"result":{"text":"..."}}
```

Parse the first stdout line for the lane ID and the final stdout line for the outcome. Intermediate stdout lines, when present, are event records. Stderr is diagnostic and not contractual.

## Commands

```text
orca dispatch --agent <agent> [--surface lane|task] [--model <model>]
              [--cwd <dir>] [--label <label>] [--timeout <ms>] <prompt>

orca inspect <laneId> [--follow] [--since <seq>]
             [--wait-for blocked|done] [--timeout <ms>]

orca answer <laneId> <text>
orca resume <laneId> [--timeout <ms>] <prompt>
orca lanes
orca kill <laneId>
orca agents
orca contract [--schema envelope|event|manifest]
```

Run `orca <command> --help` for human-readable command help. Run `orca contract` for the machine-readable source of truth.

## Dispatch surfaces

The default `--surface lane` creates an internal worker conversation intended to report back to its coordinator.

Codex also supports `--surface task`, which creates a named durable task that can appear in clients sharing the same `CODEX_HOME`:

```bash
orca dispatch \
  --agent codex \
  --surface task \
  --label "HAPPY-123 — Fix API" \
  --cwd . \
  "Implement HAPPY-123"
```

Task surface requires `--label`. It does not create a Codex Desktop-managed project or worktree; pass the intended existing checkout or worktree with `--cwd`.

## Inspecting and following lanes

```bash
orca inspect lane_a3f81c02
orca inspect lane_a3f81c02 --since 7
orca inspect lane_a3f81c02 --follow
orca inspect lane_a3f81c02 --wait-for done --timeout 120000
orca lanes
```

Every final envelope separates three independent axes:

- `delivery`: whether the native agent acknowledged the turn.
- `nativeStatus`: what the native agent reported.
- `semanticOutcome`: whether an explicit validator proved the result. This remains `unknown` unless a validator sets it.

Never infer task correctness from `ok:true` alone. Read `status`, `result`, `warnings`, and `next`, then verify the work yourself.

## Blocked questions

When a lane returns `status:"blocked"`, inspect `blocked.questions` and follow its literal `next[]` commands:

```bash
orca answer lane_a3f81c02 "Use the staging database"
```

A live native turn may consume the answer inside the original dispatch. A parked question requires a separate resume:

```bash
orca resume lane_a3f81c02 "Continue with that answer"
```

Completed lanes can also be resumed as a new turn. Failed, killed, and lost lanes cannot be reopened; dispatch a new lane instead.

## Exit codes

| Exit | Meaning | Envelope codes |
| ---: | --- | --- |
| `0` | Success, including `status:"blocked"` | — |
| `2` | Malformed command line | `usage_error` |
| `3` | Adapter or agent failure | `agent_unavailable`, `adapter_error`, `agent_failed` |
| `4` | Invalid lane operation or continuity failure | `invalid_state`, `lane_not_found`, `continuity_unverified` |
| `5` | Deadline exceeded | `timeout` |

A command never exits `0` with `ok:false`. `--help` and `--version` are human-readable CLI options rather than envelope-producing commands.

## Durable state

Lane state lives under `${ORCA_HOME:-~/.orca}/lanes/<laneId>/`:

```text
lane.json       durable lane record
events.ndjson   append-only evidence stream
answer.txt      pending blocked-question answer
artifacts/      lane-produced artifacts
```

Set `ORCA_HOME` to isolate tests and automation from personal lane history.

## Package API

The package exports the lane store, schemas, envelope helpers, contract helpers, adapter registry, and their TypeScript types:

```ts
import {
  LaneStore,
  EnvelopeSchema,
  buildContractPayload,
  type AgentAdapter,
  type LaneRecord,
} from "orcastrator";

const store = new LaneStore();
const contract = buildContractPayload();
```

## Operator skills

- [`skills/orca/SKILL.md`](./skills/orca/SKILL.md) — dispatch and manage lanes.
- [`skills/analyze-orca-usage/SKILL.md`](./skills/analyze-orca-usage/SKILL.md) — mine `~/.orca/lanes` for agent-experience friction.

## Architecture

[`docs/LANES.md`](./docs/LANES.md) documents the durable store, event ordering, transitions, envelopes, question flow, continuity, kill semantics, and adapter contract. Runtime schemas in [`src/types/lane.ts`](./src/types/lane.ts) remain authoritative.

## Development

Use npm for dependency and release workflows and Bun for local development and tests:

```bash
npm install
bun run src/cli/index.ts contract
bun run typecheck
bun run lint
bun run build
bun test src/lane src/types/lane.test.ts src/cli/lane-commands.test.ts src/adapters
```

Do not include live adapter smoke tests in routine validation unless you explicitly intend to exercise installed native agents.

## License

MIT
