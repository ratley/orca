import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";

import { RunStore } from "../../state/store.js";

type AnswerModule = typeof import("./answer.js");

let tempDir = "";
let runsDir = "";
let logs: string[] = [];
let errors: string[] = [];
const originalRunsDir = process.env.ORCA_RUNS_DIR;
const originalHome = process.env.HOME;
const originalConsoleLog = console.log;
const originalConsoleError = console.error;
const originalStdoutIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

function setStdoutTty(value: boolean): void {
  Object.defineProperty(process.stdout, "isTTY", {
    configurable: true,
    value,
  });
}

async function loadAnswerModule(options?: {
  input?: () => Promise<string>;
  select?: () => Promise<string>;
  password?: () => Promise<string>;
}): Promise<{
  answerModule: AnswerModule;
  inputMock: ReturnType<typeof mock>;
  selectMock: ReturnType<typeof mock>;
  passwordMock: ReturnType<typeof mock>;
}> {
  const inputMock = mock(options?.input ?? (async () => "prompt answer"));
  const selectMock = mock(options?.select ?? (async () => "selected-run-1000-abcd"));
  const passwordMock = mock(options?.password ?? (async () => "prompt secret"));

  mock.module("@inquirer/prompts", () => ({
    input: inputMock,
    password: passwordMock,
    select: selectMock,
  }));

  const answerModule = await import(`./answer.js?test=${Math.random()}`);
  return { answerModule, inputMock, selectMock, passwordMock };
}

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "orca-answer-test-"));
  runsDir = path.join(tempDir, "runs");
  process.env.ORCA_RUNS_DIR = runsDir;
  process.env.HOME = tempDir;
  process.exitCode = 0;
  logs = [];
  errors = [];
  setStdoutTty(false);

  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };

  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
});

afterEach(async () => {
  mock.restore();
  console.log = originalConsoleLog;
  console.error = originalConsoleError;

  if (originalRunsDir === undefined) {
    delete process.env.ORCA_RUNS_DIR;
  } else {
    process.env.ORCA_RUNS_DIR = originalRunsDir;
  }

  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }

  if (originalStdoutIsTTY) {
    Object.defineProperty(process.stdout, "isTTY", originalStdoutIsTTY);
  }

  process.exitCode = 0;
  await rm(tempDir, { recursive: true, force: true });
});

