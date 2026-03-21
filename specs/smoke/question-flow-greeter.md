# Question Flow Greeter Smoke

Manual smoke scenario for exercising:

- a small execution run where Orca should skip multi-step planning
- live clarification during execution
- `waiting_for_answer`
- `onQuestion`
- `orca answer`
- same-run resume and completion hooks

The generated project stays local and gitignored under `tmp/smoke/question-greeter/`.

## Workspace setup

```bash
mkdir -p tmp/smoke/question-greeter
cd tmp/smoke/question-greeter
bun init -y
git init
git add .
git commit -m "baseline"
```

Create a minimal starting project:

```bash
mkdir -p test
cat > index.ts <<'EOF'
export const releaseCodename = "TODO";

export function greet(): string {
  return `Release: ${releaseCodename}`;
}

if (import.meta.main) {
  console.log(greet());
}
EOF

cat > test/greet.test.ts <<'EOF'
import { expect, test } from "bun:test";
import { greet, releaseCodename } from "../index";

test("release codename is set", () => {
  expect(releaseCodename).not.toBe("TODO");
});

test("greet includes the release codename", () => {
  expect(greet()).toContain(releaseCodename);
});
EOF

cat > validate-answer.ts <<'EOF'
import { readFileSync } from "node:fs";

const codename = readFileSync(new URL("./codename.txt", import.meta.url), "utf8").trim();
if (!codename) {
  throw new Error("codename.txt was empty");
}
console.log(`Validated codename: ${codename}`);
EOF
```

## Local spec file

Copy the spec below into `tmp/smoke/question-greeter/SMOKE_SPEC.md`.

```md
# Fill In A Missing Release Codename

Update this Bun project so it asks for the missing release codename if needed during execution instead of guessing.

## Requirements

- Do not invent a codename.
- If the codename is not specified in the repo or the prompt context, ask for it explicitly before making the change.
- Update `index.ts` so the exported value is no longer `TODO`.
- Write the chosen codename into `codename.txt`.
- Keep the project minimal and avoid adding dependencies.
- Run local verification before finishing.

## Verification

- Run `bun test`.
- Run `bun run validate-answer.ts`.
```

## Suggested run flow

From `tmp/smoke/question-greeter/`:

```bash
export ORCA_RUNS_DIR="$(pwd)/.orca-runs"
orca run --spec ./SMOKE_SPEC.md \
  --on-question 'node ./hook-log.mjs question' \
  --on-complete 'node ./hook-log.mjs complete' \
  --on-error 'node ./hook-log.mjs error' \
  --on-task-complete 'node ./hook-log.mjs task-complete'
```

When the run enters `waiting_for_answer`, answer it:

```bash
orca status --run <run-id>
orca answer <run-id> "Nebula-7"
```

## Manual acceptance

- Orca asks for the missing codename instead of guessing.
- `orca status` shows the pending question and question IDs if multiple prompts are present.
- `orca answer` resumes the same live run.
- The final run completes successfully.
- `bun test` passes.
- `bun run validate-answer.ts` passes.
- `codename.txt` contains the answer that was provided.
