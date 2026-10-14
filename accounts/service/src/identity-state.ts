import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";
import type {
  CredentialUnlinkIntent,
  CredentialUnlinkReceipt,
  CredentialUnlinkMutation,
  UnlinkOperationProofContext,
} from "./identity-unlink-state.ts";
import type { TakosumiAccountRecord, UpstreamIdentityRecord } from "./store.ts";

/** Exact address-bound evidence. Historical account booleans are not evidence. */
export interface AccountEmailProofRecord {
  subject: TakosumiSubject;
  address: string;
  normalizedAddress: string;
  providerId: string;
  upstreamIssuer: string;
  upstreamSubject: string;
  verification: "provider" | "mailbox";
  authoritative: boolean;
  observedAt: number;
  validUntil: number;
}

export interface UpstreamLoginTransactionRecord {
  id: string;
  providerId: string;
  browserBindingHash: string;
  codeVerifier: string;
  nonce: string;
  redirectUri: string;
  createdAt: number;
  expiresAt: number;
  prompt?: "login";
  maxAgeSeconds?: number;
  returnTo?: string;
  operationProof?: IdentityOperationProofContext;
  unlinkProof?: UnlinkOperationProofContext;
}

export interface HostedOidcGrantRecord {
  identityGeneration?: number;
  issuer?: string;
  sid: string;
  issuerSessionId: string;
  clientId: string;
  subject: TakosumiSubject;
  scope: string;
  authTime: number;
  createdAt: number;
  absoluteExpiresAt: number;
  revokedAt?: number;
  authorizationCodeHash?: string;
}

export interface UpstreamIdentityStatusRecord {
  identityKey: string;
  canonicalSubject: TakosumiSubject;
  disabledAt?: number;
  operationId: string;
}

export interface IdentityOperationReceiptRecord {
  receiptId: string;
  operationId: string;
  role: "source" | "target";
  sourceSubject: TakosumiSubject;
  targetSubject: TakosumiSubject;
  subject: TakosumiSubject;
  providerId: string;
  upstreamIssuer: string;
  upstreamSubject: string;
  browserBindingHash: string;
  policyVersion: string;
  identityGeneration: number;
  transactionDigest: string;
  startedAt: number;
  completedAt: number;
  expiresAt: number;
  emailDigest: string;
  legConsent: true;
  legConsentAt: number;
  method: "upstream-oauth-operation" | "issuer-credential-reauth";
  /** Non-replayable, backend-normalized issuer session anchor. */
  issuerSessionHash: string;
  consumedByOperation?: string;
}
export type IdentityOperationProofContext = Omit<
  IdentityOperationReceiptRecord,
  "method" | "completedAt" | "emailDigest" | "consumedByOperation"
>;

export interface IdentityMergeProof {
  subject: TakosumiSubject;
  receiptId: string;
  method: IdentityOperationReceiptRecord["method"];
  identityGeneration: number;
  provedAt: number;
  legConsentAt?: number;
  authTime?: number;
  sessionDigest?: string;
  sessionLookupHash?: string;
}

export interface IdentityMergeAcknowledgements {
  operationId: string;
  sourceSubject: TakosumiSubject;
  targetSubject: TakosumiSubject;
  externalBindings: string;
  workspaceMembership: string;
  billingLedger: string;
  consumerIntentCustody: string;
  rpSessions: string;
  personalWorkspaceId: string;
  reconciledAt: number;
}

export interface IdentityMergeRecoveryAcknowledgements
  extends IdentityMergeAcknowledgements {
  undoOperationId: string;
  reviewedRecoveryRef: string;
  /** Explicit rollback confirmations are required for pre-activation abort. */
  preActivationRollback?: {
    externalBindings: string;
    workspaceMembership: string;
    billingLedger: string;
    rpSessions: string;
    consumerIntentCustody: string;
  };
}

export interface IdentityMergeOperation {
  operationId: string;
  sourceSubject: TakosumiSubject;
  targetSubject: TakosumiSubject;
  actor: TakosumiSubject;
  addressDigest: string;
  browserBindingHash: string;
  policyVersion: string;
  status:
    | "pending"
    | "proved"
    | "reconciled"
    | "active"
    | "quarantined"
    | "restored"
    | "aborted";
  revision: number;
  mutationId: string;
  createdAt: number;
  expiresAt: number;
  updatedAt: number;
  sourceProof?: IdentityMergeProof;
  targetProof?: IdentityMergeProof;
  consentAt?: number;
  acknowledgements?: IdentityMergeAcknowledgements;
  conflict?: string;
  undoOperationId?: string;
  recoveryAcknowledgements?: IdentityMergeRecoveryAcknowledgements;
}

