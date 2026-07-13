# Lanes: the orca/v1 substrate (v0 design)

Status: v0, implemented against `src/types/lane.ts`. The Zod schemas in that
file ARE the contract; if this document and the schemas ever disagree, the
schemas win.

## 1. What orca is now

The lane surface is a **substrate that orchestrators call, not an
orchestrator**. Any agent — a Claude session, a Codex thread, a CI script, a
human in a shell — can dispatch work to another agent through orca and get
back machine-readable, evidence-based state. The lane surface does not plan,
decompose, route, or judge; the caller does.

The graph pipeline documented in the README (`orca "<task>"`, `plan`, `run`,
`status`, `pr ...`) is the **legacy flow**. It keeps working unchanged and its
exports (`src/agents/codex/session.ts`, `src/state/store.ts`) are stable. New
work happens on the lane primitive described here.

## 2. The lane primitive and the envelope

A **lane** is one delegated unit of work: one agent, one working directory,
one conversation that can block on questions and be resumed. Lanes live on
disk and outlast the process that created them.

### 2.1 Lane store

```
~/.orca/lanes/<laneId>/
  lane.json           # LaneRecord, written atomically (temp file + rename)
  events.ndjson       # append-only, fsync'd, monotonically increasing seq
  answer.txt          # pending answer for a blocked lane (atomic write)
  artifacts/          # files the lane produced
  lane.lock           # transient interprocess write lock (exists only while held)
  lane.lock.recovery  # transient stale-lock recovery gate (exists only during takeover)
```

`ORCA_HOME` overrides `~/.orca` (used for hermetic tests). Lane ids look like
`lane_a3f81c02` and must match `^lane_[0-9a-f]{8}$`. Each event append assigns
the next `seq` and mirrors it onto `lane.json`, so after a completed append
`lane.seq` names the latest event without reading the log. The log itself is
the authoritative seq source: the store derives the next seq from a bounded tail read of
`events.ndjson` under the lane lock, with `lane.json` as a monotonicity
backstop, so a writer crashing between the event append and the `lane.json`
mirror cannot cause duplicate seqs (a hardening-critique finding against the
earlier in-process seq cache).

`lane.json` may also carry `process?: {pid, pgid?, startedAt}` — the child
process identity persisted by the dispatching CLI when an adapter reports it
(§3 Rule 12). `process` is persisted-only: it never appears in the envelope's
`lane` summary, but `kind:"list"` envelopes carry it because `lanes` returns
full records. `process` is **historical spawn identity, not a liveness
claim**: it records which process was spawned for the lane (so `kill` has
something real to signal), and it is never updated to say whether that
process is still alive. Wound (2026-07 cold-consumer desktop tests): a
consumer read a settled lane's `process` as "this lane still has a live
agent". Liveness evidence surfaces separately, as the stale-running
`warnings` entry on inspect (§2.3), never through `process` itself.

**Immediate process identity and the kill-before-spawn race.** Wound
(2026-07 review, finding 15): adapters reported `{pid, pgid}` only after
protocol initialization — Claude after its structured `init` line, Codex
after connect and thread bind — so a pre-protocol hang left `orca kill`
nothing to signal, and a kill that settled the lane terminally before the
identity arrived left a freshly spawned process unowned.
`LaneStore.recordProcessIdentity(laneId, {pid, pgid?, startedAt})` persists
spawn-time identity the moment the child exists: on a LIVE lane
(queued|running|blocked) it records `lane.process` and appends
`agent_started` evidence under one lane lease; on a lane that already
settled terminally (ANY terminal status, not only killed) it persists
nothing and returns `laneKilled:true` — the caller MUST terminate the
process it just spawned. Session/model metadata still arrives separately,
after protocol initialization, so identity is never delayed by it.

`orca answer` writes `answer.txt` and leaves it present until consumption.
An adapter may only read it; after the adapter emits `answered`, the owning
CLI event sink clears the file. Wound (hardening critique): clearing at write
time or from two owners could lose an answer before a live turn consumed it.

**Answer generations.** Wound (2026-07 review, finding 13): replacing answer
A with answer B while blocked, then having the adapter report consuming A,
unconditionally deleted the current file — erasing B as if it were A. Every
submission now gets a monotonic generation. `LaneStore.submitAnswer` (the
choke point behind `orca answer`) checks `blocked`, bumps
`lane.answerGeneration` BEFORE the answer file lands, stamps the generation
into the submission's `answered` event data, and returns it — all under one
lane lease. `consumeAnswerWithEvent` records adapter-confirmed consumption
(the event is stamped `data.consumed:true`), returns the lane to running,
and deletes `answer.txt` only when the caller-supplied generation still
equals `lane.answerGeneration`, so a replacement answer submitted after the
adapter read the previous one survives; omitting the generation preserves
the legacy unconditional delete. Because the generation bump precedes the
file write, a crash between them can only make a stale consumption MISS the
compare (the answer survives for redelivery) — never delete a newer answer.
`answerGeneration` is store-owned: it lives in `lane.json`, is not patchable
through `updateLane`, and is stripped from envelope `lane` summaries
(`kind:"list"` carries it because `lanes` returns full records).

**Atomic answer reads.** Adapters consume through
`LaneStore.readAnswerWithGeneration`, which reads `answer.txt` and the lane's
current `answerGeneration` under ONE lane lease — the only way an adapter can
echo a generation that provably belongs to the text it read (the lock-free
`readAnswer` + `loadLane` pair could interleave with a replacement
submission). The same read finishes crash-interrupted consumption: when the
latest `data.consumed:true` answered event carries a generation equal to the
lane's persisted `answerGeneration`, the surviving file is a leftover from a
crash between consumption evidence and deletion, and is deleted under the
lock — generation-matched only — instead of being resurrected and
redelivered. The codex turn-runner consumes via this read and echoes the
generation in its `answered` event.

