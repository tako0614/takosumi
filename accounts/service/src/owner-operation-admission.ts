import type { ControlIdentityAuthorityReader, ControlIdentityReconciliationPort, ControlMergeAdmission, ControlUnlinkAdmission } from "../../../contract/identity-reconciliation.ts";
import { CONTROL_IDENTITY_AUTHORITY_VERSION } from "../../../contract/identity-reconciliation.ts";
import type { AccountsStore } from "./store.ts";
import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";
import type { IdentityMergeOperation, IdentityOperationReceiptRecord } from "./identity-state.ts";
import type { CredentialUnlinkIntent } from "./identity-unlink-state.ts";
import {
  identityMergeOwnerContext, identityUnlinkOwnerContext, identityRecoveryOwnerContext,
  type IdentityRecoveryApprovalAuthority, type IdentityExternalOwnerContext, type IdentityExternalOwnerKind,
} from "./control-identity-reconciler.ts";
import {
  OWNER_OPERATION_PROTOCOL, type OwnerOperationAdmission, type OwnerOperationRequest, type OwnerOperationReader,
  type OwnerOperationTarget, type OwnerOperationCurrentState, type OwnerOperationContextEvidence,
  type OwnerOperationReceiptEvidence, type OwnerOperationTerminalEvidence, type OwnerOperationRecoveryEvidenceReader,
  type OwnerOperationRecoveryEvidence,
} from "./owner-operation-contract.ts";
import { canonicalOwnerJson, digest, validOwnerTarget, validOwnerContextEvidence, validOwnerReceiptEvidence } from "./owner-operation-evidence.ts";
import { identityRecordsEqual, identityContextPlanMatches, identityContextReceiptMatches } from "./hosted-identity-records.ts";
import { consumedProofReceipts } from "./identity-merge.ts";
import { readIdentityMergeContextEvidence } from "./identity-context.ts";
import { validateCredentialUnlinkReceipt } from "./identity-unlink.ts";
import { upstreamIdentityKey } from "./identity-state.ts";
import { sha256Text } from "./encoding.ts";

const ownerKinds = ["financial", "hosted-intents", "rp-sessions", "resource-bindings"] as const;
const kinds = ["merge", "unlink", "abort-before-active", "restore-after-active"];
const purposes = ["readiness", "reconcile", "readback", "release"];
const mergeId = /^imrg_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const unlinkId = /^iunl_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const validTime = (n: number) => Number.isSafeInteger(n) && n >= 0;
// Core owns its opaque plan representation (currently sha256:HEX64). Never
// transcode it or validate it as one of Accounts' new base64url digests.
const opaquePlanDigest = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256;
const recoveryProofValid = (value: OwnerOperationRecoveryEvidence): boolean => !!value &&
  typeof value.recoveryId === "string" && value.recoveryId.length > 0 && value.recoveryId.length <= 256 &&
  typeof value.reviewedApprovalRef === "string" && value.reviewedApprovalRef.length > 0 && value.reviewedApprovalRef.length <= 256 &&
  [value.approvalDigest, value.decisionDigest, value.ownerEvidenceDigest].every(digest);

function requestValue(value: unknown): OwnerOperationRequest | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const r = value as OwnerOperationRequest;
  if (Object.keys(r).sort().join(",") !== "kind,operationId,planDigest,purpose" ||
    !kinds.includes(r.kind) || !purposes.includes(r.purpose) || !opaquePlanDigest(r.planDigest) ||
    !(r.kind === "unlink" ? unlinkId : mergeId).test(r.operationId)) return undefined;
  return { operationId: r.operationId, kind: r.kind, planDigest: r.planDigest, purpose: r.purpose };
}

/** Read-only admission. Every authority and audience is captured by composition,
 * never read from an RPC body, browser session, owner props or supplied roots. */
