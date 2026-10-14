import type { AccountsStore } from "./store.ts";
import type { OwnerOperationTarget, OwnerOperationRecoveryEvidence } from "./owner-operation-contract.ts";
import type { ReviewedRecoveryApprovalClaims, ReviewedRecoveryApprovalRecord, ReviewedRecoveryApprovalMutation, ReviewedRecoveryApprovalView } from "./reviewed-recovery-state.ts";
import { boundedText, canonicalOwnerJson, digest, validOwnerTarget } from "./owner-operation-evidence.ts";
import { base64UrlEncodeBytes, sha256Text } from "./encoding.ts";

const version = "takosumi.accounts.reviewed-recovery@v1";
export interface ReviewedRecoveryReviewIssuer {
  readonly issuer: string;
  readonly keyId: string;
  /** Separately qualified operator authority. No real key is supplied here. */
  readonly publicKey: CryptoKey;
}
declare const verifiedReview: unique symbol;
export interface VerifiedReviewedRecoveryApproval { readonly [verifiedReview]: true; }
const verified = new WeakMap<object, ReviewedRecoveryApprovalRecord>();

export function reviewedRecoveryDecisionDigest(approval: ReviewedRecoveryApprovalClaims): Promise<string> {
  const { createdAt: _created, expiresAt: _expires, previousApprovalDigest: _previous, reviewedApprovalRef: _event, ...decision } = approval;
  return sha256Text(`takosumi.accounts.reviewed-recovery-decision@v1:${canonicalOwnerJson(decision)}`);
}
export function reviewedRecoveryApprovalDigest(record: Pick<ReviewedRecoveryApprovalRecord, "version" | "approval" | "decisionDigest"> & { attestation: Pick<ReviewedRecoveryApprovalRecord["attestation"], "algorithm" | "issuer" | "keyId"> }): Promise<string> {
  return sha256Text(`takosumi.accounts.reviewed-recovery-approval@v1:${canonicalOwnerJson({ version: record.version, approval: record.approval, decisionDigest: record.decisionDigest, attestation: { algorithm: record.attestation.algorithm, issuer: record.attestation.issuer, keyId: record.attestation.keyId } })}`);
}
export function reviewedRecoverySignatureInput(approvalDigest: string): Uint8Array {
  return new TextEncoder().encode(`takosumi.accounts.reviewed-recovery-signature@v1:${approvalDigest}`);
}

export async function validReviewedRecoveryRecord(record: ReviewedRecoveryApprovalRecord): Promise<boolean> {
  try {
    if (!record || JSON.stringify(record).length > 16384 || Object.keys(record).sort().join(",") !== "approval,approvalDigest,attestation,decisionDigest,version" || record.version !== version || !digest(record.approvalDigest) || !digest(record.decisionDigest)) return false;
    const a = record.approval;
    const expected = ["operationId", "recoveryId", "operationRevision", "sourceAccountId", "targetAccountId", "planDigest", "sourceIdentityGeneration", "targetIdentityGeneration", "mode", "rootReviewRef", "reviewedApprovalRef", "target", "ownerEvidenceDigest", "createdAt", "expiresAt", ...(a.previousApprovalDigest === undefined ? [] : ["previousApprovalDigest"])].sort().join(",");
    if (Object.keys(a).sort().join(",") !== expected || ![a.operationId, a.recoveryId, a.sourceAccountId, a.targetAccountId, a.planDigest, a.rootReviewRef, a.reviewedApprovalRef].every(boundedText) || a.operationId === a.recoveryId || a.sourceAccountId === a.targetAccountId || ![a.operationRevision, a.sourceIdentityGeneration, a.targetIdentityGeneration, a.createdAt, a.expiresAt].every((n) => Number.isSafeInteger(n) && n >= 0) || a.expiresAt <= a.createdAt || a.expiresAt > a.createdAt + 300000 || !["abort-before-active", "restore-after-active"].includes(a.mode) || !validOwnerTarget(a.target) || !digest(a.ownerEvidenceDigest) || (a.previousApprovalDigest !== undefined && !digest(a.previousApprovalDigest))) return false;
    const proof = record.attestation;
    if (Object.keys(proof).sort().join(",") !== "algorithm,issuer,keyId,signature" || proof.algorithm !== "ES256" || !boundedText(proof.issuer) || !boundedText(proof.keyId) || !/^[A-Za-z0-9_-]{86}$/u.test(proof.signature)) return false;
    return record.decisionDigest === await reviewedRecoveryDecisionDigest(a) && record.approvalDigest === await reviewedRecoveryApprovalDigest(record);
  } catch { return false; }
}

/** No boolean verifier or caller-selected reviewer string is accepted. The
 * operator composition must qualify the actual issuer/key out of band. */
