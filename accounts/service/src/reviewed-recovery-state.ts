import type { OwnerOperationTarget } from "./owner-operation-contract.ts";

/** Private signed review claims. An ID, reviewer name or database row alone
 * never establishes review authority. No issuer is configured by default. */
export interface ReviewedRecoveryApprovalClaims {
  operationId: string;
  recoveryId: string;
  operationRevision: number;
  sourceAccountId: string;
  targetAccountId: string;
  planDigest: string;
  sourceIdentityGeneration: number;
  targetIdentityGeneration: number;
  mode: "abort-before-active" | "restore-after-active";
  /** Immutable original root decision; distinct from each fresh review event. */
  rootReviewRef: string;
  reviewedApprovalRef: string;
  target: OwnerOperationTarget;
  /** PRE-review commitment, excluding approval hash and outer owner envelope. */
  ownerEvidenceDigest: string;
  previousApprovalDigest?: string;
  createdAt: number;
  expiresAt: number;
}

export interface ReviewedRecoveryApprovalRecord {
  version: "takosumi.accounts.reviewed-recovery@v1";
  approval: ReviewedRecoveryApprovalClaims;
  approvalDigest: string;
  decisionDigest: string;
  attestation: {
    algorithm: "ES256";
    issuer: string;
    keyId: string;
    signature: string;
  };
}

export interface ReviewedRecoveryApprovalPointer {
  operationId: string;
  approvalDigest: string;
  revision: number;
  mutationId: string;
  updatedAt: number;
}

export interface ReviewedRecoveryApprovalMutation {
  expectedApprovalDigest?: string;
  record: ReviewedRecoveryApprovalRecord;
  pointer: ReviewedRecoveryApprovalPointer;
}

export type ReviewedRecoveryApprovalView = ReviewedRecoveryApprovalClaims & {
  approvalDigest: string;
  decisionDigest: string;
};
