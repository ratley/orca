function tryParseJson(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    return undefined;
  }
}

function extractFencedCandidates(text: string): string[] {
  const candidates: string[] = [];
  const fenceRegex = /```(?:json)?\s*\n?([\s\S]*?)\n?```/gi;

  for (const match of text.matchAll(fenceRegex)) {
    const body = match[1]?.trim();
    if (body) {
      candidates.push(body);
    }
  }

  return candidates;
}

function extractFirstJsonObjectOrArray(text: string): string | null {
  for (let start = 0; start < text.length; start += 1) {
    const first = text[start];
    if (first !== "{" && first !== "[") {
      continue;
    }

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let end = start; end < text.length; end += 1) {
      const ch = text[end];

      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }

        if (ch === "\\") {
          escaped = true;
          continue;
        }

        if (ch === '"') {
          inString = false;
        }

        continue;
      }

      if (ch === '"') {
        inString = true;
        continue;
      }

      if (ch === "{" || ch === "[") {
        depth += 1;
        continue;
      }

      if (ch === "}" || ch === "]") {
        depth -= 1;
        if (depth === 0) {
          const candidate = text.slice(start, end + 1).trim();
          if (tryParseJson(candidate) !== undefined) {
            return candidate;
          }
          break;
        }
      }
    }
  }

  return null;
}

export function parseAgentJson(raw: string): unknown {
  const text = raw.trim();

  const candidates = [text, ...extractFencedCandidates(text)];

  const extracted = extractFirstJsonObjectOrArray(text);
  if (extracted) {
    candidates.push(extracted);
  }

  for (const candidate of candidates) {
    const parsed = tryParseJson(candidate);
    if (parsed !== undefined) {
      return parsed;
    }
  }

  throw new Error("Response did not contain valid JSON object/array");
}
