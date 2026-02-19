export interface PlanOptions {
  spec: string;
  config?: string;
}

export async function planCommand(options: PlanOptions) {
  console.log(`orca plan: not yet implemented (spec=${options.spec})`);
}
