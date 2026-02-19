import { spawn as nodeSpawn } from "node:child_process";

export interface GhResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function spawnProcess(
  cmd: string,
  args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  // Use Bun.spawn when available, fall back to Node.js child_process
  if (typeof globalThis.Bun !== "undefined") {
    return (async () => {
      const proc = globalThis.Bun.spawn([cmd, ...args], {
        stdout: "pipe",
        stderr: "pipe"
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited
      ]);
      return { stdout, stderr, exitCode };
    })();
  }

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = nodeSpawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
    child.on("error", () => resolve({ stdout, stderr, exitCode: 1 }));
  });
}

export async function checkGhCli(): Promise<boolean> {
  try {
    const { exitCode } = await spawnProcess("which", ["gh"]);
    return exitCode === 0;
  } catch {
    return false;
  }
}

export async function runGh(args: string[]): Promise<GhResult> {
  return spawnProcess("gh", args);
}