export interface IdentityMergeSessionRequirement {
  sessionId?: string;
  sessionLookupHash?: string;
  subject: TakosumiSubject;
  authTime: number;
  reauthentication?: boolean;
}

export interface IdentityMergeMutation {
  expectedRevision: number;
  next: IdentityMergeOperation;
  now: number;
  /** Revalidated atomically with proof consumption/activation. */
  sessions?: readonly IdentityMergeSessionRequirement[];
  emailProofs?: readonly AccountEmailProofRecord[];
  receipt?: IdentityOperationReceiptRecord;
  proofReceipts?: readonly IdentityOperationReceiptRecord[];
  reserve?: boolean;
  retryCapacity?: number;
  activate?: boolean;
  quarantine?: boolean;
  restore?: boolean;
  abort?: boolean;
  requireRecovery?: boolean;
}

export interface UnlinkUpstreamIdentityInput {
  subject: TakosumiSubject;
  identity: Pick<
    UpstreamIdentityRecord,
    "providerId" | "upstreamIssuer" | "upstreamSubject"
  >;
  proof: IdentityMergeSessionRequirement;
  operationId: string;
  now: number;
}

export interface IdentityMergeRetryCheckpoint {
  revision: number;
  mutationId: string;
  cursor?: string;
  leaseId?: string;
  leaseExpiresAt?: number;
  nextPollAt?: number;
  updatedAt: number;
}
export interface IdentityMergeRetryPage {
  operations: readonly IdentityMergeOperation[];
  nextCursor?: string;
}
export interface IdentityMergeRetryCheckpointMutation {
  key: string;
  expectedRevision?: number;
  next: IdentityMergeRetryCheckpoint;
}

