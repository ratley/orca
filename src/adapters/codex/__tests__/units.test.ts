import { describe, expect, test } from "bun:test";

import type { ToolRequestUserInputQuestion } from "@happycatlabs/codex-client";

import { AgentManifestSchema } from "../../../types/lane";
import { parseAnswerInput, toBlockedQuestions } from "../answers";
import {
  buildCodexManifest,
  CODEX_CAVEATS,
  CODEX_DECLARED_FACTS,
  CODEX_POSIX_KILL_CAVEAT,
} from "../manifest";
import { resolveSessionPolicy } from "../sandbox";

const singleQuestion: ToolRequestUserInputQuestion[] = [
  { header: "Deploy", id: "q1", question: "Proceed?" },
];

const twoQuestions: ToolRequestUserInputQuestion[] = [
  { header: "A", id: "qa", question: "First?" },
  { header: "B", id: "qb", question: "Second?" },
];

describe("parseAnswerInput", () => {
  test("plain text answers a single question", () => {
    expect(parseAnswerInput("yes\n", singleQuestion)).toEqual({
      answers: { q1: { answers: ["yes"] } },
    });
  });

  test("empty payload is rejected", () => {
    expect(() => parseAnswerInput("   \n", singleQuestion)).toThrow("empty");
  });

  test("plain text is rejected for multiple questions", () => {
    expect(() => parseAnswerInput("yes", twoQuestions)).toThrow("JSON object");
  });

  test("JSON object keyed by question id answers multiple questions", () => {
    expect(parseAnswerInput('{"qa":"one","qb":["two","three"]}', twoQuestions)).toEqual({
      answers: { qa: { answers: ["one"] }, qb: { answers: ["two", "three"] } },
    });
  });

  test("payload wrapped in an answers envelope is accepted", () => {
    expect(
      parseAnswerInput('{"answers":{"qa":{"answers":["one"]},"qb":"two"}}', twoQuestions),
    ).toEqual({
      answers: { qa: { answers: ["one"] }, qb: { answers: ["two"] } },
    });
  });

  test("missing question ids are rejected", () => {
    expect(() => parseAnswerInput('{"qa":"one"}', twoQuestions)).toThrow("qb");
  });

  test("non-string answer values are rejected", () => {
    expect(() => parseAnswerInput('{"qa": 5, "qb": "two"}', twoQuestions)).toThrow("'qa'");
  });

  test("JSON payloads work for a single question too", () => {
    expect(parseAnswerInput('{"q1":"yes"}', singleQuestion)).toEqual({
      answers: { q1: { answers: ["yes"] } },
    });
  });
});

describe("toBlockedQuestions", () => {
  test("maps header, question, and option labels", () => {
    const blocked = toBlockedQuestions([
      {
        header: "Deploy",
        id: "q1",
        question: "Proceed?",
        options: [
          { label: "yes", description: "ship it" },
          { label: "no", description: "abort" },
        ],
      },
    ]);

    expect(blocked).toEqual([{ id: "q1", question: "Deploy: Proceed?", options: ["yes", "no"] }]);
  });

  test("omits options when absent and skips redundant headers", () => {
    expect(toBlockedQuestions([{ header: "", id: "q1", question: "Proceed?" }])).toEqual([
      { id: "q1", question: "Proceed?" },
    ]);
    expect(
      toBlockedQuestions([{ header: "Proceed?", id: "q1", question: "Proceed?", options: null }]),
    ).toEqual([{ id: "q1", question: "Proceed?" }]);
  });
});

describe("resolveSessionPolicy", () => {
  test("defaults to workspace-write with approvals never", () => {
    expect(resolveSessionPolicy()).toEqual({
      sandbox: "workspace-write",
      approvalPolicy: "never",
    });
  });

  test("read-only lanes get the read-only sandbox", () => {
    expect(resolveSessionPolicy({ readOnly: true })).toEqual({
      sandbox: "read-only",
      approvalPolicy: "never",
    });
  });
});

describe("codex manifest", () => {
  test("is schema-valid and carries the measured overhead", () => {
    const manifest = AgentManifestSchema.parse(buildCodexManifest("linux"));

    expect(manifest.agent).toBe("codex");
    expect(manifest.capabilities).toEqual({
      resume: true,
      kill: true,
      questions: true,
      continuityMethods: ["thread-id-match"],
    });
    expect(manifest.overhead).toEqual({
      startupMsP50: CODEX_DECLARED_FACTS.startupMs,
      measuredAt: "2026-07-11",
    });
    expect(manifest.declared).toEqual(CODEX_DECLARED_FACTS);
    expect(manifest.caveats).toEqual([...CODEX_CAVEATS, CODEX_POSIX_KILL_CAVEAT]);
  });

  test("kill capability is platform-aware and always carries the posix_only caveat (P-POSIX)", () => {
    const posix = AgentManifestSchema.parse(buildCodexManifest("linux"));
    expect(posix.capabilities.kill).toBe(true);
    expect(posix.caveats?.some((caveat) => caveat.code === "posix_only")).toBe(true);

    const windows = AgentManifestSchema.parse(buildCodexManifest("win32"));
    expect(windows.capabilities.kill).toBe(false);
    expect(windows.caveats?.some((caveat) => caveat.code === "posix_only")).toBe(true);

    // Runtime default reports the actual platform.
    expect(buildCodexManifest().capabilities.kill).toBe(process.platform !== "win32");
  });

  test("declares the residual spawn-window identity caveat honestly", () => {
    const codes = buildCodexManifest().caveats?.map((caveat) => caveat.code);
    expect(codes).toContain("process_identity_spawn_window");
    expect(codes).toContain("process_group_signalling_cli_owned");
  });

  test("declared facts pin the measurement source", () => {
    expect(CODEX_DECLARED_FACTS.measuredOn).toBe("codex-cli 0.144.1");
    expect(CODEX_DECLARED_FACTS.inputTokenOverhead).toBe(24000);
  });

  test("declared facts and caveats survive manifest JSON round-trip", () => {
    const manifest = AgentManifestSchema.parse(buildCodexManifest());
    const roundTripped = AgentManifestSchema.parse(JSON.parse(JSON.stringify(manifest)));

    expect(roundTripped).toEqual(manifest);
    expect(roundTripped.declared?.sandboxModes).toEqual([
      "read-only",
      "workspace-write",
      "danger-full-access",
    ]);
    expect(roundTripped.caveats?.map((caveat) => caveat.code)).toContain(
      "process_group_signalling_cli_owned",
    );
    expect(roundTripped.caveats?.map((caveat) => caveat.code)).not.toContain(
      "process_identity_unavailable",
    );
    expect(roundTripped.capabilities.kill).toBe(process.platform !== "win32");
  });
});
