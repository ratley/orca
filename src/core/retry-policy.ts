import type { Task } from "../types/index.js";

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  return String(error);
}

function isPermanentError(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase();

  if (error instanceof TypeError) {
    return true;
  }

  const permanentPatterns = [
    "schema",
    "validation",
    "invalid json",
    "parse",
    "cancelled",
    "canceled",
    "abort"
  ];

  return permanentPatterns.some((pattern) => message.includes(pattern));
}

function isTransientError(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase();

  const transientPatterns = [
    "timeout",
    "timed out",
    "network",
    "econnreset",
    "econnrefused",
    "enotfound",
    "eai_again",
    "rate limit",
    "too many requests",
    "429",
    "503",
    "temporarily unavailable",
    "socket hang up"
  ];

  return transientPatterns.some((pattern) => message.includes(pattern));
}

export function shouldRetry(task: Task, error: unknown): boolean {
  if (task.retries >= task.maxRetries) {
    return false;
  }

  if (isPermanentError(error)) {
    return false;
  }

  return isTransientError(error);
}
