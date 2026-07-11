import type {
  AgentMessageDeltaNotification,
  CodexClient,
  ErrorNotification,
  ItemNotification,
  PlanDeltaNotification,
  PlanUpdatedNotification,
  RequestId,
  ServerRequestResolvedNotification,
  ThreadTokenUsageUpdatedNotification,
  ToolRequestUserInputParams,
  ToolRequestUserInputResponse,
  Turn,
  TurnCompletedNotification,
} from "@happycatlabs/codex-client";

import { AdapterError } from "../../lane/adapter.js";
import type { LaneStore } from "../../lane/store.js";
import type {
  BlockedInfo,
  Delivery,
  DispatchOutcome,
  LaneEventInput,
  UsageInfo,
} from "../../types/lane.js";
import { parseAnswerInput, toBlockedQuestions } from "./answers.js";
import { awaitWithin, DEFAULT_CLEANUP_GRACE_MS, startDeadline } from "./deadline.js";

export interface RunLaneTurnOptions {
  client: CodexClient;
  /**
   * Locked read of answer.txt paired with the lane's answerGeneration under
   * one lane lease; the CLI owns every lane status/session write. (The
   * store's readAnswerWithGeneration also deletes an already-consumed
   * leftover answer file under the same lock — finding 19.)
   */
  answerReader: Pick<LaneStore, "readAnswerWithGeneration">;
  laneId: string;
  threadId: string;
  prompt: string;
  /**
   * Remaining wall-clock budget for the turn, including parked-question
   * time. The adapter computes one absolute deadline at verb entry (finding
   * 16) and passes what is left of it after connect/thread setup.
   */
  timeoutMs?: number | undefined;
  /** Poll interval for parked-question answer.txt checks. */
  answerPollMs: number;
  /** Budget for the post-deadline turn/interrupt request (finding 16). */
  cleanupGraceMs?: number | undefined;
  /** Live-streaming hook; the owning CLI persists each event exactly once. */
  onEvent?: ((event: LaneEventInput) => void | Promise<void>) | undefined;
}

type TerminalCause =
  | { kind: "turn"; turn: Turn }
  | { kind: "timeout" }
  | { kind: "client_error"; error: Error }
  | { kind: "event_error"; error: AdapterError };

type StartCause =
  | { kind: "started"; turn: Turn }
  | { kind: "start_error"; error: unknown }
  | TerminalCause;

/**
 * Runs one codex turn against an already-bound thread and maps the app-server
 * protocol stream onto lane events and a DispatchOutcome. Pre-turn evidence
 * (agent_started with spawn-time process identity, the thread_bound progress
 * event) is the caller's responsibility and is emitted before this runs.
 *
 * Honesty rules: nativeStatus comes ONLY from the protocol turn status (or is
 * "unknown" when no terminal protocol evidence exists); semanticOutcome is
 * always "unknown" (no validator in v0); prose is never interpreted.
 *
 * Question parking (ported from the legacy codex session's answer.txt loop):
 * tool/requestUserInput emits a live question event, then polls
 * <lane>/answer.txt read-only. The CLI owns answer writes, event persistence,
 * and all lane status transitions.
 */
