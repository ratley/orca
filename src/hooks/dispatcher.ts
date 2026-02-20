import { spawn } from "node:child_process";

import type { HookDispatchOptions } from "./types.js";
import type {
  HookEvent,
  HookEventMap,
  HookHandler,
  HookHandlerContext,
  HookName
} from "../types/index.js";

const DEFAULT_TIMEOUT_MS = 10_000;

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Hook timeout after ${timeoutMs}ms`)), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export class HookDispatcher {
  private readonly handlers: Map<HookName, HookHandler[]> = new Map();
  private readonly commandHooks: Partial<Record<HookName, string>>;
  private readonly timeoutMs: number;

  constructor(options: HookDispatchOptions = {}) {
    this.commandHooks = options.commandHooks ?? {};
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  on<K extends HookName>(hook: K, handler: HookHandler<K>): void {
    const existing = this.handlers.get(hook) ?? [];
    existing.push(handler as HookHandler);
    this.handlers.set(hook, existing);
  }

  async dispatch<K extends HookName>(event: HookEventMap[K]): Promise<void> {
    const handlers = this.handlers.get(event.hook) ?? [];
    const context: HookHandlerContext = {
      cwd: process.cwd(),
      pid: process.pid,
      invokedAt: new Date().toISOString()
    };

    for (const handler of handlers) {
      try {
        await withTimeout(Promise.resolve(handler(event, context)), this.timeoutMs);
      } catch (error) {
        await this.emitHookErrorSafely(event, error);
      }
    }

    const commandTemplate = this.commandHooks[event.hook];
    if (commandTemplate) {
      try {
        await this.runCommandHook(commandTemplate, event);
      } catch (error) {
        await this.emitHookErrorSafely(event, error);
      }
    }
  }

  private async runCommandHook(command: string, event: HookEvent): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, {
        shell: true,
        env: process.env,
        stdio: ["pipe", "ignore", "pipe"]
      });

      let settled = false;
      let stderr = "";
      const timeout = setTimeout(() => {
        if (settled) {
          return;
        }

        child.kill("SIGKILL");
        settled = true;
        reject(new Error(`Hook timeout after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      child.stderr?.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      child.stdin?.on("error", (error) => {
        if (settled) {
          return;
        }

        clearTimeout(timeout);
        settled = true;
        reject(error);
      });

      child.on("error", (error) => {
        if (settled) {
          return;
        }

        clearTimeout(timeout);
        settled = true;
        reject(error);
      });

      child.on("close", (code, signal) => {
        if (settled) {
          return;
        }

        clearTimeout(timeout);
        settled = true;

        if (code === 0) {
          resolve();
          return;
        }

        const details = stderr.trim();
        reject(
          new Error(
            `Hook command failed (${signal ? `signal=${signal}` : `exit=${code ?? "unknown"}`})${details ? `: ${details}` : ""}`
          )
        );
      });

      child.stdin?.end(`${JSON.stringify(event)}\n`);
    });
  }

  private async emitHookErrorSafely(sourceEvent: HookEvent, error: unknown): Promise<void> {
    try {
      await this.emitHookError(sourceEvent, error);
    } catch {
      // Never let hook error reporting failures bubble into run execution.
    }
  }

  private async emitHookError(sourceEvent: HookEvent, error: unknown): Promise<void> {
    if (sourceEvent.hook === "onError") {
      return;
    }

    const onErrorHandlers = this.handlers.get("onError") ?? [];
    const event: HookEventMap["onError"] = {
      runId: sourceEvent.runId,
      hook: "onError",
      message: `Hook dispatch failed for ${sourceEvent.hook}`,
      timestamp: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
      ...(sourceEvent.taskId ? { taskId: sourceEvent.taskId } : {}),
      ...(sourceEvent.taskName ? { taskName: sourceEvent.taskName } : {}),
      ...(sourceEvent.metadata ? { metadata: sourceEvent.metadata } : {})
    };
    const context: HookHandlerContext = {
      cwd: process.cwd(),
      pid: process.pid,
      invokedAt: new Date().toISOString()
    };

    for (const handler of onErrorHandlers) {
      await withTimeout(Promise.resolve(handler(event, context)), this.timeoutMs);
    }

    const commandTemplate = this.commandHooks.onError;
    if (commandTemplate) {
      await this.runCommandHook(commandTemplate, event);
    }
  }
}
