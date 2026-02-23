import { execSync, spawnSync } from "node:child_process";
import { constants as fsConstants, readFileSync } from "node:fs";
import { access, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { pathToFileURL } from "node:url";

import chalk from "chalk";
import { InvalidArgumentError, type Command } from "commander";

import type { OrcaConfig } from "../../types/index.js";

export interface SetupCommandOptions {
  anthropicKey?: string;
  openaiKey?: string;
  global?: boolean;
  project?: boolean;
  executor?: "codex" | "claude";
  projectConfigTemplate?: boolean;
  skipProjectConfig?: boolean;
}

type PackageManager = "brew" | "apt" | "winget";
type CheckStatus = "pass" | "fail" | "warn";
type ApiKeyConfig = {
  anthropicApiKey?: string;
  openaiApiKey?: string;
};

type CheckResult = {
  name: string;
  status: CheckStatus;
  detail: string;
};

function serializeForModule(value: unknown, depth = 0): string {
  const indent = "  ".repeat(depth);
  const childIndent = "  ".repeat(depth + 1);

  if (value === null) {
    return "null";
  }

  if (typeof value === "string") {
    return JSON.stringify(value);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return "[]";
    }

    const items = value.map((item) => `${childIndent}${serializeForModule(item, depth + 1)}`);
    return `[\n${items.join(",\n")}\n${indent}]`;
  }

  if (typeof value === "function") {
    return value.toString();
  }

  if (typeof value === "object") {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined);
    if (entries.length === 0) {
      return "{}";
    }

    const body = entries.map(([key, item]) => {
      const safeKey = /^[$A-Z_][0-9A-Z_$]*$/i.test(key) ? key : JSON.stringify(key);
      return `${childIndent}${safeKey}: ${serializeForModule(item, depth + 1)}`;
    });
    return `{\n${body.join(",\n")}\n${indent}}`;
  }

  return "undefined";
}

function supportsPrompting(): boolean {
  return Boolean(process.stdin.isTTY);
}

function commandExists(command: string): boolean {
  const result = spawnSync("which", [command], { stdio: "ignore" });
  return result.status === 0;
}

type ResolveApiKeyOptions = {
  openclawConfigPath?: string;
  homedir?: string;
};

type ApiKeySource = "flag" | "env" | "openclaw";

type ResolvedApiKey = {
  value: string;
  source: ApiKeySource;
};

function getOrcaEnvVarName(envVarName: string): string | undefined {
  if (envVarName === "ANTHROPIC_API_KEY") {
    return "ORCA_ANTHROPIC_API_KEY";
  }

  if (envVarName === "OPENAI_API_KEY") {
    return "ORCA_OPENAI_API_KEY";
  }

  return undefined;
}

function resolveApiKeyWithSource(
  flagValue: string | undefined,
  envVarName: string,
  openclawConfigPathOrOptions?: string | ResolveApiKeyOptions,
  maybeOptions?: ResolveApiKeyOptions
): ResolvedApiKey | undefined {
  if (flagValue && flagValue.trim().length > 0) {
    return { value: flagValue.trim(), source: "flag" };
  }

  const orcaEnvVarName = getOrcaEnvVarName(envVarName);
  if (orcaEnvVarName) {
    const orcaEnvValue = process.env[orcaEnvVarName];
    if (orcaEnvValue && orcaEnvValue.trim().length > 0) {
      return { value: orcaEnvValue.trim(), source: "env" };
    }
  }

  const envValue = process.env[envVarName];
  if (envValue && envValue.trim().length > 0) {
    return { value: envValue.trim(), source: "env" };
  }

  const options =
    typeof openclawConfigPathOrOptions === "string"
      ? { ...maybeOptions, openclawConfigPath: openclawConfigPathOrOptions }
      : (openclawConfigPathOrOptions ?? {});

  const homedir = options.homedir ?? os.homedir();
  const openclawValue = readOpenclawEnvVar(envVarName, options.openclawConfigPath, homedir);
  if (openclawValue) {
    return { value: openclawValue, source: "openclaw" };
  }

  return undefined;
}

