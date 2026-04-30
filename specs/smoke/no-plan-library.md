# No-Plan Library Smoke

Manual smoke scenario for exercising:

- automatic planning skip for a tiny task
- standard task execution
- task completion hooks
- final completion without review-loop complications

The generated project stays local and gitignored under `tmp/smoke/no-plan-lib/`.

## Workspace setup

```bash
mkdir -p tmp/smoke/no-plan-lib
cd tmp/smoke/no-plan-lib
bun init -y
git init
git add .
git commit -m "baseline"
```

Create a small starting project:

```bash
cat > math.ts <<'EOF'
export function sum(a: number, b: number): number {
  return a + b;
}
EOF

cat > math.test.ts <<'EOF'
import { expect, test } from "bun:test";
import { sum } from "./math";

test("sum adds two numbers", () => {
  expect(sum(2, 3)).toBe(5);
});
EOF
```

## Local spec file

Copy the spec below into `tmp/smoke/no-plan-lib/SMOKE_SPEC.md`.

```md
# Add A Small Math Helper

Update this Bun project. Orca should decide that no multi-step plan is needed and keep execution as a single task.

## Requirements

- Add `multiply(a, b)` to `math.ts`.
- Add a Bun test that covers the new helper.
- Keep the project tiny and dependency-free.
- Run local verification before finishing.

## Verification

- Run `bun test`.
```

## Suggested run flow

From `tmp/smoke/no-plan-lib/`:

```bash
export ORCA_RUNS_DIR="$(pwd)/.orca-runs"
orca run --spec ./SMOKE_SPEC.md \
  --on-task-complete 'node ./hook-log.mjs task-complete' \
  --on-complete 'node ./hook-log.mjs complete' \
  --on-error 'node ./hook-log.mjs error'
```

## Manual acceptance

- Orca decides planning can be skipped and finishes in a single execution task.
- `bun test` passes.
- Completion hooks fire.
- The project remains simple and framework-free.
