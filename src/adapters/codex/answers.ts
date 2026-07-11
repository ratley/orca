import type {
  ToolRequestUserInputQuestion,
  ToolRequestUserInputResponse,
} from "@happycatlabs/codex-client";

import type { BlockedQuestion } from "../../types/lane.js";

/**
 * Answer-file protocol for parked questions, ported from the legacy codex
 * session's requestUserInput -> answer.txt loop onto the lane store:
 * `orca answer` writes <lane>/answer.txt, the dispatching adapter polls it,
 * parses it, and replies to the app-server. The adapter never mutates the
 * answer file; lifecycle/cleanup remains CLI-owned.
 */

/** Lane-contract view of a codex requestUserInput question set. */
export function toBlockedQuestions(questions: ToolRequestUserInputQuestion[]): BlockedQuestion[] {
  return questions.map((question) => ({
    id: question.id,
    question:
      question.header !== "" && question.header !== question.question
        ? `${question.header}: ${question.question}`
        : question.question,
    ...(Array.isArray(question.options) && question.options.length > 0
      ? { options: question.options.map((option) => option.label) }
      : {}),
  }));
}

/**
 * Parses raw answer.txt content into the app-server response shape. A single
 * question accepts plain text; multiple questions require a JSON object
 * mapping question ids to answers (optionally wrapped in {"answers": {...}}).
 * Throws with a human-readable message when the payload is invalid.
 */
export function parseAnswerInput(
  rawInput: string,
  questions: ToolRequestUserInputQuestion[],
): ToolRequestUserInputResponse {
  const trimmed = rawInput.trim();
  if (trimmed.length === 0) {
    throw new Error("answer payload is empty");
  }

  const onlyQuestion = questions.length === 1 ? questions[0] : undefined;
  if (onlyQuestion && !trimmed.startsWith("{")) {
    return { answers: { [onlyQuestion.id]: { answers: [trimmed] } } };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(
      onlyQuestion
        ? `answer payload is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
        : "multiple pending questions require a JSON object mapping question ids to answers",
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("answer payload must be a JSON object");
  }

  const record = parsed as Record<string, unknown>;
  if (
    "answers" in record &&
    record.answers &&
    typeof record.answers === "object" &&
    !Array.isArray(record.answers)
  ) {
    const normalized: Record<string, { answers: string[] }> = {};
    for (const [questionId, value] of Object.entries(record.answers as Record<string, unknown>)) {
      normalized[questionId] = { answers: requireAnswerList(questionId, value) };
    }

    return { answers: normalized };
  }

  const normalized: Record<string, { answers: string[] }> = {};
  for (const question of questions) {
    if (!(question.id in record)) {
      throw new Error(`answer payload is missing question id '${question.id}'`);
    }

    normalized[question.id] = { answers: requireAnswerList(question.id, record[question.id]) };
  }

  return { answers: normalized };
}

function requireAnswerList(questionId: string, value: unknown): string[] {
  const answers = normalizeAnswerList(value);
  if (answers === null) {
    throw new Error(
      `answer payload for '${questionId}' must be a string, string array, or { answers: string[] }`,
    );
  }

  return answers;
}

function normalizeAnswerList(value: unknown): string[] | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? [trimmed] : [];
  }

  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }

  if (
    value &&
    typeof value === "object" &&
    "answers" in value &&
    Array.isArray((value as { answers?: unknown }).answers)
  ) {
    return normalizeAnswerList((value as { answers: unknown[] }).answers);
  }

  return null;
}
