import { readReviewedRecoveryIssuerAvailabilityCheckpoint, consumeReviewedRecoveryIssuerAvailabilityCheckpoint } from "./reviewed-recovery-issuer-availability.ts";
import type { ReviewedRecoveryApprovalMutation } from "./reviewed-recovery-state.ts";
import { canonicalOwnerJson, ownerContextBucket, ownerReceiptBucket, reviewedApprovalBucket, reviewedApprovalCurrentBucket, reviewedApprovalRefBucket, reviewedApprovalRefKey } from "./owner-operation-evidence.ts";
import type {
  CredentialUnlinkIntent,
  CredentialUnlinkReceipt,
  CredentialUnlinkMutation,
} from "./identity-unlink-state.ts";
import type { IdentityMergeRetryCheckpointMutation } from "./identity-state.ts";
import { hashSessionId } from "./session-hash-salt.ts";
import type { IdentityRecordRepository } from "./hosted-identity-records.ts";
import {
  assertMergeMutation,
  identityMergeProofAudit,
  assertCredentialUnlinkMutation,
  unlinkImmutableContext,
  credentialUnlinkAudit,
  identityRecordsEqual,
  identityContextReceiptMatches,
} from "./hosted-identity-records.ts";
import type {
  AccountSessionRecord,
  TakosumiAccountRecord,
  UpstreamIdentityRecord,
} from "./store.ts";
import type {
  IdentityOperationReceiptRecord,
  IdentityMergeMutation,
  IdentityMergeOperation,
  UnlinkUpstreamIdentityInput,
} from "./identity-state.ts";
import { upstreamIdentityKey } from "./identity-state.ts";
import type * as Financial from "./identity-state.ts";
import type { FinancialSourceRegistration, FinancialSourceReceiptRecord } from "./financial-source-contract.ts";
import { parseFinancialSourceRegistration, FINANCIAL_SOURCE_MAX_PAGE } from "./financial-source-contract.ts";
import { sha256Text } from "./encoding.ts";
import { consumeFinancialSourcePrecommitCheckpoint } from "./financial-source.ts";
import {
  financialSourceBuckets, financialSourceScopeKey, financialSourcePendingKey, financialSourceReceiptKey,
  financialSourceEqual, financialSourceParentScopes, validFinancialSourceAuthority,
  financialSourceAffectedRecord,
  validFinancialSourceParentEnvelope, financialSourceParentExpected, buildFinancialSourceEnrollment,
  closeFinancialSourceParent, financialSourceRawPending, financialSourceReadyReference,
  financialSourceProofMatches, validFinancialSourceMaterialization, validFinancialSourceReceipt,
  type FinancialSourceParentEnvelope,
} from "./hosted-identity-records.ts";
type MutableFinancialVector<T> = { -readonly [K in keyof Financial.FinancialSourceParentVector<T>]: T };