export async function runLaneTurn(options: RunLaneTurnOptions): Promise<DispatchOutcome> {
  const { client, answerReader, laneId, threadId, answerPollMs } = options;
  const cleanupGraceMs = options.cleanupGraceMs ?? DEFAULT_CLEANUP_GRACE_MS;
  const turnStartedAt = Date.now();

  let delivery: Delivery = "not_sent";
  let usage: UsageInfo | undefined;
  let currentBlocked: BlockedInfo | undefined;
  let currentQuestionData: Record<string, unknown> | undefined;
  let cancelled = false;
  const finalTextByItem = new Map<string, string>();
  const deltaTextByItem = new Map<string, string>();
  const resolvedRequests = new Set<string>();
  const parkings: Promise<void>[] = [];
  const wake = createWake();
  const events = new LaneEventChain(options.onEvent);

  let resolveTerminal: (cause: TerminalCause) => void = () => undefined;
  const terminal = new Promise<TerminalCause>((resolve) => {
    resolveTerminal = resolve;
  });

  const unpark = (): void => {
    currentBlocked = undefined;
    currentQuestionData = undefined;
  };

  const parkQuestion = async (
    request: ToolRequestUserInputParams & { requestId: RequestId },
  ): Promise<void> => {
    const requestKey = String(request.requestId);
    const questions = toBlockedQuestions(request.questions);
    let lastInvalidAnswer: string | undefined;

    currentBlocked = { questions };
    currentQuestionData = {
      requestId: requestKey,
      itemId: request.itemId,
      questions,
    };
    await events.record({
      event: "question",
      data: { ...currentQuestionData, live: true },
    });

    while (!cancelled) {
      if (resolvedRequests.has(requestKey)) {
        // The server resolved the request without us (e.g. autoResolutionMs).
        events.emit({
          event: "progress",
          data: { type: "question_resolved_externally", requestId: requestKey },
        });
        unpark();
        return;
      }

      // Answer-generation echo (finding 13, closed): the store reads
      // answer.txt AND the lane's answerGeneration under one lane lease, so
      // the echoed generation provably belongs to the text consumed — a
      // replacement landing mid-poll is observed whole (new text with its
      // new generation) or not at all.
      const pending = await answerReader.readAnswerWithGeneration(laneId);
      if (pending === null || pending.text === lastInvalidAnswer) {
        await wake.wait(answerPollMs);
        continue;
      }
      const { text: raw, generation } = pending;

      let response: ToolRequestUserInputResponse;
      try {
        response = parseAnswerInput(raw, request.questions);
      } catch (error) {
        events.emit({
          event: "progress",
          data: { type: "invalid_answer", requestId: requestKey, message: messageOf(error) },
        });
        // The adapter is read-only. Wait for the CLI/user to replace the
        // invalid payload instead of repeatedly reporting the same contents.
        lastInvalidAnswer = raw;
        continue;
      }

      client.respondToUserInputRequest(request.requestId, response);
      await events.record({
        event: "answered",
        data: {
          requestId: requestKey,
          answers: response.answers,
          generation,
        },
      });
      unpark();
      return;
    }
  };

  const onTurnCompleted = (notification: TurnCompletedNotification): void => {
    if (notification.threadId !== threadId) return;
    delivery = "confirmed";
    resolveTerminal({ kind: "turn", turn: notification.turn });
  };

  const onClientError = (error: Error): void => {
    resolveTerminal({ kind: "client_error", error });
  };

  const onItemCompleted = (notification: ItemNotification): void => {
    if (notification.threadId !== threadId) return;
    const item = notification.item;
    if (item.type === "agentMessage") {
      const text = (item as { text?: unknown }).text;
      if (typeof text === "string" && text.length > 0) {
        finalTextByItem.set(item.id, text);
      }
    }

    events.emit({
      event: "progress",
      data: { type: "item_completed", itemType: item.type, itemId: item.id },
    });
  };

  const onAgentDelta = (notification: AgentMessageDeltaNotification): void => {
    if (notification.threadId !== threadId) return;
    deltaTextByItem.set(
      notification.itemId,
      `${deltaTextByItem.get(notification.itemId) ?? ""}${notification.delta}`,
    );
    events.emit({
      event: "progress",
      data: { type: "agent_message_delta", itemId: notification.itemId, text: notification.delta },
    });
  };

  const onPlanDelta = (notification: PlanDeltaNotification): void => {
    if (notification.threadId !== threadId) return;
    events.emit({
      event: "progress",
      data: { type: "plan_delta", itemId: notification.itemId, text: notification.delta },
    });
  };

  const onPlanUpdated = (notification: PlanUpdatedNotification): void => {
    if (notification.threadId !== undefined && notification.threadId !== threadId) return;
    events.emit({ event: "progress", data: { type: "plan", plan: notification.plan } });
  };

  const onTurnError = (notification: ErrorNotification): void => {
    if (notification.threadId !== threadId) return;
    events.emit({
      event: "progress",
      data: {
        type: "turn_error",
        message: notification.error.message,
        willRetry: notification.willRetry,
      },
    });
  };

  const onTokenUsage = (notification: ThreadTokenUsageUpdatedNotification): void => {
    if (notification.threadId !== threadId) return;
    usage = {
      inputTokens: notification.tokenUsage.total.inputTokens,
      outputTokens: notification.tokenUsage.total.outputTokens,
    };
  };

  const onUserInput = (request: ToolRequestUserInputParams & { requestId: RequestId }): void => {
    if (request.threadId !== threadId) return;
    parkings.push(
      parkQuestion(request).catch((error: unknown) => {
        events.emit({
          event: "progress",
          data: { type: "question_parking_failed", message: messageOf(error) },
        });
      }),
    );
  };

  const onServerRequestResolved = (notification: ServerRequestResolvedNotification): void => {
    if (notification.threadId !== threadId) return;
    resolvedRequests.add(String(notification.requestId));
    wake.signal();
  };

  client.on("turn:completed:notification", onTurnCompleted);
  client.on("item:completed:notification", onItemCompleted);
  client.on("item:agentMessage:delta:notification", onAgentDelta);
  client.on("item:plan:delta", onPlanDelta);
  client.on("turn:plan:updated", onPlanUpdated);
  client.on("turn:error", onTurnError);
  client.on("thread:tokenUsage:updated", onTokenUsage);
  client.on("request:userInput", onUserInput);
  client.on("serverRequest:resolved", onServerRequestResolved);
  client.on("error", onClientError);

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let turnId: string | undefined;

  try {
    if (options.timeoutMs !== undefined) {
      timeoutHandle = setTimeout(() => {
        resolveTerminal({ kind: "timeout" });
      }, options.timeoutMs);
    }

    let startTurn: Promise<Turn>;
    try {
      startTurn = client.startTurn({
        threadId,
        input: [{ type: "text", text: options.prompt }],
      });
    } catch (error) {
      const message = messageOf(error);
      return {
        status: "failed",
        delivery: "not_sent",
        nativeStatus: "unknown",
        semanticOutcome: "unknown",
        code: "adapter_error",
        error: { message: `codex turn/start failed: ${message}` },
      };
    }

    // The request left the adapter but is not confirmed until turn/start
    // responds. Race the acknowledgement itself against the same wall-clock
    // deadline and event/client failures as the live turn.
    delivery = "unknown";
    const eventFailure = events
      .waitForFailure()
      .then<TerminalCause>((error) => ({ kind: "event_error", error }));
    const startCause = await Promise.race<StartCause>([
      startTurn.then(
        (turn): StartCause => ({ kind: "started", turn }),
        (error: unknown): StartCause => ({ kind: "start_error", error }),
      ),
      terminal,
      eventFailure,
    ]);

    let cause: TerminalCause;
    if (startCause.kind === "start_error") {
      return {
        status: "failed",
        delivery: "unknown",
        nativeStatus: "unknown",
        semanticOutcome: "unknown",
        code: "adapter_error",
        error: { message: `codex turn/start failed: ${messageOf(startCause.error)}` },
      };
    }
    if (startCause.kind === "started") {
      turnId = startCause.turn.id;
      delivery = "confirmed";
      cause = await Promise.race<TerminalCause>([terminal, eventFailure]);
    } else {
      cause = startCause;
      if (cause.kind === "turn") {
        // A matching terminal notification is stronger delivery evidence
        // than a delayed turn/start response.
        delivery = "confirmed";
        turnId = cause.turn.id;
      }
    }

    if (cause.kind === "event_error") {
      if (turnId !== undefined) {
        await interruptBounded(client, threadId, turnId, cleanupGraceMs);
      }
      throw cause.error;
    }

    if (cause.kind === "timeout") {
      if (currentBlocked !== undefined) {
        // Blocked is a successful outcome; leave the lane parked instead of
        // failing it. The per-lane app-server dies with this dispatch, so the
        // parked question must be re-asked via resume.
        // The latest question event tells the CLI that no dispatch process is
        // left polling answer.txt, so `next` can offer resume rather than wait.
        await events.record({
          event: "question",
          data: {
            ...(currentQuestionData ?? { questions: currentBlocked.questions }),
            live: false,
            delivery,
            nativeStatus: "unknown",
          },
        });
        return {
          status: "blocked",
          delivery,
          nativeStatus: "unknown",
          semanticOutcome: "unknown",
          blocked: currentBlocked,
          ...(usage !== undefined ? { usage } : {}),
        };
      }

      if (turnId !== undefined) {
        await interruptBounded(client, threadId, turnId, cleanupGraceMs);
      }

      return {
        status: "failed",
        delivery,
        nativeStatus: "unknown",
        semanticOutcome: "unknown",
        code: "timeout",
        error: {
          message:
            turnId === undefined
              ? `codex turn/start was not acknowledged within ${options.timeoutMs}ms`
              : `codex turn did not finish within ${options.timeoutMs}ms (interrupt requested)`,
          remediation: "Re-dispatch with a larger --timeout or resume the lane.",
        },
        ...(usage !== undefined ? { usage } : {}),
      };
    }

    if (cause.kind === "client_error") {
      return {
        status: "failed",
        delivery,
        nativeStatus: "unknown",
        semanticOutcome: "unknown",
        code: "adapter_error",
        error: { message: `codex app-server connection failed: ${cause.error.message}` },
        ...(usage !== undefined ? { usage } : {}),
      };
    }

    const turn = cause.turn;
    // Protocol-reported turn duration (Rule 6: apiMs appears only when the
    // agent's protocol actually reports it). The caller overwrites wallMs and
    // startupMs with its own harness-measured values but preserves apiMs.
    const timing = turnTiming(turn, turnStartedAt);
    if (turn.status === "completed") {
      const text = collectAgentMessage(turn, finalTextByItem, deltaTextByItem);
      return {
        status: "completed",
        delivery,
        nativeStatus: "completed",
        semanticOutcome: "unknown",
        result: { text },
        ...(usage !== undefined ? { usage } : {}),
        ...(timing !== undefined ? { timing } : {}),
      };
    }

    if (turn.status === "interrupted") {
      return {
        status: "killed",
        delivery,
        nativeStatus: "interrupted",
        semanticOutcome: "unknown",
        ...(usage !== undefined ? { usage } : {}),
        ...(timing !== undefined ? { timing } : {}),
      };
    }

    // "failed" — and any unexpected terminal status maps to failure, never success.
    const message = turn.error?.message ?? `codex turn ended with status "${turn.status}"`;
    return {
      status: "failed",
      delivery,
      nativeStatus: turn.status === "failed" ? "failed" : "unknown",
      semanticOutcome: "unknown",
      code: "agent_failed",
      error: { message },
      ...(usage !== undefined ? { usage } : {}),
      ...(timing !== undefined ? { timing } : {}),
    };
  } finally {
    cancelled = true;
    wake.signal();
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
    }

    client.off("turn:completed:notification", onTurnCompleted);
    client.off("item:completed:notification", onItemCompleted);
    client.off("item:agentMessage:delta:notification", onAgentDelta);
    client.off("item:plan:delta", onPlanDelta);
    client.off("turn:plan:updated", onPlanUpdated);
    client.off("turn:error", onTurnError);
    client.off("thread:tokenUsage:updated", onTokenUsage);
    client.off("request:userInput", onUserInput);
    client.off("serverRequest:resolved", onServerRequestResolved);
    client.off("error", onClientError);

    await Promise.allSettled(parkings);
    await events.flush();
  }
}

