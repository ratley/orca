import type { HookEvent, HookHandler } from "../../types/index.js";

export function createStdoutHookHandler(prefix = "[hook]"): HookHandler {
  return async (event: HookEvent): Promise<void> => {
    const line = {
      prefix,
      hook: event.hook,
      runId: event.runId,
      taskId: event.taskId,
      timestamp: event.timestamp,
      message: event.message,
      error: event.error,
      metadata: event.metadata
    };

    console.log(JSON.stringify(line));
  };
}