export function createReviewedRecoveryReviewVerifier(input: { reviewIssuer: ReviewedRecoveryReviewIssuer; target: OwnerOperationTarget; now?: () => number }) {
  const target = structuredClone(input.target), issuer = { ...input.reviewIssuer };
  const clock = input.now ?? Date.now;
  return Object.freeze({
    async verify(value: unknown, historical = false): Promise<VerifiedReviewedRecoveryApproval | undefined> {
      try {
        const record = structuredClone(value) as ReviewedRecoveryApprovalRecord;
        const key = issuer.publicKey;
        if (!validOwnerTarget(target) || !boundedText(issuer.issuer) || !boundedText(issuer.keyId) || key.type !== "public" || key.algorithm.name !== "ECDSA" || (key.algorithm as EcKeyAlgorithm).namedCurve !== "P-256" || !key.usages.includes("verify") || !await validReviewedRecoveryRecord(record) || canonicalOwnerJson(record.approval.target) !== canonicalOwnerJson(target) || record.attestation.issuer !== issuer.issuer || record.attestation.keyId !== issuer.keyId) return undefined;
        const now = clock();
        if (!Number.isSafeInteger(now) || record.approval.createdAt > now || (!historical && record.approval.expiresAt <= now)) return undefined;
        const signature = Uint8Array.from(atob(record.attestation.signature.replaceAll("-", "+").replaceAll("_", "/") + "=="), (c) => c.charCodeAt(0));
        if (base64UrlEncodeBytes(signature) !== record.attestation.signature || !await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, signature.buffer as ArrayBuffer, reviewedRecoverySignatureInput(record.approvalDigest).buffer as ArrayBuffer)) return undefined;
        const capability = Object.freeze({}) as VerifiedReviewedRecoveryApproval;
        verified.set(capability, record);
        return capability;
      } catch { return undefined; }
    },
  });
}

async function currentOperationMatches(store: AccountsStore, a: ReviewedRecoveryApprovalClaims): Promise<boolean> {
  const op = await store.findIdentityMergeOperation?.(a.operationId);
  if (!(!!op?.consentAt && op.revision === a.operationRevision && op.sourceSubject === a.sourceAccountId && op.targetSubject === a.targetAccountId && op.contextPlan?.planDigest === a.planDigest &&
    (a.mode === "abort-before-active" ? ["proved", "reconciled", "quarantined"].includes(op.status) : op.status === "quarantined") &&
    await store.getAccountAuthenticationGeneration?.(a.sourceAccountId) === a.sourceIdentityGeneration && await store.getAccountAuthenticationGeneration?.(a.targetAccountId) === a.targetIdentityGeneration)) return false;
  for (const subject of [a.sourceAccountId, a.targetAccountId]) {
    if ((await store.findIdentityMergeLock?.(subject))?.operationId !== a.operationId || !await store.isAccountAuthenticationFenced?.(subject)) return false;
  }
  return (await store.findCanonicalAccount?.(a.sourceAccountId))?.subject === (a.mode === "abort-before-active" ? a.sourceAccountId : a.targetAccountId) &&
    (await store.findCanonicalAccount?.(a.targetAccountId))?.subject === a.targetAccountId && canonicalOwnerJson(op) === canonicalOwnerJson(await store.findIdentityMergeOperation?.(a.operationId));
}

/** Future authenticated operator seam, deliberately not mounted as an HTTP/RPC
 * writer. An opaque verified capability is required even for internal callers. */
export async function recordVerifiedReviewedRecoveryApproval(input: { store: AccountsStore; review: VerifiedReviewedRecoveryApproval; now?: () => number }): Promise<boolean> {
  const record = verified.get(input.review);
  const store = input.store, clock = input.now ?? Date.now, now = clock();
  if (!record || !Number.isSafeInteger(now) || record.approval.createdAt > now || record.approval.expiresAt <= now || !store.findCurrentReviewedRecoveryApproval || !store.findReviewedRecoveryApproval || !store.compareAndSetReviewedRecoveryApproval || !await currentOperationMatches(store, record.approval)) return false;
  const prior = await store.findCurrentReviewedRecoveryApproval(record.approval.operationId);
  if (prior?.approvalDigest === record.approvalDigest) {
    const saved = await store.findReviewedRecoveryApproval(record.approvalDigest);
    const ref = await store.findReviewedRecoveryApprovalByRef?.(record.approval);
    return ref === record.approvalDigest && !!saved && canonicalOwnerJson(saved) === canonicalOwnerJson(record) && await currentOperationMatches(store, record.approval) && freshAt(record.approval, clock());
  }
  if (record.approval.previousApprovalDigest !== prior?.approvalDigest) return false;
  if (prior) {
    const previous = await store.findReviewedRecoveryApproval(prior.approvalDigest);
    if (!previous || previous.decisionDigest !== record.decisionDigest || previous.approval.createdAt >= record.approval.createdAt) return false;
  }
  const committedAt = clock();
  if (!freshAt(record.approval, committedAt)) return false;
  return store.compareAndSetReviewedRecoveryApproval({
    expectedApprovalDigest: prior?.approvalDigest,
    record: structuredClone(record),
    pointer: { operationId: record.approval.operationId, approvalDigest: record.approvalDigest, revision: (prior?.revision ?? -1) + 1, mutationId: crypto.randomUUID(), updatedAt: committedAt },
  });
}

