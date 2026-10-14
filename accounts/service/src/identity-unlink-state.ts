import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";

export interface CredentialIdentityTuple {
  providerId: string;
  upstreamIssuer: string;
  upstreamSubject: string;
}

export interface CredentialUnlinkAcknowledgementRequest {
  operationId: string;
  subject: TakosumiSubject;
  removedIdentity: CredentialIdentityTuple;
  retainedIdentity: CredentialIdentityTuple;
  receiptId: string;
  identityGeneration: number;
}

export interface CredentialUnlinkAcknowledgement
  extends CredentialUnlinkAcknowledgementRequest {
  ownerRef: string;
  acknowledgedAt: number;
}

export interface CredentialUnlinkReconciler {
  /** A separate capability; a legacy subject-only boolean ACK is insufficient. */
  acknowledgeCredentialUnlinkIntent?(
    input: CredentialUnlinkAcknowledgementRequest,
  ): Promise<CredentialUnlinkAcknowledgement | undefined>;
}

export interface CredentialUnlinkIntent {
  operationId: string;
  subject: TakosumiSubject;
  removedIdentity: CredentialIdentityTuple;
  retainedIdentity: CredentialIdentityTuple;
  browserBindingHash: string;
  /** Stable, non-replayable anchor survives ordinary issuer session rotation. */
  issuerSessionHash: string;
  identityGeneration: number;
  policyVersion: string;
  status: "pending" | "completed";
  revision: number;
  createdAt: number;
  expiresAt: number;
  updatedAt: number;
  receiptId?: string;
  acknowledgement?: CredentialUnlinkAcknowledgement;
}

export interface UnlinkOperationProofContext {
  receiptId: string;
  operationId: string;
  subject: TakosumiSubject;
  removedIdentity: CredentialIdentityTuple;
  retainedIdentity: CredentialIdentityTuple;
  browserBindingHash: string;
  issuerSessionHash: string;
  identityGeneration: number;
  policyVersion: string;
  transactionDigest: string;
  startedAt: number;
  expiresAt: number;
  legConsent: true;
  legConsentAt: number;
}

export interface CredentialUnlinkReceipt extends UnlinkOperationProofContext {
  method: "upstream-oauth-operation";
  completedAt: number;
  consumedByOperation?: string;
}

export interface CredentialUnlinkMutation {
  expectedRevision: number;
  next: CredentialUnlinkIntent;
  receipt: CredentialUnlinkReceipt;
  now: number;
}
