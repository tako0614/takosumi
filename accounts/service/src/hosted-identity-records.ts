import { consumeFinancialSourcePrecommitCheckpoint } from "./financial-source.ts";
import type * as FS from "./identity-state.ts";
import type { FinancialSourceRegistration, FinancialSourceReceiptRecord } from "./financial-source-contract.ts";
import { canonicalFinancialSourceJson, financialSourceRef, financialSourceDigest, parseFinancialSourceRegistration, parseFinancialSourceRawEvent, parseFinancialSourceReceipt, parseFinancialIdentityChallenge, materializeFinancialSourceEvent, financialReceiptMatches } from "./financial-source-contract.ts";
import type {
  IdentityMergeContextPlanRecord,
  IdentityMergeContextReceipt,
  IdentityMergeLock,
} from "./identity-context-state.ts";
import type {
  CredentialUnlinkIntent,
  CredentialUnlinkReceipt,
  CredentialUnlinkMutation,
} from "./identity-unlink-state.ts";
import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";
import type {
  AccountsStore,
  TakosumiAccountRecord,
  UpstreamIdentityRecord,
  AccountSessionRecord,
} from "./store.ts";
import type {
  IdentityOperationReceiptRecord,
  AccountEmailProofRecord,
  HostedIdentityStore,
  HostedOidcGrantRecord,
  IdentityMergeRetryCheckpoint,
  IdentityMergeRetryPage,
  IdentityMergeRetryCheckpointMutation,
  IdentityMergeMutation,
  IdentityMergeOperation,
  UnlinkUpstreamIdentityInput,
  UpstreamIdentityStatusRecord,
  UpstreamLoginTransactionRecord,
} from "./identity-state.ts";
import { upstreamIdentityKey } from "./identity-state.ts";
import type { OwnerOperationContextEvidence, OwnerOperationReceiptEvidence } from "./owner-operation-contract.ts";
import type { ReviewedRecoveryApprovalRecord, ReviewedRecoveryApprovalPointer, ReviewedRecoveryApprovalMutation } from "./reviewed-recovery-state.ts";
import { ownerContextBucket, ownerReceiptBucket, ownerContextKey, ownerReceiptKey, reviewedApprovalBucket, reviewedApprovalCurrentBucket, reviewedApprovalRefBucket, reviewedApprovalRefKey, canonicalOwnerJson, digest, boundedText, validOwnerTarget, validOwnerContextEvidence, validOwnerReceiptEvidence, OwnerOperationEvidenceConflict, type OwnerOperationContextEvidenceLookup, type OwnerOperationReceiptEvidenceLookup } from "./owner-operation-evidence.ts";
import { validReviewedRecoveryMutation, validReviewedRecoveryRecord } from "./reviewed-recovery-approvals.ts";

export interface IdentityRecordRepository {
  registerFinancialSourceRegistration(registration: import("./financial-source-contract.ts").FinancialSourceRegistration): Promise<boolean>;
  findFinancialSourceRegistration(registrationRef: string): Promise<import("./financial-source-contract.ts").FinancialSourceRegistration | undefined>;
  findFinancialSourceParent(scope: import("./identity-state.ts").FinancialSourceParentScope): Promise<import("./identity-state.ts").FinancialSourceParentHead | undefined>;
  enrollFinancialSourceParents(input: import("./identity-state.ts").FinancialSourceEnrollmentMutation): Promise<import("./identity-state.ts").FinancialSourceParentVector<import("./identity-state.ts").FinancialSourceParentHead> | undefined>;
  issueFinancialSourceProof(input: import("./identity-state.ts").FinancialSourceProofMutation): Promise<import("./identity-state.ts").FinancialSourceProofRecord | undefined>;
  findFinancialSourceProof(proofRef: string): Promise<import("./identity-state.ts").FinancialSourceProofRecord | undefined>;
  findFinancialSourceProofsForOriginalRequest(input: FS.FinancialSourceProofLookup): Promise<readonly FS.FinancialSourceProofRecord[]>;
  revokeHostedOidcScope(input: import("./identity-state.ts").FinancialSourceRevocationMutation): Promise<boolean>;
  findFinancialSourceRaw(eventRef: string): Promise<import("./identity-state.ts").FinancialSourceRawRecord | undefined>;
  listFinancialSourcePending(input: { readonly registrationRef: string; readonly after?: string; readonly limit: number }): Promise<import("./identity-state.ts").FinancialSourcePendingPage>;
  findFinancialSourceMaterialization(eventRef: string): Promise<import("./identity-state.ts").FinancialSourceMaterializationRecord | undefined>;
  commitFinancialSourceMaterialization(input: import("./identity-state.ts").FinancialSourceMaterializationMutation): Promise<boolean>;
  findFinancialSourceReceipt(input: { readonly registrationRef: string; readonly eventRef: string; readonly receiverRef: string }): Promise<import("./financial-source-contract.ts").FinancialSourceReceiptRecord | undefined>;
  recordFinancialSourceReceipt(input: import("./identity-state.ts").FinancialSourceReceiptMutation): Promise<boolean>;
  commitReviewedRecoveryApproval(input: ReviewedRecoveryApprovalMutation): Promise<boolean>;
  listIdentities(
    subject: TakosumiSubject,
  ): Promise<readonly UpstreamIdentityRecord[]>;
  get<T>(bucket: string, key: string): Promise<T | undefined>;
  put(bucket: string, key: string, record: unknown): Promise<void>;
  create(bucket: string, key: string, record: unknown): Promise<boolean>;
  consume<T>(
    bucket: string,
    key: string,
    binding: string,
    now: number,
  ): Promise<T | undefined>;
  query<T>(
    bucket: string,
    field: string,
    value: string,
    limit: number,
  ): Promise<readonly T[]>;
  revokeGrants(
    field: "issuerSessionId" | "clientId" | "sid",
    value: string,
    now: number,
  ): Promise<void>;
  page<T>(
    bucket: string,
    after: string | undefined,
    limit: number,
  ): Promise<readonly { key: string; record: T }[]>;
  compareAndSetCheckpoint(
    input: IdentityMergeRetryCheckpointMutation,
  ): Promise<boolean>;
  completeUnlink(input: CredentialUnlinkMutation): Promise<boolean>;
  mutateMerge(input: IdentityMergeMutation): Promise<boolean>;
  unlink(input: UnlinkUpstreamIdentityInput): Promise<boolean>;
  touchSession(
    sessionId: string,
    now: number,
    idleExpiresAt: number,
  ): Promise<boolean>;
  emailCandidates(address: string): Promise<readonly TakosumiAccountRecord[]>;
}

