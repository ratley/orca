import { spawn } from "node:child_process";

import type { OrcaConfig, PlanResult, Task } from "../../types/index.js";

const DEFAULT_CLAUDE_TIMEOUT_MS = 300_000;

function buildPlanningPrompt(spec: string, systemContext: string): string {
  return [
    systemContext,
    "You are decomposing a spec into an ordered Orca task graph.",
    "Use broad product and implementation judgment when choosing the task boundaries.",
    "Prefer task decomposition that maximizes safe parallelism for independent workstreams.",
    "Isolate task ownership (files/subsystems) to avoid cross-task collisions.",
    "Return a JSON array of tasks.",
    "Each task must include fields: id, name, description, dependencies, acceptance_criteria, status, retries, maxRetries.",
    'Set status to "pending", retries to 0, and maxRetries to 3 for every task.',
    "dependencies must be an array of task IDs.",
    "acceptance_criteria must be an array of strings.",
    "Return ONLY valid JSON. No markdown fences. No explanation.",
    "Spec:",
    spec,
  ].join("\n\n");
}

function resolveClaudeCommand(config?: OrcaConfig): string {
  return config?.claude?.command
    ?? process.env.ORCA_CLAUDE_COMMAND
    ?? process.env.ORCA_CLAUDE_PATH
    ?? "claude";
}

function resolveClaudeArgs(config?: OrcaConfig): string[] {
  return [
    "-p",
    "--output-format",
    "text",
    "--tools",
    "",
    ...(config?.claude?.model ? ["--model", config.claude.model] : []),
    ...(config?.claude?.effort ? ["--effort", config.claude.effort] : []),
  ];
}

function resolveClaudeTimeoutMs(config?: OrcaConfig): number {
  return config?.claude?.timeoutMs ?? DEFAULT_CLAUDE_TIMEOUT_MS;
}

function runClaudePrint(prompt: string, config?: OrcaConfig): Promise<string> {
  const command = resolveClaudeCommand(config);
  const args = resolveClaudeArgs(config);
  const timeoutMs = resolveClaudeTimeoutMs(config);

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timeout = setTimeout(() => {
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`Claude planner timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      reject(new Error(`Failed to start Claude planner command '${command}': ${error.message}`));
    });

    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);

      if (code !== 0) {
        const detail = stderr.trim() || stdout.trim() || `signal ${signal ?? "unknown"}`;
        reject(new Error(`Claude planner exited with code ${code ?? "null"}: ${detail}`));
        return;
      }

      resolve(stdout.trim());
    });

    child.stdin.end(prompt);
  });
}

function extractJson(text: string): string {
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch?.[1]) {
    return fenceMatch[1].trim();
  }

  const lines = text.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]?.trim() ?? "";
    if (line.startsWith("[") || line.startsWith("{")) {
      try {
        JSON.parse(line);
        return line;
      } catch {
        // Continue searching for a valid JSON line.
      }
    }
  }

  return text.trim();
}

function parseTaskArray(raw: string): Task[] {
  const parsed = JSON.parse(extractJson(raw)) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("Claude plan response was not a JSON array");
  }

  return parsed as Task[];
}

export async function planSpec(
  spec: string,
  systemContext: string,
  config?: OrcaConfig,
): Promise<PlanResult> {
  const rawResponse = await runClaudePrint(buildPlanningPrompt(spec, systemContext), config);
  return {
    tasks: parseTaskArray(rawResponse),
    rawResponse,
  };
}