/** Optional ports keep ordinary self-host Accounts independent of hosted mode. */
export interface HostedIdentityStore {
  createCredentialUnlinkIntent?(
    record: CredentialUnlinkIntent,
  ): boolean | Promise<boolean>;
  findCredentialUnlinkIntent?(
    operationId: string,
  ):
    | CredentialUnlinkIntent
    | undefined
    | Promise<CredentialUnlinkIntent | undefined>;
  createCredentialUnlinkReceipt?(
    record: CredentialUnlinkReceipt,
  ): boolean | Promise<boolean>;
  findCredentialUnlinkReceipt?(
    receiptId: string,
  ):
    | CredentialUnlinkReceipt
    | undefined
    | Promise<CredentialUnlinkReceipt | undefined>;
  completeCredentialUnlink?(
    input: CredentialUnlinkMutation,
  ): boolean | Promise<boolean>;
  listIdentityMergeOperations?(input: {
    after?: string;
    limit: number;
  }): IdentityMergeRetryPage | Promise<IdentityMergeRetryPage>;
  findIdentityMergeRetryCheckpoint?(
    key: string,
  ):
    | IdentityMergeRetryCheckpoint
    | undefined
    | Promise<IdentityMergeRetryCheckpoint | undefined>;
  compareAndSetIdentityMergeRetryCheckpoint?(
    input: IdentityMergeRetryCheckpointMutation,
  ): boolean | Promise<boolean>;
  findHostedAccountSessionAnchor?(
    sessionId: string,
  ): string | undefined | Promise<string | undefined>;
  createIdentityOperationReceipt?(
    record: IdentityOperationReceiptRecord,
  ): boolean | Promise<boolean>;
  findIdentityOperationReceipt?(
    receiptId: string,
  ):
    | IdentityOperationReceiptRecord
    | undefined
    | Promise<IdentityOperationReceiptRecord | undefined>;
  isHostedOidcSessionHashRevoked?(
    issuerSessionHash: string,
  ): boolean | Promise<boolean>;
  listCanonicalUpstreamIdentities?(
    subject: TakosumiSubject,
  ):
    | readonly UpstreamIdentityRecord[]
    | Promise<readonly UpstreamIdentityRecord[]>;
  getAccountAuthenticationGeneration?(
    subject: TakosumiSubject,
  ): number | Promise<number>;
  hashAccountSessionId?(sessionId: string): string | Promise<string>;
  isHostedOidcClientRevoked?(clientId: string): boolean | Promise<boolean>;
  isHostedOidcSessionRevoked?(
    issuerSessionId: string,
  ): boolean | Promise<boolean>;
  saveAccountEmailProof?(record: AccountEmailProofRecord): void | Promise<void>;
  findAccountEmailProof?(
    subject: TakosumiSubject,
  ):
    | AccountEmailProofRecord
    | undefined
    | Promise<AccountEmailProofRecord | undefined>;
  findAccountsByEmailCandidate?(
    address: string,
  ):
    | readonly TakosumiAccountRecord[]
    | Promise<readonly TakosumiAccountRecord[]>;
  findCanonicalAccount?(
    subject: TakosumiSubject,
  ):
    | TakosumiAccountRecord
    | undefined
    | Promise<TakosumiAccountRecord | undefined>;
  isAccountAuthenticationFenced?(
    subject: TakosumiSubject,
  ): boolean | Promise<boolean>;
  findUpstreamIdentityStatus?(
    identity: Pick<
      UpstreamIdentityRecord,
      "providerId" | "upstreamIssuer" | "upstreamSubject"
    >,
  ):
    | UpstreamIdentityStatusRecord
    | undefined
    | Promise<UpstreamIdentityStatusRecord | undefined>;
  saveUpstreamLoginTransaction?(
    record: UpstreamLoginTransactionRecord,
  ): void | Promise<void>;
  consumeUpstreamLoginTransaction?(
    id: string,
    browserBindingHash: string,
    now: number,
  ):
    | UpstreamLoginTransactionRecord
    | undefined
    | Promise<UpstreamLoginTransactionRecord | undefined>;
  saveHostedOidcGrant?(record: HostedOidcGrantRecord): void | Promise<void>;
  findHostedOidcGrant?(
    sid: string,
  ):
    | HostedOidcGrantRecord
    | undefined
    | Promise<HostedOidcGrantRecord | undefined>;
  findHostedOidcGrantForSession?(input: {
    issuerSessionId: string;
    clientId: string;
    subject: TakosumiSubject;
  }):
    | HostedOidcGrantRecord
    | undefined
    | Promise<HostedOidcGrantRecord | undefined>;
  findHostedOidcGrantForCode?(
    authorizationCodeHash: string,
  ):
    | HostedOidcGrantRecord
    | undefined
    | Promise<HostedOidcGrantRecord | undefined>;
  revokeHostedOidcGrant?(sid: string, now: number): void | Promise<void>;
  revokeHostedOidcSessionGrants?(
    issuerSessionId: string,
    now: number,
  ): void | Promise<void>;
  revokeHostedOidcClientGrants?(
    clientId: string,
    now: number,
  ): void | Promise<void>;
  touchHostedAccountSession?(
    sessionId: string,
    now: number,
    idleExpiresAt: number,
  ): boolean | Promise<boolean>;
  createIdentityMergeOperation?(
    record: IdentityMergeOperation,
  ): boolean | Promise<boolean>;
  findIdentityMergeOperation?(
    operationId: string,
  ):
    | IdentityMergeOperation
    | undefined
    | Promise<IdentityMergeOperation | undefined>;
  compareAndSetIdentityMerge?(
    input: IdentityMergeMutation,
  ): boolean | Promise<boolean>;
  unlinkCanonicalUpstreamIdentity?(
    input: UnlinkUpstreamIdentityInput,
  ): boolean | Promise<boolean>;
}

export function upstreamIdentityKey(
  identity: Pick<
    UpstreamIdentityRecord,
    "providerId" | "upstreamIssuer" | "upstreamSubject"
  >,
): string {
  return JSON.stringify([
    identity.providerId,
    identity.upstreamIssuer,
    identity.upstreamSubject,
  ]);
}

/** Conservative matching: preserve ASCII local case and aliases, IDNA domain only. */
export function normalizeMergeEmail(value: string): string | undefined {
  const address = value.trim();
  const at = address.lastIndexOf("@");
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  if (
    at < 1 ||
    at !== address.indexOf("@") ||
    local.length > 64 ||
    !/^[\x21-\x7e]+$/.test(local) ||
    /[<>(),:;\\[\]\"]/.test(local) ||
    !domain ||
    /[\s/:?#@]/.test(domain)
  )
    return undefined;
  try {
    const host = new URL(`https://${domain}`).hostname;
    if (
      !host ||
      host.startsWith("[") ||
      host.endsWith(".") ||
      !host.includes(".")
    )
      return undefined;
    return `${local}@${host.toLowerCase()}`;
  } catch {
    return undefined;
  }
}