export function resolveApiKey(
  flagValue: string | undefined,
  envVarName: string,
  openclawConfigPathOrOptions?: string | ResolveApiKeyOptions,
  maybeOptions?: ResolveApiKeyOptions
): string | undefined {
  return resolveApiKeyWithSource(flagValue, envVarName, openclawConfigPathOrOptions, maybeOptions)?.value;
}

function readOpenclawEnvVar(
  envVarName: string,
  openclawConfigPath?: string,
  homedir: string = os.homedir()
): string | undefined {
  const configPath = openclawConfigPath ?? path.join(homedir, ".openclaw", "openclaw.json");
  try {
    const fileText = readFileSync(configPath, "utf8");
    const parsed = JSON.parse(fileText) as { env?: { vars?: Record<string, unknown> } };
    const value = parsed.env?.vars?.[envVarName];

    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }

    if (value && typeof value === "object") {
      const candidateObject = value as {
        value?: unknown;
        ref?: unknown;
        opRef?: unknown;
        reference?: unknown;
      };

      for (const candidate of [
        candidateObject.value,
        candidateObject.ref,
        candidateObject.opRef,
        candidateObject.reference
      ]) {
        if (typeof candidate === "string" && candidate.trim().length > 0) {
          return candidate.trim();
        }
      }
    }
  } catch {
    return undefined;
  }

  return undefined;
}

export function readCodexAuthJson(homedir: string = os.homedir()): string | undefined {
  const authPath = path.join(homedir, ".codex", "auth.json");

  try {
    const parsed = JSON.parse(readFileSync(authPath, "utf8")) as { OPENAI_API_KEY?: unknown };
    const key = parsed.OPENAI_API_KEY;

    if (typeof key === "string" && key.trim().length > 0) {
      return key.trim();
    }
  } catch {
    return undefined;
  }

  return undefined;
}

