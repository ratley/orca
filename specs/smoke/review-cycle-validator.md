# Review Cycle Validator Smoke

Manual smoke scenario for exercising:

- planned or unplanned execution with validator commands
- post-exec findings collection
- `onFindings`
- auto-fix review loop
- final completion after review

The generated project stays local and gitignored under `tmp/smoke/review-cycle/`.

## Workspace setup

```bash
mkdir -p tmp/smoke/review-cycle
cd tmp/smoke/review-cycle
bun init -y
git init
git add .
git commit -m "baseline"
```

Create a small starting project:

```bash
cat > index.ts <<'EOF'
export function label(name: string): string {
  return `Hello, ${name}`;
}
EOF

cat > index.test.ts <<'EOF'
import { expect, test } from "bun:test";
import { label } from "./index";

test("label greets by name", () => {
  expect(label("Orca")).toBe("Hello, Orca");
});
EOF

cat > verify-output.ts <<'EOF'
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
if (!source.includes("Goodbye")) {
  throw new Error("expected updated farewell text");
}
console.log("Verified expected farewell text");
EOF
```

## Local spec file

Copy the spec below into `tmp/smoke/review-cycle/SMOKE_SPEC.md`.

```md
# Change The Greeting Contract

Update this Bun project so the exported function now returns a farewell string instead of a greeting.

## Requirements

- Change `label(name)` so it returns `Goodbye, <name>`.
- Update tests to match the new behavior.
- Keep the project tiny and dependency-free.
- Run local verification before finishing.

## Verification

- Run `bun test`.
- Run `bun run verify-output.ts`.
```

## Suggested run flow

Use an Orca config that enables execution review and validator commands, then run:

```bash
export ORCA_RUNS_DIR="$(pwd)/.orca-runs"
orca run --spec ./SMOKE_SPEC.md \
  --on-findings 'node ./hook-log.mjs findings' \
  --on-complete 'node ./hook-log.mjs complete' \
  --on-error 'node ./hook-log.mjs error'
```

## Manual acceptance

- The validator commands run after execution.
- If execution or review misses something, Orca records findings and loops.
- `onFindings` fires when the review cycle finds a real problem.
- The final run reaches `completed` only after review succeeds.
- `bun test` passes.
- `bun run verify-output.ts` passes.
