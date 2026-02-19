import { exec as execCallback } from "node:child_process";
import { promisify } from "node:util";

import type { HookEvent, HookHandler, HookName } from "../types/index.js";
import type { HookDispatchOptions } from "./types.js";

const exec = promisify(execCallback);
const DEFAULT_TIMEOUT_MS = 10_000;

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`Hook timeout after ${timeoutMs}ms`)), timeoutMs);
    })
  ]);
}

function sanitizeValue(value: string): string {
  return value.replace(/[\r\n]/g, " ").replace(/'/g, "'\\''");
}

function applyCommandTemplate(template: string, event: HookEvent): string {
  return template
    .replaceAll("{msg}", sanitizeValue(event.message))
    .replaceAll("{runId}", sanitizeValue(event.runId))
    .replaceAll("{taskId}", sanitizeValue(event.taskId ?? ""));
}

export class HookDispatcher {
  private readonly handlers: Map<HookName, HookHandler[]> = new Map();
  private readonly commandHooks: Partial<Record<HookName, string>>;
  private readonly timeoutMs: number;
  private isEmittingHookError = false;

  constructor(options: HookDispatchOptions = {}) {
    this.commandHooks = options.commandHooks ?? {};
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  on(hook: HookName, handler: HookHandler): void {
    const existing = this.handlers.get(hook) ?? [];
    existing.push(handler);
    this.handlers.set(hook, existing);
  }

  async dispatch(event: HookEvent): Promise<void> {
    const handlers = this.handlers.get(event.hook) ?? [];

    for (const handler of handlers) {
      try {
        await withTimeout(handler(event), this.timeoutMs);
      } catch (error) {
        await this.emitHookError(event, error);
      }
    }

    const commandTemplate = this.commandHooks[event.hook];
    if (commandTemplate) {
      try {
        const command = applyCommandTemplate(commandTemplate, event);
        await withTimeout(exec(command), this.timeoutMs);
      } catch (error) {
        await this.emitHookError(event, error);
      }
    }
  }

  private async emitHookError(sourceEvent: HookEvent, error: unknown): Promise<void> {
    if (this.isEmittingHookError || sourceEvent.hook === "onError") {
      return;
    }

    this.isEmittingHookError = true;

    try {
      const onErrorHandlers = this.handlers.get("onError") ?? [];
      const event: HookEvent = {
        runId: sourceEvent.runId,
        hook: "onError",
        message: `Hook dispatch failed for ${sourceEvent.hook}`,
        timestamp: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
        ...(sourceEvent.taskId ? { taskId: sourceEvent.taskId } : {}),
        ...(sourceEvent.taskName ? { taskName: sourceEvent.taskName } : {}),
        ...(sourceEvent.metadata ? { metadata: sourceEvent.metadata } : {})
      };

      for (const handler of onErrorHandlers) {
        await withTimeout(handler(event), this.timeoutMs);
      }
    } finally {
      this.isEmittingHookError = false;
    }
  }
}
