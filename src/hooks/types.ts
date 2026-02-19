import type { HookEvent, HookHandler, HookName } from "../types/index.js";

export interface HookDispatchOptions {
  timeoutMs?: number;
  commandHooks?: Partial<Record<HookName, string>>;
}

export interface HookAdapter {
  isAvailable(): Promise<boolean>;
  handle(event: HookEvent): Promise<void>;
}

export type { HookEvent, HookHandler, HookName };
