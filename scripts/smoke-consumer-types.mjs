#!/usr/bin/env node
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const repoRoot = resolve(process.cwd());
const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
const npxCmd = process.platform === "win32" ? "npx.cmd" : "npx";

function run(cmd, args, cwd, env = {}) {
  execFileSync(cmd, args, {
    cwd,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
}

function runCapture(cmd, args, cwd) {
  return execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    env: process.env,
  }).trim();
}

function createConsumerProject(baseDir, mode) {
  const dir = join(baseDir, `consumer-${mode}`);
  mkdirSync(dir, { recursive: true });

  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify(
      {
        name: `orca-consumer-${mode}`,
        private: true,
        type: "module",
        scripts: {
          typecheck: "tsc --noEmit",
        },
      },
      null,
      2,
    ),
  );

  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: mode === "bundler" ? "ESNext" : "NodeNext",
          moduleResolution: mode,
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          allowJs: true,
          checkJs: true,
        },
        include: ["orca.config.ts", "orca.config.js", "types-negative.ts"],
      },
      null,
      2,
    ),
  );

  writeFileSync(
    join(dir, "orca.config.ts"),
    `import { defineOrcaConfig } from "orcastrator";

export default defineOrcaConfig({
  hooks: {
    onTaskComplete(event, context) {
      event.taskId.toUpperCase();
      event.taskName.toUpperCase();
      context.cwd.toUpperCase();
      context.pid.toFixed(0);
      context.invokedAt.toUpperCase();
    },
    onError(event) {
      event.error.toUpperCase();
    }
  }
});
`,
  );

  writeFileSync(
    join(dir, "orca.config.js"),
    `// @ts-check
/** @type {import("orcastrator").OrcaConfig} */
const config = {
  hooks: {
    onTaskComplete(event, context) {
      event.taskId.toUpperCase();
      event.taskName.toUpperCase();
      context.cwd.toUpperCase();
    },
  },
};

export default config;
`,
  );

  writeFileSync(
    join(dir, "types-negative.ts"),
    `import type { HookEventMap } from "orcastrator/types";

// @ts-expect-error onTaskComplete requires taskId + taskName
const badComplete: HookEventMap["onTaskComplete"] = {
  hook: "onTaskComplete",
  runId: "abc-123-ffff",
  message: "m",
  timestamp: new Date().toISOString(),
};

// @ts-expect-error onError requires error
const badError: HookEventMap["onError"] = {
  hook: "onError",
  runId: "abc-123-ffff",
  message: "m",
  timestamp: new Date().toISOString(),
};
`,
  );

  return dir;
}

const workspace = mkdtempSync(join(tmpdir(), "orca-consumer-smoke-"));
const keep = process.env.KEEP_TMP === "1";
let tarballPath = "";

try {
  console.log(`consumer smoke workspace: ${workspace}`);

  // Ensure tarball reflects current package state.
  run(npmCmd, ["run", "build"], repoRoot);
  const tarballName = runCapture(npmCmd, ["pack", "--silent"], repoRoot).split("\n").at(-1);
  tarballPath = join(repoRoot, tarballName);

  for (const mode of ["bundler", "nodenext"]) {
    console.log(`\n==> validating consumer install (${mode})`);
    const projectDir = createConsumerProject(workspace, mode);

    run(npmCmd, ["install", "--silent", "typescript@5"], projectDir);
    run(npmCmd, ["install", "--silent", tarballPath], projectDir);
    run(npxCmd, ["tsc", "--pretty", "false", "--noEmit"], projectDir);
  }

  console.log("\nconsumer typing smoke passed (bundler + nodenext)");
} finally {
  if (tarballPath && existsSync(tarballPath)) {
    rmSync(tarballPath, { force: true });
  }

  if (!keep) {
    rmSync(workspace, { recursive: true, force: true });
  } else {
    console.log(`KEEP_TMP=1 set; preserving ${workspace}`);
  }
}
