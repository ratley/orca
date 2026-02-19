export interface PrFinalizeOptions {
  run: string;
}

export async function prFinalizeCommand(options: PrFinalizeOptions) {
  console.log(`orca pr finalize: not yet implemented (run=${options.run})`);
}