export class MemoryIdentityRecordRepository
  implements IdentityRecordRepository
{
  readonly records = new Map<string, unknown>();
  constructor(
    readonly accounts: Map<string, TakosumiAccountRecord>,
    readonly sessions: Map<string, AccountSessionRecord>,
    readonly identities: Map<string, UpstreamIdentityRecord>,
    readonly revoke: (subjects: readonly string[], now: number) => void,
    /** This reads the actual private token map synchronously at final commit. */
    readonly findCurrentAccessToken?: (accessToken: string) => import("./store.ts").TokenRecord | undefined,
  ) {}
  private assertReferences(record: unknown, bucket: string): void {
    const r = record as Record<string, unknown>;
    const context = (bucket === ownerContextBucket ? r.context : bucket === ownerReceiptBucket ? r.receipt : undefined) as Record<string, unknown> | undefined;
    for (const subject of [
      context?.targetAccountId ?? r.subject ?? r.targetSubject ?? r.canonicalSubject,
      context?.sourceAccountId ?? r.sourceSubject,
    ])
      if (typeof subject === "string" && !this.accounts.has(subject))
        throw new Error("identity_record_subject_missing");
  }
  private key(bucket: string, key: string): string {
    return `${bucket}\n${key}`;
  }
  private financialRecord<T>(bucket: string, key: string): T | undefined {
    return this.records.get(this.key(bucket, key)) as T | undefined;
  }
  async registerFinancialSourceRegistration(registration: FinancialSourceRegistration): Promise<boolean> {
    try {
      const record = parseFinancialSourceRegistration(registration);
      const key = this.key(financialSourceBuckets.registrations, record.registrationRef);
      const previous = this.records.get(key);
      if (previous !== undefined) return financialSourceEqual(previous, record);
      this.records.set(key, record);
      return true;
    } catch { return false; }
  }
  async findFinancialSourceRegistration(registrationRef: string): Promise<FinancialSourceRegistration | undefined> {
    return structuredClone(this.financialRecord<FinancialSourceRegistration>(financialSourceBuckets.registrations, registrationRef));
  }
  async findFinancialSourceParent(scope: Financial.FinancialSourceParentScope): Promise<Financial.FinancialSourceParentHead | undefined> {
    const envelope = this.financialRecord<FinancialSourceParentEnvelope>(financialSourceBuckets.parents, financialSourceScopeKey(scope));
    return envelope && validFinancialSourceParentEnvelope(envelope, scope) ? structuredClone(envelope.head) : undefined;
  }
  private financialAuthority(input: Financial.FinancialSourceAuthoritySnapshot, now: number, accessTokenHash: string): boolean {
    if (!validFinancialSourceAuthority(input, now) || accessTokenHash !== input.accessTokenHash ||
      !financialSourceEqual(this.financialRecord(financialSourceBuckets.registrations, input.registration.registrationRef), input.registration)) return false;
    const access = this.findCurrentAccessToken?.(input.accessToken);
    const grant = this.financialRecord<Financial.HostedOidcGrantRecord>("hosted_oidc_grants", input.expectedGrant.sid);
    const subject = input.expectedGrant.subject;
    if (!access || !grant || !financialSourceEqual(access, input.expectedAccess) || !financialSourceEqual(grant, input.expectedGrant) ||
      access.oidcProfile !== "shared-account" || access.subject !== subject || (access.takosumiSubject !== undefined && access.takosumiSubject !== subject) ||
      access.clientId !== grant.clientId || access.sid !== grant.sid || access.issuer !== grant.issuer || access.issuerSessionId !== grant.issuerSessionId ||
      (access.identityGeneration ?? 0) !== input.expectedIdentityGeneration || (grant.identityGeneration ?? 0) !== input.expectedIdentityGeneration ||
      access.expiresAt <= now || grant.absoluteExpiresAt <= now || grant.revokedAt !== undefined ||
      !this.accounts.has(subject) || this.records.has(this.key("canonical_accounts", subject)) ||
      this.records.has(this.key("hosted_oidc_revoked_sessions", grant.issuerSessionId)) ||
      this.records.has(this.key("hosted_oidc_revoked_clients", grant.clientId)) ||
      (this.financialRecord<{ generation: number }>("authentication_generations", subject)?.generation ?? 0) !== input.expectedIdentityGeneration) return false;
    const lock = this.financialRecord<{ operationId: string }>("identity_merge_locks", subject);
    return !lock || this.financialRecord<IdentityMergeOperation>("identity_merge_operations", lock.operationId)?.status === "active";
  }
  /** Prepare every immutable write before the synchronous decision/write block. */
  private financialEnvelopeWrites(envelope: FinancialSourceParentEnvelope, registration?: FinancialSourceRegistration): readonly (readonly [string, unknown])[] {
    if (!validFinancialSourceParentEnvelope(envelope, envelope.scope)) throw new Error("invalid_financial_parent_envelope");
    const writes: Array<readonly [string, unknown]> = [[this.key(financialSourceBuckets.parents, financialSourceScopeKey(envelope.scope)), structuredClone(envelope)]];
    const head = envelope.head, raw = envelope.lastRaw;
    if (!head) return writes;
    if (!raw || !registration || registration.registrationRef !== head.registrationRef || registration.incarnation !== head.incarnation) throw new Error("financial_parent_registration_missing");
    const affected = { affectedRef: head.affectedRef, scope: envelope.scope, registrationRef: head.registrationRef, incarnation: head.incarnation };
    const oldAffected = this.financialRecord(financialSourceBuckets.affected, head.affectedRef);
    if (oldAffected !== undefined && !financialSourceEqual(oldAffected, affected)) throw new Error("financial_parent_affected_conflict");
    writes.push([this.key(financialSourceBuckets.affected, head.affectedRef), structuredClone(affected)]);
    if (this.financialRecord(financialSourceBuckets.raw, raw.raw.eventRef) !== undefined) throw new Error("financial_source_event_ref_reused");
    const pending = financialSourceRawPending(registration, raw);
    const pendingKey = this.key(financialSourceBuckets.pending, financialSourcePendingKey(registration.registrationRef, raw.raw.eventRef));
    if (this.records.has(pendingKey)) throw new Error("financial_source_pending_conflict");
    writes.push([this.key(financialSourceBuckets.raw, raw.raw.eventRef), structuredClone(raw)], [pendingKey, structuredClone(pending)]);
    return writes;
  }
  private commitFinancialWrites(writes: readonly (readonly [string, unknown])[]): void {
    for (const [key, value] of writes) this.records.set(key, value);
  }
  async enrollFinancialSourceParents(input: Financial.FinancialSourceEnrollmentMutation): Promise<Financial.FinancialSourceParentVector<Financial.FinancialSourceParentHead> | undefined> {
    const accessTokenHash = await sha256Text(input.accessToken);
    const now = consumeFinancialSourcePrecommitCheckpoint(input);
    if (now === undefined || !this.financialAuthority(input, now, accessTokenHash)) return undefined;
    try {
      const scopes = financialSourceParentScopes(input), next = buildFinancialSourceEnrollment(input, now);
      if (!next) return undefined;
      const heads = {} as MutableFinancialVector<Financial.FinancialSourceParentHead>;
      const writes: Array<readonly [string, unknown]> = [];
      const affected = new Set<string>(), eventRefs = new Set<string>();
      for (const slot of ["grant", "issuerSession", "client", "accountGeneration"] as const) {
        const current = this.financialRecord<FinancialSourceParentEnvelope>(financialSourceBuckets.parents, financialSourceScopeKey(scopes[slot]));
        if (!financialSourceParentExpected(current, scopes[slot], input.parents[slot].expected) || !next[slot].head) return undefined;
        heads[slot] = next[slot].head;
        if (affected.has(heads[slot].affectedRef) || eventRefs.has(heads[slot].lastEventRef)) return undefined;
        affected.add(heads[slot].affectedRef); eventRefs.add(heads[slot].lastEventRef);
        if (current === undefined) {
          if (this.financialRecord(financialSourceBuckets.affected, heads[slot].affectedRef) !== undefined) return undefined;
          writes.push(...this.financialEnvelopeWrites(next[slot], input.registration));
        } else if (!financialSourceEqual(this.financialRecord(financialSourceBuckets.affected, current.head!.affectedRef), financialSourceAffectedRecord(current.head!))) return undefined;
      }
      this.commitFinancialWrites(writes);
      return structuredClone(heads);
    } catch { return undefined; }
  }
  async issueFinancialSourceProof(input: Financial.FinancialSourceProofMutation): Promise<Financial.FinancialSourceProofRecord | undefined> {
    const accessTokenHash = await sha256Text(input.accessToken);
    const now = consumeFinancialSourcePrecommitCheckpoint(input);
    if (now === undefined || !this.financialAuthority(input, now, accessTokenHash)) return undefined;
    try {
      const scopes = financialSourceParentScopes(input);
      const references = {} as MutableFinancialVector<Financial.FinancialSourceParentReference>;
      for (const slot of ["grant", "issuerSession", "client", "accountGeneration"] as const) {
        const envelope = this.financialRecord<FinancialSourceParentEnvelope>(financialSourceBuckets.parents, financialSourceScopeKey(scopes[slot]));
        if (!financialSourceParentExpected(envelope, scopes[slot], input.expectedParents[slot]) || !envelope?.head) return undefined;
        if (!financialSourceEqual(this.financialRecord(financialSourceBuckets.affected, envelope.head.affectedRef), financialSourceAffectedRecord(envelope.head))) return undefined;
        const materialization = this.financialRecord<Financial.FinancialSourceMaterializationRecord>(financialSourceBuckets.materializations, envelope.head.lastEventRef);
        if (!materialization || !financialSourceEqual(this.financialRecord(financialSourceBuckets.raw, envelope.head.lastEventRef), materialization.rawRecord)) return undefined;
        const receipts = input.registration.receivers.flatMap(receiver => {
          const receipt = this.financialRecord<FinancialSourceReceiptRecord>(financialSourceBuckets.receipts, financialSourceReceiptKey(input.registration.registrationRef, envelope.head!.lastEventRef, receiver.receiverRef));
          return receipt ? [receipt] : [];
        });
        const reference = financialSourceReadyReference(envelope.head, materialization, input.registration, receipts);
        if (!reference) return undefined;
        references[slot] = reference;
      }
      if (!financialSourceProofMatches(input, now, input.expectedParents, references)) return undefined;
      if (this.financialProofCensus({registrationRef: input.registration.registrationRef, challengeRef: input.challenge.challengeRef, accessTokenHash: input.accessTokenHash}).length !== 0) return undefined;
      const key = this.key(financialSourceBuckets.proofs, input.proof.proofRef), old = this.records.get(key);
      if (old !== undefined) return financialSourceEqual(old, input.proof) ? structuredClone(input.proof) : undefined;
      this.records.set(key, structuredClone(input.proof));
      return structuredClone(input.proof);
    } catch { return undefined; }
  }
  async findFinancialSourceProof(proofRef: string): Promise<Financial.FinancialSourceProofRecord | undefined> {
    return structuredClone(this.financialRecord<Financial.FinancialSourceProofRecord>(financialSourceBuckets.proofs, proofRef));
  }
  private financialProofCensus(input: Financial.FinancialSourceProofLookup): readonly Financial.FinancialSourceProofRecord[] {
    const result: Financial.FinancialSourceProofRecord[] = [];
    for (const [key, value] of this.records) {
      const record = value as Financial.FinancialSourceProofRecord | undefined;
      if (key.startsWith(financialSourceBuckets.proofs + "\n") && record?.challenge?.registrationRef === input.registrationRef &&
        record.challenge.challengeRef === input.challengeRef && record.accessTokenHash === input.accessTokenHash) {
        result.push(record);
        if (result.length === 2) break;
      }
    }
    return result;
  }
  async findFinancialSourceProofsForOriginalRequest(input: Financial.FinancialSourceProofLookup): Promise<readonly Financial.FinancialSourceProofRecord[]> {
    return structuredClone(this.financialProofCensus(input));
  }
  private financialCloseWrites(scope: Financial.FinancialSourceParentScope, cause: Financial.FinancialSourceRawCause, evidenceRef: string, now: number): readonly (readonly [string, unknown])[] {
    const current = this.financialRecord<FinancialSourceParentEnvelope>(financialSourceBuckets.parents, financialSourceScopeKey(scope));
    if (current !== undefined && !validFinancialSourceParentEnvelope(current, scope)) throw new Error("invalid_financial_parent_envelope");
    if (current?.closed) return [];
    const next = closeFinancialSourceParent(scope, current, cause, evidenceRef, now);
    const registration = next.head ? this.financialRecord<FinancialSourceRegistration>(financialSourceBuckets.registrations, next.head.registrationRef) : undefined;
    return this.financialEnvelopeWrites(next, registration);
  }
  private financialGenerationWrites(subjects: readonly TakosumiAccountRecord["subject"][], now: number, operationId: string, operationRevision: number,
    reason: Extract<Financial.FinancialSourceRawCause, { kind: "identity-generation-advanced" }>["reason"], legacyUnlink = false): readonly (readonly [string, unknown])[] {
    const writes: Array<readonly [string, unknown]> = [];
    for (const subject of new Set(subjects)) {
      const previousGeneration = this.financialRecord<{ generation: number }>("authentication_generations", subject)?.generation ?? 0;
      const scope: Financial.FinancialSourceParentScope = { kind: "account-generation", subject, identityGeneration: previousGeneration };
      // An ordinary account with no enrolled financial parent retains its behavior.
      if (!this.records.has(this.key(financialSourceBuckets.parents, financialSourceScopeKey(scope)))) continue;
      const cause: Financial.FinancialSourceRawCause = { kind: "identity-generation-advanced", subject, previousGeneration,
        nextGeneration: previousGeneration + 1, operationId, operationRevision, reason, ...(legacyUnlink ? { legacyUnlink: true } : {}) };
      writes.push(...this.financialCloseWrites(scope, cause, `accounts-generation/${operationId}/${operationRevision}`, now));
    }
    return writes;
  }
  async revokeHostedOidcScope(input: Financial.FinancialSourceRevocationMutation): Promise<boolean> {
    const { scope, now, evidenceRef } = input;
    if (!Number.isSafeInteger(now) || now < 0 || !scope || !["grant", "issuer-session", "client"].includes(scope.kind)) return false;
    const field = scope.kind === "grant" ? "sid" : scope.kind === "issuer-session" ? "issuerSessionId" : "clientId";
    const value = scope.kind === "grant" ? scope.sid : scope.kind === "issuer-session" ? scope.issuerSessionId : scope.clientId;
    const bucket = scope.kind === "issuer-session" ? "hosted_oidc_revoked_sessions" : "hosted_oidc_revoked_clients";
    const cause: Financial.FinancialSourceRawCause = scope.kind === "grant" ? { kind: "grant-revoked", sid: value, revokedAt: now } : scope.kind === "issuer-session" ? { kind: "issuer-session-revoked", issuerSessionId: value, revokedAt: now } : { kind: "client-revoked", clientId: value, revokedAt: now };
    const writes = [...this.financialCloseWrites(scope, cause, evidenceRef, now)];
    const tombstone = this.key(bucket, value);
    if (scope.kind !== "grant" && !this.records.has(tombstone)) writes.push([tombstone, { [field]: value, revokedAt: now }]);
    for (const [key, record] of this.records) {
      const grant = record as Record<string, unknown>;
      if (key.startsWith("hosted_oidc_grants\n") && grant[field] === value && grant.revokedAt === undefined) writes.push([key, { ...grant, revokedAt: now }]);
    }
    this.commitFinancialWrites(writes);
    return true;
  }
  async findFinancialSourceRaw(eventRef: string): Promise<Financial.FinancialSourceRawRecord | undefined> {
    return structuredClone(this.financialRecord<Financial.FinancialSourceRawRecord>(financialSourceBuckets.raw, eventRef));
  }
  async listFinancialSourcePending(input: { readonly registrationRef: string; readonly after?: string; readonly limit: number }): Promise<Financial.FinancialSourcePendingPage> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > FINANCIAL_SOURCE_MAX_PAGE) throw new TypeError("invalid_financial_source_page");
    const entries = [...this.records].filter(([key]) => key.startsWith(financialSourceBuckets.pending + "\n")).map(([, value]) => value as Financial.FinancialSourcePendingRecord)
      .filter(value => value.registration.registrationRef === input.registrationRef && (input.after === undefined || value.eventRef > input.after)).sort((a, b) => a.eventRef < b.eventRef ? -1 : a.eventRef > b.eventRef ? 1 : 0);
    const page = entries.slice(0, input.limit);
    return { entries: structuredClone(page), ...(entries.length > input.limit ? { nextCursor: page.at(-1)!.eventRef } : {}) };
  }
  async findFinancialSourceMaterialization(eventRef: string): Promise<Financial.FinancialSourceMaterializationRecord | undefined> {
    return structuredClone(this.financialRecord<Financial.FinancialSourceMaterializationRecord>(financialSourceBuckets.materializations, eventRef));
  }
  async commitFinancialSourceMaterialization(original: Financial.FinancialSourceMaterializationMutation): Promise<boolean> {
    const input = structuredClone(original);
    const registration = structuredClone(this.financialRecord<FinancialSourceRegistration>(financialSourceBuckets.registrations, input.expectedRaw.raw.registrationRef));
    if (!registration || !await validFinancialSourceMaterialization(input, registration)) return false;
    if (!financialSourceEqual(this.financialRecord(financialSourceBuckets.registrations, registration.registrationRef), registration) ||
      !financialSourceEqual(this.financialRecord(financialSourceBuckets.raw, input.expectedRaw.raw.eventRef), input.expectedRaw)) return false;
    const raw = input.expectedRaw.raw;
    const predecessor = raw.previousEventRef === null ? undefined : this.financialRecord<Financial.FinancialSourceMaterializationRecord>(financialSourceBuckets.materializations, raw.previousEventRef);
    if (!financialSourceEqual(predecessor, input.expectedPredecessor)) return false;
    const envelope = this.financialRecord<FinancialSourceParentEnvelope>(financialSourceBuckets.parents, financialSourceScopeKey(input.expectedRaw.parent));
    if (!envelope || !validFinancialSourceParentEnvelope(envelope, input.expectedRaw.parent) || !envelope.head || envelope.head.registrationRef !== raw.registrationRef || envelope.head.incarnation !== raw.incarnation || envelope.head.affectedRef !== raw.affectedRef || envelope.head.sequence < raw.sequence || envelope.head.revision < input.expectedRaw.parentRevision) return false;
    const record = { rawRecord: input.expectedRaw, materialization: input.materialization };
    const key = this.key(financialSourceBuckets.materializations, raw.eventRef), old = this.records.get(key);
    if (old !== undefined) return financialSourceEqual(old, record);
    this.records.set(key, record); return true;
  }
  async findFinancialSourceReceipt(input: { readonly registrationRef: string; readonly eventRef: string; readonly receiverRef: string }): Promise<FinancialSourceReceiptRecord | undefined> {
    return structuredClone(this.financialRecord<FinancialSourceReceiptRecord>(financialSourceBuckets.receipts, financialSourceReceiptKey(input.registrationRef, input.eventRef, input.receiverRef)));
  }
  async recordFinancialSourceReceipt(input: Financial.FinancialSourceReceiptMutation): Promise<boolean> {
    const event = input.expectedMaterialization.materialization.event;
    const registration = this.financialRecord<FinancialSourceRegistration>(financialSourceBuckets.registrations, event.registrationRef);
    if (!registration || !validFinancialSourceReceipt(input, registration) || !financialSourceEqual(this.financialRecord(financialSourceBuckets.materializations, event.eventRef), input.expectedMaterialization) ||
      !financialSourceEqual(this.financialRecord(financialSourceBuckets.raw, event.eventRef), input.expectedMaterialization.rawRecord)) return false;
    const key = this.key(financialSourceBuckets.receipts, financialSourceReceiptKey(event.registrationRef, event.eventRef, input.receipt.receiverRef));
    const old = this.records.get(key);
    if (old !== undefined) return financialSourceEqual(old, input.receipt);
    const pendingKey = this.key(financialSourceBuckets.pending, financialSourcePendingKey(event.registrationRef, event.eventRef));
    const pending = this.records.get(pendingKey) as Financial.FinancialSourcePendingRecord | undefined;
    if (!pending || !financialSourceEqual(pending.registration, registration)) return false;
    this.records.set(key, structuredClone(input.receipt));
    if (registration.receivers.every(receiver => {
      const receipt = this.financialRecord<FinancialSourceReceiptRecord>(financialSourceBuckets.receipts, financialSourceReceiptKey(event.registrationRef, event.eventRef, receiver.receiverRef));
      return receipt !== undefined && validFinancialSourceReceipt({ expectedMaterialization: input.expectedMaterialization, receipt }, registration);
    })) this.records.delete(pendingKey);
    return true;
  }
  async commitReviewedRecoveryApproval(input: ReviewedRecoveryApprovalMutation): Promise<boolean> {
    const {record:r,pointer:p}=input,a=r.approval;
    const op=this.records.get(this.key("identity_merge_operations",a.operationId)) as import("./identity-state.ts").IdentityMergeOperation|undefined;
    const old=this.records.get(this.key(reviewedApprovalCurrentBucket,a.operationId)) as import("./reviewed-recovery-state.ts").ReviewedRecoveryApprovalPointer|undefined;
    const history=this.records.get(this.key(reviewedApprovalBucket,r.approvalDigest));
    const refKey=reviewedApprovalRefKey(a);
    const ref=this.records.get(this.key(reviewedApprovalRefBucket,refKey)) as {operationId:string;recoveryId:string;reviewedApprovalRef:string;approvalDigest:string}|undefined;
    const expectedRef={operationId:a.operationId,recoveryId:a.recoveryId,reviewedApprovalRef:a.reviewedApprovalRef,approvalDigest:r.approvalDigest};
    if(!op?.consentAt||op.revision!==a.operationRevision||op.sourceSubject!==a.sourceAccountId||op.targetSubject!==a.targetAccountId||op.contextPlan?.planDigest!==a.planDigest||!(a.mode==="abort-before-active"?["proved","reconciled","quarantined"].includes(op.status):op.status==="quarantined"))return false;
    for(const [subject,generation]of [[a.sourceAccountId,a.sourceIdentityGeneration],[a.targetAccountId,a.targetIdentityGeneration]]as const){
      if(!this.accounts.has(subject)||(this.records.get(this.key("identity_merge_locks",subject))as {operationId:string}|undefined)?.operationId!==a.operationId||((this.records.get(this.key("authentication_generations",subject))as {generation:number}|undefined)?.generation??0)!==generation)return false;
    }
    const source=(this.records.get(this.key("canonical_accounts",a.sourceAccountId))as {targetSubject:string}|undefined)?.targetSubject??a.sourceAccountId;
    const target=(this.records.get(this.key("canonical_accounts",a.targetAccountId))as {targetSubject:string}|undefined)?.targetSubject??a.targetAccountId;
    if(source!==(a.mode==="abort-before-active"?a.sourceAccountId:a.targetAccountId)||target!==a.targetAccountId)return false;
    if(history&&canonicalOwnerJson(history)!==canonicalOwnerJson(r)||ref&&canonicalOwnerJson(ref)!==canonicalOwnerJson(expectedRef))return false;
    if(old?.approvalDigest===r.approvalDigest)return !!history&&!!ref&&ref.approvalDigest===r.approvalDigest&&old.operationId===a.operationId&&old.revision===p.revision;
    if(history||ref||old&&old.operationId!==a.operationId||old?.approvalDigest!==input.expectedApprovalDigest||p.revision!==(old?.revision??-1)+1)return false;
    if(old){const previous=this.records.get(this.key(reviewedApprovalBucket,old.approvalDigest))as typeof r|undefined;if(!previous||previous.decisionDigest!==r.decisionDigest||previous.approval.createdAt>=a.createdAt)return false;}
    // The complete decision/write section has no await: one current pointer,
    // immutable history, and exact review-ref index commit together.
    this.records.set(this.key(reviewedApprovalCurrentBucket,a.operationId),structuredClone(p));
    if(!history)this.records.set(this.key(reviewedApprovalBucket,r.approvalDigest),structuredClone(r));
    if(!ref)this.records.set(this.key(reviewedApprovalRefBucket,refKey),{operationId:a.operationId,recoveryId:a.recoveryId,reviewedApprovalRef:a.reviewedApprovalRef,approvalDigest:r.approvalDigest});
    return true;
  }
  async get<T>(bucket: string, key: string): Promise<T | undefined> {
    const r = this.records.get(this.key(bucket, key));
    return r === undefined ? undefined : (structuredClone(r) as T);
  }
  async put(bucket: string, key: string, record: unknown): Promise<void> {
    this.assertReferences(record, bucket);
    this.records.set(this.key(bucket, key), structuredClone(record));
  }
  async create(bucket: string, key: string, record: unknown): Promise<boolean> {
    this.assertReferences(record, bucket);
    const k = this.key(bucket, key);
    if (this.records.has(k)) return false;
    this.records.set(k, structuredClone(record));
    return true;
  }
  async consume<T>(
    bucket: string,
    key: string,
    binding: string,
    now: number,
  ): Promise<T | undefined> {
    const k = this.key(bucket, key);
    const r = this.records.get(k) as
      | { browserBindingHash: string; expiresAt: number }
      | undefined;
    if (!r || r.browserBindingHash !== binding || r.expiresAt <= now)
      return undefined;
    this.records.delete(k);
    return structuredClone(r) as T;
  }
  async query<T>(
    bucket: string,
    field: string,
    value: string,
    limit: number,
  ): Promise<readonly T[]> {
    return [...this.records]
      .filter(
        ([k, v]) =>
          k.startsWith(`${bucket}\n`) &&
          (v as Record<string, unknown>)[field] === value,
      )
      .slice(0, limit)
      .map(([, v]) => structuredClone(v) as T);
  }
  async revokeGrants(
    field: "issuerSessionId" | "clientId" | "sid",
    value: string,
    now: number,
  ): Promise<void> {
    const scope: Financial.FinancialSourceRevocationMutation["scope"] = field === "sid" ? { kind: "grant", sid: value } :
      field === "issuerSessionId" ? { kind: "issuer-session", issuerSessionId: value } : { kind: "client", clientId: value };
    if (!await this.revokeHostedOidcScope({ scope, now, evidenceRef: `accounts-revoke/${crypto.randomUUID()}` })) throw new Error("financial_source_revocation_failed");
  }
  async emailCandidates(
    address: string,
  ): Promise<readonly TakosumiAccountRecord[]> {
    return [...this.accounts.values()]
      .filter((a) => candidateMatches(a.email, address))
      .slice(0, 3)
      .map((a) => ({ ...a }));
  }
  async listIdentities(
    subject: string,
  ): Promise<readonly UpstreamIdentityRecord[]> {
    return [...this.identities.values()]
      .filter(
        (i) =>
          ((
            this.records.get(this.key("canonical_accounts", i.subject)) as
              | { targetSubject: string }
              | undefined
          )?.targetSubject ?? i.subject) === subject &&
          !(
            this.records.get(
              this.key("upstream_identity_status", upstreamIdentityKey(i)),
            ) as { disabledAt?: number } | undefined
          )?.disabledAt,
      )
      .slice(0, 101)
      .map((i) => ({ ...i }));
  }
  async touchSession(
    sessionId: string,
    now: number,
    idleExpiresAt: number,
  ): Promise<boolean> {
    const s = this.sessions.get(sessionId);
    if (
      !s ||
      s.policy !== "hosted" ||
      s.expiresAt <= now ||
      !s.absoluteExpiresAt ||
      s.absoluteExpiresAt <= now
    )
      return false;
    this.sessions.set(sessionId, {
      ...s,
      expiresAt: Math.min(idleExpiresAt, s.absoluteExpiresAt),
    });
    return true;
  }
  async mutateMerge(input: IdentityMergeMutation): Promise<boolean> {
    assertMergeMutation(input);
    const lookup = new Map<string, string>();
    for (const key of this.sessions.keys())
      lookup.set(await hashSessionId(key), key);
    if (input.availabilityCheckpoint !== undefined) {
      const freshNow = readReviewedRecoveryIssuerAvailabilityCheckpoint(input.availabilityCheckpoint, input);
      if (freshNow === undefined) return false;
      input = { ...input, now: freshNow };
      try { assertMergeMutation(input); } catch { return false; }
      if (input.emailProofs?.some((proof) => proof.validUntil <= freshNow || proof.observedAt > freshNow)) return false;
    }
    const n = input.next;
    const old = this.records.get(
      this.key("identity_merge_operations", n.operationId),
    ) as IdentityMergeOperation | undefined;
    if (
      !old ||
      old.revision !== input.expectedRevision ||
      old.sourceSubject !== n.sourceSubject ||
      old.targetSubject !== n.targetSubject
    )
      return false;
    if (
      !input.quarantine &&
      !input.restore &&
      !input.abort &&
      !input.requireRecovery &&
      (old.expiresAt <= input.now ||
        this.records.has(this.key("canonical_accounts", n.sourceSubject)) ||
        this.records.has(this.key("canonical_accounts", n.targetSubject)))
    )
      return false;
    if (
      input.restore &&
      (old.status !== "quarantined" ||
        (
          this.records.get(this.key("canonical_accounts", n.sourceSubject)) as
            | { operationId: string; targetSubject: string }
            | undefined
        )?.operationId !== n.operationId)
    )
      return false;
    if (
      input.abort &&
      (!old.consentAt ||
        !["proved", "reconciled", "quarantined"].includes(old.status) ||
        [n.sourceSubject, n.targetSubject].some(
          (subject) =>
            this.records.has(this.key("canonical_accounts", subject)) ||
            (
              this.records.get(this.key("identity_merge_locks", subject)) as
                | { operationId: string }
                | undefined
            )?.operationId !== n.operationId,
        ))
    )
      return false;
    if (
      input.requireRecovery &&
      (!old.consentAt ||
        !["proved", "reconciled"].includes(old.status) ||
        old.status !== n.status ||
        !this.hasExpiredEvidence(old, input.now))
    )
      return false;
    for (const p of input.sessions ?? []) {
      const s = this.sessions.get(
        p.sessionId ?? lookup.get(p.sessionLookupHash!)!,
      );
      if (
        !s ||
        s.subject !== p.subject ||
        (p.reauthentication === false ? s.authTime : s.reauthenticatedAt) !==
          p.authTime ||
        s.policy !== "hosted" ||
        s.expiresAt <= input.now ||
        !s.absoluteExpiresAt ||
        s.absoluteExpiresAt <= input.now ||
        (s.identityGeneration ?? 0) !==
          ((
            this.records.get(
              this.key("authentication_generations", s.subject),
            ) as { generation: number } | undefined
          )?.generation ?? 0)
      )
        return false;
    }
    for (const proof of input.emailProofs ?? []) {
      const saved = this.records.get(
        this.key("account_email_proofs", proof.subject),
      );
      const account = this.accounts.get(proof.subject);
      if (
        JSON.stringify(saved) !== JSON.stringify(proof) ||
        account?.email !== proof.address ||
        account.emailVerified !== true
      )
        return false;
    }
    if (
      input.emailProofs?.length &&
      [...this.accounts.values()].filter((a) =>
        candidateMatches(a.email, input.emailProofs![0]!.normalizedAddress),
      ).length !== 2
    )
      return false;
    if (
      input.receipt &&
      !this.validReceipt(input.receipt, n, input.now, false, 0)
    )
      return false;
    for (const receipt of input.proofReceipts ?? [])
      if (
        !this.validReceipt(
          receipt,
          n,
          input.now,
          true,
          input.activate || n.status === "reconciled" ? 1 : 0,
        )
      )
        return false;
    if (
      old.contextPlan &&
      !identityRecordsEqual(old.contextPlan, n.contextPlan)
    )
      return false;
    if (
      input.contextPlanRecord &&
      !identityRecordsEqual(
        this.records.get(
          this.key(
            "identity_merge_context_plans",
            input.contextPlanRecord.planId,
          ),
        ),
        input.contextPlanRecord,
      )
    )
      return false;
    for (const receipt of [
      ...(input.contextReceipt ? [input.contextReceipt] : []),
      ...(input.contextReceipts ?? []),
    ]) {
      const offset = input.activate || n.status === "reconciled" ? 1 : 0;
      if (
        !identityContextReceiptMatches(
          receipt,
          n,
          input.now,
          !input.contextReceipt,
        ) ||
        !identityRecordsEqual(
          this.records.get(
            this.key("identity_merge_context_receipts", receipt.receiptId),
          ),
          receipt,
        ) ||
        ((
          this.records.get(
            this.key("authentication_generations", receipt.subject),
          ) as { generation: number } | undefined
        )?.generation ?? 0) !==
          receipt.identityGeneration + offset ||
        this.records.has(
          this.key("hosted_oidc_revoked_sessions", receipt.issuerSessionHash),
        )
      )
        return false;
      if (
        input.contextReceipt &&
        (receipt.role === "source"
          ? old.sourceContextAcceptance
          : old.targetContextAcceptance)
      )
        return false;
    }
    if (
      input.activate &&
      (old.status !== "reconciled" ||
        [n.sourceSubject, n.targetSubject].some(
          (subject) =>
            (
              this.records.get(this.key("identity_merge_locks", subject)) as
                | { operationId: string }
                | undefined
            )?.operationId !== n.operationId,
        ))
    )
      return false;
    if (input.reserve || input.activate) {
      for (const subject of [n.sourceSubject, n.targetSubject]) {
        const l = this.records.get(
          this.key("identity_merge_locks", subject),
        ) as { operationId: string } | undefined;
        if (l && l.operationId !== n.operationId) return false;
      }
    }
    if (
      input.reserve &&
      [...this.records.keys()]
        .filter((k) => k.startsWith("identity_merge_retry_pending\n"))
        .slice(0, input.retryCapacity!).length >= input.retryCapacity!
    )
      return false;
    // The checkpoint and all captured expiry bounds are checked again after
    // preparation. This is a local precommit boundary, not server execution/2PC.
    if (input.availabilityCheckpoint !== undefined && consumeReviewedRecoveryIssuerAvailabilityCheckpoint(input.availabilityCheckpoint, input) === undefined) return false;
    let financialWrites: readonly (readonly [string, unknown])[] = [];
    try {
      const reason = input.reserve ? "reserve" : input.activate ? "activate" : input.quarantine ? "quarantine" : input.abort ? "abort" : input.restore ? "restore" : undefined;
      if (reason) financialWrites = this.financialGenerationWrites([n.sourceSubject, n.targetSubject], input.now, n.operationId, n.revision, reason);
    } catch { return false; }
    // No awaits in this decision/write section: one winner consumes the proof.
    this.commitFinancialWrites(financialWrites);
    this.records.set(
      this.key("identity_merge_operations", n.operationId),
      structuredClone(n),
    );
    this.records.set(
      this.key("identity_merge_audit", `${n.operationId}:${n.revision}`),
      {
        operationId: n.operationId,
        sourceSubject: n.sourceSubject,
        targetSubject: n.targetSubject,
        actor: n.actor,
        policyVersion: n.policyVersion,
        decision: n.status,
        proofs: identityMergeProofAudit(n),
        consentAt: n.consentAt,
        acknowledgements: n.acknowledgements,
        undoOperationId: n.undoOperationId,
        recoveryAcknowledgements: n.recoveryAcknowledgements,
        at: input.now,
      },
    );
    if (input.contextReceipt)
      this.records.set(
        this.key(
          "identity_merge_context_receipts",
          input.contextReceipt.receiptId,
        ),
        {
          ...input.contextReceipt,
          consumedByOperation: n.operationId,
          consumedAt: input.now,
        },
      );
    if (input.receipt)
      this.records.set(
        this.key("identity_operation_receipts", input.receipt.receiptId),
        {
          ...input.receipt,
          consumedByOperation: n.operationId,
          consumedAt: input.now,
        },
      );
    if (input.reserve || input.quarantine || input.restore) {
      for (const subject of [n.sourceSubject, n.targetSubject])
        this.records.set(this.key("identity_merge_locks", subject), {
          operationId: n.operationId,
          subject,
        });
      this.revokeSubjects([n.sourceSubject, n.targetSubject], input.now);
    }
    if (input.restore || input.abort) {
      if (input.restore)
        this.records.delete(this.key("canonical_accounts", n.sourceSubject));
      for (const subject of [n.sourceSubject, n.targetSubject])
        this.records.delete(this.key("identity_merge_locks", subject));
    }
    if (input.activate || input.abort)
      this.revokeSubjects([n.sourceSubject, n.targetSubject], input.now);
    if (
      input.reserve ||
      input.activate ||
      input.quarantine ||
      input.restore ||
      input.abort
    )
      this.advanceGeneration([n.sourceSubject, n.targetSubject]);
    if (input.reserve)
      this.records.set(
        this.key("identity_merge_retry_pending", n.operationId),
        { operationId: n.operationId },
      );
    if (input.activate || input.requireRecovery || input.abort || input.restore)
      this.records.delete(
        this.key("identity_merge_retry_pending", n.operationId),
      );
    if (input.activate)
      this.records.set(this.key("canonical_accounts", n.sourceSubject), {
        sourceSubject: n.sourceSubject,
        targetSubject: n.targetSubject,
        operationId: n.operationId,
        activatedAt: input.now,
      });
    return true;
  }
  private hasExpiredEvidence(op: IdentityMergeOperation, now: number): boolean {
    return (
      op.expiresAt <= now ||
      [op.sourceProof, op.targetProof].some(
        (p) =>
          !p ||
          (
            this.records.get(
              this.key("identity_operation_receipts", p.receiptId),
            ) as IdentityOperationReceiptRecord | undefined
          )?.expiresAt! <= now,
      ) ||
      [op.sourceSubject, op.targetSubject].some(
        (subject) =>
          (
            this.records.get(this.key("account_email_proofs", subject)) as
              | { validUntil: number }
              | undefined
          )?.validUntil! <= now,
      )
    );
  }
  private validReceipt(
    r: IdentityOperationReceiptRecord,
    op: IdentityMergeOperation,
    now: number,
    consumed: boolean,
    offset: number,
  ): boolean {
    const stored = this.records.get(
      this.key("identity_operation_receipts", r.receiptId),
    );
    const subject = r.role === "source" ? op.sourceSubject : op.targetSubject;
    const identity = [...this.identities.values()].find(
      (i) =>
        i.providerId === r.providerId &&
        i.upstreamIssuer === r.upstreamIssuer &&
        i.upstreamSubject === r.upstreamSubject,
    );
    return (
      JSON.stringify(stored) === JSON.stringify(r) &&
      r.operationId === op.operationId &&
      r.sourceSubject === op.sourceSubject &&
      r.targetSubject === op.targetSubject &&
      r.subject === subject &&
      r.browserBindingHash === op.browserBindingHash &&
      r.policyVersion === op.policyVersion &&
      r.emailDigest === op.addressDigest &&
      r.startedAt >= op.createdAt &&
      r.completedAt >= r.startedAt &&
      r.completedAt <= now &&
      r.legConsent === true &&
      r.legConsentAt >= r.startedAt &&
      r.legConsentAt <= r.completedAt &&
      r.expiresAt > now &&
      r.expiresAt <= r.startedAt + 300000 &&
      r.identityGeneration + offset ===
        ((
          this.records.get(this.key("authentication_generations", subject)) as
            | { generation: number }
            | undefined
        )?.generation ?? 0) &&
      (consumed
        ? r.consumedByOperation === op.operationId
        : r.consumedByOperation === undefined) &&
      !this.records.has(
        this.key("hosted_oidc_revoked_sessions", r.issuerSessionHash),
      ) &&
      identity?.subject === subject &&
      !(
        this.records.get(
          this.key("upstream_identity_status", upstreamIdentityKey(r)),
        ) as { disabledAt?: number } | undefined
      )?.disabledAt
    );
  }
  private advanceGeneration(subjects: readonly string[]): void {
    for (const subject of new Set(subjects)) {
      const old = this.records.get(
        this.key("authentication_generations", subject),
      ) as { generation: number } | undefined;
      this.records.set(this.key("authentication_generations", subject), {
        subject,
        generation: (old?.generation ?? 0) + 1,
      });
    }
  }
  private revokeSubjects(subjects: readonly string[], now: number): void {
    this.revoke(subjects, now);
    for (const [k, v] of this.records) {
      const r = v as Record<string, unknown>;
      if (
        k.startsWith("hosted_oidc_grants\n") &&
        subjects.includes(r.subject as string)
      )
        this.records.set(k, { ...r, revokedAt: now });
    }
  }

  async page<T>(
    bucket: string,
    after: string | undefined,
    limit: number,
  ): Promise<readonly { key: string; record: T }[]> {
    return [...this.records]
      .filter(
        ([k]) =>
          k.startsWith(`${bucket}\n`) &&
          (!after || k.slice(bucket.length + 1) > after),
      )
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(0, limit)
      .map(([k, v]) => ({
        key: k.slice(bucket.length + 1),
        record: structuredClone(v) as T,
      }));
  }
  async compareAndSetCheckpoint(
    input: IdentityMergeRetryCheckpointMutation,
  ): Promise<boolean> {
    const key = this.key("identity_merge_retry_checkpoints", input.key);
    const old = this.records.get(key) as { revision: number } | undefined;
    if (
      input.expectedRevision === undefined
        ? old !== undefined
        : old?.revision !== input.expectedRevision
    )
      return false;
    this.records.set(key, structuredClone(input.next));
    return true;
  }
  async completeUnlink(input: CredentialUnlinkMutation): Promise<boolean> {
    try {
      assertCredentialUnlinkMutation(input);
    } catch {
      return false;
    }
    const { next: n, receipt: r } = input;
    const key = this.key("credential_unlink_intents", n.operationId);
    const old = this.records.get(key) as CredentialUnlinkIntent | undefined;
    if (old?.status === "completed") return identityRecordsEqual(old, n);
    if (
      !old ||
      old.status !== "pending" ||
      old.revision !== input.expectedRevision ||
      !identityRecordsEqual(
        unlinkImmutableContext(old),
        unlinkImmutableContext(n),
      ) ||
      JSON.stringify(
        this.records.get(this.key("credential_unlink_receipts", r.receiptId)),
      ) !== JSON.stringify(r) ||
      this.records.has(
        this.key("hosted_oidc_revoked_sessions", n.issuerSessionHash),
      ) ||
      ((
        this.records.get(this.key("authentication_generations", n.subject)) as
          | { generation: number }
          | undefined
      )?.generation ?? 0) !== n.identityGeneration ||
      this.records.has(this.key("canonical_accounts", n.subject))
    )
      return false;
    const lock = this.records.get(
      this.key("identity_merge_locks", n.subject),
    ) as { operationId: string } | undefined;
    if (
      lock &&
      (
        this.records.get(
          this.key("identity_merge_operations", lock.operationId),
        ) as IdentityMergeOperation | undefined
      )?.status !== "active"
    )
      return false;
    for (const tuple of [n.removedIdentity, n.retainedIdentity]) {
      const identity = [...this.identities.values()].find(
        (i) => upstreamIdentityKey(i) === upstreamIdentityKey(tuple),
      );
      if (
        !identity ||
        ((
          this.records.get(this.key("canonical_accounts", identity.subject)) as
            | { targetSubject: string }
            | undefined
        )?.targetSubject ?? identity.subject) !== n.subject ||
        (
          this.records.get(
            this.key("upstream_identity_status", upstreamIdentityKey(tuple)),
          ) as { disabledAt?: number } | undefined
        )?.disabledAt !== undefined
      )
        return false;
    }
    let financialWrites: readonly (readonly [string, unknown])[];
    try { financialWrites = this.financialGenerationWrites([n.subject], input.now, n.operationId, n.revision, "unlink"); }
    catch { return false; }
    this.commitFinancialWrites(financialWrites);
    this.records.set(key, structuredClone(n));
    this.records.set(this.key("credential_unlink_receipts", r.receiptId), {
      ...r,
      consumedByOperation: n.operationId,
    });
    this.records.set(
      this.key(
        "upstream_identity_status",
        upstreamIdentityKey(n.removedIdentity),
      ),
      {
        ...n.removedIdentity,
        identityKey: upstreamIdentityKey(n.removedIdentity),
        canonicalSubject: n.subject,
        disabledAt: input.now,
        operationId: n.operationId,
      },
    );
    this.records.set(
      this.key("identity_merge_audit", n.operationId),
      credentialUnlinkAudit(input),
    );
    this.advanceGeneration([n.subject]);
    this.revokeSubjects([n.subject], input.now);
    return true;
  }
  async unlink(input: UnlinkUpstreamIdentityInput): Promise<boolean> {
    const lookup = new Map<string, string>();
    for (const key of this.sessions.keys())
      lookup.set(await hashSessionId(key), key);
    const s = this.sessions.get(
      input.proof.sessionId ?? lookup.get(input.proof.sessionLookupHash!)!,
    );
    if (
      !s ||
      s.subject !== input.subject ||
      s.reauthenticatedAt !== input.proof.authTime ||
      s.policy !== "hosted" ||
      s.expiresAt <= input.now ||
      !s.absoluteExpiresAt ||
      s.absoluteExpiresAt <= input.now ||
      (s.identityGeneration ?? 0) !==
        ((
          this.records.get(
            this.key("authentication_generations", s.subject),
          ) as { generation: number } | undefined
        )?.generation ?? 0)
    )
      return false;
    const identityKey = upstreamIdentityKey(input.identity);
    if (this.records.has(this.key("upstream_identity_status", identityKey)))
      return false;
    const canonical = (subject: string) =>
      (
        this.records.get(this.key("canonical_accounts", subject)) as
          | { targetSubject: string }
          | undefined
      )?.targetSubject ?? subject;
    const entries = [...this.identities.values()].filter(
      (i) =>
        canonical(i.subject) === input.subject &&
        !this.records.has(
          this.key("upstream_identity_status", upstreamIdentityKey(i)),
        ),
    );
    if (
      entries.length < 2 ||
      !entries.some((i) => upstreamIdentityKey(i) === identityKey)
    )
      return false;
    const lock = this.records.get(
      this.key("identity_merge_locks", input.subject),
    ) as { operationId: string } | undefined;
    if (lock) {
      const op = this.records.get(
        this.key("identity_merge_operations", lock.operationId),
      ) as IdentityMergeOperation | undefined;
      if (op?.status !== "active") return false;
    }
    let financialWrites: readonly (readonly [string, unknown])[];
    try {
      // Revision zero is an explicit legacy sentinel, not a named intent revision.
      financialWrites = this.financialGenerationWrites([input.subject], input.now, input.operationId, 0, "unlink", true);
    } catch { return false; }
    this.commitFinancialWrites(financialWrites);
    this.records.set(this.key("upstream_identity_status", identityKey), {
      identityKey,
      ...input.identity,
      canonicalSubject: input.subject,
      disabledAt: input.now,
      operationId: input.operationId,
    });
    this.records.set(this.key("identity_merge_audit", input.operationId), {
      operationId: input.operationId,
      subject: input.subject,
      decision: "credential_unlinked",
      identityKey,
      at: input.now,
    });
    this.revokeSubjects([input.subject], input.now);
    this.advanceGeneration([input.subject]);
    return true;
  }
}

function candidateMatches(email: string | undefined, address: string): boolean {
  if (!email) return false;
  const raw = email.trim();
  if (raw.toLowerCase() === address.trim().toLowerCase()) return true;
  const at = raw.lastIndexOf("@");
  return (
    at > 0 &&
    raw.slice(0, at).toLowerCase() ===
      address.slice(0, address.lastIndexOf("@")).toLowerCase() &&
    (/[^\x00-\x7f]/.test(raw.slice(at + 1)) || /[%\\]/.test(raw.slice(at + 1)))
  );
}