**Lane id validation.** Wound (hardening critique): a crafted "lane id" like
`../../../etc` reached filesystem path construction. Every verb that takes a
lane id validates it against `^lane_[0-9a-f]{8}$` BEFORE any path is built
from it; failure is `usage_error` (exit 2). The store refuses invalid ids
defensively as a second layer: reads (`loadLane`/`readEvents`/`readAnswer`)
return null/empty, writes (`appendEvent`/`updateLane`/`transitionLane`/
`transitionLaneWithEvent`/`writeAnswer`) throw `LaneNotFoundError`, path getters throw
`InvalidLaneIdError`, and `listLanes` skips directory entries that are not
lane ids.

**Interprocess write lock.** Wound (hardening critique): two orca processes —
say a live `dispatch` and a concurrent `kill` — interleaved store writes and
could issue duplicate seqs or clobber each other's `lane.json`. Every
`appendEvent`/`updateLane`/`transitionLane`/`transitionLaneWithEvent` call now
acquires `<laneDir>/lane.lock`: an `O_EXCL`-created file holding the holder's
pid plus a random 32-hex per-acquisition owner token, whose mtime the holder
refreshes while held. Waiters retry with backoff and take over a lock whose
mtime has gone stale for 10s (crashed-holder
recovery, `lockStaleMs`); acquisition gives up after 30s (`lockTimeoutMs`)
with a plain timeout error that the CLI maps to `adapter_error`. The lock
file is transient — removed on release. An in-process per-lane mutex remains
as the fast path, and separate `LaneStore` instances in the same process are
serialized by the lockfile too.

**Lock ownership tokens.** Wound (2026-07 review): a stale holder that
resumed after a waiter's takeover — a suspended or descheduled process whose
lock's mtime went stale — could silently refresh or unlink the NEW owner's
`lane.lock`, reopening the interleaved-writer wound from the other side. The
per-acquisition owner token closes this: the mtime refresher re-reads the
lock file and verifies the token BEFORE every `utimes`, and release re-reads
and verifies before `rm`. A foreign token (or missing file) means the lock
was taken over: the refresher stops without touching the file, and release
throws `LaneLockLostError` (exported) — the mutation is reported as FAILED,
because a concurrent owner may have interleaved writes, and the new owner's
lock file is left untouched. Honest residual, documented in code:
verify-then-act is two syscalls, so a takeover landing BETWEEN the token
re-read and the utimes/unlink can still be touched by the old holder. That
window is microseconds wide AND requires the lock to have already gone stale
(`lockStaleMs` without a refresh) at that exact moment; closing it fully
needs OS advisory locking (flock), which v0 deliberately forgoes.

**Stale-lock recovery gate.** Wound (2026-07 review, finding 11): two
waiters could both observe the same stale lock, and the slower one's unlink
then removed the FRESH `lane.lock` a new holder had created behind the
faster one's takeover — reopening the interleaved-writer wound the lock
exists to close. All stale takeovers are now serialized through a second
`O_EXCL` file, `<laneDir>/lane.lock.recovery`: only the single gate holder
may re-verify the observed lock (same inode, same mtime, still stale) and
unlink the shared `lane.lock` pathname. The gate critical section is a
stat+unlink — it never spans user work, lock waits, or holder-refresh
intervals — so a healthy recoverer holds it for milliseconds. A gate is
presumed abandoned by a crashed recoverer, and cleared, only when ALL of:
its mtime is older than `lockStaleMs`, the pid recorded inside it is dead,
and a re-stat confirms the same inode+mtime immediately before removal.
Clearing never grants the gate — the clearer re-contends through `O_EXCL`.
A suspended (SIGSTOPped) recoverer's gate is never removed: acquisition
times out honestly instead of racing a takeover. Residual, documented in
code: the conditional-unlink TOCTOU cannot be fully eliminated with POSIX
primitives — the gate reduces the exposed window to that stat+unlink
critical section, and the per-acquisition owner token turns a woken stale
holder's overlap from silent corruption into a loud `LaneLockLostError` at
refresh/release time; OS advisory locking (flock) is the escape hatch if
this must ever become airtight.

**Crash-torn tail repair.** Wound (2026-07 review, finding 12): a crash
mid-append could leave a truncated final NDJSON fragment in `events.ndjson`;
reads failed loud and the next append would have concatenated new JSON onto
the corruption. Under the lane lock — `readEvents` on a dirty tail, and
every locked append BEFORE sequence derivation — the store now validates the
final fragment: a complete valid event missing only its trailing newline
gets the delimiter (durable data is preserved); anything else after the last
newline is truncated away; either repair is fsynced before any seq is
derived or new line lands. Only the unterminated tail is treated as a crash
artifact: a malformed newline-TERMINATED record still fails loud, because
that is corruption, not a torn write.

**Crash replay on read.** Wound (2026-07 review, findings 7 and 19): a
crash between fsyncing a status-bearing event and the `lane.json` rename
left the record lagging its own durable evidence — first observed for
terminal events, then for a fsynced `question` that left the raw lane
`running` and unanswerable. `loadLane` now replays the status implied by
the durable log, not just terminal kinds: terminal evidence
(`result`/`failed`/`killed`) always wins; `question` implies `blocked`,
`resume_started` implies `running`, and an `answered` event stamped
`data.consumed:true` (adapter-confirmed consumption) implies `running` — a
bare answer submission implies no status change. A non-terminal replay is
adopted only when `lane.json` demonstrably lags the event (its mirrored seq
is behind), and the next locked write heals the recovered status durably
into `lane.json` instead of clobbering it with the stale raw status.