export async function validReviewedRecoveryMutation(input: ReviewedRecoveryApprovalMutation): Promise<boolean> {
  const { record, pointer } = input;
  return await validReviewedRecoveryRecord(record) && record.approval.previousApprovalDigest === input.expectedApprovalDigest && pointer.operationId === record.approval.operationId && pointer.approvalDigest === record.approvalDigest && Number.isSafeInteger(pointer.revision) && pointer.revision >= 0 && (input.expectedApprovalDigest !== undefined || pointer.revision === 0) && boundedText(pointer.mutationId) && Number.isSafeInteger(pointer.updatedAt) && pointer.updatedAt >= record.approval.createdAt && pointer.updatedAt < record.approval.expiresAt;
}

export function createReviewedRecoveryApprovalAuthority(input: { store: AccountsStore; target: OwnerOperationTarget; reviewIssuer?: ReviewedRecoveryReviewIssuer; now?: () => number }) {
  const store = input.store;
  const clock = input.now ?? Date.now;
  const verifier = input.reviewIssuer ? createReviewedRecoveryReviewVerifier({ reviewIssuer: input.reviewIssuer, target: input.target, now: input.now }) : undefined;
  async function load(hash: string, historical: boolean): Promise<ReviewedRecoveryApprovalView | undefined> {
    if (!verifier || !digest(hash)) return undefined;
    try {
      const record = await store.findReviewedRecoveryApproval?.(hash);
      if (!record || record.approvalDigest !== hash || !await verifier.verify(record, historical) || (!historical && (!await currentOperationMatches(store, record.approval) || !freshAt(record.approval, clock())))) return undefined;
      return structuredClone({ ...record.approval, approvalDigest: record.approvalDigest, decisionDigest: record.decisionDigest });
    } catch { return undefined; }
  }
  async function findForOperation(operationId: string): Promise<ReviewedRecoveryApprovalView | undefined> {
    if (!verifier || !boundedText(operationId)) return undefined;
    try {
      const pointer = await store.findCurrentReviewedRecoveryApproval?.(operationId);
      if (!pointer || pointer.operationId !== operationId) return undefined;
      const approval = await load(pointer.approvalDigest, false);
      if (!approval || await store.findReviewedRecoveryApprovalByRef?.(approval) !== approval.approvalDigest) return undefined;
      const again = await store.findCurrentReviewedRecoveryApproval?.(operationId);
      return approval?.operationId === operationId && canonicalOwnerJson(pointer) === canonicalOwnerJson(again) && await currentOperationMatches(store, approval) && freshAt(approval, clock()) ? approval : undefined;
    } catch { return undefined; }
  }
  async function read(request: { operationId: string; recoveryId: string }) {
    const approval = await findForOperation(request.operationId);
    return approval?.recoveryId === request.recoveryId ? approval : undefined;
  }
  const evidence = (a: ReviewedRecoveryApprovalView): OwnerOperationRecoveryEvidence => ({ recoveryId: a.recoveryId, reviewedApprovalRef: a.reviewedApprovalRef, approvalDigest: a.approvalDigest, decisionDigest: a.decisionDigest, ownerEvidenceDigest: a.ownerEvidenceDigest });
  return Object.freeze({
    findForOperation, read,
    async readRecoveryEvidence(request: { operationId: string; recoveryId: string }) { const a = await read(request); return a && evidence(a); },
    async readHistoricalRecoveryEvidence(request: { operationId: string; recoveryId: string; approvalDigest: string }) { const a = await load(request.approvalDigest, true); return a?.operationId === request.operationId && a.recoveryId === request.recoveryId ? evidence(a) : undefined; },
    async readHistoricalRecoveryEvidenceByReviewRef(request: {operationId:string;recoveryId:string;reviewedApprovalRef:string}) {
      if (!verifier || ![request.operationId, request.recoveryId, request.reviewedApprovalRef].every(boundedText)) return undefined;
      try {
        const hash = await store.findReviewedRecoveryApprovalByRef?.(request);
        const a = hash && await load(hash, true);
        return a && a.operationId === request.operationId && a.recoveryId === request.recoveryId && a.reviewedApprovalRef === request.reviewedApprovalRef ? evidence(a) : undefined;
      } catch { return undefined; }
    },
  });
}

function freshAt(approval: ReviewedRecoveryApprovalClaims, now: number): boolean {
  return Number.isSafeInteger(now) && approval.createdAt <= now && approval.expiresAt > now;
}
