# Task 3: TypeScript Type Correctness Audit

## Scope reviewed
- Reviewed all non-test TypeScript source files: **38** files under `src/**`.
- Ran compiler check: `npm run -s typecheck` (passes).
- Searched for: `any`, unsafe casts (`as ...`), broad object casting, JSON parse casting, and signature/annotation gaps.

## Findings (structured)

### High
1. **Unsafe `Task[]` casting from untrusted JSON (no runtime shape validation).**
- File: `src/agents/claude/session.ts`
- Location: `parseTaskArray` (`:74`, `:79`)
- Problem: `JSON.parse(raw) as unknown` is returned as `Task[]` via `as Task[]` without schema validation.
- Risk: malformed model output can violate declared `Task` contract and fail downstream at runtime.

2. **Unsafe model-response object casting for task execution result.**
- File: `src/agents/claude/session.ts`
- Location: `parseTaskExecution` (`:83`, `:89`)
- Problem: parsed JSON is cast to `{ outcome?: unknown; error?: unknown }`; only partial checks are applied.
- Risk: declared types imply stronger guarantees than runtime actually enforces.

3. **Unsafe `Task[]` and consultation-object casting in Codex adapter.**
- File: `src/agents/codex/session.ts`
- Location: `parseTaskArray` (`:99`, `:104`), `consultTaskGraph` (`:283`, `:289`)
- Problem: JSON payloads are coerced with `as` to `Task[]` / object shapes without full structural validation.
- Risk: runtime data may diverge from declared types and break execution flow.

### Medium
4. **`RunId` template-literal type is bypassed with assertions, not validated.**
- File: `src/state/store.ts`
- Location: `createRun` (`:20`), `getRun` (`:42`), `updateRun` (`:62`)
- Problem: values are forced to `RunId`/`RunStatus` with `as` even though runtime parser only guarantees `z.string()` for `runId`.
- Risk: inconsistency between declared type (`RunId = \`${string}-${number}-${string}\``) and runtime acceptance.

5. **Additional `RunId` assertion bypasses type guarantee in runner.**
- File: `src/core/task-runner.ts`
- Location: `:362`
- Problem: `runId as RunId` in emitted hook event bypasses compile-time format guarantee.
- Risk: non-conforming IDs can be treated as valid typed IDs.

6. **Config typing is overly broad after partial validation.**
- File: `src/core/config-loader.ts`
- Location: `coerceConfig` return (`:60`), `mergeConfigs` casts (`:94`)
- Problem: arbitrary object is cast to `OrcaConfig`; only `hooks`/`hookCommands` are deeply checked.
- Risk: fields like `maxRetries`, nested `codex/claude/pr` values can have wrong runtime types while appearing type-safe.

7. **Setup config loader also force-casts unknown object to `OrcaConfig`.**
- File: `src/cli/commands/setup.ts`
- Location: `loadExistingConfig` (`:224`)
- Problem: imported config object is cast without structural validation.
- Risk: invalid persisted config shape can propagate with trusted types.

8. **PR status JSON parsing trusts asserted API shape.**
- File: `src/cli/commands/pr/status.ts`
- Location: `:61`
- Problem: `JSON.parse(result.stdout) as GhPrStatusView` with no runtime schema check.
- Risk: missing or unexpected fields can break formatting logic despite typed interface.

### Low
9. **Type guard uses cast-based membership check.**
- File: `src/cli/commands/run.ts`
- Location: `isHookName` (`:50-52`)
- Problem: `VALID_HOOK_NAMES.has(value as HookName)` relies on assertion inside guard.
- Risk: low; function still behaves correctly at runtime, but pattern is weaker than a literal-derived guard.

## Additional notes
- **`any` usage in source code:** none found (only natural-language occurrences in strings/comments).
- **Missing return type annotations:** exported functions are consistently annotated; most local helpers are also annotated or safely inferred under `strict` mode.
- Main risk area is not `any`, but **assertion-heavy trust of dynamic JSON/config data**.