**CAS transitions — the first terminal settlement is immutable.** Wound
(hardening critique): settlement blindly wrote its own terminal status, so a
lane killed mid-run could be resurrected as `completed` by the dispatch
process's last write. `LaneStore.transitionLane(id, {from: LaneStatus[], to})`
applies `to` only when the current status is in `from`, atomically under the
lane lock, and throws `TransitionConflictError` (exported; fields `laneId`,
`expectedFrom`, `actualStatus`, `to`) otherwise. Terminal statuses
(`completed|failed|killed|lost`) are immutable — no transition FROM them ever
succeeds through the CAS helpers, even when listed in `from`. The ONE
documented carve-out lives outside them: `beginResume` may take a `completed`
lane back to `running` (§2.5) — a user-initiated resume is a new turn, not a
conflicting settlement of the finished one, and `failed|killed|lost` stay
fully immutable (the carve-out is documented on `TERMINAL_LANE_STATUSES` in
`src/types/lane.ts`).

Settlement commits terminal evidence and the status CAS together through
`transitionLaneWithEvent`, under one acquisition of that same per-lane
interprocess lock. It appends and fsyncs the evidence to `events.ndjson`
before atomically writing the terminal status and mirrored `seq` to
`lane.json`, so a lock-free reader cannot observe a terminal status without
its evidence. Adapter-emitted terminal events are buffered by the CLI event
sink rather than persisted mid-stream, so settlement is the ONLY writer of
terminal records; an already-persisted `question` is the one case where
settlement performs the bare `transitionLane` status CAS. When a factory
supplies the evidence it runs while the lane lock is held and must not call
back into the LaneStore — the `orca kill` termination seam and the
tail-repair path both rely on this. A
`TransitionConflictError` means another writer settled first, and the
dispatch process must re-read the store and emit the STORE's status in its
envelope, not its own. (`updateLane` accepts only mutable metadata —
`agentSessionId`, `process`, `model`, `label`, `usage`, `timing`. Identity,
status, timestamps, `seq`, and `answerGeneration` are store-owned; status
settlement must go through a CAS helper. Wound (hardening critique): a
permissive `updateLane` let tests — and any caller — manufacture terminal
state around the CAS.) Terminal settlement persists the adapter-reported
`usage`/`timing` onto `lane.json` through this metadata seam, so a later
`orca inspect` of the settled lane still reports them — the settling
process, the only holder of the adapter outcome, is long gone by then.

### 2.2 stdout discipline

Every CLI verb prints **exactly one JSON envelope as the FINAL stdout line**,
success and failure alike. `dispatch` additionally prints a **handle line
FIRST**, immediately after lane creation and before any agent work:

```
{"v":1,"kind":"handle","laneId":"lane_a3f81c02","agent":"codex"}
```

Nothing else is promised on stdout. Parse the first line for the handle (on
dispatch) and the last line for the result; ignore everything between.

**stderr is not contractual.** Wound (2026-07 cold-consumer desktop tests): a
consumer treated stderr output during a successful run as a failure signal.
Harness diagnostics — adapter-load complaints, native-CLI tracing lines, MCP
auth noise — may appear on stderr during perfectly successful runs; only
stdout carries the envelope, and only the envelope (plus its exit code)
carries the outcome.

The single DOCUMENTED exemption to one-envelope-per-command is `--help`/`-h`:
help output stays human-readable and prints no envelope (also noted in the
`orca contract` payload). `orca answer --help` and `orca resume --help` route
to the LANE program's help — not the legacy commands of the same name — when
no `lane_`/run positional disambiguates.

### 2.3 Envelope shape (orca/v1)

```
{ v: 1,
  kind: "lane" | "list" | "agents" | "contract" | "error",
  ok: boolean,
  status: "queued"|"running"|"blocked"|"completed"|"failed"|"killed"|"lost",
  code?: "usage_error"|"invalid_state"|"lane_not_found"
        |"continuity_unverified"|"agent_unavailable"|"adapter_error"
        |"agent_failed"|"timeout",
  lane?: { id, agent, surface?: "lane"|"task", model?, cwd, label?, agentSessionId?,
           createdAt, updatedAt, seq },
  delivery: "not_sent" | "confirmed" | "unknown",
  nativeStatus: "running" | "completed" | "failed" | "interrupted" | "unknown",
  semanticOutcome: "unknown" | "validated_pass" | "validated_fail",
  blocked?: { questions: [{ id, question, options? }] },
  result?: { text, artifacts?: string[] },
  usage?: { inputTokens?, outputTokens?, costUsd? },
  timing?: { wallMs, apiMs?, startupMs? },
  continuity?: { verified: boolean,
                 method: "thread-id-match"|"nonce-echo"|"session-id-match",
                 detail? },
  next?: string[],          // literal follow-up commands
  warnings?: string[],      // non-fatal lane-health observations
  error?: { message, remediation? },
  lanes?: LaneRecord[],     // payload for kind:"list" (full records: + status,
                            // process?, answerGeneration?, usage?, timing?)
  agents?: AgentManifest[], // payload for kind:"agents"
  contract?: object }       // payload for kind:"contract"
```

