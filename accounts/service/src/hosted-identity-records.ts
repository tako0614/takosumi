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

export interface IdentityRecordRepository {
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
  revokeHostedOidcGrant(sid: string, now: number): Promise<void> {
    return this.repository.revokeGrants("sid", sid, now);
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
    await this.repository.create(
      "hosted_oidc_revoked_sessions",
      issuerSessionId,
      { issuerSessionId, revokedAt: now },
    );
    await this.repository.revokeGrants("issuerSessionId", issuerSessionId, now);
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
    await this.repository.create("hosted_oidc_revoked_clients", clientId, {
      clientId,
      revokedAt: now,
    });
    await this.repository.revokeGrants("clientId", clientId, now);
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