/** Common hosted semantics; backend mutations remain atomic SQL operations. */
export class HostedIdentityRecords implements HostedIdentityStore {
  constructor(
    readonly repository: IdentityRecordRepository,
    readonly accounts: Pick<AccountsStore, "findAccount">,
  ) {}
  registerFinancialSourceRegistration(value: FinancialSourceRegistration) { return this.repository.registerFinancialSourceRegistration(value); }
  findFinancialSourceRegistration(value: string) { return this.repository.findFinancialSourceRegistration(value); }
  findFinancialSourceParent(value: FS.FinancialSourceParentScope) { return this.repository.findFinancialSourceParent(value); }
  enrollFinancialSourceParents(value: FS.FinancialSourceEnrollmentMutation) { return this.repository.enrollFinancialSourceParents(value); }
  issueFinancialSourceProof(value: FS.FinancialSourceProofMutation) { return this.repository.issueFinancialSourceProof(value); }
  findFinancialSourceProof(value: string) { return this.repository.findFinancialSourceProof(value); }
  findFinancialSourceProofsForOriginalRequest(value: FS.FinancialSourceProofLookup) { return this.repository.findFinancialSourceProofsForOriginalRequest(value); }
  revokeHostedOidcScope(value: FS.FinancialSourceRevocationMutation) { return this.repository.revokeHostedOidcScope(value); }
  findFinancialSourceRaw(value: string) { return this.repository.findFinancialSourceRaw(value); }
  listFinancialSourcePending(value: { readonly registrationRef: string; readonly after?: string; readonly limit: number }) { return this.repository.listFinancialSourcePending(value); }
  findFinancialSourceMaterialization(value: string) { return this.repository.findFinancialSourceMaterialization(value); }
  commitFinancialSourceMaterialization(value: FS.FinancialSourceMaterializationMutation) { return this.repository.commitFinancialSourceMaterialization(value); }
  findFinancialSourceReceipt(value: { readonly registrationRef: string; readonly eventRef: string; readonly receiverRef: string }) { return this.repository.findFinancialSourceReceipt(value); }
  recordFinancialSourceReceipt(value: FS.FinancialSourceReceiptMutation) { return this.repository.recordFinancialSourceReceipt(value); }
  async createOwnerOperationContextEvidence(value: OwnerOperationContextEvidence): Promise<boolean> {
    const record = structuredClone(value);
    if (!await validOwnerContextEvidence(record)) return false;
    const key = ownerContextKey(record.context);
    if (await this.repository.create(ownerContextBucket, key, record)) return true;
    return canonicalOwnerJson(await this.repository.get(ownerContextBucket, key)) === canonicalOwnerJson(record);
  }
  async findOwnerOperationContextEvidence(input: OwnerOperationContextEvidenceLookup): Promise<OwnerOperationContextEvidence | undefined> {
    if (!validOwnerTarget(input.target)) return undefined;
    const record = await this.repository.get<OwnerOperationContextEvidence>(ownerContextBucket, ownerContextKey(input));
    if (!record) return undefined;
    if (!await validOwnerContextEvidence(record) || canonicalOwnerJson(record.target) !== canonicalOwnerJson(input.target) || ownerContextKey(record.context) !== ownerContextKey(input)) throw new OwnerOperationEvidenceConflict();
    return structuredClone(record);
  }
  async createOwnerOperationReceiptEvidence(value: OwnerOperationReceiptEvidence): Promise<boolean> {
    const record = structuredClone(value);
    const parent = await this.repository.get<OwnerOperationContextEvidence>(ownerContextBucket, ownerContextKey(record.receipt));
    if (!parent || !await validOwnerContextEvidence(parent) || !validOwnerReceiptEvidence(record, parent)) return false;
    const key = ownerReceiptKey(record);
    if (await this.repository.create(ownerReceiptBucket, key, record)) return true;
    return canonicalOwnerJson(await this.repository.get(ownerReceiptBucket, key)) === canonicalOwnerJson(record);
  }
  async findOwnerOperationReceiptEvidence(input: OwnerOperationReceiptEvidenceLookup): Promise<OwnerOperationReceiptEvidence | undefined> {
    const record = await this.repository.get<OwnerOperationReceiptEvidence>(ownerReceiptBucket, ownerReceiptKey(input));
    if (!record) return undefined;
    if (ownerReceiptKey(record) !== ownerReceiptKey(input)) throw new OwnerOperationEvidenceConflict();
    const parent = await this.repository.get<OwnerOperationContextEvidence>(ownerContextBucket, ownerContextKey(record.receipt));
    if (!parent || !await validOwnerContextEvidence(parent) || !validOwnerReceiptEvidence(record, parent)) throw new OwnerOperationEvidenceConflict();
    return structuredClone(record);
  }
  async findReviewedRecoveryApproval(hash: string): Promise<ReviewedRecoveryApprovalRecord | undefined> {
    if (!digest(hash)) return undefined;
    const record = await this.repository.get<ReviewedRecoveryApprovalRecord>(reviewedApprovalBucket, hash);
    return record && record.approvalDigest === hash && await validReviewedRecoveryRecord(record) ? structuredClone(record) : undefined;
  }
  async findCurrentReviewedRecoveryApproval(operationId: string): Promise<ReviewedRecoveryApprovalPointer | undefined> {
    if (!boundedText(operationId)) return undefined;
    const p = await this.repository.get<ReviewedRecoveryApprovalPointer>(reviewedApprovalCurrentBucket, operationId);
    return p?.operationId === operationId && digest(p.approvalDigest) && Number.isSafeInteger(p.revision) && p.revision >= 0 && boundedText(p.mutationId) && Number.isSafeInteger(p.updatedAt) && p.updatedAt >= 0 ? structuredClone(p) : undefined;
  }
  async findReviewedRecoveryApprovalByRef(input: {operationId:string;recoveryId:string;reviewedApprovalRef:string}): Promise<string | undefined> {
    const r = await this.repository.get<{operationId:string;recoveryId:string;reviewedApprovalRef:string;approvalDigest:string}>(reviewedApprovalRefBucket, reviewedApprovalRefKey(input));
    return r && r.operationId === input.operationId && r.recoveryId === input.recoveryId && r.reviewedApprovalRef === input.reviewedApprovalRef && digest(r.approvalDigest) ? r.approvalDigest : undefined;
  }
  async compareAndSetReviewedRecoveryApproval(value: ReviewedRecoveryApprovalMutation): Promise<boolean> {
    const input = structuredClone(value);
    if (!await validReviewedRecoveryMutation(input)) return false;
    const old = await this.repository.get<ReviewedRecoveryApprovalPointer>(reviewedApprovalCurrentBucket, input.pointer.operationId);
    if (old && (!digest(old.approvalDigest) || old.operationId !== input.pointer.operationId || !Number.isSafeInteger(old.revision) || !boundedText(old.mutationId))) return false;
    const history = await this.repository.get<ReviewedRecoveryApprovalRecord>(reviewedApprovalBucket, input.record.approvalDigest);
    if (history && (!await validReviewedRecoveryRecord(history) || canonicalOwnerJson(history) !== canonicalOwnerJson(input.record))) return false;
    const ref = await this.repository.get<{operationId:string;recoveryId:string;reviewedApprovalRef:string;approvalDigest:string}>(reviewedApprovalRefBucket, reviewedApprovalRefKey(input.record.approval));
    if (ref && (ref.operationId !== input.record.approval.operationId || ref.recoveryId !== input.record.approval.recoveryId || ref.reviewedApprovalRef !== input.record.approval.reviewedApprovalRef || ref.approvalDigest !== input.record.approvalDigest)) return false;
    return this.repository.commitReviewedRecoveryApproval(input);
  }
  createCredentialUnlinkAuthorityTicket(
    record: import("./identity-context-state.ts").CredentialUnlinkAuthorityTicket,
  ): Promise<boolean> {
    return this.repository.create(
      "credential_unlink_authority_tickets",
      record.operationId,
      record,
    );
  }
  findCredentialUnlinkAuthorityTicket(
    operationId: string,
  ): Promise<
    | import("./identity-context-state.ts").CredentialUnlinkAuthorityTicket
    | undefined
  > {
    return this.repository.get(
      "credential_unlink_authority_tickets",
      operationId,
    );
  }
  createIdentityMergeContextPlan(
    record: IdentityMergeContextPlanRecord,
  ): Promise<boolean> {
    return this.repository.create(
      "identity_merge_context_plans",
      record.planId,
      record,
    );
  }
  findIdentityMergeContextPlan(
    planId: string,
  ): Promise<IdentityMergeContextPlanRecord | undefined> {
    return this.repository.get("identity_merge_context_plans", planId);
  }
  createIdentityMergeContextReceipt(
    record: IdentityMergeContextReceipt,
  ): Promise<boolean> {
    if (!/^sha256:[A-Za-z0-9_-]{43}$/u.test(record.issuerSessionHash))
      throw new TypeError("invalid_context_session_hash");
    return this.repository.create(
      "identity_merge_context_receipts",
      record.receiptId,
      record,
    );
  }
  findIdentityMergeContextReceipt(
    receiptId: string,
  ): Promise<IdentityMergeContextReceipt | undefined> {
    return this.repository.get("identity_merge_context_receipts", receiptId);
  }
  findIdentityMergeLock(
    subject: TakosumiSubject,
  ): Promise<IdentityMergeLock | undefined> {
    return this.repository.get("identity_merge_locks", subject);
  }
  async rememberHostedAccountSessionAnchor(
    sessionLookupHash: string,
    record: AccountSessionRecord,
  ): Promise<void> {
    if (record.policy !== "hosted" || !record.issuerSessionId) return;
    if (!record.issuerSessionId.startsWith("sha256:"))
      throw new TypeError("invalid_issuer_session_anchor");
    const anchor = {
      subject: record.subject,
      issuerSessionHash: record.issuerSessionId,
      retentionExpiresAt:
        (record.absoluteExpiresAt ?? record.expiresAt) + 30 * 86400000 + 60000,
    };
    if (
      !(await this.repository.create(
        "hosted_session_anchors",
        sessionLookupHash,
        anchor,
      ))
    ) {
      const prior = await this.repository.get<{ issuerSessionHash: string }>(
        "hosted_session_anchors",
        sessionLookupHash,
      );
      if (prior?.issuerSessionHash !== anchor.issuerSessionHash)
        throw new Error("issuer_session_anchor_conflict");
    }
  }
  async findHostedAccountSessionAnchor(
    sessionLookupHash: string,
  ): Promise<string | undefined> {
    return (
      await this.repository.get<{ issuerSessionHash: string }>(
        "hosted_session_anchors",
        sessionLookupHash,
      )
    )?.issuerSessionHash;
  }
  async createIdentityOperationReceipt(
    record: IdentityOperationReceiptRecord,
  ): Promise<boolean> {
    if (
      !record.issuerSessionHash.startsWith("sha256:") ||
      record.legConsent !== true ||
      !["source", "target"].includes(record.role)
    )
      throw new TypeError("invalid_operation_receipt");
    return this.repository.create(
      "identity_operation_receipts",
      record.receiptId,
      record,
    );
  }
  findIdentityOperationReceipt(
    receiptId: string,
  ): Promise<IdentityOperationReceiptRecord | undefined> {
    return this.repository.get("identity_operation_receipts", receiptId);
  }
  async isHostedOidcSessionHashRevoked(
    issuerSessionHash: string,
  ): Promise<boolean> {
    return (
      (await this.repository.get(
        "hosted_oidc_revoked_sessions",
        issuerSessionHash,
      )) !== undefined
    );
  }
  listCanonicalUpstreamIdentities(
    subject: TakosumiSubject,
  ): Promise<readonly UpstreamIdentityRecord[]> {
    return this.repository.listIdentities(subject);
  }
  async getAccountAuthenticationGeneration(
    subject: TakosumiSubject,
  ): Promise<number> {
    const record = await this.repository.get<{ generation: number }>(
      "authentication_generations",
      subject,
    );
    return record?.generation ?? 0;
  }
  saveAccountEmailProof(record: AccountEmailProofRecord): Promise<void> {
    return this.repository.put("account_email_proofs", record.subject, record);
  }
  findAccountEmailProof(
    subject: TakosumiSubject,
  ): Promise<AccountEmailProofRecord | undefined> {
    return this.repository.get("account_email_proofs", subject);
  }
  findAccountsByEmailCandidate(
    address: string,
  ): Promise<readonly TakosumiAccountRecord[]> {
    return this.repository.emailCandidates(address);
  }
  async findCanonicalAccount(
    subject: TakosumiSubject,
  ): Promise<TakosumiAccountRecord | undefined> {
    const mapping = await this.repository.get<{
      targetSubject: TakosumiSubject;
    }>("canonical_accounts", subject);
    // Never follow chains. Merging an already merged root is a reviewed recovery.
    const canonical = mapping?.targetSubject ?? subject;
    if (mapping && (await this.repository.get("canonical_accounts", canonical)))
      return undefined;
    return await this.accounts.findAccount(canonical);
  }
  async isAccountAuthenticationFenced(
    subject: TakosumiSubject,
  ): Promise<boolean> {
    const lock = await this.repository.get<{ operationId: string }>(
      "identity_merge_locks",
      subject,
    );
    if (!lock) return false;
    const operation = await this.findIdentityMergeOperation(lock.operationId);
    return !operation || operation.status !== "active";
  }
  findUpstreamIdentityStatus(
    identity: Parameters<typeof upstreamIdentityKey>[0],
  ): Promise<UpstreamIdentityStatusRecord | undefined> {
    return this.repository.get(
      "upstream_identity_status",
      upstreamIdentityKey(identity),
    );
  }
  saveUpstreamLoginTransaction(
    record: UpstreamLoginTransactionRecord,
  ): Promise<void> {
    return this.repository.put(
      "upstream_login_transactions",
      record.id,
      record,
    );
  }
  consumeUpstreamLoginTransaction(
    id: string,
    browserBindingHash: string,
    now: number,
  ): Promise<UpstreamLoginTransactionRecord | undefined> {
    return this.repository.consume(
      "upstream_login_transactions",
      id,
      browserBindingHash,
      now,
    );
  }
  async saveHostedOidcGrant(record: HostedOidcGrantRecord): Promise<void> {
    // A SID is immutable. In particular a caller cannot clear a revocation.
    if (
      !(await this.repository.create("hosted_oidc_grants", record.sid, record))
    ) {
      const prior = await this.findHostedOidcGrant(record.sid);
      if (JSON.stringify(prior) !== JSON.stringify(record))
        throw new Error("hosted_grant_conflict");
    }
  }
  findHostedOidcGrant(sid: string): Promise<HostedOidcGrantRecord | undefined> {
    return this.repository.get("hosted_oidc_grants", sid);
  }
  async findHostedOidcGrantForSession(input: {
    issuerSessionId: string;
    clientId: string;
    subject: TakosumiSubject;
  }): Promise<HostedOidcGrantRecord | undefined> {
    const records = await this.repository.query<HostedOidcGrantRecord>(
      "hosted_oidc_grants",
      "issuerSessionId",
      input.issuerSessionId,
      101,
    );
    if (records.length > 100) return undefined;
    return records.find(
      (r) =>
        r.clientId === input.clientId &&
        r.subject === input.subject &&
        r.revokedAt === undefined,
    );
  }
  async findHostedOidcGrantForCode(
    authorizationCodeHash: string,
  ): Promise<HostedOidcGrantRecord | undefined> {
    const records = await this.repository.query<HostedOidcGrantRecord>(
      "hosted_oidc_grants",
      "authorizationCodeHash",
      authorizationCodeHash,
      2,
    );
    return records.length === 1 ? records[0] : undefined;
  }
  async revokeHostedOidcGrant(sid: string, now: number): Promise<void> {
    if(!await this.repository.revokeHostedOidcScope({scope:{kind:"grant",sid},evidenceRef:crypto.randomUUID(),now}))throw new Error("hosted_grant_revoke_failed");
  }
  async isHostedOidcSessionRevoked(issuerSessionId: string): Promise<boolean> {
    return (
      (await this.repository.get(
        "hosted_oidc_revoked_sessions",
        issuerSessionId,
      )) !== undefined
    );
  }
  async revokeHostedOidcSessionGrants(
    issuerSessionId: string,
    now: number,
  ): Promise<void> {
    if(!await this.repository.revokeHostedOidcScope({scope:{kind:"issuer-session",issuerSessionId},evidenceRef:crypto.randomUUID(),now}))throw new Error("hosted_session_revoke_failed");
  }
  async isHostedOidcClientRevoked(clientId: string): Promise<boolean> {
    return (
      (await this.repository.get("hosted_oidc_revoked_clients", clientId)) !==
      undefined
    );
  }
  async revokeHostedOidcClientGrants(
    clientId: string,
    now: number,
  ): Promise<void> {
    if(!await this.repository.revokeHostedOidcScope({scope:{kind:"client",clientId},evidenceRef:crypto.randomUUID(),now}))throw new Error("hosted_client_revoke_failed");
  }
  touchHostedAccountSession(
    sessionId: string,
    now: number,
    idleExpiresAt: number,
  ): Promise<boolean> {
    return this.repository.touchSession(sessionId, now, idleExpiresAt);
  }
  createCredentialUnlinkIntent(
    record: CredentialUnlinkIntent,
  ): Promise<boolean> {
    return this.repository.create(
      "credential_unlink_intents",
      record.operationId,
      record,
    );
  }
  findCredentialUnlinkIntent(
    operationId: string,
  ): Promise<CredentialUnlinkIntent | undefined> {
    return this.repository.get("credential_unlink_intents", operationId);
  }
  createCredentialUnlinkReceipt(
    record: CredentialUnlinkReceipt,
  ): Promise<boolean> {
    return this.repository.create(
      "credential_unlink_receipts",
      record.receiptId,
      record,
    );
  }
  findCredentialUnlinkReceipt(
    receiptId: string,
  ): Promise<CredentialUnlinkReceipt | undefined> {
    return this.repository.get("credential_unlink_receipts", receiptId);
  }
  completeCredentialUnlink(input: CredentialUnlinkMutation): Promise<boolean> {
    return this.repository.completeUnlink(input);
  }
  async listIdentityMergeOperations(input: {
    after?: string;
    limit: number;
  }): Promise<IdentityMergeRetryPage> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)
      throw new TypeError("invalid_merge_retry_limit");
    const rows = await this.repository.page<{ operationId: string }>(
      "identity_merge_retry_pending",
      input.after,
      input.limit + 1,
    );
    const operations = await Promise.all(
      rows
        .slice(0, input.limit)
        .map((r) => this.findIdentityMergeOperation(r.key)),
    );
    return {
      operations: operations.filter(
        (op): op is IdentityMergeOperation => op !== undefined,
      ),
      ...(rows.length > input.limit
        ? { nextCursor: rows[input.limit - 1]!.key }
        : {}),
    };
  }

  findIdentityMergeRetryCheckpoint(
    key: string,
  ): Promise<IdentityMergeRetryCheckpoint | undefined> {
    return this.repository.get("identity_merge_retry_checkpoints", key);
  }
  compareAndSetIdentityMergeRetryCheckpoint(
    input: IdentityMergeRetryCheckpointMutation,
  ): Promise<boolean> {
    if (
      input.next.nextPollAt !== undefined &&
      (!Number.isSafeInteger(input.next.nextPollAt) ||
        input.next.nextPollAt < 0 ||
        input.next.nextPollAt > input.next.updatedAt + 60000)
    )
      throw new TypeError("invalid_merge_retry_checkpoint");
    if (
      !input.key ||
      !input.next.mutationId ||
      input.next.revision !==
        (input.expectedRevision === undefined
          ? 0
          : input.expectedRevision + 1) ||
      (input.next.leaseExpiresAt !== undefined &&
        (input.next.leaseExpiresAt < input.next.updatedAt ||
          input.next.leaseExpiresAt > input.next.updatedAt + 60000))
    )
      throw new TypeError("invalid_merge_retry_checkpoint");
    return this.repository.compareAndSetCheckpoint(input);
  }
  createIdentityMergeOperation(
    record: IdentityMergeOperation,
  ): Promise<boolean> {
    return this.repository.create(
      "identity_merge_operations",
      record.operationId,
      record,
    );
  }
  findIdentityMergeOperation(
    operationId: string,
  ): Promise<IdentityMergeOperation | undefined> {
    return this.repository.get("identity_merge_operations", operationId);
  }
  compareAndSetIdentityMerge(input: IdentityMergeMutation): Promise<boolean> {
    return this.repository.mutateMerge(input);
  }
  unlinkCanonicalUpstreamIdentity(
    input: UnlinkUpstreamIdentityInput,
  ): Promise<boolean> {
    return this.repository.unlink(input);
  }
}

