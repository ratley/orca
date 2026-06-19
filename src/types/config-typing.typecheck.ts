import { defineOrcaConfig, defineOrcaFlow } from "./index.js";

const orchestrateFlow = defineOrcaFlow({
  description: "Coordinate implementation slices and review the integrated result",
  baseline: {
    prompt: "Establish the dirty-tree baseline before dispatching work.",
    skills: ["./.orca/skills/orchestrate"]
  },
  planning: {
    review: {
      enabled: true,
      onInvalid: "fail"
    }
  },
  execution: {
    codex: {
      multiAgent: true,
      maxParallelTasks: 2
    },
    review: {
      enabled: true,
      onFindings: "auto_fix"
    }
  },
  summary: {
    prompt: "Report files changed, checks run, and integration notes."
  }
});

defineOrcaConfig({
  flow: {
    default: "orchestrate",
    presets: {
      orchestrate: orchestrateFlow
    }
  },
  codex: {
    multiAgent: true,
    maxParallelTasks: 2
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
    }
  }
});

defineOrcaConfig({
  hooks: {
    // @ts-expect-error unknown hook key should be rejected by types
    onMystery: async () => {}
  }
});

defineOrcaConfig({
  hooks: {
    onMilestone: async (event) => {
      // @ts-expect-error onMilestone does not guarantee taskId
      const mustExist: string = event.taskId;
      void mustExist;
    }
  }
});

defineOrcaFlow({
  overrides: {
    hookCommands: {
      // @ts-expect-error unknown hook key should be rejected by flow override types
      onMystery: "echo nope"
    }
  }
});
