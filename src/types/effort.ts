export const CODEX_EFFORT_VALUES = ["low", "medium", "high", "extra-high"] as const;
export type CodexEffort = (typeof CODEX_EFFORT_VALUES)[number];

function formatAllowed(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(", ");
}

function parseEffort<T extends readonly string[]>(
  raw: string,
  allowed: T,
  label: string,
): T[number] {
  if ((allowed as readonly string[]).includes(raw)) {
    return raw as T[number];
  }

  throw new Error(`${label} must be one of ${formatAllowed(allowed)}, got '${raw}'`);
}

export function parseCodexEffort(raw: string): CodexEffort {
  return parseEffort(raw, CODEX_EFFORT_VALUES, "Codex effort");
}
