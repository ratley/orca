# Task 2: Error Handling Review Findings

## Review coverage
- Reviewed all non-test async/promise/error paths in `src/**`.
- Inventory counts:
  - Async declarations / async command actions / `for await`: **59**
  - `try` / `catch` markers: **46**
  - Explicit `.catch(...)` promise chains: **2**

## Findings (ranked)

### High
1. **Top-level CLI parse has no terminal error boundary (risk of unhandled rejection / stack trace exposure).**
- Location: `src/cli/index.ts:37`
- Detail: `await program.parseAsync(process.argv)` is not wrapped in a top-level `try/catch`.
- Impact: if any async command action rejects, the process can terminate without normalized user-facing error formatting.

2. **Many async command actions lack local try/catch, relying on upstream behavior.**
- Locations:
  - `src/cli/commands/plan.ts:55`
  - `src/cli/commands/list.ts:68`
  - `src/cli/commands/status.ts:121`
  - `src/cli/commands/cancel.ts:96`
  - `src/cli/commands/resume.ts:104`
  - `src/cli/commands/setup.ts:457`
  - `src/cli/commands/pr/create.ts:76`
  - `src/cli/commands/pr/draft.ts:76`
  - `src/cli/commands/pr/publish.ts:60`
  - `src/cli/commands/pr/status.ts:91`
  - `src/cli/commands/pr/index.ts:25`
  - `src/cli/commands/pr/index.ts:27`
  - `src/cli/commands/pr-finalize.ts:18`
- Detail: these actions call async handlers directly without local error wrapping (contrast with guarded actions in `answer` and `run`).
- Impact: inconsistent error propagation and inconsistent end-user error output across commands.

### Medium
3. **Permission/IO errors can be silently swallowed when reading existing setup config.**
- Location: `src/cli/commands/setup.ts:213-216` (`loadExistingConfig`)
- Detail: catch block returns `undefined` for *all* access failures, not only `ENOENT`.
- Impact: real filesystem errors (e.g., `EACCES`, transient IO errors) are misreported as “no config”, which can lead to accidental config overwrite behavior.

4. **External command failures in setup are not checked or surfaced.**
- Locations:
  - `src/cli/commands/setup.ts:198-210` (`installGhVia`)
  - `src/cli/commands/setup.ts:383` (`gh auth login`)
- Detail: `spawnSync(...)` results are not inspected (`status`, `error`, `signal`) and no failure message is emitted.
- Impact: setup can appear to proceed while installation/authentication actually failed.

5. **Hook execution errors are converted to secondary hooks and otherwise swallowed from main flow.**
- Location: `src/hooks/dispatcher.ts:52-56`, `src/hooks/dispatcher.ts:61-65`, `src/hooks/dispatcher.ts:83-113`
- Detail: handler/command failures are caught and routed to `onError`; `dispatch()` does not fail unless `onError` itself fails.
- Impact: upstream caller may treat hook dispatch as success despite underlying hook failure, which can hide operational errors.

6. **Temp-file cleanup errors are fully suppressed.**
- Location: `src/cli/commands/run.ts:247-249`
- Detail: `unlink(specPath).catch(() => {})` swallows cleanup failures with no logging.
- Impact: silent cleanup failure complicates diagnosing temp-file leaks or permission problems.

## Notes
- Some catches are intentionally defensive and acceptable (e.g., `writeSessionSummary` warning path in `src/core/task-runner.ts:104-114`), but they should be explicit policy choices.
- No obvious uncaught rejection pattern was found in core loop code where errors are intentionally rethrown (`src/core/task-runner.ts:353-370`, `src/agents/codex/session.ts:326-344`, `src/agents/claude/session.ts:150-184`).
