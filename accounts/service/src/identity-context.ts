import type { ControlIdentityContextPlan } from "../../../contract/identity-reconciliation.ts";
import { CONTROL_IDENTITY_AUTHORITY_VERSION } from "../../../contract/identity-reconciliation.ts";
import type { AccountsStore, AccountSessionRecord } from "./store.ts";
import type { IdentityMergeOperation } from "./identity-state.ts";
import type {
  IdentityMergeContextPlanRecord,
  IdentityMergeContextReceipt,
} from "./identity-context-state.ts";
import {
  identityContextPlanMatches,
  identityContextReceiptMatches,
  identityRecordsEqual,
} from "./hosted-identity-records.ts";
import {
  IdentityMergeConflict,
  consumedProofReceipts,
  eligibleEvidence,
  type IdentityMergeReconciler,
} from "./identity-merge.ts";

/** Both original operation proofs precede every peer Workspace inventory read. */
export async function assertIdentityContextPlanning(
  store: AccountsStore,
  operation: IdentityMergeOperation,
  now: number,
): Promise<void> {
  const current = await store.findIdentityMergeOperation?.(
    operation.operationId,
  );
  if (
    !current ||
    !identityRecordsEqual(current, operation) ||
    operation.status !== "proved" ||
    operation.consentAt ||
    operation.expiresAt <= now ||
    !operation.sourceProof ||
    !operation.targetProof
  )
    throw new IdentityMergeConflict("context_plan_unavailable");
  await consumedProofReceipts(store, operation, now, 0);
  await eligibleEvidence(
    store,
    operation.sourceSubject,
    operation.targetSubject,
    now,
  );
  for (const subject of [operation.sourceSubject, operation.targetSubject])
    if (
      (await store.isAccountAuthenticationFenced?.(subject)) ||
      (await store.findCanonicalAccount?.(subject))?.subject !== subject
    )
      throw new IdentityMergeConflict("context_plan_unavailable");
}

export function validateCoreIdentityContextPlan(
  plan: ControlIdentityContextPlan,
  op: IdentityMergeOperation,
): void {
  const planningRevision = op.contextPlan?.planningRevision ?? op.revision;
  if (
    !plan ||
    plan.authorityVersion !== CONTROL_IDENTITY_AUTHORITY_VERSION ||
    plan.operationId !== op.operationId ||
    plan.planningRevision !== planningRevision ||
    plan.sourceAccountId !== op.sourceSubject ||
    plan.targetAccountId !== op.targetSubject ||
    plan.supportedInventory !== "two-disjoint-personal-contexts/v1" ||
    typeof plan.digest !== "string" ||
    plan.digest.length < 1 ||
    plan.digest.length > 128 ||
    !plan.proofBindingDigest ||
    !plan.inventoryDigest ||
    !plan.personalWorkspaceId ||
    plan.contexts.length !== 2 ||
    JSON.stringify(plan).length > 65536 ||
    !Number.isFinite(Date.parse(plan.createdAt))
  )
    throw new IdentityMergeConflict("context_plan_conflict");
  const anchor = plan.contexts.filter(
    (c) => c.disposition === "retain-personal-anchor",
  );
  const additional = plan.contexts.filter(
    (c) => c.disposition === "insert-additional-membership",
  );
  if (
    anchor.length !== 1 ||
    additional.length !== 1 ||
    anchor[0]!.workspaceId !== plan.personalWorkspaceId ||
    anchor[0]!.originalOwnerAccountId !== op.targetSubject ||
    additional[0]!.originalOwnerAccountId !== op.sourceSubject ||
    anchor[0]!.workspaceId === additional[0]!.workspaceId ||
    plan.contexts.some(
      (c) =>
        c.canonicalAccountId !== op.targetSubject ||
        !c.workspaceRef ||
        !c.billingAuthority ||
        !c.organizationRef ||
        !Array.isArray(c.roles) ||
        !c.roles.length ||
        c.roles.length > 16 ||
        new Set(c.roles).size !== c.roles.length ||
        c.roles.some((r) => typeof r !== "string" || !r || r.length > 64),
    )
  )
    throw new IdentityMergeConflict("context_plan_conflict");
}

