export interface ResumeOptions {
  run: string;
}

export async function resumeCommand(options: ResumeOptions) {
  console.log(`orca resume: not yet implemented (run=${options.run})`);
}
