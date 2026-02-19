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

export function createOpenclawHookHandler(timeoutMs = 10_000): HookHandler {
  return async (event: HookEvent): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let child: ReturnType<typeof spawn>;

      const settleResolve = (): void => {
        if (settled) {
          return;
        }

        settled = true;
        resolve();
      };

      const settleReject = (reason: unknown): void => {
        if (settled) {
          return;
        }

        settled = true;
        reject(reason);
      };

      try {
        child = spawn(
          "openclaw",
          ["system", "event", "--text", event.message, "--mode", "now"],
          {
            stdio: "ignore"
          }
        );
      } catch (error) {
        settleReject(error);
        return;
      }

      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        settleReject(
          new Error(`openclaw timed out after ${timeoutMs}ms while handling hook ${event.hook}`)
        );
      }, timeoutMs);

      child.on("error", (error) => {
        clearTimeout(timeout);
        settleReject(error);
      });
      child.on("exit", (code) => {
        clearTimeout(timeout);

        if (code === 0) {
          settleResolve();
          return;
        }

        settleReject(new Error(`openclaw exited with code ${code ?? "unknown"}`));
      });
    });
  };
}