/**
 * Serializes event-hook delivery in emission order. The adapter never writes
 * the lane store; its owning CLI persists each hook invocation exactly once.
 */
class LaneEventChain {
  private chain: Promise<void> = Promise.resolve();
  private firstError: AdapterError | undefined;
  private readonly failure: Promise<AdapterError>;
  private readonly resolveFailure: (error: AdapterError) => void;

  constructor(private readonly hook?: (event: LaneEventInput) => void | Promise<void>) {
    let resolveFailure: (error: AdapterError) => void = () => undefined;
    this.failure = new Promise<AdapterError>((resolve) => {
      resolveFailure = resolve;
    });
    this.resolveFailure = resolveFailure;
  }

  emit(event: LaneEventInput): void {
    void this.enqueue(event).catch(() => undefined);
  }

  /** Like emit, but resolves once this event has reached the hook. */
  record(event: LaneEventInput): Promise<void> {
    return this.enqueue(event);
  }

  waitForFailure(): Promise<AdapterError> {
    return this.failure;
  }

  private enqueue(event: LaneEventInput): Promise<void> {
    const delivery = this.chain.then(async () => {
      if (this.firstError !== undefined) {
        throw this.firstError;
      }
      if (this.hook === undefined) {
        return;
      }

      try {
        await this.hook(event);
      } catch (cause) {
        throw this.captureFailure(event, cause);
      }
    });

    // Keep the serialization chain usable so already-enqueued deliveries can
    // observe firstError and suppress themselves without unhandled rejection.
    this.chain = delivery.catch(() => undefined);
    return delivery;
  }

