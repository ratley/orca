#!/usr/bin/env python3
"""Analyze real orca lane usage for agent-experience (AX) friction.

The orca lane store is first-party, structured usage telemetry: every run
leaves ~/.orca/lanes/<id>/{lane.json, events.ndjson}. This tool reconstructs
each lane's event timeline, classifies friction against a fixed taxonomy, and
(critically) separates *orca AX defects* — things a contract/help/docs/UX fix
would prevent — from *environmental noise* (spend limits, network, an agent
erroring on its own task). Only the former should ever reach a fix queue.

What the store CAN prove (authoritative here):
  - terminal outcome + code/message (failed/killed carry it in the EVENT, not
    lane.json), timing, model, the full event sequence, capability exercise.
What it CANNOT (transcript-only, never fabricated from the store):
  - the CLI argv (was --cwd/--timeout passed?), whether the agent ran
    `orca contract` first, whether it retried a failing command verbatim, or
    poll-looped `inspect` instead of `--wait-for`. Use --lane <id> to get a
    transcript pointer for those.

Usage:
  analyze_orca_usage.py                      # human summary over ~/.orca
  analyze_orca_usage.py --json               # structured report
  analyze_orca_usage.py --home /path/.orca   # alternate ORCA_HOME
  analyze_orca_usage.py --append-findings learnings.jsonl   # feed a fix queue
  analyze_orca_usage.py --lane lane_abc123   # deep-dive one lane + transcript pointer
  analyze_orca_usage.py --ax-only            # only AX defects (drop env noise)
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any, Iterable, Optional

# Markers that mean a failure is the environment's fault, not orca's AX.
# An agent_failed carrying any of these is excluded from the AX fix queue.
_EXTERNAL_MARKERS = re.compile(
    r"spend limit|usage limit|monthly (spend|limit)|quota|rate.?limit|"
    r"credit|billing|/usage-credits|network|ENOTFOUND| ETIMEDOUT|ECONNREFUSED|"
    r"unauthorized|401|403|authenticate|not logged in|login",
    re.IGNORECASE,
)

# A kill that followed at least this many substantive events is a "review
# candidate": the lane was doing real work when it died, so the kill may have
# been a driver that couldn't tell "live" from "hung" — OR a legitimate steer.
# The store cannot tell them apart; only the transcript can.
_KILL_AFTER_PROGRESS_THRESHOLD = 1

_SUBSTANTIVE_EVENTS = {"progress", "result", "heartbeat", "question", "answered"}


@dataclass
class Finding:
    kind: str
    severity: str  # high | medium | info
    surface: str  # contract | help | next_hints | docs | observability | environment | agent | adapter
    is_ax_defect: bool
    lane_id: str
    agent: str
    evidence: str
    suggestion: str

    @property
    def finding_id(self) -> str:
        # Stable across re-runs so --append-findings can dedupe a fix queue.
        return f"{self.kind}:{self.lane_id}"

    def to_record(self) -> dict[str, Any]:
        rec = asdict(self)
        rec["finding_id"] = self.finding_id
        return rec


@dataclass
class LaneAnalysis:
    lane_id: str
    agent: str
    status: str
    model: Optional[str]
    wall_ms: Optional[int]
    event_kinds: list[str]
    terminal_kind: Optional[str]
    terminal_data: dict[str, Any]
    substantive_before_terminal: int
    had_heartbeat: bool
    resumed: bool


def _load_json(path: Path) -> Optional[dict[str, Any]]:
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return None


def _read_events(path: Path) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    try:
        for line in path.read_text().splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError:
                # A crash-torn trailing line is expected; skip it, don't die.
                continue
    except OSError:
        pass
    return events


def analyze_lane(lane_dir: Path) -> Optional[LaneAnalysis]:
    lane = _load_json(lane_dir / "lane.json")
    if lane is None:
        return None
    events = _read_events(lane_dir / "events.ndjson")
    kinds = [e.get("event", "") for e in events]

    terminal_kind: Optional[str] = None
    terminal_data: dict[str, Any] = {}
    for e in reversed(events):
        if e.get("event") in ("result", "failed", "killed"):
            terminal_kind = e.get("event")
            terminal_data = e.get("data", {}) or {}
            break

    # Count substantive events that preceded the terminal one.
    substantive = 0
    for e in events:
        if e.get("event") in ("result", "failed", "killed"):
            break
        if e.get("event") in _SUBSTANTIVE_EVENTS:
            substantive += 1

    return LaneAnalysis(
        lane_id=lane.get("id", lane_dir.name),
        agent=lane.get("agent", "unknown"),
        status=lane.get("status", "unknown"),
        model=lane.get("model") or (lane.get("timing") and None),
        wall_ms=(lane.get("timing") or {}).get("wallMs"),
        event_kinds=kinds,
        terminal_kind=terminal_kind,
        terminal_data=terminal_data,
        substantive_before_terminal=substantive,
        had_heartbeat="heartbeat" in kinds,
        resumed="resume_started" in kinds,
    )


def classify(la: LaneAnalysis) -> list[Finding]:
    findings: list[Finding] = []
    data = la.terminal_data
    code = str(data.get("code", "") or "")
    message = str(data.get("message", "") or "")

    if la.terminal_kind == "failed":
        if code == "usage_error":
            findings.append(Finding(
                kind="interface_misread", severity="high", surface="contract",
                is_ax_defect=True, lane_id=la.lane_id, agent=la.agent,
                evidence=f"failed usage_error: {message[:200]}",
                suggestion="A malformed command line means the contract/--help failed to convey usage. "
                           "Fix the synopsis or add a next[] hint that steers the correct form.",
            ))
        elif code in ("agent_unavailable", "adapter_error"):
            # orca could not start/run the agent. May be an orca packaging/runtime
            # defect (e.g. the Bun-only transport) or a genuinely absent CLI. Worth
            # a finding either way; remediation quality is the AX question.
            findings.append(Finding(
                kind="agent_unavailable", severity="high", surface="adapter",
                is_ax_defect=True, lane_id=la.lane_id, agent=la.agent,
                evidence=f"failed {code}: {message[:200]}",
                suggestion="orca could not run the agent. Confirm the error.remediation names the ACTUAL "
                           "cause (runtime/packaging vs missing CLI); a misdirecting remediation is an AX defect.",
            ))
        elif code == "continuity_unverified":
            findings.append(Finding(
                kind="continuity_unverified", severity="medium", surface="contract",
                is_ax_defect=True, lane_id=la.lane_id, agent=la.agent,
                evidence=f"resume failed continuity: {message[:200]}",
                suggestion="A resume could not prove native-session continuity. Check whether the driver "
                           "should have dispatched fresh; if the failure is spurious, the continuity proof is too strict.",
            ))
        elif code == "agent_failed" and _EXTERNAL_MARKERS.search(message):
            findings.append(Finding(
                kind="external_block", severity="info", surface="environment",
                is_ax_defect=False, lane_id=la.lane_id, agent=la.agent,
                evidence=f"agent_failed (external): {message[:200]}",
                suggestion="Environmental (credits/auth/network). NOT an orca defect — excluded from the fix queue.",
            ))
        else:
            # agent_failed on its own task: the agent errored, not orca.
            findings.append(Finding(
                kind="agent_error", severity="info", surface="agent",
                is_ax_defect=False, lane_id=la.lane_id, agent=la.agent,
                evidence=f"{code or 'failed'}: {message[:200]}",
                suggestion="The agent failed its own task. Orca reported it honestly; not an AX defect unless "
                           "the outcome axes (delivery/nativeStatus) misrepresent what happened.",
            ))

    elif la.terminal_kind == "killed":
        if la.substantive_before_terminal >= _KILL_AFTER_PROGRESS_THRESHOLD:
            findings.append(Finding(
                kind="kill_after_progress", severity="medium", surface="observability",
                is_ax_defect=False,  # review candidate: could be a legit steer
                lane_id=la.lane_id, agent=la.agent,
                evidence=f"killed after {la.substantive_before_terminal} substantive event(s); "
                         f"heartbeat={'yes' if la.had_heartbeat else 'no'}",
                suggestion="REVIEW: was the lane killed because the driver couldn't tell live-from-hung, or a "
                           "deliberate steer? The store can't say — check the transcript (--lane). If the former, "
                           "it's an observability/heartbeat gap.",
            ))
        else:
            findings.append(Finding(
                kind="kill_before_output", severity="medium", surface="observability",
                is_ax_defect=True, lane_id=la.lane_id, agent=la.agent,
                evidence="killed before any substantive output (no progress/heartbeat/result)",
                suggestion="The lane was killed while still dark. A driver had no liveness signal to distinguish "
                           "cold-start from hang. Ensure the adapter emits an early heartbeat for this agent.",
            ))

    elif la.terminal_kind == "result":
        text = str(data.get("text", "") or "")
        if text.strip() == "":
            findings.append(Finding(
                kind="empty_result", severity="medium", surface="adapter",
                is_ax_defect=True, lane_id=la.lane_id, agent=la.agent,
                evidence="settled with an empty result text",
                suggestion="An empty result should carry an explicit warning[] so a driver isn't left with silent "
                           "nothing. Confirm the empty-result warning fired.",
            ))

    return findings


def coverage_gaps(lanes: list[LaneAnalysis]) -> list[Finding]:
    """Store-wide gaps: capabilities that exist but were never exercised."""
    gaps: list[Finding] = []
    all_kinds = {k for la in lanes for k in la.event_kinds}
    agents = {la.agent for la in lanes}

    if "question" not in all_kinds and "codex" in agents:
        gaps.append(Finding(
            kind="capability_unused", severity="info", surface="docs",
            is_ax_defect=False, lane_id="(store-wide)", agent="codex",
            evidence="no question/answered events across the store despite codex lanes",
            suggestion="The codex question-parking flow has zero real-world exercise. Either drivers don't reach for "
                       "interactive lanes, or the docs don't surface the flow. Worth a targeted dogfood before trusting it.",
        ))
    return gaps


def _iter_lane_dirs(home: Path) -> Iterable[Path]:
    lanes_root = home / "lanes"
    if not lanes_root.is_dir():
        return []
    return sorted(p for p in lanes_root.iterdir() if p.is_dir())


def build_report(home: Path) -> dict[str, Any]:
    lanes = [la for p in _iter_lane_dirs(home) if (la := analyze_lane(p))]
    findings: list[Finding] = []
    for la in lanes:
        findings.extend(classify(la))
    findings.extend(coverage_gaps(lanes))

    ax_defects = [f for f in findings if f.is_ax_defect]
    friction_lane_ids = {f.lane_id for f in findings if f.lane_id != "(store-wide)"}
    completed = [la for la in lanes if la.status == "completed"]

    by_agent: dict[str, dict[str, int]] = {}
    for la in lanes:
        a = by_agent.setdefault(la.agent, {})
        a[la.status] = a.get(la.status, 0) + 1

    return {
        "home": str(home),
        "totals": {
            "lanes": len(lanes),
            "completed": len(completed),
            "friction_lanes": len(friction_lane_ids),
            "friction_rate": round(len(friction_lane_ids) / len(lanes), 3) if lanes else 0.0,
            "ax_defects": len(ax_defects),
            "findings": len(findings),
        },
        "by_agent": by_agent,
        "findings": [f.to_record() for f in findings],
    }


def append_findings(report: dict[str, Any], target: Path, ax_only: bool) -> tuple[int, int]:
    """Append new findings to a jsonl fix queue, deduped by finding_id."""
    existing: set[str] = set()
    if target.exists():
        for line in target.read_text().splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                existing.add(json.loads(line).get("finding_id", ""))
            except json.JSONDecodeError:
                continue

    to_write = [
        f for f in report["findings"]
        if f["finding_id"] not in existing and (not ax_only or f["is_ax_defect"])
    ]
    if to_write:
        with target.open("a") as fh:
            for rec in to_write:
                fh.write(json.dumps(rec) + "\n")
    return len(to_write), len(existing)


# --- transcript pointer (best-effort join) ---------------------------------

def _transcript_roots() -> list[Path]:
    home = Path.home()
    roots = [
        Path(os.environ.get("CODEX_HOME", home / ".codex")) / "sessions",
        home / ".claude" / "projects",
        home / ".cursor" / "chats",
    ]
    return [r for r in roots if r.is_dir()]


def find_transcript_pointer(lane_id: str) -> list[str]:
    """Grep known transcript roots for a lane id. The dispatching session
    echoes the handle line ({"laneId":"<id>"...}), so a hit points at the
    session that ran the lane. Best-effort: bounded, read-only, may miss."""
    hits: list[str] = []
    for root in _transcript_roots():
        try:
            out = subprocess.run(
                ["grep", "-rl", "--include=*.jsonl", lane_id, str(root)],
                capture_output=True, text=True, timeout=20,
            )
            hits.extend(p for p in out.stdout.splitlines() if p)
        except (subprocess.SubprocessError, OSError):
            continue
    return hits


def deep_dive(home: Path, lane_id: str) -> dict[str, Any]:
    lane_dir = home / "lanes" / lane_id
    la = analyze_lane(lane_dir)
    if la is None:
        return {"error": f"lane not found: {lane_id} under {home}"}
    return {
        "lane": asdict(la),
        "findings": [f.to_record() for f in classify(la)],
        "transcript_pointers": find_transcript_pointer(lane_id),
    }


# --- rendering --------------------------------------------------------------

_SEV_ORDER = {"high": 0, "medium": 1, "info": 2}


def render_human(report: dict[str, Any], ax_only: bool) -> str:
    t = report["totals"]
    lines = [
        f"orca usage analysis — {report['home']}",
        f"  lanes: {t['lanes']}  |  completed: {t['completed']}  |  "
        f"friction lanes: {t['friction_lanes']} ({t['friction_rate']:.0%})  |  AX defects: {t['ax_defects']}",
        "  by agent: " + ", ".join(
            f"{a}({', '.join(f'{k}:{v}' for k, v in sorted(s.items()))})"
            for a, s in sorted(report["by_agent"].items())
        ),
        "",
    ]
    findings = report["findings"]
    if ax_only:
        findings = [f for f in findings if f["is_ax_defect"]]
    if not findings:
        lines.append("  no findings.")
        return "\n".join(lines)

    findings = sorted(findings, key=lambda f: (_SEV_ORDER.get(f["severity"], 9), f["kind"]))
    lines.append("findings (most severe first):")
    for f in findings:
        tag = "AX" if f["is_ax_defect"] else "  "
        lines.append(f"  [{f['severity']:>6}] [{tag}] {f['kind']} · {f['agent']} · {f['lane_id']}  →{f['surface']}")
        lines.append(f"            {f['evidence']}")
        lines.append(f"            ↳ {f['suggestion']}")
    return "\n".join(lines)


def main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="Analyze orca lane usage for AX friction.")
    ap.add_argument("--home", type=Path, default=None,
                    help="ORCA_HOME (default: $ORCA_HOME or ~/.orca)")
    ap.add_argument("--json", action="store_true", help="emit the structured report")
    ap.add_argument("--ax-only", action="store_true",
                    help="show/append only AX defects (drop environmental noise)")
    ap.add_argument("--append-findings", type=Path, default=None,
                    help="append new (deduped) findings to a jsonl fix queue")
    ap.add_argument("--lane", type=str, default=None,
                    help="deep-dive one lane id, with a transcript pointer")
    args = ap.parse_args(argv)

    home = args.home or Path(os.environ.get("ORCA_HOME", Path.home() / ".orca"))
    if not (home / "lanes").is_dir():
        print(f"no lane store at {home}/lanes", file=sys.stderr)
        return 4

    if args.lane:
        result = deep_dive(home, args.lane)
        print(json.dumps(result, indent=2))
        return 0 if "error" not in result else 4

    report = build_report(home)

    if args.append_findings:
        written, existing = append_findings(report, args.append_findings, args.ax_only)
        print(f"appended {written} new finding(s) to {args.append_findings} "
              f"({existing} already present, deduped by finding_id)")
        return 0

    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print(render_human(report, args.ax_only))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
