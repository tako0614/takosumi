import type { ControlIdentityContextPlan } from "../../../contract/identity-reconciliation.ts";
import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";

/** Private Accounts custody. Neither raw issuer cookies nor Workspace authority
 * supplied by a browser are stored as a context acceptance. */
export interface IdentityMergeContextPlanBinding {
  planId: string;
  planDigest: string;
  planningRevision: number;
  authorityId: string;
  authorityVersion: string;
  canonicalPersonalWorkspaceId: string;
}
export interface IdentityMergeContextPlanRecord
  extends IdentityMergeContextPlanBinding {
  operationId: string;
  sourceSubject: TakosumiSubject;
  targetSubject: TakosumiSubject;
  sourceProofReceiptId: string;
  targetProofReceiptId: string;
  sourceIdentityGeneration: number;
  targetIdentityGeneration: number;
  browserBindingHash: string;
  policyVersion: string;
  createdAt: number;
  expiresAt: number;
  /** The exact bounded Core-owned plan, never a browser projection. */
  controlPlan: ControlIdentityContextPlan;
}
export interface IdentityMergeContextAcceptance {
  receiptId: string;
  proofReceiptId: string;
  identityGeneration: number;
  acceptedAt: number;
  planDigest: string;
}
export interface IdentityMergeContextReceipt
  extends IdentityMergeContextAcceptance {
  operationId: string;
  role: "source" | "target";
  subject: TakosumiSubject;
  sourceSubject: TakosumiSubject;
  targetSubject: TakosumiSubject;
  planId: string;
  planningRevision: number;
  browserBindingHash: string;
  policyVersion: string;
  issuerSessionHash: string;
  expiresAt: number;
  explicitContextConsent: true;
  consumedByOperation?: string;
}
export interface IdentityMergeLock {
  operationId: string;
  subject: TakosumiSubject;
}

export interface CredentialUnlinkAuthorityTicket {
  operationId: string;
  subject: TakosumiSubject;
  receiptId: string;
  identityGeneration: number;
  createdAt: number;
}

export interface IdentityContextContinuation {
  path: string;
  operationId: string;
  operationRevision: number;
  sourceSubject: TakosumiSubject;
  targetSubject: TakosumiSubject;
  currentSubject: TakosumiSubject;
  currentGeneration: number;
  issuerSessionHash: string;
  expectedSubject: TakosumiSubject;
  providerId: string;
  upstreamIssuer: string;
  upstreamSubject: string;
  proofReceiptId: string;
  browserBindingHash: string;
  policyVersion: string;
  planDigest: string;
  createdAt: number;
  expiresAt: number;
}