export function identityMergeProofAudit(n: IdentityMergeOperation): unknown[] {
  return [n.sourceProof, n.targetProof]
    .filter((p) => p !== undefined)
    .map((p) => ({
      receiptId: p.receiptId,
      method: p.method,
      provedAt: p.provedAt,
      identityGeneration: p.identityGeneration,
      ...(p.legConsentAt !== undefined ? { legConsentAt: p.legConsentAt } : {}),
    }));
}

export function assertMergeMutation(input: IdentityMergeMutation): void {
  const next = input.next;
  if (
    input.contextReceipt &&
    (!input.contextPlanRecord ||
      input.contextReceipt.acceptedAt < input.contextPlanRecord.createdAt)
  )
    throw new TypeError("context_plan_acceptance_required");
  if (
    input.contextReceipts?.some(
      (r) =>
        !input.contextPlanRecord ||
        r.acceptedAt < input.contextPlanRecord.createdAt,
    )
  )
    throw new TypeError("context_plan_acceptance_required");
  if (
    (input.reserve || input.activate) &&
    (!next.contextPlan ||
      !next.sourceContextAcceptance ||
      !next.targetContextAcceptance ||
      input.contextReceipts?.length !== 2 ||
      !input.contextPlanRecord)
  )
    throw new TypeError("context_plan_acceptance_required");
  if (
    input.contextPlanRecord &&
    !identityContextPlanMatches(input.contextPlanRecord, next, input.now)
  )
    throw new TypeError("invalid_context_plan");
  if (
    input.contextReceipt &&
    (!identityContextReceiptMatches(
      input.contextReceipt,
      next,
      input.now,
      false,
    ) ||
      (input.contextReceipt.role === "source"
        ? next.sourceContextAcceptance
        : next.targetContextAcceptance
      )?.receiptId !== input.contextReceipt.receiptId)
  )
    throw new TypeError("invalid_context_acceptance");
  if (
    input.contextReceipts &&
    (new Set(input.contextReceipts.map((r) => r.role)).size !== 2 ||
      new Set(input.contextReceipts.map((r) => r.receiptId)).size !== 2)
  )
    throw new TypeError("invalid_context_acceptance");
  for (const receipt of input.contextReceipts ?? [])
    if (!identityContextReceiptMatches(receipt, next, input.now, true))
      throw new TypeError("invalid_context_acceptance");

  if (
    input.reserve &&
    (!Number.isInteger(input.retryCapacity) ||
      input.retryCapacity! < 1 ||
      input.retryCapacity! > 100)
  )
    throw new TypeError("invalid_identity_merge_retry_capacity");
  if (
    input.abort &&
    (next.status !== "aborted" ||
      !next.consentAt ||
      !next.undoOperationId ||
      !next.recoveryAcknowledgements?.preActivationRollback)
  )
    throw new TypeError("incomplete_identity_merge_abort");
  if (input.abort) {
    const a = next.recoveryAcknowledgements!;
    const r = a.preActivationRollback!;
    if (
      a.operationId !== next.operationId ||
      a.sourceSubject !== next.sourceSubject ||
      a.targetSubject !== next.targetSubject ||
      a.undoOperationId !== next.undoOperationId ||
      a.undoOperationId === next.operationId ||
      !a.reviewedRecoveryRef ||
      a.reconciledAt < next.createdAt ||
      a.reconciledAt > input.now ||
      ![
        a.externalBindings,
        a.workspaceMembership,
        a.billingLedger,
        a.consumerIntentCustody,
        a.rpSessions,
        a.personalWorkspaceId,
        r.externalBindings,
        r.workspaceMembership,
        r.billingLedger,
        r.rpSessions,
        r.consumerIntentCustody,
      ].every((v) => typeof v === "string" && v.length > 0 && v.length <= 256)
    )
      throw new TypeError("incomplete_identity_merge_abort");
  }
  if (
    input.requireRecovery &&
    (!next.consentAt ||
      !["proved", "reconciled"].includes(next.status) ||
      next.conflict !== "reviewed_recovery_required")
  )
    throw new TypeError("invalid_identity_merge_recovery_marker");
  if (
    next.revision !== input.expectedRevision + 1 ||
    !next.mutationId ||
    next.sourceSubject === next.targetSubject ||
    (input.sessions && input.sessions.length > 2)
  )
    throw new TypeError("invalid_identity_merge_mutation");
  if (
    input.restore &&
    (next.status !== "restored" ||
      !next.undoOperationId ||
      !next.recoveryAcknowledgements)
  )
    throw new TypeError("incomplete_identity_merge_recovery");
  if (
    input.activate &&
    (next.status !== "active" ||
      !next.sourceProof ||
      !next.targetProof ||
      !next.consentAt ||
      !next.acknowledgements)
  )
    throw new TypeError("incomplete_identity_merge_activation");
}