export async function prepareIdentityMergeContextPlan(input: {
  store: AccountsStore;
  operation: IdentityMergeOperation;
  reconciler?: IdentityMergeReconciler;
  now: number;
  clock?: () => number;
}): Promise<{
  operation: IdentityMergeOperation;
  plan: ControlIdentityContextPlan;
}> {
  const { store, operation, reconciler } = input;
  await assertIdentityContextPlanning(store, operation, input.now);
  if (
    !reconciler?.prepareContextPlan ||
    !store.createIdentityMergeContextPlan ||
    !store.findIdentityMergeContextPlan
  )
    throw new IdentityMergeConflict("context_plan_unavailable");
  if (operation.contextPlan) {
    const saved = await store.findIdentityMergeContextPlan(
      operation.contextPlan.planId,
    );
    if (!saved || !identityContextPlanMatches(saved, operation, input.now))
      throw new IdentityMergeConflict("context_plan_conflict");
    return { operation, plan: saved.controlPlan };
  }
  const plan = await reconciler.prepareContextPlan(operation);
  const now = input.clock?.() ?? input.now;
  await assertIdentityContextPlanning(store, operation, now);
  validateCoreIdentityContextPlan(plan, operation);
  const binding = {
    planId: plan.planId,
    planDigest: plan.digest,
    planningRevision: plan.planningRevision,
    authorityId: "takosumi-control",
    authorityVersion: plan.authorityVersion,
    canonicalPersonalWorkspaceId: plan.personalWorkspaceId,
  };
  const record: IdentityMergeContextPlanRecord = {
    ...binding,
    operationId: operation.operationId,
    sourceSubject: operation.sourceSubject,
    targetSubject: operation.targetSubject,
    sourceProofReceiptId: operation.sourceProof!.receiptId,
    targetProofReceiptId: operation.targetProof!.receiptId,
    sourceIdentityGeneration: operation.sourceProof!.identityGeneration,
    targetIdentityGeneration: operation.targetProof!.identityGeneration,
    browserBindingHash: operation.browserBindingHash,
    policyVersion: operation.policyVersion,
    createdAt: Date.parse(plan.createdAt),
    expiresAt: operation.expiresAt,
    controlPlan: plan,
  };
  if (!(await store.createIdentityMergeContextPlan(record))) {
    const existing = await store.findIdentityMergeContextPlan(record.planId);
    if (!identityRecordsEqual(existing, record))
      throw new IdentityMergeConflict("context_plan_conflict");
  }
  const next = {
    ...operation,
    contextPlan: binding,
    revision: operation.revision + 1,
    mutationId: crypto.randomUUID(),
    updatedAt: now,
  };
  const proofs = await consumedProofReceipts(store, operation, now, 0);
  if (
    !(await store.compareAndSetIdentityMerge?.({
      expectedRevision: operation.revision,
      next,
      now,
      contextPlanRecord: record,
      proofReceipts: proofs,
    }))
  )
    throw new IdentityMergeConflict("merge_conflict");
  return { operation: next, plan };
}

