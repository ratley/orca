#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const PLATFORM_MAP = {
  darwin: "darwin",
  linux: "linux",
  win32: "win32",
};

const ARCH_MAP = {
  x64: "x64",
  arm64: "arm64",
  arm: "arm",
};

function run(cmd, args) {
  return spawnSync(cmd, args, { stdio: "inherit" });
}

function runTscFallback(reason) {
  if (reason) {
    console.warn(`[typecheck] ${reason}`);
  }
  console.warn("[typecheck] Falling back to TypeScript (tsc --noEmit)");
  const fallback = run("npx", ["-y", "tsc", "--noEmit"]);
  process.exit(fallback.status ?? 1);
}

const platform = PLATFORM_MAP[process.platform];
const arch = ARCH_MAP[process.arch];

if (!platform || !arch) {
  runTscFallback(`Native preview does not support ${process.platform}/${process.arch}.`);
}

const nativePackage = `@typescript/native-preview-${platform}-${arch}`;

try {
  import.meta.resolve(`${nativePackage}/package.json`);
} catch {
  runTscFallback(`Native preview binary package ${nativePackage} is not installed in this environment.`);
}

console.log("[typecheck] Running TypeScript Native Preview (tsgo --noEmit)");
const result = run("npx", ["-y", "tsgo", "--noEmit"]);
process.exit(result.status ?? 1);