export function assertCredentialUnlinkMutation(
  input: CredentialUnlinkMutation,
): void {
  const { next: n, receipt: r, now } = input;
  const a = n.acknowledgement;
  const same = identityRecordsEqual;
  if (
    input.expectedRevision !== 0 ||
    n.revision !== 1 ||
    n.status !== "completed" ||
    n.receiptId !== r.receiptId ||
    r.consumedByOperation !== undefined ||
    r.method !== "upstream-oauth-operation" ||
    r.operationId !== n.operationId ||
    r.subject !== n.subject ||
    !same(r.removedIdentity, n.removedIdentity) ||
    !same(r.retainedIdentity, n.retainedIdentity) ||
    upstreamIdentityKey(n.removedIdentity) ===
      upstreamIdentityKey(n.retainedIdentity) ||
    r.browserBindingHash !== n.browserBindingHash ||
    r.issuerSessionHash !== n.issuerSessionHash ||
    r.identityGeneration !== n.identityGeneration ||
    r.policyVersion !== n.policyVersion ||
    r.legConsent !== true ||
    r.legConsentAt !== r.startedAt ||
    r.startedAt < n.createdAt ||
    r.completedAt < r.startedAt ||
    r.completedAt > now ||
    r.expiresAt <= now ||
    r.expiresAt > r.startedAt + 300000 ||
    r.expiresAt > n.expiresAt ||
    n.expiresAt <= now ||
    n.expiresAt > n.createdAt + 300000 ||
    !a ||
    a.operationId !== n.operationId ||
    a.subject !== n.subject ||
    !same(a.removedIdentity, n.removedIdentity) ||
    !same(a.retainedIdentity, n.retainedIdentity) ||
    a.receiptId !== r.receiptId ||
    a.identityGeneration !== n.identityGeneration ||
    !a.ownerRef ||
    a.ownerRef.length > 256 ||
    a.acknowledgedAt < r.completedAt ||
    a.acknowledgedAt > now ||
    !n.issuerSessionHash.startsWith("sha256:")
  )
    throw new TypeError("invalid_credential_unlink_mutation");
}
export function unlinkImmutableContext(n: CredentialUnlinkIntent): unknown {
  const {
    status: _status,
    revision: _revision,
    updatedAt: _updatedAt,
    receiptId: _receiptId,
    acknowledgement: _ack,
    ...immutable
  } = n;
  return immutable;
}
export function credentialUnlinkAudit(
  input: CredentialUnlinkMutation,
): unknown {
  return {
    operationId: input.next.operationId,
    subject: input.next.subject,
    decision: "credential_unlinked",
    removedIdentity: input.next.removedIdentity,
    retainedIdentity: input.next.retainedIdentity,
    receiptId: input.receipt.receiptId,
    method: input.receipt.method,
    provedAt: input.receipt.completedAt,
    legConsentAt: input.receipt.legConsentAt,
    identityGeneration: input.receipt.identityGeneration,
    ownerRef: input.next.acknowledgement?.ownerRef,
    at: input.now,
  };
}

export function identityRecordsEqual(a: unknown, b: unknown): boolean {
  const canonical = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canonical)
      : v !== null && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, v]) => [k, canonical(v)]),
          )
        : v;
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

export function identityContextPlanMatches(
  p: IdentityMergeContextPlanRecord,
  n: IdentityMergeOperation,
  now: number,
): boolean {
  const b = n.contextPlan;
  return (
    !!b &&
    p.operationId === n.operationId &&
    p.sourceSubject === n.sourceSubject &&
    p.targetSubject === n.targetSubject &&
    p.sourceProofReceiptId === n.sourceProof?.receiptId &&
    p.targetProofReceiptId === n.targetProof?.receiptId &&
    p.sourceIdentityGeneration === n.sourceProof.identityGeneration &&
    p.targetIdentityGeneration === n.targetProof.identityGeneration &&
    p.browserBindingHash === n.browserBindingHash &&
    p.policyVersion === n.policyVersion &&
    p.planId === b.planId &&
    p.planDigest === b.planDigest &&
    p.planningRevision === b.planningRevision &&
    p.authorityVersion === b.authorityVersion &&
    p.authorityId === b.authorityId &&
    p.canonicalPersonalWorkspaceId === b.canonicalPersonalWorkspaceId &&
    p.createdAt >= n.createdAt &&
    p.createdAt <= now &&
    p.expiresAt > now &&
    p.expiresAt <= n.expiresAt &&
    p.controlPlan.digest === p.planDigest &&
    p.controlPlan.operationId === n.operationId
  );
}
export function identityContextReceiptMatches(
  r: IdentityMergeContextReceipt,
  n: IdentityMergeOperation,
  now: number,
  consumed: boolean,
): boolean {
  const b = n.contextPlan;
  if (!b || !["source", "target"].includes(r.role)) return false;
  const proof = r.role === "source" ? n.sourceProof : n.targetProof;
  const a =
    r.role === "source" ? n.sourceContextAcceptance : n.targetContextAcceptance;
  return (
    r.operationId === n.operationId &&
    r.subject === (r.role === "source" ? n.sourceSubject : n.targetSubject) &&
    r.sourceSubject === n.sourceSubject &&
    r.targetSubject === n.targetSubject &&
    r.planId === b.planId &&
    r.planDigest === b.planDigest &&
    r.planningRevision === b.planningRevision &&
    r.proofReceiptId === proof?.receiptId &&
    r.identityGeneration === proof.identityGeneration &&
    r.browserBindingHash === n.browserBindingHash &&
    r.policyVersion === n.policyVersion &&
    r.acceptedAt >= n.createdAt &&
    r.acceptedAt >= proof.provedAt &&
    r.acceptedAt <= now &&
    r.expiresAt > now &&
    r.expiresAt <= n.expiresAt &&
    r.explicitContextConsent === true &&
    r.issuerSessionHash.startsWith("sha256:") &&
    (consumed
      ? r.consumedByOperation === n.operationId
      : r.consumedByOperation === undefined) &&
    (!consumed ||
      (a?.receiptId === r.receiptId &&
        a.planDigest === r.planDigest &&
        a.proofReceiptId === r.proofReceiptId &&
        a.identityGeneration === r.identityGeneration &&
        a.acceptedAt === r.acceptedAt))
  );
}