Schema-enforced invariants (`EnvelopeSchema` refinements):

- `ok:false` ⇒ `code` is present (machine-readable, never prose-only).
- `ok:false` ⇒ `error.message` is present.
- `ok:true` ⇒ `code` is absent.

`warnings` carries non-fatal lane-health observations and never changes
status or exit code. The one v0 warning is the stale-running observation,
produced by the lane-state envelope (`orca inspect` and the
conflict-settlement paths that re-read the store) on a lane that claims
`running` while its recorded `lane.process` pid is dead: the dispatch that
owned the run has likely exited without settling the lane. The warning
reports the evidence and points at `resume` (the ownerless-running reclaim,
§2.5) or `kill` — it never auto-transitions the status, because a dead
leader pid does not prove the whole process tree (or a reattached resumer)
is gone.

A second warning comes from settlement: a lane that settles `completed` with
an empty or whitespace-only `result.text` carries `"agent returned an empty
result; semanticOutcome is unknown and the response may not have addressed
the prompt"`. Wound (2026-07 cold-consumer desktop tests): a consumer took
`status:"completed"` with an empty result as a successful no-op answer.
Protocol completion proves only that the turn ended; with no text there is
nothing for the caller to act on, and the warning says so without changing
status or exit code.

`usage` and `timing` are **per-turn, not cumulative over the lane**: they
cover the single dispatch or resume the envelope settles. Wound (2026-07
cold-consumer desktop tests): a consumer read a resume envelope's numbers as
lane-lifetime totals. Each envelope's `timing.wallMs` is the harness-measured
wall clock of that one verb invocation, `startupMs`/`apiMs` decompose that
same invocation, and `usage` is what the agent's protocol reported during
that run — orca never aggregates usage or timing across turns.

Event lines in `events.ndjson`:

```
{"v":1,"seq":7,"ts":"2026-07-11T...","laneId":"lane_a3f81c02","event":"question","data":{}}
```

with `event` ∈ `created | agent_started | progress | question | answered |
resume_started | result | failed | killed | heartbeat` and `seq` a positive,
strictly increasing integer. `resume_started` is the durable evidence
`beginResume` appends when a lane transitions to running for a resume; its
data records the resuming process's pid — the pid the ownerless-running
reclaim (§2.5) probes — and crash replay reads it as `running`. Answer
events share the `answered` kind: a submission carries `{text, generation}`,
while adapter-confirmed consumption is stamped `data.consumed:true` and
echoes the consumed generation (§2.1). `heartbeat` is a non-terminal liveness
signal: the cursor adapter emits one (`data.source` ∈ `stdout | stderr`) on the
first native output of a run, so a driver can distinguish a live cold start
from a pre-output hang. It is liveness only — never delivery evidence — and,
like all non-terminal events, appends without a status transition.

### 2.4 Exit codes

| Exit | Meaning                                                                     | Envelope `code` values                                     |
| ---- | --------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 0    | success — **including `status:"blocked"`; blocked is a successful outcome** | —                                                          |
| 2    | usage error (malformed command line only)                                   | `usage_error`                                              |
| 3    | adapter or agent failure                                                    | `agent_unavailable`, `adapter_error`, `agent_failed`       |
| 4    | not found, continuity failure, or invalid lane state for the verb           | `invalid_state`, `lane_not_found`, `continuity_unverified` |
| 5    | timeout                                                                     | `timeout`                                                  |

`usage_error` is reserved for a malformed command LINE. A well-formed
command against a lane in the wrong state reports `invalid_state` (exit 4)
instead: resume of a non-resumable lane (§2.5), answer on a non-blocked
lane, kill on a completed/failed/lost lane (killing an already-killed lane
stays idempotent, exit 0).

A command **NEVER exits 0 with `ok:false`**. The mapping lives in exactly one
place (`exitCodeForEnvelope` in `src/lane/envelope.ts`, via
`ERROR_CODE_EXIT_CODES`).

### 2.5 Verbs (v0)

```
orca dispatch --agent <agent> [--surface lane|task] [--model <model>] [--cwd <dir>] [--label <label>] [--timeout <ms>] <prompt>
orca inspect <laneId> [--follow] [--since <seq>] [--wait-for blocked|done] [--timeout <ms>]
orca answer <laneId> <text>
orca resume <laneId> [--timeout <ms>] <prompt>
orca lanes
orca kill <laneId>
orca agents
orca contract [--schema envelope|event|manifest]
```

`orca contract` prints the whole machine-readable contract — JSON Schemas for
envelope, event, manifest, and handle, plus the exit-code table and verb
synopses. It is the only document a cold agent should need (see §7).

**Dispatch surfaces.** `--surface lane` is the default: it creates an internal
worker lane. `--surface task` instead creates a durable, user-followable Codex
thread and names it from the required non-empty `--label`. Task surfaces are
Codex-only. Both surfaces retain an Orca lane record and native thread ID for
inspection and continuity-verified resume.

The adapter requests `threadSource:"subagent"` for lanes and
`threadSource:"user"` for tasks as an ownership hint. Hosts may normalize or
ignore it. Live Codex Desktop verification on 2026-07-13 stored both as
`source:"vscode"` / `threadSource:null` and indexed both in the sidebar, so
`--surface lane` is not a visibility filter. The enforceable task distinction
is Orca's persisted surface plus the required native thread name.

The task surface deliberately stops at the App Server thread boundary. It uses
the caller-supplied `--cwd`; Orca does not create a Codex Desktop-managed
project, worktree, or handoff environment. Use Desktop's native task/worktree
flow when that app-owned isolation is required.

