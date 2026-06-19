import { mergeConfigs } from "./config-loader.js";
import { getExecutionReviewConfig, getTaskReviewConfig, type FindingsMode } from "./review-cycle.js";
import type { OrcaConfig, OrcaFlowConfig } from "../types/index.js";

export interface FlowPresetUsage {
  run: string;
  spec: string;
  plan: string;
}

export interface FlowPresetEffects {
  agents: {
    multiAgent: boolean;
    maxParallelTasks: number;
  };
  skills: string[];
  planReview: {
    enabled: boolean;
    onInvalid: "fail" | "warn_skip";
  };
  taskReview: {
    enabled: boolean;
    maxCycles: number;
    onFindings: FindingsMode;
  };
  executionReview: {
    enabled: boolean;
    maxCycles: number;
    onFindings: FindingsMode;
    validators: "auto" | "configured" | "disabled";
    commands?: string[];
  };
}

export interface FlowPresetSummary {
  name: string;
  default: boolean;
  description?: string;
  usage: FlowPresetUsage;
  effects: FlowPresetEffects;
  flow: OrcaFlowConfig;
}

export interface ResolvedFlowConfig {
  name?: string;
  flow?: OrcaFlowConfig;
  config?: OrcaConfig;
}

export type FlowInstructionStage = "planning" | "execution" | "summary";

function buildFlowUsage(name: string): FlowPresetUsage {
  const flowName = shellQuote(name);
  return {
    run: `orca --flow ${flowName} "<task>"`,
    spec: `orca --flow ${flowName} --spec <path>`,
    plan: `orca plan --spec <path> --flow ${flowName}`
  };
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9._:/-]+$/.test(value)) {
    return value;
  }

  return `'${value.replaceAll("'", "'\\''")}'`;
}

function getPlanReviewSummary(config?: OrcaConfig): FlowPresetEffects["planReview"] {
  const review = (config?.review ?? {}) as OrcaConfig["review"] & { enabled?: boolean };
  return {
    enabled: review.plan?.enabled ?? review.enabled ?? true,
    onInvalid: review.plan?.onInvalid ?? review.onInvalid ?? "fail"
  };
}

function getValidatorSummary(
  executionReview: ReturnType<typeof getExecutionReviewConfig>
): Pick<FlowPresetEffects["executionReview"], "validators" | "commands"> {
  if (!executionReview.enabled) {
    return { validators: "disabled" };
  }

  const commands = executionReview.validatorCommands?.filter((command) => command.trim().length > 0);
  if (commands !== undefined && commands.length > 0) {
    return { validators: "configured", commands };
  }

  return { validators: executionReview.validatorAuto ? "auto" : "disabled" };
}

function getFlowEffects(config?: OrcaConfig): FlowPresetEffects {
  const multiAgent = config?.codex?.multiAgent === true;
  const taskReview = getTaskReviewConfig(config);
  const executionReview = getExecutionReviewConfig(config, {});
  const validatorSummary = getValidatorSummary(executionReview);

  return {
    agents: {
      multiAgent,
      maxParallelTasks: multiAgent ? config?.codex?.maxParallelTasks ?? 4 : 1
    },
    skills: config?.skills ?? [],
    planReview: getPlanReviewSummary(config),
    taskReview: {
      enabled: taskReview.enabled,
      maxCycles: taskReview.maxCycles,
      onFindings: taskReview.onFindings
    },
    executionReview: {
      enabled: executionReview.enabled,
      maxCycles: executionReview.maxCycles,
      onFindings: executionReview.onFindings,
      ...validatorSummary
    }
  };
}

export function listFlowPresets(config?: OrcaConfig): FlowPresetSummary[] {
  const presets = config?.flow?.presets ?? {};
  const defaultFlow = config?.flow?.default;

  return Object.entries(presets).map(([name, flow]) => {
    const selected = resolveSelectedFlowConfig(config, name);
    return {
      name,
      default: name === defaultFlow,
      ...(flow.description !== undefined ? { description: flow.description } : {}),
      usage: buildFlowUsage(name),
      effects: getFlowEffects(selected.config),
      flow
    };
  });
}

