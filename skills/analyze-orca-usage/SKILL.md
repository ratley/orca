---
name: analyze-orca-usage
description: "Mine real orca lane usage for agent-experience (AX) friction and feed a fix queue. Use when: reviewing how agents actually used orca in practice, finding contract/help/observability defects from real runs, or deciding what to fix before publishing. Reads the ~/.orca lane store (authoritative) and points at transcripts for intent. NOT for: operating lanes (use the orca skill) or inspecting one agent's transcript (use inspect-*-session)."
---

# Analyze Orca Usage

The orca lane store is first-party, structured usage telemetry — every run leaves `~/.orca/lanes/<id>/{lane.json, events.ndjson}`. This skill reconstructs each lane's timeline, classifies friction against a fixed taxonomy, and separates **orca AX defects** (fixable by contract/help/docs/observability changes) from **environmental noise** (spend limits, auth, network, an agent failing its own task). Only AX defects should reach a fix queue — the whole point is a signal, not a pile.

This is the longitudinal complement to cold-consumer testing: those catch what a fresh agent trips on in its first ten minutes; this catches what real agents trip on across weeks of runs.

## Fast path

Run by absolute path (Claude Code resets cwd between commands; the base dir is announced when the skill loads):

```bash
python3 <skill-base-dir>/scripts/analyze_orca_usage.py            # human summary
python3 <skill-base-dir>/scripts/analyze_orca_usage.py --json     # structured report
python3 <skill-base-dir>/scripts/analyze_orca_usage.py --ax-only  # AX defects only (drop env noise)
python3 <skill-base-dir>/scripts/analyze_orca_usage.py --lane lane_7630224c   # deep-dive + transcript pointer
python3 <skill-base-dir>/scripts/analyze_orca_usage.py --ax-only --append-findings learnings.jsonl
python3 <skill-base-dir>/scripts/analyze_orca_usage.py --home /path/to/.orca  # alternate ORCA_HOME
```

## What the store proves vs. what it doesn't

The split is load-bearing — never fabricate the second column from the first:

- **Authoritative (store):** terminal outcome and its `code`/`message` (failed/killed carry it in the **event**, not `lane.json`), timing, model, the full event sequence, and which capabilities were ever exercised.
- **Transcript-only (never inferred from the store):** the CLI argv (was `--cwd`/`--timeout` passed?), whether the agent ran `orca contract` first, whether it retried a failing command verbatim, or poll-looped `inspect` instead of `--wait-for`. Use `--lane <id>` to get a transcript pointer, then read it with the matching `inspect-*-session` skill.

## Friction taxonomy

Each finding carries `severity`, `surface` (where the fix goes), and `is_ax_defect`:

| kind | AX? | surface | meaning |
|---|---|---|---|
| `interface_misread` | yes | contract/help | `usage_error` — the agent malformed the command line, so the contract/`--help` failed to convey usage |
| `agent_unavailable` | yes | adapter | orca couldn't start/run the agent; the AX question is whether `error.remediation` names the *actual* cause |
| `continuity_unverified` | yes | contract | a resume couldn't prove native-session continuity |
| `empty_result` | yes | adapter | settled with empty text and (should have) an explicit warning |
| `kill_before_output` | yes | observability | killed while still dark — no liveness signal to tell cold-start from hang |
| `kill_after_progress` | **review** | observability | killed after real work — *could* be a live-vs-hung misread or a deliberate steer; the store can't say, so it's flagged for transcript review, not asserted |
| `external_block` | no | environment | spend limit / auth / network — excluded from the fix queue |
| `agent_error` | no | agent | the agent failed its own task; orca reported it honestly |
| `capability_unused` | no | docs | a capability (e.g. codex question-parking) exists but has zero real-world exercise |

## Feeding a fix queue

`--append-findings <jsonl>` appends new findings, **deduped by `finding_id`** (`kind:lane_id`), so re-running never double-writes. Pair with `--ax-only` to keep environmental noise out of the queue. This mirrors the `briefing-feedback.jsonl` pattern: findings become diffs, not vibes with timestamps.

## Caveats

- The transcript pointer greps known roots (`~/.codex/sessions`, `~/.claude/projects`, `~/.cursor/chats`) for the lane id. It finds **every** session that mentions the lane — including an observer, not only the dispatcher. The dispatcher is the session carrying the `dispatch`/handle line. Best-effort and read-only.
- `kill_after_progress` is deliberately not an asserted defect. Resolve it by reading the transcript: a user steer is not a bug; a driver that killed because it couldn't see liveness is.
- The taxonomy is versioned with orca's event schema (this skill ships in the orca repo). When the schema gains an event kind or error code, extend the classifier here in the same change.