**Wait semantics.** `inspect --wait-for` waits for the lane to reach the
named state — and terminal states also satisfy `--wait-for blocked`, so the
wait never hangs on a lane that finishes without blocking. Wound (2026-07
cold-consumer desktop tests): a consumer expected `--wait-for blocked` to
wait forever (or time out) on a lane that completed without asking anything,
and treated the early return as a bug. The waits are ordered, not exclusive:
`blocked` means "blocked or done", `done` means terminal only, and the
envelope's `status` says which state actually ended the wait.

**Resume semantics.** `LaneStore.beginResume` is the locked CAS entry point
for `orca resume`: under one lane lease it admits the lane, appends
`resume_started` evidence stamped with the resuming process's pid, and
transitions to running. A lane is resumable in exactly four states; a
rejection surfaces as `invalid_state` (exit 4):

- `blocked` with a parked (non-live) latest question — the normal case.
- `blocked` with a LIVE latest question, but only when the lane has no
  recorded process or its recorded pid is dead: the dispatch that was
  polling `answer.txt` is provably gone, so a resume cannot double-drive
  the agent, and it is the only way out of an otherwise-permanent lockout.
  A live question with a living recorded process still rejects (the
  live-question exclusion below).
- `completed` — the EXPLICIT documented carve-out from terminal
  immutability (§2.1). A resume is a user-initiated new turn on a finished
  lane, not a conflicting settlement of the finished one; only
  `beginResume` may take it.
- `running` whose latest `resume_started` event records a resumer pid that
  is now dead: the resuming process crashed after the CAS but before
  settling, leaving the lane ownerless, so a later resume may reclaim it.
  A running lane with a living (or unrecorded) owner still rejects.

`failed`, `killed`, and `lost` remain non-resumable — dispatch a new lane
for new work so their terminal history stays truthful.

**Live-question resume exclusion.** Wound (2026-07 review, finding 14):
resume checked only `status:"blocked"`, so a lane whose latest question was
still LIVE — the original dispatch parked on it, polling `answer.txt` —
could be resumed concurrently, putting two drivers on one native session.
While the latest `question` event carries `data.live:true` AND the recorded
lane process is alive, `beginResume` throws `TransitionConflictError` whose
detail says the original dispatch is still attached and polling; the
correct path is `orca answer` plus `orca inspect --wait-for done` (Rule 5)
— never a second driver. Once the recorded poller pid is dead (or no
process was ever recorded), the exclusion lifts: the live flag has outlived
its poller.

**Timeout semantics (wound: unbounded hangs and self-reported cutoffs).**
`--timeout <ms>` on `dispatch` and `resume` threads into the adapter as
`DispatchRequest.timeoutMs` / resume `opts.timeoutMs`. Before classifying a
spawned process as `timeout`, the harness checks whether it already exited —
in a race, exit evidence beats the timer. The Claude adapter bounds its
current stdout protocol line at 4MB, retains only the latest terminal
candidate, and keeps a 256KB stderr tail; an oversized stdout line tree-kills
its detached process group. Cursor keeps a 4MB stdout tail and a 256KB stderr
tail, and tree-kills when either stream exceeds its cap. Both surface
`adapter_error` rather than silently trusting truncated protocol evidence.
Codex uses structured app-server events instead of these local stdout
buffers; its timeout path interrupts the native turn.

**Post-deadline exit laundering.** Wound (2026-07 review, finding 18
residual): a SIGTERM handler that exits 0 after the deadline could launder
an expired run into success. In the Claude and Cursor exec harnesses, once
the deadline fired against a live leader and a group kill was attempted, the
run is classified `timedOut` regardless of any exit code produced afterward;
close-time arbitration protects only runs where NO kill intent was
recorded — a natural exit that beat the deadline is never reclassified as a
timeout.

**Codex abandoned-disconnect force-kill.** Wound (2026-07 review, finding 16
residual): a clean codex disconnect waits for app-server exit, which a
wedged server can withhold forever — an expired lane could abandon a live,
billing app-server. Cleanup now has its own grace budget (`cleanupGraceMs`);
when it expires, the adapter force-terminates the app-server via its
spawn-time process identity — SIGTERM to the process group (or pid when no
group was recorded), grace wait, liveness verify, SIGKILL, re-verify — and
reports the honest outcome (termination verified vs unverified) both as an
`app_server_termination` progress event and appended to a failed outcome's
error message. An expired lane never silently leaves a live app-server.

## 3. AX rules

Each rule exists because a specific wound in the 2026-07-11 agent-experience
benchmark corpus showed what happens without it. These are structural rules:
they are enforced by schemas and single-choke-point code paths, not by
convention.

**Rule 1 — One envelope, final stdout line, schema-validated, success and
failure alike.**
Wound: orchestrating agents scraped mixed human-oriented logs and picked the
wrong line; output files went stale (see Rule 3) and were parsed as fresh.
The final stdout line of the live process is the only result channel, and it
is validated against `EnvelopeSchema` before it is printed. The one
documented exemption is `--help`/`-h` (§2.2): help is for humans, prints no
envelope, and is declared as an exemption in the `orca contract` notes so
machine callers are never surprised by it.

**Rule 2 — Handle line first, before any agent work.**
Wound: when a dispatch crashed or timed out mid-run, callers had no id for
the work in flight — nothing to `inspect`, `kill`, or `resume` — so they
re-dispatched and duplicated the work. The handle line puts `laneId` on
stdout before the agent does anything, so the lane is addressable even if
everything after it burns down.

