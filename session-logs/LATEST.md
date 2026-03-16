# Session Log

- Timestamp: 2026-03-16T07:40:30Z
- Scope: Codex clarification question flow, pending-question persistence, onQuestion hooks, answer/resume handling, and live CLI smoke coverage.
- Verification:
  - `bun test src`
  - `npm run typecheck:tsc`
  - `npm run build`
  - `bun test src/__tests__/client.test.ts src/__tests__/integration.test.ts`
- Notes:
  - Orca now surfaces Codex `requestUserInput` prompts in `status.json`, `orca status`, and `onQuestion` hooks.
  - `orca answer` writes structured answers and the original live run resumes without `orca resume`.
  - The CLI smoke passed against a fake Codex app-server exercising `waiting_for_answer` end to end.
