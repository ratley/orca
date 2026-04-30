import { OrcaConfigSchema, customModel, defineOrcaConfig } from "./index.js";

defineOrcaConfig({
  planner: {
    agent: "auto",
    router: {
      model: "gpt-5.3-codex-spark",
    },
  },
  claude: {
    command: "claude",
    model: "claude-opus-4-7",
    effort: "high",
    timeoutMs: 300000,
  },
  hooks: {
    onQuestion: async (event) => {
      const questionId: string = event.questions[0]?.id ?? "";
      void questionId;
    },
    onTaskComplete: async (event, context) => {
      const taskId: string = event.taskId;
      const taskName: string = event.taskName;
      const pid: number = context.pid;
      void taskId;
      void taskName;
      void pid;
    },
    onError: async (event) => {
      const errorMessage: string = event.error;
      void errorMessage;
    },
  },
});

const parsedConfig = OrcaConfigSchema.parse({
  planner: {
    agent: "auto",
    router: { model: "gpt-5.3-codex-spark" },
  },
});

defineOrcaConfig(parsedConfig);

defineOrcaConfig({
  planner: {
    agent: "claude",
  },
});

defineOrcaConfig({
  planner: {
    agent: "codex",
  },
});

defineOrcaConfig({
  planner: {
    agent: "claude",
    // @ts-expect-error router is only valid when planner.agent is auto
    router: {
      model: "gpt-5.3-codex-spark",
    },
  },
});

defineOrcaConfig({
  codex: {
    model: customModel("private-openai-model"),
  },
  claude: {
    model: customModel("private-claude-model"),
  },
});

defineOrcaConfig({
  codex: {
    // @ts-expect-error unknown OpenAI models must use customModel()
    model: "private-openai-model",
  },
});

defineOrcaConfig({
  hooks: {
    // @ts-expect-error unknown hook key should be rejected by types
    onMystery: async () => {},
  },
});

defineOrcaConfig({
  hooks: {
    onMilestone: async (event) => {
      // @ts-expect-error onMilestone does not guarantee taskId
      const mustExist: string = event.taskId;
      void mustExist;
    },
  },
});
