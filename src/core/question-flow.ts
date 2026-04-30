import type { ToolRequestUserInputParams, ToolRequestUserInputResponse } from "@ratley/codex-client";

import type { PendingQuestion, PendingQuestionPrompt } from "../types/index.js";

function normalizeQuestionPrompt(question: ToolRequestUserInputParams["questions"][number]): PendingQuestionPrompt {
  return {
    header: question.header,
    id: question.id,
    question: question.question,
    isOther: question.isOther ?? false,
    isSecret: question.isSecret ?? false,
    ...(question.options !== undefined ? { options: question.options } : {}),
  };
}

function normalizeAnswerList(value: unknown): string[] | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? [trimmed] : [];
  }

  if (Array.isArray(value)) {
    const answers = value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    return answers;
  }

  if (
    value &&
    typeof value === "object" &&
    "answers" in value &&
    Array.isArray((value as { answers?: unknown }).answers)
  ) {
    return normalizeAnswerList((value as { answers?: unknown[] }).answers);
  }

  return null;
}

function formatQuestionBlock(question: PendingQuestionPrompt): string {
  const optionText =
    question.options && question.options.length > 0
      ? ` Options: ${question.options.map((option) => option.label).join(", ")}.`
      : "";

  return `${question.header} (${question.id}): ${question.question}${optionText}`;
}

export function createPendingQuestion(
  requestId: string | number,
  params: ToolRequestUserInputParams,
  receivedAt: string = new Date().toISOString(),
): PendingQuestion {
  return {
    requestId,
    threadId: params.threadId,
    turnId: params.turnId,
    itemId: params.itemId,
    receivedAt,
    questions: params.questions.map((question) => normalizeQuestionPrompt(question)),
  };
}

export function buildQuestionHookMessage(pendingQuestion: PendingQuestion): string {
  if (pendingQuestion.questions.length === 1) {
    return pendingQuestion.questions[0]?.question ?? "Codex requested user input.";
  }

  return `Codex requested answers for ${pendingQuestion.questions.length} questions.`;
}

export function formatPendingQuestionForStatus(pendingQuestion: PendingQuestion): string[] {
  return ["Pending Question:", ...pendingQuestion.questions.map((question) => `- ${formatQuestionBlock(question)}`)];
}

export function serializeQuestionAnswerResponse(response: ToolRequestUserInputResponse): string {
  return `${JSON.stringify(response, null, 2)}\n`;
}

function buildSingleQuestionTextResponse(
  question: PendingQuestionPrompt,
  answer: string,
): ToolRequestUserInputResponse {
  return {
    answers: {
      [question.id]: {
        answers: [answer],
      },
    },
  };
}

function normalizeStructuredAnswers(
  answerRecord: Record<string, unknown>,
  pendingQuestion: PendingQuestion,
): Record<string, { answers: string[] }> {
  const expectedQuestionIds = new Set(pendingQuestion.questions.map((question) => question.id));

  for (const questionId of Object.keys(answerRecord)) {
    if (!expectedQuestionIds.has(questionId)) {
      throw new Error(`answer payload includes unknown question id '${questionId}'`);
    }
  }

  const normalizedAnswers: Record<string, { answers: string[] }> = {};
  for (const question of pendingQuestion.questions) {
    if (!(question.id in answerRecord)) {
      throw new Error(`answer payload is missing question id '${question.id}'`);
    }

    const answers = normalizeAnswerList(answerRecord[question.id]);
    if (answers === null) {
      throw new Error(`answer payload for '${question.id}' must be a string, string array, or { answers: string[] }`);
    }

    normalizedAnswers[question.id] = { answers };
  }

  return normalizedAnswers;
}

export function parseQuestionAnswerInput(
  rawInput: string,
  pendingQuestion: PendingQuestion,
): ToolRequestUserInputResponse {
  const trimmed = rawInput.trim();
  if (trimmed.length === 0) {
    throw new Error("answer payload is empty");
  }

  const onlyQuestion = pendingQuestion.questions.length === 1 ? pendingQuestion.questions[0] : undefined;
  if (pendingQuestion.questions.length === 1 && !onlyQuestion) {
    throw new Error("pending question is missing its question definition");
  }

  if (pendingQuestion.questions.length === 1 && !trimmed.startsWith("{")) {
    return buildSingleQuestionTextResponse(onlyQuestion!, trimmed);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    if (pendingQuestion.questions.length === 1) {
      return buildSingleQuestionTextResponse(onlyQuestion!, trimmed);
    }

    throw new Error("multiple pending questions require a JSON object mapping question ids to answers");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    if (pendingQuestion.questions.length === 1) {
      return buildSingleQuestionTextResponse(onlyQuestion!, trimmed);
    }

    throw new Error("answer payload must be a JSON object");
  }

  const record = parsed as Record<string, unknown>;
  if ("answers" in record && record.answers && typeof record.answers === "object" && !Array.isArray(record.answers)) {
    return { answers: normalizeStructuredAnswers(record.answers as Record<string, unknown>, pendingQuestion) };
  }

  if (pendingQuestion.questions.length === 1 && !(onlyQuestion!.id in record)) {
    return buildSingleQuestionTextResponse(onlyQuestion!, trimmed);
  }

  return { answers: normalizeStructuredAnswers(record, pendingQuestion) };
}