function formatFlowNames(config?: OrcaConfig): string {
  const names = Object.keys(config?.flow?.presets ?? {});
  if (names.length === 0) {
    return "No flow presets are configured.";
  }

  return `Available flows: ${names.join(", ")}.`;
}

function flowToConfig(flow: OrcaFlowConfig): OrcaConfig | undefined {
  const configs: OrcaConfig[] = [];

  if (flow.baseline?.skills !== undefined) {
    configs.push({ skills: flow.baseline.skills });
  }

  if (flow.planning?.review !== undefined) {
    configs.push({ review: { plan: flow.planning.review } });
  }

  if (flow.execution?.codex !== undefined || flow.execution?.review !== undefined) {
    configs.push({
      ...(flow.execution.codex !== undefined ? { codex: flow.execution.codex } : {}),
      ...(flow.execution.review !== undefined ? { review: { task: flow.execution.review } } : {})
    });
  }

  if (flow.review !== undefined) {
    configs.push({ review: flow.review });
  }

  if (flow.overrides !== undefined) {
    configs.push(flow.overrides);
  }

  return mergeConfigs(...configs);
}

function normalizePrompt(prompt: string | undefined): string | undefined {
  const trimmed = prompt?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function getStagePrompt(flow: OrcaFlowConfig, stage: FlowInstructionStage): string | undefined {
  if (stage === "planning") {
    return normalizePrompt(flow.planning?.prompt);
  }

  if (stage === "execution") {
    return normalizePrompt(flow.execution?.prompt);
  }

  return normalizePrompt(flow.summary?.prompt);
}

function formatInstructionBlock(label: string, prompt: string): string {
  return [`### ${label}`, "", prompt].join("\n");
}

function getStageInstructionLabel(stage: FlowInstructionStage): string {
  switch (stage) {
    case "planning":
      return "Planning Instructions";
    case "execution":
      return "Execution Instructions";
    case "summary":
      return "Summary Instructions";
  }
}

export function formatFlowInstructions(
  resolved: ResolvedFlowConfig,
  stage: FlowInstructionStage
): string | undefined {
  if (resolved.name === undefined || resolved.flow === undefined) {
    return undefined;
  }

  const description = normalizePrompt(resolved.flow.description);
  const baselinePrompt = normalizePrompt(resolved.flow.baseline?.prompt);
  const stagePrompt = getStagePrompt(resolved.flow, stage);

  if (description === undefined && baselinePrompt === undefined && stagePrompt === undefined) {
    return undefined;
  }

  const parts = ["## Orca Flow", "", `Selected flow: ${resolved.name}`];

  if (description !== undefined) {
    parts.push("", description);
  }

  if (baselinePrompt !== undefined) {
    parts.push("", formatInstructionBlock("Baseline Instructions", baselinePrompt));
  }

  if (stagePrompt !== undefined) {
    parts.push("", formatInstructionBlock(getStageInstructionLabel(stage), stagePrompt));
  }

  return parts.join("\n");
}

export function resolveSelectedFlowConfig(
  config: OrcaConfig | undefined,
  flowName?: string
): ResolvedFlowConfig {
  const selectedName = flowName ?? config?.flow?.default;
  if (selectedName === undefined) {
    return config === undefined ? {} : { config };
  }

  const flow = config?.flow?.presets?.[selectedName];
  if (flow === undefined) {
    throw new Error(`Unknown flow preset "${selectedName}". ${formatFlowNames(config)}`);
  }

  const flowConfig = flowToConfig(flow);
  const resolvedConfig = mergeConfigs(config, flowConfig);

  return {
    name: selectedName,
    flow,
    ...(resolvedConfig !== undefined ? { config: resolvedConfig } : {})
  };
}
