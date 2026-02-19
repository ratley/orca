export interface CancelOptions {
  run: string;
}

export async function cancelCommand(options: CancelOptions) {
  console.log(`orca cancel: not yet implemented (run=${options.run})`);
}