  async flush(): Promise<void> {
    await this.chain;
    if (this.firstError !== undefined) {
      throw this.firstError;
    }
  }

  private captureFailure(event: LaneEventInput, cause: unknown): AdapterError {
    if (this.firstError !== undefined) {
      return this.firstError;
    }

    const error = new AdapterError(
      "adapter_error",
      `codex lane event hook failed for "${event.event}": ${messageOf(cause)}`,
      { cause },
    );
    this.firstError = error;
    this.resolveFailure(error);
    return error;
  }
}

/**
 * Best-effort turn/interrupt with its own small budget (finding 16): the
 * lane deadline is already exhausted when this runs, and an unresponsive
 * server must not be able to hold the outcome hostage via its interrupt ack.
 */
async function interruptBounded(
  client: CodexClient,
  threadId: string,
  turnId: string,
  graceMs: number,
): Promise<void> {
  await awaitWithin(
    client.interruptTurn(threadId, turnId).catch(() => undefined),
    startDeadline(graceMs),
  );
}

/**
 * Timing evidence from a terminal protocol turn: turn.durationMs is the
 * app-server's own report of how long the turn took, mapped onto
 * timing.apiMs. wallMs here is the turn-runner's local measurement and is a
 * placeholder only — the adapter overwrites it with the verb-level wall
 * clock. Returns undefined (no timing claim at all) when the protocol did
 * not report a usable duration; apiMs is never fabricated.
 */
