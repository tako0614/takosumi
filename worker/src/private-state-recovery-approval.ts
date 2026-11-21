/** Closed private recovery approval data; no issuer, session or role authority. */
import type { VerifiedRecoveryArtifact } from "../../core/domains/deploy-control/operator_state_recovery.ts";

const APPROVAL_FORMAT = "takosumi.private-worker-state-recovery-approval/v1";
export const PRIVATE_STATE_STAGE_PURPOSE = "stage-initial-create-state";
export const PRIVATE_STATE_COMMIT_PURPOSE = "commit-staged-initial-create-state";
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const BASE_KEYS = ["format", "purpose", "approvedOperatorId", "selectedTargetId", "workspaceId",
  "capsuleId", "environment", "failedApplyRunId", "recoveryRunId", "sourceSnapshotId",
  "commandTimestamp", "expiresAt", "plaintextSha256", "custodyEvidenceDigest"] as const;
type Digest = VerifiedRecoveryArtifact["plaintextSha256"];
export interface PrivateStateApprovalBinding {
  readonly format: typeof APPROVAL_FORMAT;
  readonly approvedOperatorId: string;
  readonly selectedTargetId: string;
  readonly workspaceId: string;
  readonly capsuleId: string;
  readonly environment: string;
  readonly failedApplyRunId: string;
  readonly recoveryRunId: string;
  readonly sourceSnapshotId: string;
  readonly commandTimestamp: string;
  readonly expiresAt: string;
  readonly plaintextSha256: Digest;
  readonly custodyEvidenceDigest: Digest;
}
export interface PrivateStateStageApproval extends PrivateStateApprovalBinding { readonly purpose: typeof PRIVATE_STATE_STAGE_PURPOSE }
export interface PrivateStateCommitApproval extends PrivateStateApprovalBinding {
  readonly purpose: typeof PRIVATE_STATE_COMMIT_PURPOSE;
  readonly artifactHandle: string;
  readonly encryptedDigest: Digest;
  readonly evidenceDigest: Digest;
}
export type PrivateStateRecoveryApproval = PrivateStateStageApproval | PrivateStateCommitApproval;
/**
 * A qualified authority verifies the private proof's current effect, purpose,
 * holder/channel and revocation before returning its exact approved record.
 * A public case-ID lookup, named-RPC caller, role or boolean is not this port.
 * No production issuer is supplied by this module.
 */
export interface QualifiedStateRecoveryApprovalPort {
  readApprovedStateRecovery(input: {
    readonly approvalRef: string;
    readonly purpose: typeof PRIVATE_STATE_STAGE_PURPOSE | typeof PRIVATE_STATE_COMMIT_PURPOSE;
    readonly selectedTargetId: string;
  }): Promise<unknown>;
}
export interface PrivateStateStageReceipt extends Omit<PrivateStateStageApproval, "format" | "purpose" | "expiresAt"> {
  readonly format: "takosumi.private-worker-state-stage-receipt/v1";
  readonly purpose: "staged-initial-create-state";
  readonly artifactHandle: string;
  readonly encryptedDigest: Digest;
  readonly evidenceDigest: Digest;
}
export class PrivateStateRecoveryRefusal extends Error {
  readonly code = "private_state_recovery_refused";
  constructor() { super("private state recovery approval or custody is unavailable"); }
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}
function timestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}
export function assertPrivateStateRecoveryApproval(value: unknown, purpose: typeof PRIVATE_STATE_STAGE_PURPOSE | typeof PRIVATE_STATE_COMMIT_PURPOSE, target: string, now: number): asserts value is PrivateStateRecoveryApproval {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PrivateStateRecoveryRefusal();
  const row = value as Record<string, unknown>;
  const keys = purpose === PRIVATE_STATE_STAGE_PURPOSE ? BASE_KEYS : [...BASE_KEYS, "artifactHandle", "encryptedDigest", "evidenceDigest"];
  if (!exactKeys(row, keys) || row.format !== APPROVAL_FORMAT || row.purpose !== purpose ||
    row.selectedTargetId !== target ||
    !["approvedOperatorId", "selectedTargetId", "workspaceId", "capsuleId", "environment",
      "failedApplyRunId", "recoveryRunId", "sourceSnapshotId"]
      .every(key => typeof row[key] === "string" && IDENTIFIER.test(row[key])) ||
    !timestamp(row.commandTimestamp) || !timestamp(row.expiresAt) ||
    !Number.isFinite(now) || Date.parse(row.commandTimestamp) > now || now >= Date.parse(row.expiresAt) ||
    !["plaintextSha256", "custodyEvidenceDigest", ...(purpose === PRIVATE_STATE_COMMIT_PURPOSE ? ["encryptedDigest", "evidenceDigest"] : [])]
      .every(key => typeof row[key] === "string" && DIGEST.test(row[key])) ||
    (purpose === PRIVATE_STATE_COMMIT_PURPOSE && (typeof row.artifactHandle !== "string" || row.artifactHandle.length > 4096 ||
      !row.artifactHandle.startsWith("recovery-state-v1.")))) throw new PrivateStateRecoveryRefusal();
}
