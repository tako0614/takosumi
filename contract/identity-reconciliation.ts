/** Private owner-to-owner contract. None of these admissions are HTTP bodies. */
export const CONTROL_IDENTITY_AUTHORITY_VERSION = "control-identity-reconciliation/v1" as const;

export interface ControlIdentityProof {
  readonly receiptId: string;
  readonly identityGeneration: number;
  readonly provedAt: number;
}

export interface ControlContextAcceptance {
  readonly receiptId: string;
  readonly proofReceiptId: string;
  readonly identityGeneration: number;
  readonly acceptedAt: number;
  readonly planDigest: string;
}

export interface ControlMergeAdmission {
  readonly operationId: string;
  readonly operationRevision: number;
  readonly planningRevision: number;
  readonly sourceAccountId: string;
  readonly targetAccountId: string;
  readonly sourceProof: ControlIdentityProof;
  readonly targetProof: ControlIdentityProof;
  readonly browserBindingHash: string;
  readonly policyVersion: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly phase: "planning" | "reserved";
  readonly contextPlan?: { readonly planId: string; readonly digest: string; readonly planningRevision: number; readonly authorityVersion: string };
  readonly contextAcceptances?: { readonly source: ControlContextAcceptance; readonly target: ControlContextAcceptance };
  readonly consentAt?: number;
}

export interface ControlIdentityContext {
  readonly workspaceId: string;
  readonly workspaceRef: string;
  readonly billingAuthority: string;
  readonly organizationRef: string;
  readonly originalOwnerAccountId: string;
  readonly canonicalAccountId: string;
  readonly roles: readonly string[];
  readonly disposition: "retain-personal-anchor" | "insert-additional-membership";
}

export interface ControlIdentityContextPlan {
  readonly planId: string;
  readonly operationId: string;
  readonly authorityVersion: typeof CONTROL_IDENTITY_AUTHORITY_VERSION;
  readonly planningRevision: number;
  readonly sourceAccountId: string;
  readonly targetAccountId: string;
  readonly proofBindingDigest: string;
  readonly inventoryDigest: string;
  /** The exact two original personal contexts are the entire supported census. */
  readonly supportedInventory: "two-disjoint-personal-contexts/v1";
  readonly personalWorkspaceId: string;
  readonly contexts: readonly ControlIdentityContext[];
  readonly createdAt: string;
  readonly digest: string;
}

export interface ControlIdentityReceipt {
  readonly receiptId: string;
  readonly operationId: string;
  readonly authorityVersion: typeof CONTROL_IDENTITY_AUTHORITY_VERSION;
  readonly kind: "merge-applied" | "unlink-preserved" | "merge-aborted" | "merge-restored";
  readonly planDigest: string;
  /** Exact resulting Control census; the consented BEFORE census is bound by
   * planDigest and stored separately in ContextPlan.inventoryDigest. */
  readonly inventoryDigest: string;
  readonly revision: number;
  readonly recordedAt: string;
  readonly personalWorkspaceId?: string;
}

export interface ControlUnlinkAdmission {
  readonly intentId: string;
  readonly intentRevision: number;
  readonly accountId: string;
  readonly removedIdentityDigest: string;
  readonly retainedIdentityDigest: string;
  readonly retainedProofReceiptId: string;
  readonly identityGeneration: number;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface ControlRecoveryAdmission {
  readonly operationId: string;
  readonly recoveryId: string;
  readonly sourceAccountId: string;
  readonly targetAccountId: string;
  readonly planDigest: string;
  readonly mode: "abort-before-active" | "restore-after-active";
  readonly reviewedApprovalRef: string;
  readonly expiresAt: number;
}

/** Accounts implements this with persisted proofs, dual consent and owned fences.
 * It must not derive an admission from an RP cookie or a supplied subject. */
export interface ControlIdentityAuthorityReader {
  readMergeAdmission(input: { readonly operationId: string; readonly phase: "planning" | "reserved"; readonly planDigest?: string }): Promise<ControlMergeAdmission | undefined>;
  readUnlinkAdmission(input: { readonly intentId: string }): Promise<ControlUnlinkAdmission | undefined>;
  readRecoveryAdmission(input: { readonly operationId: string; readonly recoveryId: string }): Promise<ControlRecoveryAdmission | undefined>;
}

export interface ControlIdentityReconciliationPort {
  prepareMerge(input: { readonly operationId: string }): Promise<ControlIdentityContextPlan>;
  assertMergePlanCurrent(input: { readonly operationId: string; readonly planDigest: string }): Promise<ControlIdentityContextPlan>;
  applyMerge(input: { readonly operationId: string; readonly planDigest: string }): Promise<ControlIdentityReceipt>;
  read(operationId: string): Promise<{ readonly plan?: ControlIdentityContextPlan; readonly receipt?: ControlIdentityReceipt; readonly revision: number; readonly status: "prepared" | "applied" | "preserved" | "recovered" } | undefined>;
  acknowledgeUnlink(input: { readonly intentId: string }): Promise<ControlIdentityReceipt>;
  recover(input: { readonly operationId: string; readonly recoveryId: string }): Promise<ControlIdentityReceipt>;
}
