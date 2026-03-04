export const CODEX_THINKING_LEVEL_VALUES = ["low", "medium", "high", "xhigh"] as const;
export const CODEX_EFFORT_VALUES = CODEX_THINKING_LEVEL_VALUES;
export type CodexEffort = (typeof CODEX_THINKING_LEVEL_VALUES)[number];

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
  const normalized = raw === "extra-high" ? "xhigh" : raw;
  return parseEffort(normalized, CODEX_EFFORT_VALUES, "Codex thinking level");
}
