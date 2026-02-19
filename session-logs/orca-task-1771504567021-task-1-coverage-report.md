# Task 1: Test Coverage Gap Findings

## Scope examined
- Source inventory: all `src/**/*.ts` excluding `*.test.ts` (38 files).
- Test inventory: all `src/**/*.test.ts` (16 files).
- Runtime evidence: `bun test --coverage` output (source + dist emitted; source rows used for findings).

## Coverage summary (source files)
- Overall source coverage (reported): `72.32% funcs / 71.90% lines`.
- Important caveat: many CLI entry/command files are absent from the source coverage table, indicating they were not executed during tests.

## Findings (ranked by risk)

### High risk
1. **Core orchestration path is effectively untested**
- File: `src/cli/commands/run.ts`
- Gap: no direct tests found; file is absent from source coverage table.
- Missing paths: argument exclusivity checks, inline-spec temp file lifecycle, hook registration/validation, Codex consultation fail-fast path, final status computation/persistence.
- Risk: regressions here can break end-to-end run execution.

2. **Large CLI surface has no direct test coverage**
- Files: `src/cli/index.ts`, `src/cli/commands/cancel.ts`, `src/cli/commands/help.ts`, `src/cli/commands/list.ts`, `src/cli/commands/plan.ts`, `src/cli/commands/resume.ts`, `src/cli/commands/status.ts`, `src/cli/commands/pr/index.ts`, `src/cli/commands/pr-finalize.ts`, `src/cli/commands/pr/create.ts`
- Gap: no dedicated `*.test.ts` for these modules; several absent from coverage output.
- Missing behaviors: command wiring, `--last` fallbacks, run-not-found/error messaging, table formatting branches, interactive PR command routing.

3. **Agent adapter coverage is weak in failure parsing/network paths**
- File: `src/agents/codex/session.ts` (`58.33% funcs / 43.53% lines`)
- Uncovered regions (from coverage): `17-28`, `56-68`, `72-93`, `125-140`, `144-173`, `222-237`, `286-295`, `319-344`.
- Also observed: integration tests fail in this environment due external connectivity (`stream disconnected`), leaving key paths unstable/unverified.

4. **Claude adapter has no tests**
- File: `src/agents/claude/session.ts`
- Gap: no test file; uncovered parsing/stream error branches.
- Risk: provider fallback path can fail silently at runtime.

5. **Setup flow is mostly untested despite helper tests**
- File: `src/cli/commands/setup.ts` (`15.00% funcs / 11.56% lines`)
- Existing tests cover only helpers (`resolveApiKey`, `detectPackageManager`, `buildConfigModule`).
- Missing paths: interactive prompting, GH auth/install flow, config merge/load/save behavior, `--check`, `--global/--project` handling, exit-code logic.

### Medium risk
1. **PR command implementation coverage is inconsistent**
- Files: `src/cli/commands/pr/draft.ts` (`0.00% funcs / 6.67% lines`), `src/cli/commands/pr/publish.ts` (`0.00% funcs / 6.25% lines`), `src/cli/commands/pr/status.ts` (`80.00% funcs / 61.40% lines`), `src/cli/commands/pr/shared.ts` (`88.89% funcs / 62.16% lines`).
- Missing branches: GH error cases, missing/invalid run data branches, parsing and update edge cases.

2. **Hook adapter availability/error branches partially uncovered**
- File: `src/hooks/adapters/openclaw.ts` (`50.00% funcs / 42.68% lines`)
- Uncovered regions include detection/command execution paths (`8-10`, `14-19`, `23-41`, `51-56`, `77-78`, `89-90`, `93-100`).

3. **Answer command has low line coverage for error/TTY branches**
- File: `src/cli/commands/answer.ts` (`66.67% funcs / 28.00% lines`)
- Uncovered regions include run-id resolution and several non-success paths (`22`, `24`, `27-40`, `53-55`, `57-63`, `65-70`, `72-76`, `78-81`, `83`, `87-98`).

4. **GitHub utility wrapper has no direct tests**
- File: `src/utils/gh.ts`
- Missing branches: Bun vs Node spawn behavior, child process error event handling, stderr/stdout edge conditions.

### Low risk
1. **Type/schema modules have little explicit test intent**
- Files: `src/types/index.ts`, `src/hooks/types.ts` (type-only), `src/state/schema.ts` (runtime schema, currently covered indirectly).
- Suggestion: lightweight schema contract tests to guard future changes.

2. **Tiny utility logger has no function coverage relevance**
- File: `src/utils/logger.ts` (`0.00% funcs / 100.00% lines`)
- Low impact currently, but no behavior assertions exist.

## Potential blockers to accurate coverage signal
- Test runner currently executes both `src/**/*.test.ts` and built `dist/**/*.test.js`, duplicating suites and adding noise.
- Some integration tests require external connectivity and fail in sandboxed/offline environments, reducing reliability of coverage as a gate.
- One config-loader test is brittle to ambient environment (`OPENAI_API_KEY` leakage), indicating test isolation gaps.

## Recommended next test additions (priority order)
1. Add focused unit tests for `runCommandHandler` (`src/cli/commands/run.ts`) with dependency mocks for planner/task-runner/codex session/store.
2. Add CLI command handler tests for `cancel`, `resume`, `status`, `list`, `plan`, and command registration smoke tests in `src/cli/index.ts`.
3. Add deterministic parser/outcome tests for `src/agents/codex/session.ts` (especially `extractJson`, `inferOutcomeFromText`, `parseTaskExecution`, consultation parse).
4. Expand `setup.ts` tests to cover interactive/non-interactive flows, save target selection, config merge/write, and exit-code semantics.
5. Add direct tests for `utils/gh.ts` process wrapper and PR subcommand negative paths.