function turnTiming(
  turn: Turn,
  turnStartedAt: number,
): { wallMs: number; apiMs: number } | undefined {
  const durationMs = turn.durationMs;
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) {
    return undefined;
  }

  return { wallMs: Date.now() - turnStartedAt, apiMs: durationMs };
}

/** Sleep that can be interrupted early by signal() (used for cancellation). */
function createWake(): { wait(ms: number): Promise<void>; signal(): void } {
  let waiters: (() => void)[] = [];
  return {
    wait(ms: number): Promise<void> {
      return new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          resolve();
        }, ms);
        waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
    signal(): void {
      const current = waiters;
      waiters = [];
      for (const waiter of current) {
        waiter();
      }
    },
  };
}

/**
 * Final agent message for the result payload: prefers the last completed
 * agentMessage item, then agentMessage items on the terminal turn, then the
 * concatenated streamed deltas.
 */
function collectAgentMessage(
  turn: Turn,
  finalTextByItem: Map<string, string>,
  deltaTextByItem: Map<string, string>,
): string {
  let last = "";
  for (const text of finalTextByItem.values()) {
    last = text;
  }

  if (last.length > 0) {
    return last;
  }

  for (const item of turn.items) {
    if (item.type === "agentMessage") {
      const text = (item as { text?: unknown }).text;
      if (typeof text === "string" && text.length > 0) {
        last = text;
      }
    }
  }

  if (last.length > 0) {
    return last;
  }

  return [...deltaTextByItem.values()].join("");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