export async function acceptIdentityMergeContextPlan(input: {
  store: AccountsStore;
  operation: IdentityMergeOperation;
  session: AccountSessionRecord;
  browserBindingHash: string;
  planDigest: string;
  consent: boolean;
  now: number;
}): Promise<IdentityMergeOperation> {
  const { store, operation, session, now } = input;
  await assertIdentityContextPlanning(store, operation, now);
  if (
    !input.consent ||
    input.browserBindingHash !== operation.browserBindingHash ||
    !operation.contextPlan ||
    input.planDigest !== operation.contextPlan.planDigest ||
    ![operation.sourceSubject, operation.targetSubject].includes(
      session.subject,
    ) ||
    !store.findIdentityMergeContextPlan ||
    !store.createIdentityMergeContextReceipt ||
    !store.findIdentityMergeContextReceipt
  )
    throw new IdentityMergeConflict("context_acceptance_required");
  const role =
    session.subject === operation.sourceSubject ? "source" : "target";
  const field =
    role === "source" ? "sourceContextAcceptance" : "targetContextAcceptance";
  const live = await store.findAccountSession(session.sessionId);
  if (
    !live ||
    !identityRecordsEqual(live, session) ||
    session.policy !== "hosted" ||
    !Number.isSafeInteger(session.authTime) ||
    !session.issuerSessionId ||
    !/^sha256:[A-Za-z0-9_-]{43}$/u.test(session.issuerSessionId) ||
    session.expiresAt <= now ||
    !session.absoluteExpiresAt ||
    session.absoluteExpiresAt <= now ||
    (session.identityGeneration ?? 0) !==
      (await store.getAccountAuthenticationGeneration?.(session.subject)) ||
    (await store.isHostedOidcSessionHashRevoked?.(session.issuerSessionId))
  )
    throw new IdentityMergeConflict("authentication_required");
  if (operation[field]) return operation;
  const plan = await store.findIdentityMergeContextPlan(
    operation.contextPlan.planId,
  );
  if (!plan || !identityContextPlanMatches(plan, operation, now))
    throw new IdentityMergeConflict("context_plan_conflict");
  const proof =
    role === "source" ? operation.sourceProof! : operation.targetProof!;
  const receipt: IdentityMergeContextReceipt = {
    receiptId: `icpa_${crypto.randomUUID()}`,
    operationId: operation.operationId,
    role,
    subject: session.subject,
    sourceSubject: operation.sourceSubject,
    targetSubject: operation.targetSubject,
    planId: plan.planId,
    planDigest: plan.planDigest,
    planningRevision: plan.planningRevision,
    proofReceiptId: proof.receiptId,
    identityGeneration: proof.identityGeneration,
    browserBindingHash: operation.browserBindingHash,
    policyVersion: operation.policyVersion,
    issuerSessionHash: session.issuerSessionId,
    acceptedAt: now,
    expiresAt: operation.expiresAt,
    explicitContextConsent: true,
  };
  const acceptance = {
    receiptId: receipt.receiptId,
    proofReceiptId: receipt.proofReceiptId,
    identityGeneration: receipt.identityGeneration,
    acceptedAt: now,
    planDigest: receipt.planDigest,
  };
  const next = {
    ...operation,
    [field]: acceptance,
    revision: operation.revision + 1,
    mutationId: crypto.randomUUID(),
    updatedAt: now,
  };
  if (!(await store.createIdentityMergeContextReceipt(receipt)))
    throw new IdentityMergeConflict("merge_conflict");
  const proofs = await consumedProofReceipts(store, operation, now, 0);
  if (
    !(await store.compareAndSetIdentityMerge?.({
      expectedRevision: operation.revision,
      next,
      now,
      contextPlanRecord: plan,
      contextReceipt: receipt,
      proofReceipts: proofs,
      sessions: [
        {
          sessionId: session.sessionId,
          subject: session.subject,
          authTime: session.authTime!,
          reauthentication: false,
        },
      ],
    }))
  )
    throw new IdentityMergeConflict("merge_conflict");
  return next;
}

/** Reader used both before reservation and by trusted scheduled owner work. */
export async function readIdentityMergeContextEvidence(
  store: AccountsStore,
  op: IdentityMergeOperation,
  now: number,
  generationOffset: number,
): Promise<{
  plan: IdentityMergeContextPlanRecord;
  receipts: readonly IdentityMergeContextReceipt[];
}> {
  if (
    !op.contextPlan ||
    !op.sourceContextAcceptance ||
    !op.targetContextAcceptance ||
    !store.findIdentityMergeContextPlan ||
    !store.findIdentityMergeContextReceipt
  )
    throw new IdentityMergeConflict("context_acceptance_required");
  const plan = await store.findIdentityMergeContextPlan(op.contextPlan.planId);
  if (!plan || !identityContextPlanMatches(plan, op, now))
    throw new IdentityMergeConflict("context_plan_conflict");
  const receipts: IdentityMergeContextReceipt[] = [];
  if (
    op.sourceContextAcceptance.receiptId ===
    op.targetContextAcceptance.receiptId
  )
    throw new IdentityMergeConflict("context_acceptance_required");
  for (const [index, acceptance] of [
    op.sourceContextAcceptance,
    op.targetContextAcceptance,
  ].entries()) {
    const r = await store.findIdentityMergeContextReceipt(acceptance.receiptId);
    if (
      !r ||
      r.role !== (index === 0 ? "source" : "target") ||
      !identityContextReceiptMatches(r, op, now, true) ||
      r.acceptedAt < plan.createdAt ||
      r.identityGeneration + generationOffset !==
        (await store.getAccountAuthenticationGeneration?.(r.subject)) ||
      !store.isHostedOidcSessionHashRevoked ||
      (await store.isHostedOidcSessionHashRevoked(r.issuerSessionHash))
    )
      throw new IdentityMergeConflict("context_acceptance_required");
    receipts.push(r);
  }
  return { plan, receipts };
}
