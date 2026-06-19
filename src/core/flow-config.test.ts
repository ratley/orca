import { describe, expect, test } from "bun:test";

import { formatFlowInstructions, listFlowPresets, resolveSelectedFlowConfig } from "./flow-config.js";
import type { OrcaConfig } from "../types/index.js";

const defaultFlowEffects = {
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
} as const;

describe("flow-config", () => {
  test("returns the original config when no flow is selected", () => {
    const config: OrcaConfig = { executor: "codex" };

    expect(resolveSelectedFlowConfig(config)).toEqual({ config });
  });

  test("lists configured flow presets with default marker", () => {
    const config: OrcaConfig = {
      flow: {
        default: "review",
        presets: {
          review: { description: "Review focused" },
          orchestrate: { description: "Coordinate slices" },
        },
      },
    };

    expect(listFlowPresets(config)).toEqual([
      {
        name: "review",
        default: true,
        description: "Review focused",
        usage: {
          run: 'orca --flow review "<task>"',
          spec: "orca --flow review --spec <path>",
          plan: "orca plan --spec <path> --flow review",
        },
        effects: defaultFlowEffects,
        flow: { description: "Review focused" },
      },
      {
        name: "orchestrate",
        default: false,
        description: "Coordinate slices",
        usage: {
          run: 'orca --flow orchestrate "<task>"',
          spec: "orca --flow orchestrate --spec <path>",
          plan: "orca plan --spec <path> --flow orchestrate",
        },
        effects: defaultFlowEffects,
        flow: { description: "Coordinate slices" },
      },
    ]);
  });

  test("lists resolved effects for agents choosing a flow", () => {
    const config: OrcaConfig = {
      skills: ["base-skill"],
      review: {
        task: { onFindings: "fail" },
        execution: { validator: { commands: ["npm test"] } },
      },
      flow: {
        default: "linear-ticket",
        presets: {
          "linear-ticket": {
            baseline: { skills: ["ticket-skill"] },
            planning: { review: { enabled: true, onInvalid: "warn_skip" } },
            execution: {
              codex: { multiAgent: true, maxParallelTasks: 3 },
              review: { maxCycles: 3, onFindings: "auto_fix" },
            },
            review: {
              execution: {
                enabled: true,
                maxCycles: 4,
                onFindings: "report_only",
              },
            },
          },
        },
      },
    };

    expect(listFlowPresets(config)[0]?.effects).toEqual({
      agents: {
        multiAgent: true,
        maxParallelTasks: 3,
      },
      skills: ["base-skill", "ticket-skill"],
      planReview: {
        enabled: true,
        onInvalid: "warn_skip",
      },
      taskReview: {
        enabled: true,
        maxCycles: 3,
        onFindings: "auto_fix",
      },
      executionReview: {
        enabled: true,
        maxCycles: 4,
        onFindings: "report_only",
        validators: "configured",
        commands: ["npm test"],
      },
    });
  });

  test("quotes flow names in generated usage commands when needed", () => {
    const config: OrcaConfig = {
      flow: {
        presets: {
          "review cycle": { description: "Review with a spaced name" },
        },
      },
    };

    expect(listFlowPresets(config)[0]?.usage).toEqual({
      run: 'orca --flow \'review cycle\' "<task>"',
      spec: "orca --flow 'review cycle' --spec <path>",
      plan: "orca plan --spec <path> --flow 'review cycle'",
    });
  });

  test("selects default flow and applies config-like sections", () => {
    const config: OrcaConfig = {
      skills: ["base-skill"],
      codex: { model: "gpt-base" },
      review: { execution: { maxCycles: 2 } },
      flow: {
        default: "orchestrate",
        presets: {
          orchestrate: {
            baseline: { skills: ["orchestrate-skill"] },
            planning: { review: { enabled: true } },
            execution: {
              codex: { maxParallelTasks: 3 },
              review: { onFindings: "report_only" },
            },
            review: {
              execution: { validator: { auto: false } },
            },
            overrides: {
              skills: ["override-skill"],
              codex: { effort: "high" },
            },
          },
        },
      },
    };

    const selected = resolveSelectedFlowConfig(config);

    expect(selected.name).toBe("orchestrate");
    expect(selected.config?.skills).toEqual([
      "base-skill",
      "orchestrate-skill",
      "override-skill",
    ]);
    expect(selected.config?.codex).toEqual({
      model: "gpt-base",
      maxParallelTasks: 3,
      effort: "high",
    });
    expect(selected.config?.review?.plan?.enabled).toBe(true);
    expect(selected.config?.review?.task?.onFindings).toBe("report_only");
    expect(selected.config?.review?.execution?.validator?.auto).toBe(false);
  });

  test("throws for unknown selected flow", () => {
    const config: OrcaConfig = {
      flow: {
        presets: {
          review: { description: "Review focused" },
        },
      },
    };

    expect(() => resolveSelectedFlowConfig(config, "missing")).toThrow(
      'Unknown flow preset "missing". Available flows: review.'
    );
  });

  test("formats selected flow instructions for a runtime stage", () => {
    const config: OrcaConfig = {
      flow: {
        default: "custom-review",
        presets: {
          "custom-review": {
            description: "Project-specific review loop",
            baseline: { prompt: "Always inspect uncommitted changes first." },
            planning: { prompt: "Split review and repair into separate tasks." },
            execution: { prompt: "Run the local review command before finishing." },
            summary: { prompt: "Report files changed and validation results." },
          },
        },
      },
    };

    const selected = resolveSelectedFlowConfig(config);

    expect(formatFlowInstructions(selected, "planning")).toContain("Selected flow: custom-review");
    expect(formatFlowInstructions(selected, "planning")).toContain("Always inspect uncommitted changes first.");
    expect(formatFlowInstructions(selected, "planning")).toContain("Split review and repair into separate tasks.");
    expect(formatFlowInstructions(selected, "planning")).not.toContain("Run the local review command before finishing.");
    expect(formatFlowInstructions(selected, "execution")).toContain("Run the local review command before finishing.");
    expect(formatFlowInstructions(selected, "summary")).toContain("Report files changed and validation results.");
    expect(formatFlowInstructions(selected, "summary")).not.toContain("Split review and repair into separate tasks.");
  });
});