**Rule 3 — Exit codes carry meaning; never exit 0 with `ok:false`.**
Wound: the corpus's codex stale-`-o`/exit-0 denial — a `codex exec` run
exited 0 while its final message denied having done the work, and a stale
output file from a previous run stood in for the current result. Shell-level
`&&` chains and CI gates read both as success. In orca the exit code is
derived from the validated envelope in one function; there is no code path
that can exit 0 while reporting failure.

**Rule 4 — Blocked is a successful outcome (exit 0) with structured
questions.**
Wound: agents treated a clarifying question as a failure, abandoned the
session, and restarted from scratch — losing all accumulated context. In
orca, `status:"blocked"` exits 0, carries
`blocked.questions[{id, question, options?}]`, and `orca answer` delivers the
reply into the same lane.

**Rule 5 — `next[]` contains literal, copy-pasteable follow-up commands.**
Wound: cold agents burned turns guessing verbs and flags, and needed a
pre-loaded skill file just to know what to type after dispatch. Every
envelope that has a sensible follow-up says exactly what it is, e.g.
`"orca inspect lane_a3f81c02 --since 7"`. A blocked lane always offers an
answer command. Its latest `question` event decides the second command: while
`data.live:true`, the native Codex turn is still polling `answer.txt`, so
`answer` points `next[]` at
`orca inspect lane_a3f81c02 --wait-for done --timeout 120000`; a separate
resume would be wrong. When `data.live` is false or absent, no live turn is
consuming the answer, so `next[]` points at
`orca resume lane_a3f81c02 "continue"`. The same distinction is preserved in
the successful `orca answer` envelope. The answer file remains until the
adapter reports consumption with an `answered` event; only then does the CLI
event sink clear it.

**Rule 6 — Timing is measured by the harness, never self-reported.**
Wound: the corpus's timing lies — agents self-reported durations that did not
match wall clock, and startup overhead was silently billed as work time.
`timing.wallMs` is measured by orca around the dispatch; `startupMs` is
separated out so adapter overhead is not attributed to the task; `apiMs`
appears only when the agent's protocol actually reports it.

**Rule 7 — Resume verifies continuity or fails loud (exit 4,
`continuity_unverified`).**
Wound: the corpus's cursor silent resume — a resume silently bound a fresh
session, the agent answered confidently with none of its prior context, and
the caller only discovered the amnesia after acting on the answer. In orca,
`resume` accepts only the states `beginResume` admits (§2.5: blocked —
unless a live question's poller is still alive — plus completed's documented
carve-out and ownerless running); the
adapter MUST verify it is talking to that lane's same native session (§4) or
throw. Adapters never silently rebind, and `failed`/`killed`/`lost` lanes
are never reopened.

**Rule 8 — Failures are machine-readable and carry remediation.**
Wound: failures surfaced as prose stack traces that agents pattern-matched
and guessed at. Every `ok:false` envelope carries a `code` from a closed enum
and `error.message`, plus `error.remediation` when there is a known fix
(e.g. `agent_unavailable` lists the registered agents and points at
`orca agents`).

**Rule 9 — No field is ever inferred from agent prose.**
Wound: "I've completed the task" in a final message was treated as task
success (see §5). `delivery`, `nativeStatus`, and `semanticOutcome` each have
a designated evidence source, and prose is not one of them.

Rules 10–13 come from the 2026-07 hardening critique of the v0
implementation rather than the original benchmark corpus; same style, newer
wounds.

**Rule 10 — One persistence boundary: CLI commands write the store.**
Wound (hardening critique): an adapter kept its own `LaneStore` and persisted
events itself while the CLI did the same — double-persisted events, competing
seq writers, and two terminal events for one lane. Adapters emit events ONLY
through their event hook (`onEvent`); they may READ the store (e.g.
`answer.txt` polling) but never call write methods. The dispatch/resume CLI's
hook persists each emitted event exactly once, while `orca answer` owns the
answer-file write. The file is cleared only after an adapter-emitted
`answered` proves consumption. Terminal evidence (`result`/`failed`/
`killed`) is never persisted mid-stream: the sink BUFFERS the adapter's
terminal kind, and settlement commits one coherent terminal record —
evidence plus status CAS — through `transitionLaneWithEvent` (one per-lane
interprocess lock, evidence appended and fsync'd before the terminal
`lane.json` write). A buffered terminal kind that contradicts the adapter's
RETURNED status settles as a durable `adapter_error` failure instead of
persisting either claim (wound: a contradictory terminal event and returned
outcome could both land, and a late result could make a killed lane inspect
as natively completed). The store enforces the boundary defensively: raw
`appendEvent` rejects terminal kinds outright, and rejects EVERY append once
a lane has settled terminally.

**Rule 11 — Settlement is compare-and-swap, and terminal state is immutable.**
Wound (hardening critique): `orca kill` raced a live dispatch's settlement
and the last writer won, so a killed lane could resurface as `completed`.
Settlement commits terminal evidence and the status CAS together through
`transitionLaneWithEvent`; only an already-persisted question (blocked
settlement) uses the bare `transitionLane` CAS (§2.1). Both use the same
per-lane lock and reject transitions from a terminal status (the
completed→running resume carve-out lives in `beginResume`, not in the CAS
helpers — §2.1, §2.5). On `TransitionConflictError`, the dispatch process
re-reads the store and reports the store's status in its envelope instead of
its own.

