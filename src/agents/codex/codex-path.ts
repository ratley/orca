import { execFile as execFileCallback } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const FALLBACK_CODEX_PATH = "codex";

const KNOWN_CODEX_BINARY_CANDIDATES = [
  "/Applications/Codex.app/Contents/Resources/codex",
  "/opt/homebrew/bin/codex",
  "/usr/local/bin/codex",
] as const;

export interface ParsedCodexCliVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: Array<number | string>;
  raw: string;
}

export interface CodexBinaryProbe {
  path: string;
  versionOutput: string | null;
}

let cachedResolvedCodexPath: Promise<string> | null = null;

export function clearResolvedCodexPathCacheForTests(): void {
  cachedResolvedCodexPath = null;
}

export function parseCodexCliVersion(output: string): ParsedCodexCliVersion | null {
  const match = output.match(/codex-cli\s+(\d+)\.(\d+)\.(\d+)(?:-([A-Za-z0-9.-]+))?/i);
  if (!match) {
    return null;
  }

  const prerelease = match[4]
    ? match[4]
        .split(".")
        .map((part) => (/^\d+$/.test(part) ? Number(part) : part))
    : [];

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
    raw: match[0],
  };
}

export function compareCodexCliVersions(a: ParsedCodexCliVersion, b: ParsedCodexCliVersion): number {
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) {
      return a[key] - b[key];
    }
  }

  if (a.prerelease.length === 0 && b.prerelease.length === 0) {
    return 0;
  }

  if (a.prerelease.length === 0) {
    return 1;
  }

  if (b.prerelease.length === 0) {
    return -1;
  }

  const maxLength = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < maxLength; index += 1) {
    const left = a.prerelease[index];
    const right = b.prerelease[index];

    if (left === undefined) {
      return -1;
    }

    if (right === undefined) {
      return 1;
    }

    if (left === right) {
      continue;
    }

    if (typeof left === "number" && typeof right === "number") {
      return left - right;
    }

    if (typeof left === "number") {
      return -1;
    }

    if (typeof right === "number") {
      return 1;
    }

    return left.localeCompare(right);
  }

  return 0;
}

export function selectPreferredCodexBinary(probes: CodexBinaryProbe[]): string | null {
  const candidates = probes.filter((probe) => probe.path.trim().length > 0);
  if (candidates.length === 0) {
    return null;
  }

  let best = candidates[0] ?? null;
  if (!best) {
    return null;
  }

  let bestVersion = parseCodexCliVersion(best.versionOutput ?? "");

  for (const candidate of candidates.slice(1)) {
    const candidateVersion = parseCodexCliVersion(candidate.versionOutput ?? "");
    if (!bestVersion) {
      if (candidateVersion) {
        best = candidate;
        bestVersion = candidateVersion;
      }
      continue;
    }

    if (!candidateVersion) {
      continue;
    }

    if (compareCodexCliVersions(candidateVersion, bestVersion) > 0) {
      best = candidate;
      bestVersion = candidateVersion;
    }
  }

  return best.path;
}

function resolveCodexPathOnPath(): string | null {
  const pathValue = process.env.PATH?.trim();
  if (!pathValue) {
    return null;
  }

  for (const entry of pathValue.split(path.delimiter)) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) {
      continue;
    }

    const candidatePath = path.join(trimmed, "codex");
    try {
      accessSync(candidatePath, fsConstants.X_OK);
      return candidatePath;
    } catch {
      continue;
    }
  }

  return null;
}

function getCandidatePaths(): string[] {
  return Array.from(
    new Set(
      [resolveCodexPathOnPath(), ...KNOWN_CODEX_BINARY_CANDIDATES].filter(
        (value): value is string => typeof value === "string" && value.trim().length > 0,
      ),
    ),
  );
}

async function isExecutable(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function readCodexCliVersion(filePath: string): Promise<string | null> {
  try {
    const { stdout, stderr } = await execFile(filePath, ["--version"], {
      timeout: 1_500,
    });
    const output = `${stdout ?? ""}\n${stderr ?? ""}`.trim();
    return output.length > 0 ? output : null;
  } catch {
    return null;
  }
}

async function autoResolveCodexPath(): Promise<string> {
  const candidates = getCandidatePaths();
  const available = await Promise.all(
    candidates.map(async (candidatePath) => {
      if (!(await isExecutable(candidatePath))) {
        return null;
      }

      return {
        path: candidatePath,
        versionOutput: await readCodexCliVersion(candidatePath),
      } satisfies CodexBinaryProbe;
    }),
  );

  const preferred = selectPreferredCodexBinary(
    available.filter((probe): probe is CodexBinaryProbe => probe !== null),
  );

  return preferred ?? FALLBACK_CODEX_PATH;
}

export async function resolveCodexPath(): Promise<string> {
  const explicitPath = process.env.ORCA_CODEX_PATH?.trim();
  if (explicitPath && explicitPath.length > 0) {
    return explicitPath;
  }

  cachedResolvedCodexPath ??= autoResolveCodexPath();
  return cachedResolvedCodexPath;
}
