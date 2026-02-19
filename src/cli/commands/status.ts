export interface StatusOptions {
  run?: string;
}

export async function statusCommand(options: StatusOptions) {
  if (options.run) {
    console.log(`orca status: not yet implemented (run=${options.run})`);
  } else {
    console.log(`orca status: list all runs (not yet implemented)`);
  }
}
