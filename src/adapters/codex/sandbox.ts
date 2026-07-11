import type { ApprovalPolicy, SandboxMode } from "@happycatlabs/codex-client";

/** App-server session policy derived from lane options. */
export interface CodexSessionPolicy {
  sandbox: SandboxMode;
  approvalPolicy: ApprovalPolicy;
}

/**
 * Explicit lane -> app-server sandbox/approval mapping.
 *
 * Lanes run unattended, so the approval policy is always "never" (command and
 * file-change approvals are decided by the sandbox, not a human); blocking
 * questions still flow through tool/requestUserInput and are parked on the
 * lane store. Dispatch with a cwd defaults to "workspace-write"; read-only
 * lanes get the "read-only" sandbox.
 */
export function resolveSessionPolicy(options: { readOnly?: boolean } = {}): CodexSessionPolicy {
  return {
    sandbox: options.readOnly === true ? "read-only" : "workspace-write",
    approvalPolicy: "never",
  };
}
