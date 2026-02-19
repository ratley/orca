import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";

import type { HookEvent, HookHandler } from "../../types/index.js";

function hasOpenclawBinary(): boolean {
  const command = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(command, ["openclaw"], { stdio: "ignore" });
  return result.status === 0;
}

function hasOpenclawAuth(): boolean {
  if (process.env.OPENCLAW_GATEWAY_TOKEN) {
    return true;
  }

  const configPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
  return existsSync(configPath);
}

export function detectOpenclawAvailability(): {
  available: boolean;
  warning?: string;
} {
  const binary = hasOpenclawBinary();
  const auth = hasOpenclawAuth();

  if (binary && auth) {
    return { available: true };
  }

  if (binary || auth) {
    return {
      available: false,
      warning:
        "OpenClaw detection is partial (binary/auth mismatch). Falling back to stdout hooks."
    };
  }

  return { available: false };
}

export function createOpenclawHookHandler(): HookHandler {
  return async (event: HookEvent): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        "openclaw",
        ["system", "event", "--text", event.message, "--mode", "now"],
        {
          stdio: "ignore"
        }
      );

      child.on("error", reject);
      child.on("exit", (code) => {
        if (code === 0) {
          resolve();
          return;
        }

        reject(new Error(`openclaw exited with code ${code ?? "unknown"}`));
      });
    });
  };
}
