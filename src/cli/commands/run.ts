export interface RunOptions {
  spec: string;
  config?: string;
}

export async function runCommand(options: RunOptions) {
  console.log(`orca run: not yet implemented (spec=${options.spec})`);
}
