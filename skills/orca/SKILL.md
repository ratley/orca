---
name: orca
description: "Dispatch and manage subagent lanes (codex, claude, cursor) through the orca CLI's uniform JSON contract. Use when: delegating coding work to another agent CLI, running background agent lanes, answering a blocked agent's question, resuming a prior lane, or routing a task to the best agent. NOT for: work you should do directly in your own session, or inspecting agent transcripts (use the inspect-*-session skills)."
---

# Orca — Lane Operator Guide

Orca wraps agent CLIs (codex, claude, cursor) behind one contract: every command prints exactly one JSON envelope as the **final stdout line**, success and failure alike. Exit codes, error codes, and envelope schemas are machine-readable via `orca contract`.

**First time in a session: run `orca contract` and trust it over memory.** It is the source of truth for verbs, exit codes, and envelope shape. Run `orca agents` to see capability manifests (questions, browser use, worktrees, models, measured startup overhead, caveats).

## Verbs

```sh
orca dispatch --agent <agent> [--model <m>] [--cwd <dir>] [--label <l>] [--timeout <ms>] <prompt>
orca inspect <laneId> [--follow] [--since <seq>] [--wait-for blocked|done] [--timeout <ms>]
orca answer <laneId> <text>
orca resume <laneId> [--timeout <ms>] <prompt>
orca lanes
orca kill <laneId>
orca agents
orca contract [--schema envelope|event|manifest]
```

## Reading envelopes

- `dispatch` prints a **handle line first** (`{"v":1,"kind":"handle","laneId":...}`) immediately after lane creation, then the final envelope when the run settles. Capture the handle — it's your lane id even if you interrupt the wait.
- Exit codes: `0` success (**blocked is success**), `2` malformed command line only, `3` adapter/agent failure, `4` lane not found / continuity unverified / wrong lane state for the verb, `5` timeout. A command never exits 0 with `ok:false`.
- Three independent honesty axes — never conflate them:
  - `delivery` — did the agent acknowledge receiving the turn (`confirmed` ≠ task done)
  - `nativeStatus` — what the agent's own harness reported
  - `semanticOutcome` — always `"unknown"` in v0; **no envelope ever claims the work is semantically correct. Verify results yourself** (run the tests, read the diff).
- Act on `next[]` (state-aware follow-up commands) and never ignore `warnings[]` (e.g. empty-result warnings, stale-running detection).
- `error.remediation` on failures tells you the fix; don't retry a failing command verbatim.

## Dispatch patterns

```sh
# Deep engineering work → codex (brief it thoroughly; it rewards detailed prompts)
orca dispatch --agent codex --cwd /path/to/repo --timeout 600000 "<detailed brief>"

# Scoped implementation → cursor (30–100s startup before any work; budget timeouts accordingly)
orca dispatch --agent cursor --cwd /path/to/repo "<scoped change>"

# Advisory / review → claude (headless claude denies file writes by default — treat as read-only)
orca dispatch --agent claude --cwd /path/to/repo "<question or review request>"
```

Routing rule of thumb: codex for hard single-lane engineering under an orchestrator, cursor for well-scoped edits, claude for analysis and advice. Check `orca agents` rather than assuming — caveats and model lists are declared per agent.

Keep **one write-capable lane per working directory**. Parallel lanes writing the same cwd will conflict.

## Questions (blocked lanes)

Only codex lanes can park a question (`status:"blocked"`, exit 0). claude and cursor never block — their questions surface as prose in the result, and question support is best-effort even for codex.

```sh
orca dispatch --agent codex --cwd . "<prompt>" &   # background the wait
orca inspect <laneId> --wait-for blocked            # returns when blocked OR terminal — never hangs
# read blocked.questions[] from the envelope
orca answer <laneId> "<your answer>"
orca inspect <laneId> --wait-for done
```

`--wait-for blocked` is satisfied by terminal states too, so it's safe on lanes that finish without asking anything. Answering a non-blocked lane fails with `invalid_state` (exit 4) — inspect first if unsure.

## Resume

```sh
orca resume <laneId> "Now add tests for the edge cases"
```

Resumable: completed lanes (documented carve-out — a resume is a new user turn) and blocked lanes whose dispatcher is dead. Continuity is **proven** in the envelope (`continuity.verified` + method) or the command fails with `continuity_unverified` (exit 4) — no silent session-rebind. Failed/killed/lost lanes are not resumable; dispatch fresh.

## Hygiene

- `orca lanes` before assuming state; lane store lives at `~/.orca/lanes/` (override with `ORCA_HOME` for isolated experiments).
- A `stale running` warning on inspect means the dispatching process died: `orca kill <laneId>` then re-dispatch. Kill of an already-killed lane is idempotent.
- `usage` and `timing` in the envelope cover the single settled turn, not the lane's history. Use them to budget follow-ups.
- stderr is not contractual — harness noise may appear there on successful runs; parse stdout only.
- When orca confuses you or an agent misuses it, that's a contract/AX defect worth recording, not something to route around silently.
