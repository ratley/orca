import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type FlowsModule = typeof import("./flows.js");

let logs: string[] = [];
let tempDir: string;
const originalConsoleLog = console.log;

async function loadFlowsModule(): Promise<FlowsModule> {
  return import(`./flows.js?test=${Math.random()}`);
}

async function writeConfig(contents: string): Promise<string> {
  const configPath = path.join(tempDir, `orca-${Math.random().toString(16).slice(2)}.config.js`);
  await writeFile(configPath, contents, "utf8");
  return configPath;
}

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "orca-flows-command-test-"));
  logs = [];
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
});

afterEach(async () => {
  console.log = originalConsoleLog;
  await rm(tempDir, { recursive: true, force: true });
});

describe("flows command", () => {
  test("prints 'No flows configured.' when config has no presets", async () => {
    const flowsModule = await loadFlowsModule();
    const configPath = await writeConfig("export default { executor: 'codex' };\n");

    await flowsModule.flowsCommandHandler({ config: configPath });

    expect(logs).toEqual(["No flows configured."]);
  });

  test("prints table for configured flows", async () => {
    const flowsModule = await loadFlowsModule();
    const configPath = await writeConfig([
      "export default {",
      "  flow: {",
      "    default: 'orchestrate',",
      "    presets: {",
      "      orchestrate: { description: 'Coordinate slices' },",
      "      review: { description: 'Review only' }",
      "    }",
      "  }",
      "};",
      "",
    ].join("\n"));

    await flowsModule.flowsCommandHandler({ config: configPath });

    expect(logs).toHaveLength(1);
    const output = logs[0] ?? "";
    expect(output).toContain("Name");
    expect(output).toContain("Default");
    expect(output).toContain("Agents");
    expect(output).toContain("Review");
    expect(output).toContain("Validators");
    expect(output).toContain("Description");
    expect(output).toMatch(/orchestrate\s+yes\s+1\s+plan:fail task:auto_fix final:auto_fix\s+auto\s+Coordinate slices/);
    expect(output).toMatch(/review\s+1\s+plan:fail task:auto_fix final:auto_fix\s+auto\s+Review only/);
  });

  test("prints JSON for configured flows", async () => {
    const flowsModule = await loadFlowsModule();
    const configPath = await writeConfig([
      "export default {",
      "  flow: {",
      "    default: 'review',",
      "    presets: {",
      "      review: { description: 'Review only' }",
      "    }",
      "  }",
      "};",
      "",
    ].join("\n"));

    await flowsModule.flowsCommandHandler({ config: configPath, json: true });

    expect(JSON.parse(logs[0] ?? "")).toEqual([
      {
        name: "review",
        default: true,
        description: "Review only",
        usage: {
          run: 'orca --flow review "<task>"',
          spec: "orca --flow review --spec <path>",
          plan: "orca plan --spec <path> --flow review",
        },
        effects: {
          agents: {
            multiAgent: false,
            maxParallelTasks: 1,
          },
          skills: [],
          planReview: {
            enabled: true,
            onInvalid: "fail",
          },
          taskReview: {
            enabled: true,
            maxCycles: 2,
            onFindings: "auto_fix",
          },
          executionReview: {
            enabled: true,
            maxCycles: 2,
            onFindings: "auto_fix",
            validators: "auto",
          },
        },
        flow: { description: "Review only" },
      },
    ]);
  });

  test("uses the --config option to choose flow config", async () => {
    const flowsModule = await loadFlowsModule();
    const configPath = await writeConfig([
      "export default {",
      "  flow: { presets: { custom: { description: 'Custom flow' } } }",
      "};",
      "",
    ].join("\n"));

    await flowsModule.flowsCommandHandler({ config: configPath });

    expect(logs[0]).toContain("custom");
    expect(logs[0]).toContain("Custom flow");
  });
});
