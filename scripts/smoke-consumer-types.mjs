#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(process.cwd());
const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
const npxCmd = process.platform === "win32" ? "npx.cmd" : "npx";

function run(cmd, args, cwd) {
  execFileSync(cmd, args, { cwd, stdio: "inherit", env: process.env });
}

function runCapture(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, encoding: "utf8", env: process.env }).trim();
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
        scripts: { typecheck: "tsc --noEmit" },
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
        include: ["consumer.ts", "consumer.js", "types-negative.ts"],
      },
      null,
      2,
    ),
  );

  writeFileSync(
    join(dir, "consumer.ts"),
    `import { LaneStore, okEnvelope } from "orcastrator";
import type { AgentManifest, DispatchRequest, Envelope } from "orcastrator";

const store = new LaneStore();
const request: DispatchRequest = { laneId: "lane_a3f81c02", prompt: "test", cwd: process.cwd() };
const manifest: AgentManifest = {
  v: 1,
  agent: "example",
  capabilities: { resume: false, kill: false, questions: false, continuityMethods: [] },
};
const envelope: Envelope = okEnvelope({ kind: "agents", agents: [manifest] });

void store;
void request;
void envelope;
`,
  );

  writeFileSync(
    join(dir, "consumer.js"),
    `// @ts-check
/** @type {import("orcastrator").LaneStatus} */
const status = "running";

export { status };
`,
  );

  writeFileSync(
    join(dir, "types-negative.ts"),
    `import type { LaneStatus } from "orcastrator";

// @ts-expect-error unknown lane status
const invalidStatus: LaneStatus = "planning";

void invalidStatus;
`,
  );

  return dir;
}

const workspace = mkdtempSync(join(tmpdir(), "orca-consumer-smoke-"));
const keep = process.env.KEEP_TMP === "1";
let tarballPath = "";

try {
  console.log(`consumer smoke workspace: ${workspace}`);

  run(npmCmd, ["run", "build"], repoRoot);
  const tarballName = runCapture(npmCmd, ["pack", "--silent"], repoRoot).split("\n").at(-1);
  tarballPath = join(repoRoot, tarballName);

  for (const mode of ["bundler", "nodenext"]) {
    console.log(`\n==> validating consumer install (${mode})`);
    const projectDir = createConsumerProject(workspace, mode);

    run(npmCmd, ["install", "--silent", "typescript@5", "@types/node"], projectDir);
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
