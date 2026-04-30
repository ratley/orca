import type { HookEvent, HookHandler } from "../../types/index.js";

type StdoutWrite = (line: string) => void;

export function createStdoutHookHandler(prefix = "[hook]", write: StdoutWrite = console.log): HookHandler {
  return async (event: HookEvent): Promise<void> => {
    const line = {
      prefix,
      hook: event.hook,
      runId: event.runId,
      taskId: event.taskId,
      timestamp: event.timestamp,
      message: event.message,
      error: event.error,
      metadata: event.metadata,
    };

    write(JSON.stringify(line));
  };
}
