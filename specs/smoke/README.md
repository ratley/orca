# Orca Smoke Specs

Checked-in manual smoke scenarios for exercising Orca end-to-end against real local repos in `tmp/`.

These specs are intentionally small. The goal is to verify Orca behavior, not to build impressive apps.

## Scenarios

- `html-game-planning.md`
  - planning-heavy Bun HTML game
  - exercises `orca plan`, task-graph review, and consultation
- `question-flow-greeter.md`
  - execution run that should require a clarification question
  - exercises `waiting_for_answer`, `onQuestion`, `orca answer`, and same-run resume
- `no-plan-library.md`
  - small execution run that Orca should automatically keep as a single task
  - exercises the planning-skip path plus standard completion hooks
- `review-cycle-validator.md`
  - execution run with a validator that should fail on the first attempt and succeed after Orca fixes findings
  - exercises post-exec review, validator findings, `onFindings`, and auto-fix looping

## Usage

Create each smoke project under `tmp/smoke/<name>/`, copy the spec body into `SMOKE_SPEC.md`, `cd` into that repo, and run Orca from that project directory.

Prefer isolated run state when smoking locally:

```bash
export ORCA_RUNS_DIR="$(pwd)/.orca-runs"
```

For hook validation, point the hook commands at simple local scripts that append stdin payloads to a JSONL file.