**Rule 12 — Kill uses real process evidence when the adapter exposes it.**
Wound (hardening critique): v0 kill was store-only bookkeeping — the lane
said `killed` while the child agent kept running and billing. Codex, Claude,
and Cursor report `{pid, pgid}` in `agent_started`; the CLI persists that
evidence as `lane.process`, and all three manifests declare `kill:true`.
Codex specifically launches a detached app-server and exposes its pid/pgid;
process-group signaling remains CLI-owned rather than adapter-owned.

`orca kill` uses the async evidence factory on `transitionLaneWithEvent`, so
it holds the one per-lane interprocess lock while it signals the NEGATIVE
pgid with SIGTERM, waits up to 5s, escalates to SIGKILL when needed, and
verifies disappearance. Only then does it append and fsync the `killed`
event, atomically write `status:"killed"` to `lane.json`, and release the
lock. Concurrent settlement therefore cannot enter during termination
verification; once the kill CAS lands, terminal-status immutability prevents
later resurrection. With no usable process group, a refused/failed signal,
or an unverifiable SIGKILL, the lane still becomes durably `killed` but
`nativeStatus` remains `"unknown"` and the result text explains why.

v0 process-group kill is explicitly **POSIX-only**: signalling the negative
pgid and probing group liveness with signal 0 are POSIX primitives with no
Windows equivalent in this design. On a non-POSIX runtime there is no
process-group evidence path — kill degrades to durable lane-state
bookkeeping exactly as in the no-usable-process-group case above.

**Rule 13 — Lane ids are validated before any path is built.**
Wound (hardening critique): a crafted lane id could traverse out of the
lane store's directory. Every verb validates `^lane_[0-9a-f]{8}$` before any
filesystem path construction (`usage_error`, exit 2), and the store enforces
the same pattern defensively (§2.1).

## 4. Adapter contract

`AgentAdapter` (`src/lane/adapter.ts`) is the per-agent integration surface:

```ts
interface AgentAdapter {
  dispatch(req: DispatchRequest): Promise<DispatchOutcome>;
  resume(lane: LaneRecord, prompt: string, opts?: ResumeOptions): Promise<DispatchOutcome>;
  inspect(lane: LaneRecord): Promise<InspectSnapshot>;
  capabilities(): AgentManifest;
}
```

- `dispatch` binds a native session, streams `LaneEventInput`s through
  `req.onEvent` (the store assigns `v/seq/ts/laneId`), and returns a terminal
  or blocked `DispatchOutcome`. `req.surface` distinguishes an internal
  `lane` worker from a user-owned `task`; `req.timeoutMs` carries the caller's
  `--timeout` (§2.5).
- `resume` MUST verify continuity or throw `ContinuityError`
  (`code: "continuity_unverified"`, exit 4). Never silently rebind.
  `opts?: {onEvent?, timeoutMs?}` (`ResumeOptions`) has the same event-hook
  and timeout semantics as dispatch; the third parameter is optional, so
  2-arg implementations remain valid. The v0 CLI calls it only after
  `beginResume`'s locked CAS admits the lane (§2.5): blocked (unless a live
  question's poller is still alive), completed (the documented carve-out),
  or ownerless running; `failed`/`killed`/`lost` lanes are never resumed.
- `inspect` returns a native-store liveness snapshot
  (`nativeStatus`, `agentSessionId?`, `lastActivityAt?`, `detail?`) when the
  agent exposes one.
