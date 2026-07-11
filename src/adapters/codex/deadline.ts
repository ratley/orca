/**
 * One absolute wall-clock deadline computed at adapter entry (handoff finding
 * 16). Every subsequent boundary — connect, thread start/resume, turn
 * start/run, interrupt, and disconnect — draws from the same remaining budget
 * instead of arming its own full-size timer, so a hang at ANY stage surfaces
 * within the lane's timeoutMs instead of only hangs inside the turn itself.
 */
export interface Deadline {
  /** Remaining budget in whole milliseconds (>= 0); undefined = unbounded. */
  remainingMs(): number | undefined;
}

/** Budget for post-deadline cleanup (turn interrupt, transport disconnect). */
export const DEFAULT_CLEANUP_GRACE_MS = 2_000;

/** Starts an absolute deadline `timeoutMs` from now; undefined = unbounded. */
export function startDeadline(timeoutMs: number | undefined): Deadline {
  if (timeoutMs === undefined) {
    return { remainingMs: () => undefined };
  }

  const expiresAt = Date.now() + timeoutMs;
  return { remainingMs: () => Math.max(0, expiresAt - Date.now()) };
}

export type BoundedResult<T> = { timedOut: false; value: T } | { timedOut: true };

/**
 * Awaits `promise` within the deadline's remaining budget. On timeout the
 * operation is abandoned but its eventual rejection is swallowed so it can
 * never surface as an unhandled rejection later. A rejection that happens
 * before the deadline propagates to the caller unchanged.
 */
export async function awaitWithin<T>(
  promise: Promise<T>,
  deadline: Deadline,
): Promise<BoundedResult<T>> {
  const remaining = deadline.remainingMs();
  if (remaining === undefined) {
    return { timedOut: false, value: await promise };
  }

  swallowLateRejection(promise);
  if (remaining <= 0) {
    return { timedOut: true };
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then((value): BoundedResult<T> => ({ timedOut: false, value })),
      new Promise<BoundedResult<T>>((resolve) => {
        timer = setTimeout(() => {
          resolve({ timedOut: true });
        }, remaining);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/** Marks a promise as intentionally abandoned: late rejections are ignored. */
export function swallowLateRejection(promise: Promise<unknown>): void {
  void promise.catch(() => undefined);
}
