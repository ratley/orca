import { unstable_v2_createSession } from "@anthropic-ai/claude-agent-sdk";

import type { Task } from "../../types/index.js";

export interface PlanResult {
  tasks: Task[];
  rawResponse: string;
}

function buildPlanningPrompt(spec: string, systemContext: string): string {
  return [
    systemContext,
    "You are decomposing a spec into an ordered task graph.",
    "Return a JSON array of tasks.",
    "Each task must include fields: id, name, description, dependencies, acceptance_criteria, status, retries, maxRetries.",
    "Set status to \"pending\", retries to 0, and maxRetries to 3 for every task.",
    "dependencies must be an array of task IDs.",
    "acceptance_criteria must be an array of strings.",
    "Return ONLY valid JSON. No markdown fences. No explanation.",
    "Spec:",
    spec
  ].join("\n\n");
}

function extractAssistantText(message: unknown): string | null {
  if (!message || typeof message !== "object") {
    return null;
  }

  const obj = message as { type?: string; message?: { content?: Array<{ type?: string; text?: string }> } };
  if (obj.type !== "assistant") {
    return null;
  }

  const blocks = obj.message?.content;
  if (!Array.isArray(blocks)) {
    return null;
  }

  const text = blocks
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n")
    .trim();

  return text.length > 0 ? text : null;
}

function parseTaskArray(raw: string): Task[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("Claude plan response was not a JSON array");
  }

  return parsed as Task[];
}

export async function planSpec(spec: string, systemContext: string): Promise<PlanResult> {
  const session = unstable_v2_createSession({
    model: process.env.ORCA_CLAUDE_MODEL ?? "claude-sonnet-4-5"
  });

  const assistantMessages: string[] = [];
  let resultText: string | null = null;

  try {
    const streamPromise = (async (): Promise<void> => {
      for await (const message of session.stream()) {
        const assistantText = extractAssistantText(message);
        if (assistantText) {
          assistantMessages.push(assistantText);
        }

        if (
          message.type === "result" &&
          message.subtype === "success" &&
          typeof message.result === "string"
        ) {
          resultText = message.result;
        }

        if (message.type === "result" && message.subtype !== "success") {
          const details = "errors" in message ? message.errors.join("; ") : "unknown error";
          throw new Error(`Claude planning failed (${message.subtype}): ${details}`);
        }
      }
    })();

    await session.send(buildPlanningPrompt(spec, systemContext));
    await streamPromise;

    const rawResponse = assistantMessages.length > 0
      ? assistantMessages[assistantMessages.length - 1]
      : resultText;

    if (!rawResponse) {
      throw new Error("Claude planning response was empty");
    }

    return {
      tasks: parseTaskArray(rawResponse),
      rawResponse
    };
  } finally {
    session.close();
  }
}