/** Shared document shape, not a source qualification or a second authority. */
export const financialSourceBuckets = Object.freeze({
  registrations: "financial_source_registrations", parents: "financial_source_parents",
  affected: "financial_source_affected", raw: "financial_source_raw", pending: "financial_source_pending",
  materializations: "financial_source_materializations", proofs: "financial_source_proofs", receipts: "financial_source_receipts",
});
export interface FinancialSourceParentEnvelope {
  readonly scope: FS.FinancialSourceParentScope;
  readonly closed: boolean;
  readonly head?: FS.FinancialSourceParentHead;
  readonly lastRaw?: FS.FinancialSourceRawRecord;
  readonly closureAttemptId?: string;
}
const financialSlots = ["grant", "issuerSession", "client", "accountGeneration"] as const;
function fsInstant(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function fsObject(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
function fsKeys(value: unknown, required: readonly string[], optional: readonly string[] = []): boolean { return fsObject(value) && required.every((k) => Object.hasOwn(value,k)) && Object.keys(value).every((k) => required.includes(k) || optional.includes(k)); }
export function financialSourceJson(value: unknown): string { return canonicalFinancialSourceJson(JSON.parse(JSON.stringify(value))); }
export function financialSourceEqual(a: unknown, b: unknown): boolean { try { return a === undefined || b === undefined ? a === b : financialSourceJson(a) === financialSourceJson(b); } catch { return false; } }
export function financialSourceScopeKey(scope: FS.FinancialSourceParentScope): string {
  let valid = false;
  if (scope?.kind === "grant") valid = fsKeys(scope,["kind","sid"]) && financialSourceRef(scope.sid);
  if (scope?.kind === "issuer-session") valid = fsKeys(scope,["kind","issuerSessionId"]) && financialSourceRef(scope.issuerSessionId);
  if (scope?.kind === "client") valid = fsKeys(scope,["kind","clientId"]) && financialSourceRef(scope.clientId);
  if (scope?.kind === "account-generation") valid = fsKeys(scope,["kind","subject","identityGeneration"]) && financialSourceRef(scope.subject) && fsInstant(scope.identityGeneration);
  if (!valid) throw new TypeError("invalid_financial_parent_scope");
  return canonicalFinancialSourceJson(scope);
}
export function financialSourcePendingKey(registrationRef: string, eventRef: string): string {
  if (![registrationRef,eventRef].every(financialSourceRef)) throw new TypeError("invalid_financial_pending_key");
  return canonicalFinancialSourceJson([registrationRef,eventRef]);
}
export function financialSourceReceiptKey(registrationRef: string, eventRef: string, receiverRef: string): string {
  if (![registrationRef,eventRef,receiverRef].every(financialSourceRef)) throw new TypeError("invalid_financial_receipt_key");
  return canonicalFinancialSourceJson([registrationRef,eventRef,receiverRef]);
}
export function financialSourceParentScopes(input: FS.FinancialSourceAuthoritySnapshot): FS.FinancialSourceParentVector<FS.FinancialSourceParentScope> {
  return { grant:{kind:"grant",sid:input.expectedGrant.sid}, issuerSession:{kind:"issuer-session",issuerSessionId:input.expectedGrant.issuerSessionId},
    client:{kind:"client",clientId:input.expectedGrant.clientId}, accountGeneration:{kind:"account-generation",subject:input.expectedGrant.subject,identityGeneration:input.expectedIdentityGeneration} };
}
export function validFinancialSourceAuthority(input: FS.FinancialSourceAuthoritySnapshot, now: number): boolean {
  try {
    const reg=parseFinancialSourceRegistration(input.registration), challenge=parseFinancialIdentityChallenge(input.challenge), a=input.expectedAccess,g=input.expectedGrant;
    if (!fsInstant(now) || !fsInstant(input.now) || now<input.now || !fsInstant(input.expectedIdentityGeneration) || typeof input.accessToken!=="string" || input.accessToken.length<1 || input.accessToken.length>8192 || typeof input.accessTokenHash!=="string" || !/^sha256:[A-Za-z0-9_-]{43}$/u.test(input.accessTokenHash)) return false;
    if (!fsKeys(a,["clientId","scope","subject","expiresAt"],["identityGeneration","oidcProfile","issuer","authTime","sid","issuerSessionId","nonce","familyStartedAt","familyExpiresAt","audience","takosumiSubject","capsuleId","workspaceId","role","interfaceId","interfaceBindingId","interfaceResolvedRevision"]) || !fsKeys(g,["sid","issuerSessionId","clientId","subject","scope","authTime","createdAt","absoluteExpiresAt"],["identityGeneration","issuer","revokedAt","authorizationCodeHash"])) return false;
    if (challenge.registrationRef!==reg.registrationRef || challenge.clientId!==g.clientId || challenge.createdAt>now || challenge.expiresAt<=now || a.oidcProfile!=="shared-account" || !a.issuer || a.issuer!==g.issuer || a.sid!==g.sid || a.issuerSessionId!==g.issuerSessionId || a.clientId!==g.clientId || a.subject!==g.subject || a.takosumiSubject!==g.subject || a.authTime!==g.authTime || (a.identityGeneration??0)!==input.expectedIdentityGeneration || (g.identityGeneration??0)!==input.expectedIdentityGeneration || g.revokedAt!==undefined || !fsInstant(a.expiresAt) || a.expiresAt<=now || !fsInstant(g.absoluteExpiresAt) || g.absoluteExpiresAt<=now || g.createdAt>now || a.capsuleId || a.workspaceId || a.role || a.interfaceId || a.interfaceBindingId || a.interfaceResolvedRevision!==undefined || (a.audience!==undefined&&a.audience!==a.clientId)) return false;
    const scopes=a.scope.split(/\s+/u).filter(Boolean), granted=g.scope.split(/\s+/u);
    if (!scopes.includes("openid") || scopes.some((scope)=>!["openid","email","profile","offline_access"].includes(scope)||!granted.includes(scope))) return false;
    if (!fsKeys(input.control,["evidenceRef","evidenceDigest","expiresAt","source"]) || !financialSourceRef(input.control.evidenceRef) || !financialSourceDigest(input.control.evidenceDigest) || !fsInstant(input.control.expiresAt) || input.control.expiresAt<=now) return false;
    const source=input.control.source;
    if(!fsKeys(source,["registrationRef","incarnation","affectedRef","sequence","eventRef","eventDigest","receivers"])||!financialSourceRef(source.affectedRef)||!fsInstant(source.sequence)||((source.sequence===0)!==(source.eventRef===null))||(source.eventRef!==null&&!financialSourceRef(source.eventRef))||!financialSourceDigest(source.eventDigest))return false;
    parseFinancialSourceRegistration({registrationRef:source.registrationRef,incarnation:source.incarnation,genesisDigest:source.eventDigest,receivers:source.receivers});
    Object.values(financialSourceParentScopes(input)).forEach(financialSourceScopeKey);
    return true;
  } catch { return false; }
}
function validFinancialRaw(record: FS.FinancialSourceRawRecord): boolean {
  try {
    if (!fsKeys(record,["raw","parent","parentRevision","cause","capturedAt"]) || !fsInstant(record.parentRevision) || !fsInstant(record.capturedAt)) return false;
    parseFinancialSourceRawEvent(record.raw); financialSourceScopeKey(record.parent);
    const c=record.cause;
    if (c.kind==="enrollment") return fsKeys(c,["kind","challengeRef","accessTokenHash","sid","identityGeneration"]) && [c.challengeRef,c.sid].every(financialSourceRef) && /^sha256:[A-Za-z0-9_-]{43}$/u.test(c.accessTokenHash) && fsInstant(c.identityGeneration) && record.raw.kind==="advance";
    if (c.kind==="grant-revoked") return fsKeys(c,["kind","sid","revokedAt"])&&record.parent.kind==="grant"&&record.parent.sid===c.sid&&c.revokedAt===record.capturedAt&&record.raw.kind==="close";
    if (c.kind==="issuer-session-revoked") return fsKeys(c,["kind","issuerSessionId","revokedAt"])&&record.parent.kind==="issuer-session"&&record.parent.issuerSessionId===c.issuerSessionId&&c.revokedAt===record.capturedAt&&record.raw.kind==="close";
    if (c.kind==="client-revoked") return fsKeys(c,["kind","clientId","revokedAt"])&&record.parent.kind==="client"&&record.parent.clientId===c.clientId&&c.revokedAt===record.capturedAt&&record.raw.kind==="close";
    return c.kind==="identity-generation-advanced"&&fsKeys(c,["kind","subject","previousGeneration","nextGeneration","operationId","operationRevision","reason"],["legacyUnlink"])&&record.parent.kind==="account-generation"&&record.parent.subject===c.subject&&record.parent.identityGeneration===c.previousGeneration&&financialSourceRef(c.operationId)&&fsInstant(c.previousGeneration)&&c.nextGeneration===c.previousGeneration+1&&fsInstant(c.operationRevision)&&["reserve","activate","quarantine","abort","restore","unlink"].includes(c.reason)&&(c.legacyUnlink===undefined||(c.legacyUnlink===true&&c.reason==="unlink"&&c.operationRevision===0))&&record.raw.kind==="close";
  } catch { return false; }
}
export function validFinancialSourceParentEnvelope(value: unknown, scope: FS.FinancialSourceParentScope): value is FinancialSourceParentEnvelope {
  try {
    if (!fsKeys(value,["scope","closed"],["head","lastRaw","closureAttemptId"])) return false;
    const e=value as unknown as FinancialSourceParentEnvelope;
    if (typeof e.closed!=="boolean" || (e.closureAttemptId!==undefined&&!financialSourceRef(e.closureAttemptId)) || financialSourceScopeKey(e.scope)!==financialSourceScopeKey(scope)) return false;
    if (!e.head) return e.closed&&e.lastRaw===undefined;
    const h=e.head,r=e.lastRaw;
    return fsKeys(h,["v","scope","registrationRef","incarnation","affectedRef","revision","sequence","lastEventRef","state","createdAt","updatedAt"])&&h.v===1&&financialSourceScopeKey(h.scope)===financialSourceScopeKey(scope)&&[h.registrationRef,h.incarnation,h.affectedRef,h.lastEventRef].every(financialSourceRef)&&h.affectedRef.length<=220&&fsInstant(h.revision)&&Number.isSafeInteger(h.sequence)&&h.sequence>=1&&fsInstant(h.createdAt)&&fsInstant(h.updatedAt)&&h.updatedAt>=h.createdAt&&h.state===(e.closed?"closed":"open")&&!!r&&validFinancialRaw(r)&&financialSourceScopeKey(r.parent)===financialSourceScopeKey(scope)&&r.parentRevision===h.revision&&r.capturedAt===h.updatedAt&&r.raw.registrationRef===h.registrationRef&&r.raw.incarnation===h.incarnation&&r.raw.affectedRef===h.affectedRef&&r.raw.sequence===h.sequence&&r.raw.eventRef===h.lastEventRef&&r.raw.kind===(e.closed?"close":"advance");
  } catch { return false; }
}
export function financialSourceParentExpected(value: unknown, scope: FS.FinancialSourceParentScope, expected?: FS.FinancialSourceParentHead): boolean {
  return value===undefined ? expected===undefined : validFinancialSourceParentEnvelope(value,scope)&&!value.closed&&!!expected&&financialSourceEqual(value.head,expected);
}
export function buildFinancialSourceEnrollment(input: FS.FinancialSourceEnrollmentMutation, now: number): FS.FinancialSourceParentVector<FinancialSourceParentEnvelope> | undefined {
  try {
    if (!validFinancialSourceAuthority(input,now)||!financialSourceRef(input.evidenceRef)||!fsKeys(input.parents,financialSlots)) return undefined;
    const scopes=financialSourceParentScopes(input), result={} as Record<typeof financialSlots[number],FinancialSourceParentEnvelope>;
    for (const slot of financialSlots) {
      const p=input.parents[slot],scope=scopes[slot];
      if (!fsKeys(p,["scope","affectedRef","eventRef"],["expected"])||financialSourceScopeKey(p.scope)!==financialSourceScopeKey(scope)) return undefined;
      if (p.expected) {
        const h=p.expected;
        if (h.state!=="open"||h.registrationRef!==input.registration.registrationRef||h.incarnation!==input.registration.incarnation||financialSourceScopeKey(h.scope)!==financialSourceScopeKey(scope)) return undefined;
        // Only the head is returned here; the backend retains the exact existing envelope.
        result[slot]={scope,closed:false,head:structuredClone(h)};
      } else {
        if (!financialSourceRef(p.affectedRef)||p.affectedRef.length>220||!financialSourceRef(p.eventRef)||p.eventRef===p.affectedRef+"/closed") return undefined;
        const raw:FS.FinancialSourceRawRecord={raw:{v:1,eventRef:p.eventRef,registrationRef:input.registration.registrationRef,incarnation:input.registration.incarnation,sequence:1,previousEventRef:null,kind:"advance",affectedRef:p.affectedRef,evidenceRef:input.evidenceRef},parent:scope,parentRevision:0,cause:{kind:"enrollment",challengeRef:input.challenge.challengeRef,accessTokenHash:input.accessTokenHash,sid:input.expectedGrant.sid,identityGeneration:input.expectedIdentityGeneration},capturedAt:now};
        result[slot]={scope,closed:false,head:{v:1,scope,registrationRef:input.registration.registrationRef,incarnation:input.registration.incarnation,affectedRef:p.affectedRef,revision:0,sequence:1,lastEventRef:p.eventRef,state:"open",createdAt:now,updatedAt:now},lastRaw:raw};
      }
    }
    if (new Set(financialSlots.map((slot)=>result[slot].head!.affectedRef)).size!==4) return undefined;
    return result;
  } catch { return undefined; }
}
export function closeFinancialSourceParent(scope: FS.FinancialSourceParentScope, previous: FinancialSourceParentEnvelope | undefined, cause: FS.FinancialSourceRawCause, evidenceRef: string, now: number): FinancialSourceParentEnvelope {
  financialSourceScopeKey(scope);
  if (!fsInstant(now)||!financialSourceRef(evidenceRef)||(previous&&!validFinancialSourceParentEnvelope(previous,scope))) throw new TypeError("invalid_financial_source_close");
  if (!previous?.head) return {scope:structuredClone(scope),closed:true};
  if (previous.closed) return structuredClone(previous);
  const h=previous.head;
  if (now<h.updatedAt||!Number.isSafeInteger(h.sequence+1)||!Number.isSafeInteger(h.revision+1)) throw new TypeError("invalid_financial_source_close");
  const eventRef=h.affectedRef+"/closed";
  const raw:FS.FinancialSourceRawRecord={raw:{v:1,eventRef,registrationRef:h.registrationRef,incarnation:h.incarnation,sequence:h.sequence+1,previousEventRef:h.lastEventRef,kind:"close",affectedRef:h.affectedRef,evidenceRef},parent:scope,parentRevision:h.revision+1,cause:structuredClone(cause),capturedAt:now};
  if (!validFinancialRaw(raw)) throw new TypeError("invalid_financial_source_close");
  return {scope:structuredClone(scope),closed:true,head:{...h,revision:h.revision+1,sequence:h.sequence+1,lastEventRef:eventRef,state:"closed",updatedAt:now},lastRaw:raw};
}
export function financialSourceRawPending(registration: FinancialSourceRegistration, raw: FS.FinancialSourceRawRecord): FS.FinancialSourcePendingRecord {
  const r=parseFinancialSourceRegistration(registration);
  if (!validFinancialRaw(raw)||raw.raw.registrationRef!==r.registrationRef||raw.raw.incarnation!==r.incarnation) throw new TypeError("invalid_financial_source_pending");
  return {registration:r,eventRef:raw.raw.eventRef,createdAt:raw.capturedAt};
}
export function financialSourceReadyReference(head: FS.FinancialSourceParentHead, materialization: FS.FinancialSourceMaterializationRecord, registration: FinancialSourceRegistration, receipts: readonly FinancialSourceReceiptRecord[]): FS.FinancialSourceParentReference | undefined {
  try {
    const r=parseFinancialSourceRegistration(registration),m=materialization.materialization,event=m.event,raw=materialization.rawRecord;
    if (head.state!=="open"||head.registrationRef!==r.registrationRef||head.incarnation!==r.incarnation||event.kind!=="advance"||!validFinancialRaw(raw)||financialSourceScopeKey(raw.parent)!==financialSourceScopeKey(head.scope)||raw.parentRevision!==head.revision||event.registrationRef!==r.registrationRef||event.incarnation!==r.incarnation||!financialSourceEqual(raw.raw,{...event,previousEventRef:raw.raw.previousEventRef,previousDigest:undefined})||event.eventRef!==head.lastEventRef||event.affectedRef!==head.affectedRef||event.sequence!==head.sequence||!financialSourceDigest(m.eventDigest)||receipts.length!==r.receivers.length) return undefined;
    for (const receiver of r.receivers) {
      const matches=receipts.filter((a)=>a.registrationRef===r.registrationRef&&a.receiverRef===receiver.receiverRef&&a.targetRef===receiver.targetRef&&financialReceiptMatches(event,m.eventDigest,a.receipt));
      if (matches.length!==1) return undefined;
    }
    return {scope:structuredClone(head.scope),registrationRef:r.registrationRef,incarnation:r.incarnation,affectedRef:head.affectedRef,sequence:head.sequence,eventRef:head.lastEventRef,eventDigest:m.eventDigest};
  } catch { return undefined; }
}
export function financialSourceProofMatches(input: FS.FinancialSourceProofMutation, now: number, heads: FS.FinancialSourceParentVector<FS.FinancialSourceParentHead>, references: FS.FinancialSourceParentVector<FS.FinancialSourceParentReference>): boolean {
  try {
    if (!validFinancialSourceAuthority(input,now)||!fsKeys(input.expectedParents,financialSlots)||!fsKeys(input.proof.parents,financialSlots)) return false;
    const p=input.proof,g=input.expectedGrant,a=input.expectedAccess,scopes=financialSourceParentScopes(input);
    if (!fsKeys(p,["v","proofRef","challenge","issuer","subject","clientId","sid","issuerSessionId","accessTokenHash","accessExpiresAt","identityGeneration","control","parents","issuedAt","expiresAt"])||p.v!==1||!financialSourceRef(p.proofRef)||p.accessTokenHash!==input.accessTokenHash||!fsInstant(p.accessExpiresAt)||p.accessExpiresAt!==a.expiresAt||!financialSourceEqual(p.challenge,input.challenge)||!financialSourceEqual(p.control,input.control)||p.issuer!==g.issuer||p.subject!==g.subject||p.clientId!==g.clientId||p.sid!==g.sid||p.issuerSessionId!==g.issuerSessionId||p.identityGeneration!==input.expectedIdentityGeneration||!fsInstant(p.issuedAt)||p.issuedAt>now||!fsInstant(p.expiresAt)||p.expiresAt<=now||p.expiresAt>Math.min(p.issuedAt+300000,p.accessExpiresAt,g.absoluteExpiresAt,input.challenge.expiresAt,input.control.expiresAt)) return false;
    return financialSlots.every((slot)=>heads[slot].state==="open"&&financialSourceEqual(heads[slot],input.expectedParents[slot])&&financialSourceScopeKey(heads[slot].scope)===financialSourceScopeKey(scopes[slot])&&financialSourceEqual(p.parents[slot],references[slot]));
  } catch { return false; }
}
export async function validFinancialSourceMaterialization(input: FS.FinancialSourceMaterializationMutation, registration: FinancialSourceRegistration): Promise<boolean> {
  try {
    if (!validFinancialRaw(input.expectedRaw)) return false;
    const expected=await materializeFinancialSourceEvent({registration,raw:input.expectedRaw.raw,predecessor:input.expectedPredecessor?.materialization});
    return financialSourceEqual(expected,input.materialization)&&(!input.expectedPredecessor||input.expectedPredecessor.rawRecord.raw.eventRef===input.expectedRaw.raw.previousEventRef);
  } catch { return false; }
}
export function validFinancialSourceReceipt(input: FS.FinancialSourceReceiptMutation, registration: FinancialSourceRegistration): boolean {
  try {
    const r=parseFinancialSourceRegistration(registration),a=input.receipt,m=input.expectedMaterialization.materialization;
    parseFinancialSourceReceipt(a.receipt);
    return fsKeys(a,["registrationRef","receiverRef","targetRef","receipt"])&&a.registrationRef===r.registrationRef&&r.receivers.some((receiver)=>receiver.receiverRef===a.receiverRef&&receiver.targetRef===a.targetRef)&&m.event.registrationRef===r.registrationRef&&m.event.incarnation===r.incarnation&&financialReceiptMatches(m.event,m.eventDigest,a.receipt);
  } catch { return false; }
}

export interface FinancialSourceDocumentExpectation { readonly bucket: string; readonly key: string; readonly record: unknown | undefined; }
export interface FinancialSourceDocumentWrite extends FinancialSourceDocumentExpectation { readonly next: unknown | undefined; readonly subject?: string; }
export interface FinancialSourceAtomicMutation {
  readonly checks: readonly FinancialSourceDocumentExpectation[];
  readonly writes: readonly FinancialSourceDocumentWrite[];
  readonly authority?: FS.FinancialSourceProtectedMutation;
  readonly proofLookup?: FS.FinancialSourceProofLookup;
  readonly now: number;
}
export function financialSourceAffectedRecord(head: FS.FinancialSourceParentHead) {
  return {affectedRef:head.affectedRef,scope:head.scope,registrationRef:head.registrationRef,incarnation:head.incarnation};
}

/** Shared portable record semantics. Native adapters supply one atomic guarded
 * statement/batch; this class cannot qualify a caller or manufacture a checkpoint. */
export class FinancialSourceDocumentRecords {
  constructor(readonly repository: Pick<IdentityRecordRepository,"get"|"create"|"page"|"findFinancialSourceProofsForOriginalRequest">,
    readonly commit: (input: FinancialSourceAtomicMutation) => Promise<boolean>) {}
  async registerFinancialSourceRegistration(value: FinancialSourceRegistration): Promise<boolean> {
    const record=parseFinancialSourceRegistration(value);
    if(await this.repository.create(financialSourceBuckets.registrations,record.registrationRef,record))return true;
    return financialSourceEqual(await this.findFinancialSourceRegistration(record.registrationRef),record);
  }
  async findFinancialSourceRegistration(ref: string): Promise<FinancialSourceRegistration|undefined> {
    if(!financialSourceRef(ref))return undefined;
    try { const value=await this.repository.get<FinancialSourceRegistration>(financialSourceBuckets.registrations,ref);return value&&value.registrationRef===ref?parseFinancialSourceRegistration(value):undefined; }catch{return undefined;}
  }
  async findFinancialSourceParent(scope: FS.FinancialSourceParentScope) {
    const value=await this.repository.get<FinancialSourceParentEnvelope>(financialSourceBuckets.parents,financialSourceScopeKey(scope));
    if(value&&!validFinancialSourceParentEnvelope(value,scope))throw new TypeError("financial_parent_conflict");
    return value?.head&&structuredClone(value.head);
  }
  async findFinancialSourceRaw(ref: string): Promise<FS.FinancialSourceRawRecord|undefined> {
    if(!financialSourceRef(ref))return undefined;
    const value=await this.repository.get<FS.FinancialSourceRawRecord>(financialSourceBuckets.raw,ref);
    return value&&validFinancialRaw(value)&&value.raw.eventRef===ref?structuredClone(value):undefined;
  }
  async listFinancialSourcePending(input: {registrationRef:string;after?:string;limit:number}): Promise<FS.FinancialSourcePendingPage> {
    if(!financialSourceRef(input.registrationRef)||input.after!==undefined&&!financialSourceRef(input.after)||!Number.isInteger(input.limit)||input.limit<1||input.limit>100)throw new TypeError("invalid_financial_pending_page");
    const registration=await this.findFinancialSourceRegistration(input.registrationRef);
    if(!registration)return {entries:[]};
    const rows=await this.repository.page<FS.FinancialSourcePendingRecord>(financialSourceBuckets.pending,financialSourceJson([input.registrationRef,input.after??""]),input.limit+1);
    const matching=rows.filter(({key,record})=>record?.registration?.registrationRef===input.registrationRef&&financialSourceEqual(record.registration,registration)&&key===financialSourcePendingKey(input.registrationRef,record.eventRef));
    const entries=matching.slice(0,input.limit).map(({record})=>structuredClone(record));
    return {entries,...(matching.length>input.limit?{nextCursor:entries.at(-1)!.eventRef}:{})};
  }
  async findFinancialSourceMaterialization(ref: string): Promise<FS.FinancialSourceMaterializationRecord|undefined> {
    if(!financialSourceRef(ref))return undefined;
    const value=await this.repository.get<FS.FinancialSourceMaterializationRecord>(financialSourceBuckets.materializations,ref);
    const raw=await this.findFinancialSourceRaw(ref);
    if(!value||!raw||!financialSourceEqual(value.rawRecord,raw)||value.materialization.event.eventRef!==ref)return undefined;
    const registration=await this.findFinancialSourceRegistration(raw.raw.registrationRef);
    const predecessor=raw.raw.previousEventRef?await this.repository.get<FS.FinancialSourceMaterializationRecord>(financialSourceBuckets.materializations,raw.raw.previousEventRef):undefined;
    return registration&&await validFinancialSourceMaterialization({expectedRaw:raw,expectedPredecessor:predecessor,materialization:value.materialization},registration)?structuredClone(value):undefined;
  }
  async commitFinancialSourceMaterialization(input: FS.FinancialSourceMaterializationMutation): Promise<boolean> {
    input=structuredClone(input);
    const registration=await this.findFinancialSourceRegistration(input.expectedRaw.raw.registrationRef);
    if(!registration||!await validFinancialSourceMaterialization(input,registration))return false;
    const raw=await this.findFinancialSourceRaw(input.expectedRaw.raw.eventRef), priorRef=input.expectedRaw.raw.previousEventRef;
    if(!financialSourceEqual(raw,input.expectedRaw))return false;
    const predecessor=priorRef?await this.findFinancialSourceMaterialization(priorRef):undefined;
    if(!financialSourceEqual(predecessor,input.expectedPredecessor))return false;
    const envelope=await this.repository.get<FinancialSourceParentEnvelope>(financialSourceBuckets.parents,financialSourceScopeKey(input.expectedRaw.parent));
    if(!envelope||!validFinancialSourceParentEnvelope(envelope,input.expectedRaw.parent)||!envelope.head||envelope.head.affectedRef!==raw!.raw.affectedRef||envelope.head.registrationRef!==registration.registrationRef||envelope.head.incarnation!==registration.incarnation||envelope.head.sequence<raw!.raw.sequence)return false;
    const ref=input.expectedRaw.raw.eventRef,old=await this.repository.get(financialSourceBuckets.materializations,ref),next={rawRecord:input.expectedRaw,materialization:input.materialization};
    if(old&&!financialSourceEqual(old,next))return false;
    return this.commit({now:input.expectedRaw.capturedAt,checks:[{bucket:financialSourceBuckets.raw,key:ref,record:raw},{bucket:financialSourceBuckets.parents,key:financialSourceScopeKey(input.expectedRaw.parent),record:envelope},{bucket:financialSourceBuckets.registrations,key:registration.registrationRef,record:registration},...(priorRef?[{bucket:financialSourceBuckets.materializations,key:priorRef,record:predecessor}]:[])],writes:[{bucket:financialSourceBuckets.materializations,key:ref,record:old,next}]});
  }
  async findFinancialSourceReceipt(input:{registrationRef:string;eventRef:string;receiverRef:string}): Promise<FinancialSourceReceiptRecord|undefined> {
    const key=financialSourceReceiptKey(input.registrationRef,input.eventRef,input.receiverRef),value=await this.repository.get<FinancialSourceReceiptRecord>(financialSourceBuckets.receipts,key);
    const registration=await this.findFinancialSourceRegistration(input.registrationRef),materialization=await this.findFinancialSourceMaterialization(input.eventRef);
    return value&&registration&&materialization&&value.registrationRef===input.registrationRef&&value.receiverRef===input.receiverRef&&validFinancialSourceReceipt({receipt:value,expectedMaterialization:materialization},registration)?structuredClone(value):undefined;
  }
  async recordFinancialSourceReceipt(input: FS.FinancialSourceReceiptMutation): Promise<boolean> {
    input=structuredClone(input);
    const registration=await this.findFinancialSourceRegistration(input.receipt.registrationRef),ref=input.receipt.receipt.eventRef;
    const materialization=await this.findFinancialSourceMaterialization(ref);
    if(!registration||!materialization||!financialSourceEqual(materialization,input.expectedMaterialization)||!validFinancialSourceReceipt(input,registration))return false;
    const key=financialSourceReceiptKey(input.receipt.registrationRef,ref,input.receipt.receiverRef),old=await this.repository.get(financialSourceBuckets.receipts,key);
    if(old&&!financialSourceEqual(old,input.receipt))return false;
    const pendingKey=financialSourcePendingKey(registration.registrationRef,ref),pending=await this.repository.get(financialSourceBuckets.pending,pendingKey);
    const checks:FinancialSourceDocumentExpectation[]=[{bucket:financialSourceBuckets.materializations,key:ref,record:materialization},{bucket:financialSourceBuckets.registrations,key:registration.registrationRef,record:registration}];
    let complete=true;
    for(const receiver of registration.receivers){if(receiver.receiverRef===input.receipt.receiverRef)continue;const k=financialSourceReceiptKey(registration.registrationRef,ref,receiver.receiverRef),record=await this.repository.get<FinancialSourceReceiptRecord>(financialSourceBuckets.receipts,k);checks.push({bucket:financialSourceBuckets.receipts,key:k,record});if(!record||!validFinancialSourceReceipt({receipt:record,expectedMaterialization:materialization},registration))complete=false;}
    const writes:FinancialSourceDocumentWrite[]=[{bucket:financialSourceBuckets.receipts,key,record:old,next:input.receipt}];
    if(complete&&pending!==undefined)writes.push({bucket:financialSourceBuckets.pending,key:pendingKey,record:pending,next:undefined});
    return this.commit({now:materialization.rawRecord.capturedAt,checks,writes});
  }
  async findFinancialSourceProof(ref:string):Promise<FS.FinancialSourceProofRecord|undefined>{
    if(!financialSourceRef(ref))return undefined;
    const record=await this.repository.get<FS.FinancialSourceProofRecord>(financialSourceBuckets.proofs,ref);
    return record?.proofRef===ref?structuredClone(record):undefined;
  }
  async enrollFinancialSourceParents(input: FS.FinancialSourceEnrollmentMutation):Promise<FS.FinancialSourceParentVector<FS.FinancialSourceParentHead>|undefined>{
    const {precommitCheckpoint,...original}=input;
    input={...structuredClone(original),precommitCheckpoint};
    const registration=await this.findFinancialSourceRegistration(input.registration.registrationRef);
    if(!financialSourceEqual(registration,input.registration))return undefined;
    const scopes=financialSourceParentScopes(input),previous={} as Record<typeof financialSlots[number],FinancialSourceParentEnvelope|undefined>;
    const checks:FinancialSourceDocumentExpectation[]=[{bucket:financialSourceBuckets.registrations,key:input.registration.registrationRef,record:registration}];
    for(const slot of financialSlots){const scope=scopes[slot],key=financialSourceScopeKey(scope),old=await this.repository.get<FinancialSourceParentEnvelope>(financialSourceBuckets.parents,key);if(!financialSourceParentExpected(old,scope,input.parents[slot].expected))return undefined;previous[slot]=old;
      const affected=input.parents[slot].expected?.affectedRef??input.parents[slot].affectedRef,index=await this.repository.get(financialSourceBuckets.affected,affected);
      if(old?.head&&!financialSourceEqual(index,financialSourceAffectedRecord(old.head))||!old&&index!==undefined)return undefined;
      checks.push({bucket:financialSourceBuckets.affected,key:affected,record:index});
      if(!old){for(const [bucket,k]of [[financialSourceBuckets.raw,input.parents[slot].eventRef],[financialSourceBuckets.pending,financialSourcePendingKey(input.registration.registrationRef,input.parents[slot].eventRef)]]as const){const value=await this.repository.get(bucket,k);if(value!==undefined)return undefined;checks.push({bucket,key:k,record:undefined});}}
    }
    const now=consumeFinancialSourcePrecommitCheckpoint(input);if(now===undefined)return undefined;
    const plan=buildFinancialSourceEnrollment(input,now);if(!plan)return undefined;
    const writes:FinancialSourceDocumentWrite[]=[],result={}as Record<typeof financialSlots[number],FS.FinancialSourceParentHead>;
    for(const slot of financialSlots){const old=previous[slot],next=old??plan[slot];result[slot]=next.head!;writes.push({bucket:financialSourceBuckets.parents,key:financialSourceScopeKey(scopes[slot]),record:old,next,subject:input.expectedGrant.subject});
      if(!old){const raw=next.lastRaw!,pending=financialSourceRawPending(input.registration,raw);writes.push({bucket:financialSourceBuckets.affected,key:next.head!.affectedRef,record:undefined,next:financialSourceAffectedRecord(next.head!),subject:input.expectedGrant.subject},{bucket:financialSourceBuckets.raw,key:raw.raw.eventRef,record:undefined,next:raw,subject:input.expectedGrant.subject},{bucket:financialSourceBuckets.pending,key:financialSourcePendingKey(input.registration.registrationRef,raw.raw.eventRef),record:undefined,next:pending,subject:input.expectedGrant.subject});}
    }
    return await this.commit({checks,writes,authority:input,now})?structuredClone(result):undefined;
  }
  async issueFinancialSourceProof(input: FS.FinancialSourceProofMutation):Promise<FS.FinancialSourceProofRecord|undefined>{
    const {precommitCheckpoint,...original}=input;
    input={...structuredClone(original),precommitCheckpoint};
    const registration=await this.findFinancialSourceRegistration(input.registration.registrationRef);if(!financialSourceEqual(registration,input.registration)||!registration)return undefined;
    const scopes=financialSourceParentScopes(input),heads={}as Record<typeof financialSlots[number],FS.FinancialSourceParentHead>,references={}as Record<typeof financialSlots[number],FS.FinancialSourceParentReference>,checks:FinancialSourceDocumentExpectation[]=[{bucket:financialSourceBuckets.registrations,key:registration.registrationRef,record:registration}],writes:FinancialSourceDocumentWrite[]=[];
    for(const slot of financialSlots){const scope=scopes[slot],key=financialSourceScopeKey(scope),envelope=await this.repository.get<FinancialSourceParentEnvelope>(financialSourceBuckets.parents,key);if(!financialSourceParentExpected(envelope,scope,input.expectedParents[slot])||!envelope?.head)return undefined;heads[slot]=envelope.head;
      const affected=await this.repository.get(financialSourceBuckets.affected,envelope.head.affectedRef);if(!financialSourceEqual(affected,financialSourceAffectedRecord(envelope.head)))return undefined;checks.push({bucket:financialSourceBuckets.affected,key:envelope.head.affectedRef,record:affected});
      const m=await this.findFinancialSourceMaterialization(envelope.head.lastEventRef);if(!m)return undefined;checks.push({bucket:financialSourceBuckets.materializations,key:envelope.head.lastEventRef,record:m});
      const receipts:FinancialSourceReceiptRecord[]=[];for(const receiver of registration.receivers){const k=financialSourceReceiptKey(registration.registrationRef,envelope.head.lastEventRef,receiver.receiverRef),receipt=await this.findFinancialSourceReceipt({registrationRef:registration.registrationRef,eventRef:envelope.head.lastEventRef,receiverRef:receiver.receiverRef});if(!receipt)return undefined;receipts.push(receipt);checks.push({bucket:financialSourceBuckets.receipts,key:k,record:receipt});}
      const reference=financialSourceReadyReference(envelope.head,m,registration,receipts);if(!reference)return undefined;references[slot]=reference;writes.push({bucket:financialSourceBuckets.parents,key,record:envelope,next:envelope,subject:input.expectedGrant.subject});
    }
    const proofLookup={registrationRef:input.registration.registrationRef,challengeRef:input.challenge.challengeRef,accessTokenHash:input.accessTokenHash};
    if((await this.repository.findFinancialSourceProofsForOriginalRequest(proofLookup)).length!==0)return undefined;
    const old=await this.repository.get(financialSourceBuckets.proofs,input.proof.proofRef);if(old!==undefined)return undefined;
    const now=consumeFinancialSourcePrecommitCheckpoint(input);if(now===undefined||!financialSourceProofMatches(input,now,heads,references))return undefined;
    writes.push({bucket:financialSourceBuckets.proofs,key:input.proof.proofRef,record:old,next:input.proof,subject:input.expectedGrant.subject});
    return await this.commit({checks,writes,authority:input,proofLookup,now})?structuredClone(input.proof):undefined;
  }
}
