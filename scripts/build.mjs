#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const compiler = fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url));

rmSync(fileURLToPath(new URL("../dist", import.meta.url)), { recursive: true, force: true });

const result = spawnSync(process.execPath, [compiler], {
  cwd: repoRoot,
  stdio: "inherit",
});

process.exit(result.status ?? 1);
