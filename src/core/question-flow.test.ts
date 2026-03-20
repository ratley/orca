import { describe, expect, test } from "bun:test";

import type { PendingQuestion } from "../types/index.js";
import { parseQuestionAnswerInput } from "./question-flow.js";

function makePendingQuestion(questions: PendingQuestion["questions"]): PendingQuestion {
  return {
    requestId: "req-1",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    receivedAt: new Date().toISOString(),
    questions,
  };
}

describe("parseQuestionAnswerInput", () => {
  test("treats JSON snippets as plain text for a single pending question", () => {
    const pendingQuestion = makePendingQuestion([
      {
        header: "Config",
        id: "config",
        question: "What config should I use?",
        isOther: true,
        isSecret: false,
      },
    ]);

    expect(parseQuestionAnswerInput('{"useMigration":true}', pendingQuestion)).toEqual({
      answers: {
        config: {
          answers: ['{"useMigration":true}'],
        },
      },
    });
  });

  test("rejects documented answers payloads that include unknown question ids", () => {
    const pendingQuestion = makePendingQuestion([
      {
        header: "Backend",
        id: "backend",
        question: "Which backend should I use?",
        isOther: true,
        isSecret: false,
      },
    ]);

    expect(() =>
      parseQuestionAnswerInput('{"answers":{"backedn":{"answers":["bun"]}}}', pendingQuestion)
    ).toThrow("answer payload includes unknown question id 'backedn'");
  });

  test("requires every pending question id in explicit answers payloads", () => {
    const pendingQuestion = makePendingQuestion([
      {
        header: "Runtime",
        id: "runtime",
        question: "Which runtime should I use?",
        isOther: true,
        isSecret: false,
      },
      {
        header: "Package Manager",
        id: "package_manager",
        question: "Which package manager should I use?",
        isOther: true,
        isSecret: false,
      },
    ]);

    expect(() =>
      parseQuestionAnswerInput('{"answers":{"runtime":{"answers":["bun"]}}}', pendingQuestion)
    ).toThrow("answer payload is missing question id 'package_manager'");
  });
});
