import { z } from "zod";

/**
 * Shapes of `claude -p --output-format stream-json --verbose` stdout lines.
 *
 * Pinned by live probes against Claude Code 2.1.207 on 2026-07-11 (verbatim
 * captures live in `__tests__/adapter.test.ts`). Verified facts encoded here:
 *
 * - The final stdout line is a `type:"result"` object identical to the
 *   `--output-format json` envelope.
 * - `is_error` is the authoritative failure signal, NOT `subtype`: a bogus
 *   model produced exit 1 with `subtype:"success"`, `is_error:true`,
 *   `api_error_status:404` and `terminal_reason:"api_error"`.
 * - `session_id` is present on every result line, success and failure alike.
 * - A `type:"system","subtype":"init"` line precedes agent work and carries
 *   session_id, model, and permissionMode.
 * - Hook and housekeeping lines (`system/hook_started`, `rate_limit_event`,
 *   ...) are interleaved on stdout and must be tolerated.
 */

export const ClaudeResultLineSchema = z.object({
  type: z.literal("result"),
  subtype: z.string(),
  is_error: z.boolean(),
  duration_ms: z.number().optional(),
  duration_api_ms: z.number().optional(),
  num_turns: z.number().optional(),
  /** Final assistant text. Present on success; also present on API errors. */
  result: z.string().optional(),
  session_id: z.string(),
  total_cost_usd: z.number().optional(),
  usage: z
    .object({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
    })
    .optional(),
  /** Tools the default permission mode refused (probed: Write is denied). */
  permission_denials: z.array(z.object({ tool_name: z.string() })).optional(),
  terminal_reason: z.string().optional(),
});
export type ClaudeResultLine = z.infer<typeof ClaudeResultLineSchema>;

export const ClaudeInitLineSchema = z.object({
  type: z.literal("system"),
  subtype: z.literal("init"),
  session_id: z.string(),
  model: z.string().optional(),
  permissionMode: z.string().optional(),
});
export type ClaudeInitLine = z.infer<typeof ClaudeInitLineSchema>;

export const ClaudeAssistantLineSchema = z.object({
  type: z.literal("assistant"),
  session_id: z.string().optional(),
  message: z.object({
    content: z.array(
      z.object({
        type: z.string(),
        text: z.string().optional(),
      }),
    ),
  }),
});
export type ClaudeAssistantLine = z.infer<typeof ClaudeAssistantLineSchema>;

export type ParsedClaudeLine =
  | { kind: "init"; line: ClaudeInitLine }
  | { kind: "assistant"; line: ClaudeAssistantLine }
  | { kind: "result"; line: ClaudeResultLine }
  | { kind: "malformed-result"; raw: string }
  | { kind: "other" };

/**
 * Classifies one stdout line. Unknown or non-JSON lines are "other" (hooks
 * write system noise); a `type:"result"` line that fails the pinned schema is
 * reported as "malformed-result" so the adapter can fail loud instead of
 * guessing.
 */
export function parseClaudeLine(raw: string): ParsedClaudeLine {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { kind: "other" };
  }

  if (typeof json !== "object" || json === null) {
    return { kind: "other" };
  }

  const type = (json as { type?: unknown }).type;
  if (type === "result") {
    const parsed = ClaudeResultLineSchema.safeParse(json);
    return parsed.success
      ? { kind: "result", line: parsed.data }
      : { kind: "malformed-result", raw };
  }

  if (type === "system") {
    const parsed = ClaudeInitLineSchema.safeParse(json);
    return parsed.success ? { kind: "init", line: parsed.data } : { kind: "other" };
  }

  if (type === "assistant") {
    const parsed = ClaudeAssistantLineSchema.safeParse(json);
    return parsed.success ? { kind: "assistant", line: parsed.data } : { kind: "other" };
  }

  return { kind: "other" };
}