export function createAccountsOwnerOperationReader(input: {
  store: AccountsStore;
  authority: ControlIdentityAuthorityReader;
  control: Pick<ControlIdentityReconciliationPort, "read">;
  target?: OwnerOperationTarget;
  recoveryApprovals?: IdentityRecoveryApprovalAuthority;
  recoveryEvidence?: OwnerOperationRecoveryEvidenceReader;
  now?: () => number;
}): OwnerOperationReader {
  const { store, authority, control, recoveryApprovals, recoveryEvidence } = input;
  const target = validOwnerTarget(input.target) ? structuredClone(input.target) : undefined;
  const sourceClock = input.now ?? Date.now;

  async function current(source: string, destination: string): Promise<OwnerOperationCurrentState> {
    if (!store.getAccountAuthenticationGeneration || !store.findCanonicalAccount || !store.findIdentityMergeLock || !store.isAccountAuthenticationFenced) throw new Error("current_state_unavailable");
    if (!source.startsWith("tsub_") || !destination.startsWith("tsub_")) throw new Error("current_state_unavailable");
    const sourceSubject = source as TakosumiSubject, targetSubject = destination as TakosumiSubject;
    const [sourceGeneration, targetGeneration, a, b, sourceLock, targetLock, sourceFenced, targetFenced] = await Promise.all([
      store.getAccountAuthenticationGeneration(sourceSubject), store.getAccountAuthenticationGeneration(targetSubject),
      store.findCanonicalAccount(sourceSubject), store.findCanonicalAccount(targetSubject), store.findIdentityMergeLock(sourceSubject),
      store.findIdentityMergeLock(targetSubject), store.isAccountAuthenticationFenced(sourceSubject), store.isAccountAuthenticationFenced(targetSubject),
    ]);
    if (!a || !b || !validTime(sourceGeneration) || !validTime(targetGeneration) ||
      (sourceLock && sourceLock.subject !== source) || (targetLock && targetLock.subject !== destination)) throw new Error("current_state_unavailable");
    return { sourceGeneration, targetGeneration, sourceCanonical: a.subject, targetCanonical: b.subject, sourceFenced, targetFenced,
      ...(sourceLock ? { sourceLockOperationId: sourceLock.operationId } : {}), ...(targetLock ? { targetLockOperationId: targetLock.operationId } : {}) };
  }

  async function journal(request: OwnerOperationRequest): Promise<OwnerOperationContextEvidence | undefined> {
    if (!target || !store.findOwnerOperationContextEvidence) return undefined;
    const evidence = await store.findOwnerOperationContextEvidence({ ...request, target });
    if (!evidence || !await validOwnerContextEvidence(evidence) || !identityRecordsEqual(evidence.target, target) ||
      evidence.context.operationId !== request.operationId || evidence.context.kind !== request.kind || evidence.context.planDigest !== request.planDigest) return undefined;
    return evidence;
  }

  async function historicalMerge(op: IdentityMergeOperation, now: number) {
    if (!op.contextPlan || !op.sourceProof || !op.targetProof || !op.sourceContextAcceptance || !op.targetContextAcceptance ||
      op.sourceProof.receiptId === op.targetProof.receiptId || op.sourceContextAcceptance.receiptId === op.targetContextAcceptance.receiptId ||
      !validTime(op.createdAt) || !validTime(op.expiresAt) || !validTime(op.updatedAt) || op.updatedAt > now ||
      !Number.isSafeInteger(op.revision) || op.revision < 0 || op.sourceSubject === op.targetSubject) throw new Error("historical_evidence_unavailable");
    const at = op.consentAt ?? Math.max(op.sourceContextAcceptance.acceptedAt, op.targetContextAcceptance.acceptedAt);
    if (!validTime(at) || at > now || at < op.createdAt || at >= op.expiresAt) throw new Error("historical_evidence_unavailable");
    const plan = await store.findIdentityMergeContextPlan?.(op.contextPlan.planId);
    if (!plan || !identityContextPlanMatches(plan, op, at)) throw new Error("historical_evidence_unavailable");
    const originals: IdentityOperationReceiptRecord[] = [];
    const contextReceipts = [];
    for (const [index, proof] of [op.sourceProof, op.targetProof].entries()) {
      const role = index === 0 ? "source" : "target", subject = index === 0 ? op.sourceSubject : op.targetSubject;
      const r = await store.findIdentityOperationReceipt?.(proof.receiptId);
      if (!r || r.role !== role || r.subject !== subject || r.operationId !== op.operationId || r.sourceSubject !== op.sourceSubject || r.targetSubject !== op.targetSubject ||
        r.browserBindingHash !== op.browserBindingHash || r.policyVersion !== op.policyVersion || r.emailDigest !== op.addressDigest || r.consumedByOperation !== op.operationId ||
        proof.subject !== subject || proof.identityGeneration !== r.identityGeneration || proof.method !== r.method || proof.provedAt !== r.completedAt ||
        (proof.providerId !== undefined && proof.providerId !== r.providerId) || !validTime(r.identityGeneration) ||
        ![r.startedAt, r.completedAt, r.expiresAt, r.legConsentAt].every(validTime) || r.startedAt < op.createdAt || r.completedAt < r.startedAt || r.completedAt > at ||
        r.expiresAt <= at || r.expiresAt > r.startedAt + 300000 || r.legConsent !== true || r.legConsentAt < r.startedAt || r.legConsentAt > r.completedAt ||
        !["upstream-oauth-operation", "issuer-credential-reauth"].includes(r.method) || !digest(r.issuerSessionHash) || !digest(r.transactionDigest)) throw new Error("historical_evidence_unavailable");
      const binding = await store.findUpstreamIdentity(r);
      if (!binding || binding.subject !== subject) throw new Error("historical_evidence_unavailable");
      const acceptance = index === 0 ? op.sourceContextAcceptance : op.targetContextAcceptance;
      const c = await store.findIdentityMergeContextReceipt?.(acceptance.receiptId);
      if (!c || c.role !== role || !identityContextReceiptMatches(c, op, at, true) || c.acceptedAt < plan.createdAt) throw new Error("historical_evidence_unavailable");
      originals.push(r); contextReceipts.push(c);
    }
    const admission: ControlMergeAdmission = { operationId: op.operationId, operationRevision: op.revision, planningRevision: op.contextPlan.planningRevision,
      sourceAccountId: op.sourceSubject, targetAccountId: op.targetSubject, sourceProof: { receiptId: op.sourceProof.receiptId, identityGeneration: op.sourceProof.identityGeneration, provedAt: op.sourceProof.provedAt },
      targetProof: { receiptId: op.targetProof.receiptId, identityGeneration: op.targetProof.identityGeneration, provedAt: op.targetProof.provedAt },
      browserBindingHash: op.browserBindingHash, policyVersion: op.policyVersion, createdAt: op.createdAt, expiresAt: op.expiresAt, phase: "reserved",
      contextPlan: { planId: op.contextPlan.planId, digest: op.contextPlan.planDigest, planningRevision: op.contextPlan.planningRevision, authorityVersion: op.contextPlan.authorityVersion },
      contextAcceptances: { source: op.sourceContextAcceptance, target: op.targetContextAcceptance }, ...(op.consentAt ? { consentAt: op.consentAt } : {}) };
    return { plan, admission, originals, contextReceipts, context: await identityMergeOwnerContext(op, admission, plan) };
  }

  async function receipts(evidence: OwnerOperationContextEvidence) {
    if (!store.findOwnerOperationReceiptEvidence) throw new Error("owner_receipts_unavailable");
    const result = {} as Record<IdentityExternalOwnerKind, OwnerOperationReceiptEvidence>;
    for (const ownerKind of ownerKinds) {
      const r = await store.findOwnerOperationReceiptEvidence({ contextEvidenceId: evidence.evidenceId, ownerKind });
      if (!r || r.ownerKind !== ownerKind || !validOwnerReceiptEvidence(r, evidence)) throw new Error("owner_receipts_unavailable");
      result[ownerKind] = r;
    }
    return result;
  }

  async function terminal(op: IdentityMergeOperation, requested: OwnerOperationContextEvidence): Promise<OwnerOperationTerminalEvidence> {
    const outcome = op.status;
    if (outcome !== "active" && outcome !== "aborted" && outcome !== "restored") throw new Error("terminal_unavailable");
    const kind = outcome === "active" ? "merge" : outcome === "aborted" ? "abort-before-active" : "restore-after-active";
    const evidence = await journal({ operationId: op.operationId, kind, planDigest: requested.context.planDigest, purpose: "release" });
    if (!evidence || !identityRecordsEqual((await control.read(op.operationId))?.receipt, evidence.coreReceipt)) throw new Error("terminal_unavailable");
    const ownerReceipts = await receipts(evidence);
    const a = outcome === "active" ? op.acknowledgements : op.recoveryAcknowledgements;
    if (!a || a.operationId !== op.operationId || a.sourceSubject !== op.sourceSubject || a.targetSubject !== op.targetSubject ||
      a.workspaceMembership !== evidence.coreReceipt.receiptId || a.externalBindings !== ownerReceipts["resource-bindings"].receipt.receiptId ||
      a.billingLedger !== ownerReceipts.financial.receipt.receiptId || a.consumerIntentCustody !== ownerReceipts["hosted-intents"].receipt.receiptId ||
      a.rpSessions !== ownerReceipts["rp-sessions"].receipt.receiptId || a.personalWorkspaceId !== op.contextPlan?.canonicalPersonalWorkspaceId ||
      !validTime(a.reconciledAt) || a.reconciledAt > op.updatedAt || a.reconciledAt < Date.parse(evidence.coreReceipt.recordedAt) ||
      ownerKinds.some((k) => a.reconciledAt < ownerReceipts[k].receipt.recordedAt)) throw new Error("terminal_unavailable");
    let recovery: OwnerOperationRecoveryEvidence | undefined;
    if (outcome !== "active") {
      if (!op.undoOperationId || op.recoveryAcknowledgements?.undoOperationId !== op.undoOperationId ||
        evidence.recovery?.recoveryId !== op.undoOperationId || !recoveryEvidence) throw new Error("terminal_unavailable");
      recovery = await recoveryEvidence.readHistoricalRecoveryEvidenceByReviewRef({ operationId: op.operationId, recoveryId: op.undoOperationId, reviewedApprovalRef: op.recoveryAcknowledgements.reviewedRecoveryRef });
      if (!recovery || !recoveryProofValid(recovery) || recovery.recoveryId !== evidence.recovery.recoveryId || recovery.decisionDigest !== evidence.recovery.decisionDigest ||
        recovery.ownerEvidenceDigest !== evidence.recovery.ownerEvidenceDigest || recovery.reviewedApprovalRef !== op.recoveryAcknowledgements.reviewedRecoveryRef) throw new Error("terminal_unavailable");
      if (outcome === "aborted") {
        const rollback = op.recoveryAcknowledgements.preActivationRollback;
        if (!rollback || rollback.externalBindings !== a.externalBindings || rollback.workspaceMembership !== a.workspaceMembership ||
          rollback.billingLedger !== a.billingLedger || rollback.rpSessions !== a.rpSessions || rollback.consumerIntentCustody !== a.consumerIntentCustody) throw new Error("terminal_unavailable");
      }
    }
    return { outcome, contextEvidence: evidence, ownerReceipts, receiptSetDigest: await sha256Text(`accounts-owner-receipt-set:${canonicalOwnerJson(ownerReceipts)}`), ...(recovery ? { recovery } : {}) };
  }

  return Object.freeze({ async readOwnerOperation(value: unknown): Promise<OwnerOperationAdmission | undefined> {
    try {
      const request = requestValue(value);
      if (!request || !target) return undefined;
      let lastTime = -1;
      const clock = () => { const n = sourceClock(); if (!validTime(n) || n < lastTime) throw new Error("invalid_owner_clock"); lastTime = n; return n; };
      const beganAt = clock();
      const fresh = request.purpose === "readiness" || request.purpose === "reconcile";
      let context: IdentityExternalOwnerContext;
      let contextEvidence = await journal(request);
      let freshUntil: number | undefined, recovery: OwnerOperationRecoveryEvidence | undefined;
      let lifecyclePhase: OwnerOperationAdmission["lifecyclePhase"];
      let snapshot: IdentityMergeOperation | CredentialUnlinkIntent;
      let terminalEvidence: OwnerOperationTerminalEvidence | undefined;
      let verifyFresh: (() => Promise<boolean>) | undefined;

      if (request.kind === "unlink") {
        const intent = await store.findCredentialUnlinkIntent?.(request.operationId), ticket = await store.findCredentialUnlinkAuthorityTicket?.(request.operationId);
        if (!intent || !ticket || ticket.operationId !== intent.operationId || ticket.subject !== intent.subject || ticket.identityGeneration !== intent.identityGeneration ||
          !validTime(ticket.createdAt) || ticket.createdAt < intent.createdAt || ticket.createdAt > beganAt) return undefined;
        const receipt = await store.findCredentialUnlinkReceipt?.(ticket.receiptId);
        if (!receipt || (intent.status === "completed" ? receipt.consumedByOperation !== intent.operationId : receipt.consumedByOperation !== undefined)) return undefined;
        const at = intent.status === "completed" ? intent.updatedAt : receipt.completedAt;
        validateCredentialUnlinkReceipt(intent, { ...receipt, consumedByOperation: undefined }, at);
        if (intent.status === "completed" && (intent.revision !== 1 || intent.receiptId !== receipt.receiptId || !intent.acknowledgement)) return undefined;
        const historical: ControlUnlinkAdmission = { intentId: intent.operationId, intentRevision: 0, accountId: intent.subject,
          removedIdentityDigest: await sha256Text(`credential-identity:${upstreamIdentityKey(intent.removedIdentity)}`), retainedIdentityDigest: await sha256Text(`credential-identity:${upstreamIdentityKey(intent.retainedIdentity)}`),
          retainedProofReceiptId: receipt.receiptId, identityGeneration: intent.identityGeneration, createdAt: intent.createdAt, expiresAt: Math.min(intent.expiresAt, receipt.expiresAt) };
        const state = await control.read(intent.operationId);
        const coreReceipt = contextEvidence?.coreReceipt ?? state?.receipt;
        if (!coreReceipt || (contextEvidence && !identityRecordsEqual(state?.receipt, coreReceipt))) return undefined;
        context = await identityUnlinkOwnerContext(historical, coreReceipt);
        snapshot = intent; lifecyclePhase = intent.status === "completed" ? "unlink-completed" : "unlink-pending";
        if (fresh) {
          if (intent.status !== "pending" || !identityRecordsEqual(await authority.readUnlinkAdmission({ intentId: intent.operationId }), historical)) return undefined;
          freshUntil = historical.expiresAt;
          verifyFresh = async () => identityRecordsEqual(await authority.readUnlinkAdmission({ intentId: intent.operationId }), historical);
        } else if (!contextEvidence) return undefined;
        if (request.purpose === "release") {
          if (intent.status !== "completed" || !contextEvidence) return undefined;
          const ownerReceipts = await receipts(contextEvidence);
          const a = intent.acknowledgement!;
          const ownerRef = await sha256Text(`control-unlink-custody:${canonicalOwnerJson({ control: coreReceipt.receiptId, external: ownerKinds.map((k) => ownerReceipts[k].receipt.receiptId) })}`);
          if (a.ownerRef !== ownerRef || a.operationId !== intent.operationId || a.subject !== intent.subject || a.receiptId !== receipt.receiptId || a.identityGeneration !== intent.identityGeneration ||
            upstreamIdentityKey(a.removedIdentity) !== upstreamIdentityKey(intent.removedIdentity) || upstreamIdentityKey(a.retainedIdentity) !== upstreamIdentityKey(intent.retainedIdentity) ||
            !validTime(a.acknowledgedAt) || a.acknowledgedAt > intent.updatedAt || a.acknowledgedAt < Date.parse(coreReceipt.recordedAt) ||
            ownerKinds.some((k) => a.acknowledgedAt < ownerReceipts[k].receipt.recordedAt)) return undefined;
          const disabled = await store.findUpstreamIdentityStatus?.(intent.removedIdentity);
          if (disabled?.operationId !== intent.operationId || disabled.canonicalSubject !== intent.subject || disabled.disabledAt !== intent.updatedAt) return undefined;
          terminalEvidence = { outcome: "unlink-completed", contextEvidence, ownerReceipts, receiptSetDigest: await sha256Text(`accounts-owner-receipt-set:${canonicalOwnerJson(ownerReceipts)}`) };
        }
      } else {
        const op = await store.findIdentityMergeOperation?.(request.operationId);
        if (!op) return undefined;
        const history = await historicalMerge(op, beganAt);
        snapshot = op; context = history.context;
        lifecyclePhase = op.status === "active" ? "active" : op.status === "aborted" ? "aborted" : op.status === "restored" ? "restored" : op.status === "quarantined" ? "recovery-pending" : op.consentAt ? "reserved" : "planning";
        if (request.kind === "merge") {
          if (fresh) {
            const phase = op.consentAt ? "reserved" : "planning";
            const admission = await authority.readMergeAdmission({ operationId: op.operationId, phase, planDigest: request.planDigest });
            if (!admission) return undefined;
            const originals = await consumedProofReceipts(store, op, beganAt, phase === "reserved" ? 1 : 0);
            const contexts = await readIdentityMergeContextEvidence(store, op, beganAt, phase === "reserved" ? 1 : 0);
            context = await identityMergeOwnerContext(op, admission, contexts.plan);
            freshUntil = Math.min(op.expiresAt, contexts.plan.expiresAt, ...originals.map((r) => r.expiresAt), ...contexts.receipts.map((r) => r.expiresAt));
            verifyFresh = async () => identityRecordsEqual(await authority.readMergeAdmission({ operationId: op.operationId, phase, planDigest: request.planDigest }), admission);
          } else if (!op.consentAt || !contextEvidence) return undefined;
          if (contextEvidence) context = { ...context, controlReceiptId: contextEvidence.coreReceipt.receiptId };
        } else {
          if (!op.consentAt) return undefined;
          lifecyclePhase = fresh ? "recovery-pending" : lifecyclePhase;
          if (fresh) {
            const approval = await recoveryApprovals?.findForOperation(op.operationId);
            if (!approval || approval.mode !== request.kind || !recoveryEvidence) return undefined;
            const admission = await authority.readRecoveryAdmission({ operationId: op.operationId, recoveryId: approval.recoveryId });
            recovery = await recoveryEvidence.readRecoveryEvidence({ operationId: op.operationId, recoveryId: approval.recoveryId });
            if (!admission || admission.mode !== request.kind || !recovery || !recoveryProofValid(recovery) || recovery.recoveryId !== admission.recoveryId || recovery.reviewedApprovalRef !== admission.reviewedApprovalRef) return undefined;
            const coreReceipt = contextEvidence?.coreReceipt ?? (await control.read(op.operationId))?.receipt;
            if (!coreReceipt) return undefined;
            context = await identityRecoveryOwnerContext(admission, coreReceipt, history.plan.controlPlan);
            freshUntil = approval.expiresAt;
            verifyFresh = async () => identityRecordsEqual(await authority.readRecoveryAdmission({ operationId: op.operationId, recoveryId: approval.recoveryId }), admission) &&
              identityRecordsEqual(await recoveryEvidence.readRecoveryEvidence({ operationId: op.operationId, recoveryId: approval.recoveryId }), recovery);
          } else {
            if (!contextEvidence?.recovery || !recoveryEvidence) return undefined;
            const proof = await recoveryEvidence.readHistoricalRecoveryEvidence({ operationId: op.operationId, recoveryId: contextEvidence.recovery.recoveryId, approvalDigest: contextEvidence.recovery.approvalDigest });
            if (!identityRecordsEqual(proof, contextEvidence.recovery)) return undefined;
            context = await identityRecoveryOwnerContext({ operationId: op.operationId, recoveryId: contextEvidence.recovery.recoveryId, sourceAccountId: op.sourceSubject, targetAccountId: op.targetSubject,
              planDigest: request.planDigest, mode: request.kind, reviewedApprovalRef: contextEvidence.recovery.reviewedApprovalRef, expiresAt: 0 }, contextEvidence.coreReceipt, history.plan.controlPlan);
          }
        }
        if (request.purpose === "release") {
          if (!contextEvidence) return undefined;
          if (request.kind !== "merge" && request.kind !== (op.status === "aborted" ? "abort-before-active" : op.status === "restored" ? "restore-after-active" : "merge")) return undefined;
          terminalEvidence = await terminal(op, contextEvidence);
        }
      }

      if (context.planDigest !== request.planDigest || (contextEvidence && !identityRecordsEqual(contextEvidence.context, context)) ||
        (request.purpose === "reconcile" && !contextEvidence)) return undefined;
      if (fresh && contextEvidence && !identityRecordsEqual((await control.read(request.operationId))?.receipt, contextEvidence.coreReceipt)) return undefined;
      const state = await current(context.sourceAccountId, context.targetAccountId);
      if (fresh && request.kind === "merge" && lifecyclePhase === "planning" && (state.sourceLockOperationId || state.targetLockOperationId)) return undefined;
      if (request.purpose === "release") {
        if (!terminalEvidence || state.sourceFenced || state.targetFenced) return undefined;
        if (request.kind === "unlink" ? state.sourceGeneration <= (snapshot as CredentialUnlinkIntent).identityGeneration :
          state.sourceGeneration <= (snapshot as IdentityMergeOperation).sourceProof!.identityGeneration || state.targetGeneration <= (snapshot as IdentityMergeOperation).targetProof!.identityGeneration) return undefined;
        if (terminalEvidence.outcome === "active") {
          if (state.sourceCanonical !== context.targetAccountId || state.targetCanonical !== context.targetAccountId ||
            state.sourceLockOperationId !== request.operationId || state.targetLockOperationId !== request.operationId) return undefined;
        } else if (terminalEvidence.outcome === "unlink-completed") {
          if (state.sourceCanonical !== context.sourceAccountId || state.targetCanonical !== context.targetAccountId) return undefined;
          if (state.sourceLockOperationId) {
            const prior = await store.findIdentityMergeOperation?.(state.sourceLockOperationId);
            if (!prior || prior.status !== "active" || prior.targetSubject !== context.sourceAccountId || prior.updatedAt > snapshot.createdAt) return undefined;
          }
        } else if (state.sourceCanonical !== context.sourceAccountId || state.targetCanonical !== context.targetAccountId || state.sourceLockOperationId || state.targetLockOperationId) return undefined;
      }
      const after = request.kind === "unlink" ? await store.findCredentialUnlinkIntent?.(request.operationId) : await store.findIdentityMergeOperation?.(request.operationId);
      if (!identityRecordsEqual(snapshot, after) || !identityRecordsEqual(state, await current(context.sourceAccountId, context.targetAccountId))) return undefined;
      if (contextEvidence && !identityRecordsEqual(contextEvidence, await journal(request))) return undefined;
      const accountsStateDigest = await sha256Text(`accounts-owner-state:${canonicalOwnerJson({ request, snapshot, current: state, contextEvidenceId: contextEvidence?.evidenceId, terminalReceiptSetDigest: terminalEvidence?.receiptSetDigest, recovery })}`);
      if (fresh && (!verifyFresh || !await verifyFresh())) return undefined;
      const observedAt = clock();
      if (fresh && (!freshUntil || freshUntil <= observedAt)) return undefined;
      if (contextEvidence && (contextEvidence.capturedAt > observedAt || contextEvidence.capturedOperationRevision > snapshot.revision)) return undefined;
      if (terminalEvidence && (terminalEvidence.contextEvidence.capturedAt > observedAt || terminalEvidence.contextEvidence.capturedOperationRevision > snapshot.revision ||
        ownerKinds.some((k) => terminalEvidence!.ownerReceipts[k].observedAt > observedAt))) return undefined;
      const base = { protocol: OWNER_OPERATION_PROTOCOL as typeof OWNER_OPERATION_PROTOCOL, target, context, operationRevision: snapshot.revision, current: state, observedAt,
        accountsStateDigest };
      if (fresh) return { ...base, admission: "fresh", purpose: request.purpose as "readiness" | "reconcile", lifecyclePhase: lifecyclePhase as "planning" | "reserved" | "unlink-pending" | "recovery-pending", freshUntil: freshUntil!, ...(contextEvidence ? { contextEvidence } : {}), ...(recovery ? { recovery } : {}) };
      if (request.purpose === "release") return { ...base, admission: "terminal-release", purpose: "release", lifecyclePhase: lifecyclePhase as "active" | "unlink-completed" | "aborted" | "restored", contextEvidence: contextEvidence!, terminal: terminalEvidence! };
      if (lifecyclePhase === "planning") return undefined;
      return { ...base, admission: "historical", purpose: "readback", lifecyclePhase, contextEvidence: contextEvidence! };
    } catch { return undefined; }
  } });
}