- `capabilities` returns the static manifest: declared capabilities
  (`resume`, `kill`, `questions`, `continuityMethods`, `models?`, and
  `browserUse?` — a boolean, or a descriptive string when availability is
  conditional, e.g. codex's `"available via config"`) plus
  measured overhead (`startupMsP50/P95`, `measuredAt`). The manifest also has
  three declared-extras slots — `caveats?: {code, note}[]` for known,
  machine-readable limitations, `worktrees?: boolean` for git-worktree
  support, and `declared?: Record<string, unknown>` for adapter-specific
  extras that fit no first-class slot. Wound (hardening critique): adapters
  smuggled these as ad-hoc keys that schema validation silently stripped, so
  callers never saw declared limitations.

Adapters NEVER write to the lane store. CLI commands own all persistence
(Rule 10): adapters emit events only through the hook and may at most read
(e.g. poll `answer.txt` while blocked). Codex, Claude, and Cursor all report
`{pid, pgid}` in `agent_started` and declare `capabilities.kill:true`.
Codex's detached app-server identity comes from the linked client, but the
lane CLI—not the adapter—persists that evidence, signals the process group,
and verifies termination (Rule 12).

Adapters NEVER interpret prose as success. `nativeStatus` comes from
protocol or exit-code evidence only, and no adapter may set `semanticOutcome`
to anything but `"unknown"` (§5) — and even if one does, settlement clamps
it.

### 4.1 Continuity verification methods

Each adapter declares which methods it supports in
`capabilities().continuityMethods`; `resume` reports the method used in
`continuity.method`.

| Method             | Evidence                                                                                                                                     | Suits                                                                                                |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `thread-id-match`  | The agent's native store records a durable thread/rollout id; resume asserts the continued run reports the same id as `lane.agentSessionId`. | Codex-style CLIs with on-disk thread stores.                                                         |
| `session-id-match` | The agent's resume protocol echoes the session id in its structured output; resume asserts it equals the bound id.                           | Claude-style `--resume <sessionId>` protocols that emit `session_id` in JSON output.                 |
| `nonce-echo`       | Orca plants a nonce in an earlier turn and requires the resumed session to reproduce it, proving shared history.                             | Agents with no verifiable native id — the fallback for exactly the cursor-style silent-resume wound. |

If none of the declared methods can produce positive evidence, resume fails
with `continuity_unverified`. An unverified resume is worse than a failed
one.

## 5. Three-axis status semantics

An envelope reports three independent axes, each with its own evidence
source. They are separate fields and no code path may conflate them:

| Axis              | Question                                 | Evidence source                                                                                       |
| ----------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `delivery`        | Did the prompt reach the agent?          | Transport acknowledgment only (`not_sent` / `confirmed` / `unknown`).                                 |
| `nativeStatus`    | What did the agent's own runtime report? | Protocol events and exit codes only (`running` / `completed` / `failed` / `interrupted` / `unknown`). |
| `semanticOutcome` | Did the task actually succeed?           | An explicit validator only. **None exists in v0**, so lane CLI output is always `"unknown"`.          |

**`delivery` defined precisely.** `confirmed` means the native agent
acknowledged receiving the turn — a protocol acknowledgment (e.g. codex's
turn/start response or a matching terminal turn notification) or a result
bound to the session (e.g. cursor's `type:"result"` line carrying the
session id). It does NOT mean the user's intent was fulfilled, the prompt
was understood, or the work was done — those live on the other two axes.
Wound (2026-07 cold-consumer desktop tests): a consumer read
`delivery:"confirmed"` as "the agent did what I asked".

This structure exists to prevent **success laundering**: the failure mode
where "the process exited 0" plus "the agent said it's done" gets collapsed
into "the task succeeded" — the exact laundering path behind the corpus's
exit-0 denial. In orca that collapse is impossible to express:
`nativeStatus:"completed"` with `semanticOutcome:"unknown"` is the honest and
normal v0 result, and it tells the caller precisely what is and is not known.
No final lane envelope may expose a non-`unknown` semantic outcome without an
explicit validator, and v0 ships none.

This is enforced structurally, not by convention. Wound (hardening critique):
the rule relied on adapters behaving — a buggy or optimistic adapter could
return `semanticOutcome:"validated_pass"` and it would flow straight into the
envelope. The CLI settlement choke point now clamps `semanticOutcome` to
`"unknown"` regardless of what the adapter claimed; a lying adapter cannot
launder success through the envelope. (`DispatchOutcomeSchema` is unchanged —
the clamp lives at settlement, the single point every outcome passes
through.)

## 6. v0 scope fence

Deliberately OUT of v0, each with the trigger condition that brings it in:

| Out                                                   | Why out                                                                              | Trigger to come in                                                                                                                                                    |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Daemon / background supervisor                        | Lanes are process-per-verb; the store on disk is the shared state.                   | Real lanes routinely outlive the dispatching process AND `inspect --follow`/`--wait-for` polling is measurably insufficient (missed events or dominant polling cost). |
| MCP server mode                                       | The CLI + `orca contract` is the whole surface; one interface to keep honest.        | A concrete host orchestrator that cannot shell out (or where CLI round-trips dominate its token budget) wants lanes.                                                  |
| Auto-routing (orca picks the agent)                   | Routing without evidence is vibes; the caller knows its agents better than we do.    | Track-record telemetry exists (below) so routing decisions can cite per-agent evidence.                                                                               |
| Track-record telemetry (per-agent success/cost stats) | Requires a `semanticOutcome` validator to be meaningful; v0 has none.                | A validator exists and lane volume is high enough for per-agent stats to be signal, with a real consumer (auto-routing or a human dashboard).                         |
| Agent-to-agent messaging                              | `dispatch`/`blocked`/`answer`/`resume` already express caller-mediated conversation. | A concrete orchestration pattern needs mid-lane peer communication that demonstrably cannot be expressed as blocked-question round-trips through the caller.          |

## 7. Test tiers

**Tier 0 — unit (hermetic, `bun test src/lane`).** Schema invariants
(ok/code/error refinements), exit-code mapping, envelope builders, store
atomicity (temp+rename, append-only monotonic seq, `ORCA_HOME` isolation),
adapter registry errors.

**Tier 1 — CLI integration (hermetic).** A fake adapter under a temp
`ORCA_HOME` drives every verb end-to-end:
dispatch → blocked → answer → resume → completed, plus kill, lanes, agents,
contract, and every failure code. Asserts stdout discipline literally: handle
line first on dispatch, exactly one envelope as the final line, exit code
matches the envelope.

**Tier 2 — live-agent smoke (opt-in, non-CI).** Real adapters against real
agent CLIs: continuity verification against the agent's actual native store,
and `inspect` liveness against a genuinely running session.

**Tier 3 — cold-agent AX benchmark.** The product-level test:

- _Setup:_ a cold agent — fresh context, no orca skill file, no access to
  this document — is told only that an `orca` binary exists and that
  `orca contract` describes it.
- _Task:_ complete a full **dispatch → blocked → answer → resume** cycle
  against a stub agent that always asks one question.
- _Measurement:_ turns and tokens consumed, compared against the same task
  performed by an agent pre-loaded with a full skill file (the baseline).
- _Pass:_ the cold agent completes the cycle with no human help and no
  guessed flags (every command it runs was either in the contract output or
  in a `next[]` array).
- _Gate:_ cold-agent turns/tokens must stay within a fixed ratio of the
  skill-file baseline. Any change to the envelope, verbs, or `orca contract`
  output reruns the benchmark; a regression is a contract bug, not a doc bug.

The benchmark encodes the v0 thesis: if the contract is honest and
self-describing, a cold agent should not need documentation — including this
file — to use it correctly.