export function readClaudeCodeKeychain(): string | undefined {
  if (process.platform !== "darwin") {
    return undefined;
  }

  try {
    const raw = execSync('security find-generic-password -s "Claude Code-credentials" -w', {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();

    const parsed = JSON.parse(raw) as {
      claudeAiOauth?: {
        accessToken?: unknown;
      };
    };

    const token = parsed.claudeAiOauth?.accessToken;
    if (typeof token === "string" && token.trim().length > 0) {
      return token.trim();
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function parseExecutorOption(value: string): "codex" | "claude" {
  if (value === "codex" || value === "claude") {
    return value;
  }

  throw new InvalidArgumentError("executor must be one of: codex, claude");
}

export function detectPackageManager(
  exists: (command: string) => boolean = commandExists
): PackageManager | null {
  if (exists("brew")) {
    return "brew";
  }

  if (exists("apt")) {
    return "apt";
  }

  if (exists("winget")) {
    return "winget";
  }

  return null;
}

export function buildConfigModule({ anthropicApiKey, openaiApiKey }: ApiKeyConfig): string {
  const lines = ["// generated by orca setup", "export default {"];

  if (anthropicApiKey !== undefined) {
    lines.push(`  anthropicApiKey: ${JSON.stringify(anthropicApiKey)},`);
  }

  if (openaiApiKey !== undefined) {
    lines.push(`  openaiApiKey: ${JSON.stringify(openaiApiKey)},`);
  }

  lines.push("};", "");
  return lines.join("\n");
}

function buildMergedConfigModule(config: OrcaConfig): string {
  return `// generated by orca setup\nexport default ${serializeForModule(config)};\n`;
}

export function buildProjectConfigTemplate(): string {
  return `import { defineOrcaConfig } from "orcastrator";

const config = defineOrcaConfig({
  // Function hooks are the primary DX. Each hook gets a strongly-typed event + deterministic context.
  hooks: {
    // Fires for run lifecycle milestones (planning/execution/review transitions).
    // Guaranteed: runId, message, timestamp. metadata may include stage/cycle details.
    // Do not assume taskId/taskName is present here.
    onMilestone: async (event, context) => {
      void context;
      void event;
    },

    // Fires after each task succeeds.
    // Guaranteed: taskId + taskName are always present.
    // Do not assume metadata exists unless your own workflow sets it.
    onTaskComplete: async (event) => {
      void event;
    },

    // Fires after a task fails.
    // Guaranteed: taskId + taskName + error are always present.
    onTaskFail: async (event) => {
      void event;
    },

    // Fires when plan validation fails before execution starts.
    // Guaranteed: error is always present.
    onInvalidPlan: async (event) => {
      void event;
    },

    // Fires when post-execution review reports findings.
    // Guaranteed: runId/message/timestamp; metadata may include findingsCount/findingsSummary/cycleIndex.
    // Do not assume every metadata field exists.
    onFindings: async (event) => {
      void event;
    },

    // Fires once when a run completes successfully.
    onComplete: async (event) => {
      void event;
    },

    // Fires when run-level or hook-level errors occur.
    // Guaranteed: error is always present.
    onError: async (event) => {
      void event;
    }
  },

  // Command hooks remain supported; Orca writes event payload JSON to stdin (no ORCA_* hook env vars).
  // Example command can parse stdin and branch on payload.hook.
  hookCommands: {
    // onMilestone: "node ./scripts/on-milestone.js"
  }
});

export default config;
`;
}

function icon(status: CheckStatus): string {
  if (status === "pass") {
    return chalk.green("✓");
  }

  if (status === "fail") {
    return chalk.red("✗");
  }

  return chalk.yellow("!");
}

function printSummary(results: CheckResult[]): void {
  const width = Math.max(...results.map((result) => result.name.length), 1);

  for (const result of results) {
    console.log(`  ${icon(result.status)} ${result.name.padEnd(width, " ")}  ${result.detail}`);
  }
}

function checkGitOrigin(): { inRepo: boolean; hasOrigin: boolean } {
  const repoCheck = spawnSync("git", ["rev-parse", "--git-dir"], { stdio: "ignore" });
  if (repoCheck.status !== 0) {
    return { inRepo: false, hasOrigin: false };
  }

  const originCheck = spawnSync("git", ["remote", "get-url", "origin"], { stdio: "ignore" });
  return { inRepo: true, hasOrigin: originCheck.status === 0 };
}

async function promptForApiKey(
  rl: readline.Interface,
  currentValue: string | undefined,
  promptText: string
): Promise<string | undefined> {
  if (currentValue || !supportsPrompting()) {
    return currentValue;
  }

  const value = (await rl.question(promptText)).trim();
  return value.length > 0 ? value : undefined;
}

function runGhAuthStatus(): { authenticated: boolean; detail: string } {
  const result = spawnSync("gh", ["auth", "status"], { encoding: "utf8" });
  if (result.status === 0) {
    const version = execSync("gh --version", { encoding: "utf8" }).split("\n")[0]?.trim();
    return {
      authenticated: true,
      detail: version ? `${version} (authenticated)` : "installed (authenticated)"
    };
  }

  return {
    authenticated: false,
    detail: "installed (not authenticated)"
  };
}

function installGhVia(packageManager: PackageManager): void {
  if (packageManager === "brew") {
    spawnSync("brew", ["install", "gh"], { stdio: "inherit" });
    return;
  }

  if (packageManager === "apt") {
    spawnSync("sudo", ["apt", "install", "gh"], { stdio: "inherit" });
    return;
  }

  spawnSync("winget", ["install", "GitHub.cli"], { stdio: "inherit" });
}

async function loadExistingConfig(configPath: string): Promise<OrcaConfig | undefined> {
  try {
    await access(configPath, fsConstants.R_OK);
  } catch {
    return undefined;
  }

  const importUrl = `${pathToFileURL(configPath).href}?t=${Date.now()}`;
  const imported = await import(importUrl);
  const candidate = "default" in imported ? imported.default : imported;

  if (candidate && typeof candidate === "object") {
    return candidate as OrcaConfig;
  }

  return undefined;
}

async function saveConfig(
  configPath: string,
  keys: ApiKeyConfig,
  executor?: "codex" | "claude"
): Promise<void> {
  const existing = await loadExistingConfig(configPath);
  const merged: OrcaConfig = {
    ...existing,
    ...(keys.anthropicApiKey !== undefined ? { anthropicApiKey: keys.anthropicApiKey } : {}),
    ...(keys.openaiApiKey !== undefined ? { openaiApiKey: keys.openaiApiKey } : {}),
    ...(executor !== undefined ? { executor } : {})
  };

  const moduleText = buildConfigModule({
    ...(merged.anthropicApiKey !== undefined ? { anthropicApiKey: merged.anthropicApiKey } : {}),
    ...(merged.openaiApiKey !== undefined ? { openaiApiKey: merged.openaiApiKey } : {})
  });
  const fullModuleText = buildMergedConfigModule(merged);

  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(
    configPath,
    existing ? fullModuleText : moduleText,
    "utf8"
  );
}

function parseSaveTarget(options: SetupCommandOptions): "global" | "project" | null {
  if (options.global && options.project) {
    throw new Error("--global and --project cannot be used together");
  }

  if (options.project) {
    return "project";
  }

  if (options.global) {
    return "global";
  }

  return null;
}

function getConfigPath(target: "global" | "project"): string {
  if (target === "project") {
    return path.resolve("orca.config.js");
  }

  return path.join(os.homedir(), ".orca", "config.js");
}

async function maybeWriteProjectTemplate(options: SetupCommandOptions, rl: readline.Interface | null): Promise<void> {
  if (options.skipProjectConfig) {
    return;
  }

  let shouldWrite = Boolean(options.projectConfigTemplate);
  const legacyProjectConfigPath = path.resolve("orca.config.js");
  let hasLegacyProjectConfig = false;

  try {
    await access(legacyProjectConfigPath, fsConstants.F_OK);
    hasLegacyProjectConfig = true;
  } catch {
    // continue
  }

  if (!shouldWrite && rl) {
    const prompt = hasLegacyProjectConfig
      ? "Generate typed project hook template at ./orca.config.ts? Note: ./orca.config.ts takes precedence over existing ./orca.config.js. (y/N): "
      : "Generate typed project hook template at ./orca.config.ts? (Y/n): ";
    const answer = (await rl.question(prompt)).trim().toLowerCase();
    shouldWrite = hasLegacyProjectConfig ? answer === "y" || answer === "yes" : answer === "" || answer === "y" || answer === "yes";
  }

  if (!shouldWrite) {
    return;
  }

  const templatePath = path.resolve("orca.config.ts");
  try {
    await access(templatePath, fsConstants.F_OK);
    console.log(chalk.yellow("! Skipping template write: ./orca.config.ts already exists"));
    return;
  } catch {
    // continue
  }

  await writeFile(templatePath, buildProjectConfigTemplate(), "utf8");
  console.log(chalk.green("✓ Project template written to ./orca.config.ts"));
}

export async function setupCommandHandler(options: SetupCommandOptions): Promise<void> {
  if (options.projectConfigTemplate && options.skipProjectConfig) {
    throw new Error("--project-config-template and --skip-project-config cannot be used together");
  }

  const explicitTarget = parseSaveTarget(options);
  const rl = supportsPrompting()
    ? readline.createInterface({
        input: process.stdin,
        output: process.stdout
      })
    : null;

  const results: CheckResult[] = [];
  const initialAnthropic = resolveApiKeyWithSource(options.anthropicKey, "ANTHROPIC_API_KEY");
  const initialOpenai = resolveApiKeyWithSource(options.openaiKey, "OPENAI_API_KEY");
  let anthropicApiKey = initialAnthropic?.value;
  let openaiApiKey = initialOpenai?.value;

  try {
    let codexAvailable = Boolean(openaiApiKey) || Boolean(readCodexAuthJson());
    let claudeAvailable = Boolean(anthropicApiKey) || Boolean(readClaudeCodeKeychain());

    if (!codexAvailable && !claudeAvailable && rl) {
      anthropicApiKey = await promptForApiKey(rl, anthropicApiKey, "Enter your Anthropic API key (sk-ant-...) [optional]: ");
      openaiApiKey = await promptForApiKey(rl, openaiApiKey, "Enter your OpenAI API key (sk-...) [optional]: ");
      codexAvailable = Boolean(openaiApiKey) || Boolean(readCodexAuthJson());
      claudeAvailable = Boolean(anthropicApiKey) || Boolean(readClaudeCodeKeychain());
    }

    results.push({ name: "Codex", status: codexAvailable ? "pass" : "warn", detail: codexAvailable ? "available" : "not available" });
    results.push({ name: "Claude", status: claudeAvailable ? "pass" : "warn", detail: claudeAvailable ? "available" : "not available" });

    const ghAvailable = commandExists("gh");
    if (!ghAvailable) {
      results.push({ name: "gh CLI", status: "warn", detail: "not found" });
      if (rl) {
        const installAnswer = (await rl.question("Install gh CLI? (y/N): ")).trim().toLowerCase();
        if (installAnswer === "y" || installAnswer === "yes") {
          const packageManager = detectPackageManager();
          if (packageManager) {
            installGhVia(packageManager);
          } else {
            console.log("Install manually: https://cli.github.com");
          }
        }
      }
    } else {
      const auth = runGhAuthStatus();
      results.push({ name: "gh CLI", status: auth.authenticated ? "pass" : "warn", detail: auth.detail });
      if (!auth.authenticated && rl) {
        const loginAnswer = (await rl.question("Run gh auth login now? (y/N): ")).trim().toLowerCase();
        if (loginAnswer === "y" || loginAnswer === "yes") {
          spawnSync("gh", ["auth", "login"], { stdio: "inherit" });
        }
      }
    }

    const gitCheck = checkGitOrigin();
    if (!gitCheck.inRepo) {
      results.push({ name: "git origin", status: "warn", detail: "not in a git repo" });
    } else if (!gitCheck.hasOrigin) {
      results.push({ name: "git origin", status: "warn", detail: "not set" });
    } else {
      results.push({ name: "git origin", status: "pass", detail: "found" });
    }

    const target = explicitTarget ?? "global";
    const configPath = getConfigPath(target);
    const resolvedExecutor = options.executor ?? (codexAvailable ? "codex" : claudeAvailable ? "claude" : undefined);

    await saveConfig(
      configPath,
      {
        ...(options.anthropicKey !== undefined ? { anthropicApiKey: options.anthropicKey } : {}),
        ...(options.openaiKey !== undefined ? { openaiApiKey: options.openaiKey } : {})
      },
      resolvedExecutor
    );

    const printedPath = target === "global" ? "~/.orca/config.js" : "./orca.config.js";
    if (resolvedExecutor) {
      console.log(chalk.green(`✓ Config saved to ${printedPath} (executor: ${resolvedExecutor})`));
    } else {
      console.log(chalk.green(`✓ Config saved to ${printedPath}`));
      console.log("! No executors detected. Set ANTHROPIC_API_KEY (Claude) or OPENAI_API_KEY (Codex), then run `orca setup` again.");
      process.exitCode = 1;
    }

    await maybeWriteProjectTemplate(options, rl);

    console.log("\nSummary:");
    printSummary(results);

    if (resolvedExecutor) {
      process.exitCode = 0;
    }
  } finally {
    rl?.close();
  }
}

export function registerSetupCommand(program: Command): void {
  program
    .command("setup")
    .description("Run first-time setup and environment checks")
    .option("--anthropic-key <key>", "Provide Anthropic API key directly")
    .option("--openai-key <key>", "Provide OpenAI API key directly")
    .option("--global", "Save config to ~/.orca/config.js")
    .option("--project", "Save config to ./orca.config.js")
    .option("--executor <value>", "Set executor in written config (codex|claude)", parseExecutorOption)
    .option("--project-config-template", "Write a typed project hook template to ./orca.config.ts")
    .option("--skip-project-config", "Do not prompt to generate a project config template")
    .action(async (commandOptions: SetupCommandOptions) => {
      await setupCommandHandler(commandOptions);
    });
}
