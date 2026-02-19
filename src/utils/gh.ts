export interface GhResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function decodeStream(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) {
    return Promise.resolve("");
  }

  return new Response(stream).text();
}

export async function checkGhCli(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["which", "gh"], {
      stdout: "pipe",
      stderr: "pipe"
    });

    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}

export async function runGh(args: string[]): Promise<GhResult> {
  const proc = Bun.spawn(["gh", ...args], {
    stdout: "pipe",
    stderr: "pipe"
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    decodeStream(proc.stdout),
    decodeStream(proc.stderr),
    proc.exited
  ]);

  return {
    stdout,
    stderr,
    exitCode
  };
}
