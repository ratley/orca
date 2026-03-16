import { defineOrcaConfig } from "./index.js";

defineOrcaConfig({
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
