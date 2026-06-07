/**
 * Security finding and run-scoped credential mint audit records.
 */

import type { Capability } from "./capability-bindings.ts";

export interface CredentialMintEvent {
  readonly id: string;
  readonly runId: string;
  readonly spaceId: string;
  readonly installationId: string;
  readonly connectionId: string;
  readonly phase:
    | "source"
    | "init"
    | "normalize"
    | "gate"
    | "plan"
    | "apply"
    | "destroy";
  readonly capabilities: readonly Capability[];
  readonly actorId?: string;
  readonly createdAt: string;
}

export interface SecurityFinding {
  readonly id: string;
  readonly spaceId: string;
  readonly installationId?: string;
  readonly runId?: string;
  readonly severity: "info" | "warning" | "error" | "critical";
  readonly type: string;
  readonly message: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}