describe("answer command", () => {
  test("submits positional answer for a single pending question", async () => {
    const runId = "answer-positional-1000-abcd";
    const store = new RunStore(runsDir);
    await store.createRun(runId, "/tmp/spec.md");
    await store.updateRun(runId, {
      overallStatus: "waiting_for_answer",
      pendingQuestion: {
        requestId: "req-1",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        receivedAt: new Date().toISOString(),
        questions: [
          {
            header: "Migration",
            id: "migration",
            question: "Which migration should I use?",
            isOther: true,
            isSecret: false,
            options: [{ label: "A", description: "Use migration A" }],
          },
        ],
      },
    });

    const { answerModule } = await loadAnswerModule();
    await answerModule.answerCommandHandler(runId, "yes", {});

    const run = await store.getRun(runId);
    expect(run?.overallStatus).toBe("waiting_for_answer");

    const answerPath = path.join(runsDir, runId, "answer.txt");
    const payload = await readFile(answerPath, "utf8");
    expect(payload).toContain('"migration"');
    expect(payload).toContain('"yes"');
    expect(logs.join("\n")).toContain(`Answer submitted. Run ${runId} will resume shortly.`);
  });

  test("fails when run is not waiting_for_answer", async () => {
    const runId = "answer-wrong-status-1000-abcd";
    const store = new RunStore(runsDir);
    await store.createRun(runId, "/tmp/spec.md");
    await store.updateRun(runId, { overallStatus: "running" });

    const { answerModule } = await loadAnswerModule();

    await answerModule.answerCommandHandler(runId, "yes", {});
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain(`is not waiting for an answer`);
  });

  test("fails when no answer is provided in non-tty mode", async () => {
    const runId = "answer-no-input-1000-abcd";
    const store = new RunStore(runsDir);
    await store.createRun(runId, "/tmp/spec.md");
    await store.updateRun(runId, {
      overallStatus: "waiting_for_answer",
      pendingQuestion: {
        requestId: "req-1",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        receivedAt: new Date().toISOString(),
        questions: [
          {
            header: "Migration",
            id: "migration",
            question: "Which migration should I use?",
            isOther: true,
            isSecret: false,
            options: null,
          },
        ],
      },
    });

    const { answerModule } = await loadAnswerModule();

    await expect(answerModule.answerCommandHandler(runId, undefined, {})).rejects.toThrow("no answer provided");
  });

  test("prompts for answer when tty and no positional answer was provided", async () => {
    const runId = "answer-prompt-1000-abcd";
    const store = new RunStore(runsDir);
    await store.createRun(runId, "/tmp/spec.md");
    await store.updateRun(runId, {
      overallStatus: "waiting_for_answer",
      pendingQuestion: {
        requestId: "req-1",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        receivedAt: new Date().toISOString(),
        questions: [
          {
            header: "Migration",
            id: "migration",
            question: "Which migration should I use?",
            isOther: true,
            isSecret: false,
            options: [{ label: "A", description: "Use migration A" }],
          },
        ],
      },
    });
    setStdoutTty(true);

    const { answerModule, inputMock } = await loadAnswerModule({
      input: async () => "from prompt",
    });

    await answerModule.answerCommandHandler(runId, undefined, {});

    expect(inputMock).toHaveBeenCalled();
    const answerPath = path.join(runsDir, runId, "answer.txt");
    const payload = await readFile(answerPath, "utf8");
    expect(payload).toContain('"migration"');
    expect(payload).toContain('"from prompt"');
  });

  test("uses interactive run selection when no run id is provided in tty mode", async () => {
    const runId = "selected-run-1000-abcd";
    const store = new RunStore(runsDir);
    await store.createRun(runId, "/tmp/spec.md");
    await store.updateRun(runId, {
      overallStatus: "waiting_for_answer",
      pendingQuestion: {
        requestId: "req-1",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        receivedAt: new Date().toISOString(),
        questions: [
          {
            header: "Migration",
            id: "migration",
            question: "Which migration should I use?",
            isOther: true,
            isSecret: false,
            options: null,
          },
        ],
      },
    });
    setStdoutTty(true);

    const { answerModule, selectMock } = await loadAnswerModule({
      select: async () => runId,
    });

    await answerModule.answerCommandHandler(undefined, "selected answer", {});

    expect(selectMock).toHaveBeenCalled();
    const answerPath = path.join(runsDir, runId, "answer.txt");
    const payload = await readFile(answerPath, "utf8");
    expect(payload).toContain('"selected answer"');
  });

  test("requires JSON mapping when multiple pending questions are answered non-interactively", async () => {
    const runId = "answer-multi-1000-abcd";
    const store = new RunStore(runsDir);
    await store.createRun(runId, "/tmp/spec.md");
    await store.updateRun(runId, {
      overallStatus: "waiting_for_answer",
      pendingQuestion: {
        requestId: "req-1",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        receivedAt: new Date().toISOString(),
        questions: [
          {
            header: "Backend",
            id: "backend",
            question: "Which backend?",
            isOther: true,
            isSecret: false,
            options: null,
          },
          {
            header: "Frontend",
            id: "frontend",
            question: "Which frontend?",
            isOther: true,
            isSecret: false,
            options: null,
          },
        ],
      },
    });

    const { answerModule } = await loadAnswerModule();
    await expect(answerModule.answerCommandHandler(runId, "just one answer", {})).rejects.toThrow(
      "multiple pending questions require a JSON object mapping question ids to answers",
    );
  });

  test("uses password prompt and direct answer channel for secret questions", async () => {
    const runId = "answer-secret-1000-abcd";
    const submissions: string[] = [];
    const { writeSecretAnswerChannel } = await import("../../core/secret-answer-channel.js");

    const store = new RunStore(runsDir);
    await store.createRun(runId, "/tmp/spec.md");
    await store.updateRun(runId, {
      overallStatus: "waiting_for_answer",
      pendingQuestion: {
        requestId: "req-1",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        receivedAt: new Date().toISOString(),
        questions: [
          {
            header: "API Key",
            id: "api_key",
            question: "What API key should I use?",
            isOther: true,
            isSecret: true,
            options: null,
          },
        ],
      },
    });
    await writeSecretAnswerChannel(runId as `${string}-${number}-${string}`, {
      transport: "ipc",
      path: path.join(tempDir, "secret-answer.sock"),
      token: "secret-token",
    });
    setStdoutTty(true);

    const { answerModule, passwordMock, inputMock } = await loadAnswerModule({
      password: async () => "super-secret",
    });
    answerModule.setAnswerChannelSubmitterForTests(async (channel, payload) => {
      submissions.push(JSON.stringify({ channel, payload }));
    });

    await answerModule.answerCommandHandler(runId, undefined, {});

    expect(passwordMock).toHaveBeenCalled();
    expect(inputMock).not.toHaveBeenCalled();
    expect(submissions).toHaveLength(1);
    expect(submissions[0]).toContain('"token":"secret-token"');
    expect(submissions[0]).toContain('\\"super-secret\\"');

    const answerPath = path.join(runsDir, runId, "answer.txt");
    await expect(readFile(answerPath, "utf8")).rejects.toThrow();
  });

  test("fails when positional run-id and --run are both provided", async () => {
    const { answerModule } = await loadAnswerModule();

    await expect(
      answerModule.answerCommandHandler("run-a-1000-abcd", "yes", { run: "run-b-1001-abcd" }),
    ).rejects.toThrow("positional run-id and --run are mutually exclusive");
  });
});
