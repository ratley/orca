import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import { RunStore } from "../../../state/store.js";

type DraftModule = typeof import("./draft.js");
type PublishModule = typeof import("./publish.js");
type StatusModule = typeof import("./status.js");

let tempDir = "";
let store: RunStore;
let logs: string[] = [];
let errors: string[] = [];
const originalRunsDir = process.env.ORCA_RUNS_DIR;
const originalConsoleLog = console.log;
const originalConsoleError = console.error;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "orca-pr-test-"));
  store = new RunStore(tempDir);
  process.env.ORCA_RUNS_DIR = tempDir;
  process.exitCode = 0;
  logs = [];
  errors = [];

  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };

  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
});

afterEach(async () => {
  console.log = originalConsoleLog;
  console.error = originalConsoleError;

  if (originalRunsDir === undefined) {
    delete process.env.ORCA_RUNS_DIR;
  } else {
    process.env.ORCA_RUNS_DIR = originalRunsDir;
  }

  process.exitCode = 0;
  mock.restore();

  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

async function loadPrModules(options: {
  checkGhCli?: () => Promise<boolean>;
  runGh?: (args: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
}): Promise<{
  draftModule: DraftModule;
  publishModule: PublishModule;
  statusModule: StatusModule;
  checkGhCli: ReturnType<typeof mock>;
  runGh: ReturnType<typeof mock>;
}> {
  const checkGhCli = mock(options.checkGhCli ?? (async () => true));
  const runGh = mock(
    options.runGh ??
      (async () => ({
        stdout: "",
        stderr: "",
        exitCode: 0,
      })),
  );

  mock.module("../../../utils/gh.js", () => ({
    checkGhCli,
    runGh,
  }));

  const nonce = Math.random();
  const [draftModule, publishModule, statusModule] = await Promise.all([
    import(`./draft.js?test=${nonce}`),
    import(`./publish.js?test=${nonce}`),
    import(`./status.js?test=${nonce}`),
  ]);

  return { draftModule, publishModule, statusModule, checkGhCli, runGh };
}

describe("PR command handlers", () => {
  test("prDraftCommandHandler: gh not installed -> prints error and exits 1", async () => {
    const runId = "draft-gh-missing-1000-abcd";
    await store.createRun(runId, "/tmp/spec.md");

    const { draftModule, runGh } = await loadPrModules({
      checkGhCli: async () => false,
    });

    await draftModule.prDraftCommandHandler({ run: runId });

    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("gh CLI not found");
    expect(runGh).not.toHaveBeenCalled();
  });

  test("prDraftCommandHandler: run not found -> prints error and exits 1", async () => {
    const { draftModule } = await loadPrModules({});

    await draftModule.prDraftCommandHandler({ run: "missing-1000-abcd" });

    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("Run not found: missing-1000-abcd");
  });

  test("prDraftCommandHandler: success -> creates draft PR, updates run.pr.url, prints URL", async () => {
    const runId = "draft-success-1000-abcd";
    const prUrl = "https://github.com/acme/repo/pull/123";
    await store.createRun(runId, "/tmp/spec.md");

    const { draftModule, runGh } = await loadPrModules({
      runGh: async () => ({
        stdout: `creating PR\n${prUrl}\n`,
        stderr: "",
        exitCode: 0,
      }),
    });

    await draftModule.prDraftCommandHandler({ run: runId });

    expect(runGh).toHaveBeenCalledWith([
      "pr",
      "create",
      "--draft",
      "--title",
      "Orca run: spec.md",
      "--body",
      expect.any(String),
    ]);

    const updated = await store.getRun(runId);
    expect(updated?.pr?.url).toBe(prUrl);
    expect(logs.join("\n")).toContain(prUrl);
  });

  test("prPublishCommandHandler: no PR url in run -> prints guidance and exits 1", async () => {
    const runId = "publish-missing-pr-1000-abcd";
    await store.createRun(runId, "/tmp/spec.md");

    const { publishModule } = await loadPrModules({});

    await publishModule.prPublishCommandHandler({ run: runId });

    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("Use `orca pr draft` or `orca pr create` first.");
  });

  test("prStatusCommandHandler: no PR url -> prints error and exits 1", async () => {
    const runId = "status-missing-pr-1000-abcd";
    await store.createRun(runId, "/tmp/spec.md");

    const { statusModule } = await loadPrModules({});

    await statusModule.prStatusCommandHandler({ run: runId });

    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("No PR associated with this run.");
  });

  test("prStatusCommandHandler: gh JSON -> prints title/state/url/checks", async () => {
    const runId = "status-success-1000-abcd";
    const prUrl = "https://github.com/acme/repo/pull/456";
    await store.createRun(runId, "/tmp/spec.md");
    await store.updateRun(runId, {
      pr: {
        readyForFinalize: false,
        url: prUrl,
      },
    });

    const { statusModule } = await loadPrModules({
      runGh: async () => ({
        stdout: JSON.stringify({
          title: "Example PR",
          state: "OPEN",
          url: prUrl,
          statusCheckRollup: [
            { name: "ci/test", status: "COMPLETED", conclusion: "SUCCESS" },
            { context: "lint", state: "PENDING" },
          ],
        }),
        stderr: "",
        exitCode: 0,
      }),
    });

    await statusModule.prStatusCommandHandler({ run: runId });

    const output = logs.join("\n");
    expect(output).toContain("Title: Example PR");
    expect(output).toContain("State: OPEN");
    expect(output).toContain(`URL: ${prUrl}`);
    expect(output).toContain("- ci/test: COMPLETED/SUCCESS");
    expect(output).toContain("- lint: PENDING");
  });
});
