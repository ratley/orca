import { describe, expect, test } from "bun:test";

import { formatFlowInstructions, listFlowPresets, resolveSelectedFlowConfig } from "./flow-config.js";
import type { OrcaConfig } from "../types/index.js";

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
        flow: { description: "Review focused" },
      },
      {
        name: "orchestrate",
        default: false,
        description: "Coordinate slices",
        flow: { description: "Coordinate slices" },
      },
    ]);
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
