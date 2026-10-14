import {
  InMemoryInterfaceBindingStore,
  InMemoryInterfaceStore,
} from "../../../../core/domains/interfaces/stores.ts";
import { expect, test } from "bun:test";
import { sha256Text } from "../../../../accounts/service/src/encoding.ts";
import { canonicalOwnerJson } from "../../../../accounts/service/src/owner-operation-evidence.ts";
import type { OwnerOperationRecoveryEvidence } from "../../../../accounts/service/src/owner-operation-contract.ts";
import { createAccountsOwnerOperationReader } from "../../../../accounts/service/src/owner-operation-admission.ts";
import { reviewIssuerAvailabilityFixture } from "../fixtures/review-issuer-availability-fixture.ts";
import type { ReviewedRecoveryIssuerAvailabilityReader } from "../../../../accounts/service/src/reviewed-recovery-issuer-availability.ts";
import {
  identityContextFixture,
  contextA,
  contextB,
} from "../fixtures/identity-context-fixture.ts";
import {
  createAccountsIdentityReconciliationAuthority,
  createControlIdentityReconciler,
  type IdentityExternalOwnerPorts,
  type IdentityExternalOwnerReceipt,
  type IdentityReviewedRecoveryApproval,
} from "../../../../accounts/service/src/control-identity-reconciler.ts";
import {
  prepareIdentityMergeContextPlan,
  acceptIdentityMergeContextPlan,
  readIdentityMergeContextEvidence,
} from "../../../../accounts/service/src/identity-context.ts";
import {
  createIdentityMerge,
  consentIdentityMerge,
  activateIdentityMerge,
  handleIdentityMergeRequest,
} from "../../../../accounts/service/src/identity-merge.ts";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import { WorkspacesService } from "../../../../core/domains/workspaces/mod.ts";
import { WorkspaceBillingBindingsService } from "../../../../core/domains/workspace-billing-bindings/mod.ts";
import { IdentityReconciliationService } from "../../../../core/domains/identity-reconciliation/mod.ts";
import type { IdentityMergeOperation } from "../../../../accounts/service/src/identity-state.ts";
import type { ControlIdentityReconciliationPort } from "../../../../contract/identity-reconciliation.ts";
import {
  createIdentityContextContinuation,
  validateIdentityContextContinuation,
} from "../../../../accounts/service/src/identity-context-continuation.ts";

/** All external confirmations below are labeled synthetic fixtures. They prove
 * exact binding/failure behavior, not real Financial/Hosted/RP qualification. */
async function composition(
  f: Awaited<ReturnType<typeof identityContextFixture>>,
  configureOwners = true,
) {
  const controlStore = new InMemoryOpenTofuControlStore();
  controlStore.attachIdentityReconciliationPrincipalStore(
    new InMemoryInterfaceBindingStore(new InMemoryInterfaceStore()),
  );
  let id = 0;
  const next = (prefix: string) => `${prefix}_context_fixture_${++id}`;
  const workspaces = new WorkspacesService({
    store: controlStore,
    newId: next,
    now: () => new Date(f.now),
  });
  const billing = new WorkspaceBillingBindingsService({
    store: controlStore,
    newId: next,
    now: () => new Date(f.now),
  });
  const anchors = [];
  for (const subject of [contextA, contextB]) {
    const workspace = await workspaces.ensurePersonalWorkspaceForSharedAccount(
      subject,
      subject === contextA ? "context-a" : "context-b",
    );
    const intent = await billing.prepare({
      workspaceId: workspace.id,
      actorAccountId: subject,
      billingAuthority: "fixture-financial",
    });
    const binding = await billing.claim({
      workspaceId: workspace.id,
      intentId: intent.intentId,
      actorAccountId: subject,
      organizationRef: subject === contextA ? "org_A" : "org_B",
      ownerAcknowledgementRef: `fixture-ack-${subject}`,
    });
    anchors.push({
      workspace,
      binding,
      member: (await controlStore.getWorkspaceMember(workspace.id, subject))!,
    });
  }
  let reviewedApproval: IdentityReviewedRecoveryApproval | undefined;
  const recoveryApprovals = {
    async findForOperation(operationId: string) {
      return reviewedApproval?.operationId === operationId
        ? reviewedApproval
        : undefined;
    },
    async read(request: { operationId: string; recoveryId: string }) {
      return reviewedApproval?.operationId === request.operationId &&
        reviewedApproval.recoveryId === request.recoveryId
        ? reviewedApproval
        : undefined;
    },
  };
  const authority = createAccountsIdentityReconciliationAuthority({
    store: f.store,
    now: () => f.now,
    recoveryApprovals,
  });
  const core = new IdentityReconciliationService({
    store: controlStore,
    authority,
    newId: next,
    now: () => new Date(f.now),
  });
  const owners: IdentityExternalOwnerPorts = {};
  const target = { ownerKind: "hosted-intents" as const, ownerClientId: "isolated-owner-fixture", targetBindingDigest: await sha256Text("isolated-actual-core-fixture-graph") };
  const issuerAvailability = await reviewIssuerAvailabilityFixture({ target, now: () => f.now });
  const proofHistory = new Map<string, OwnerOperationRecoveryEvidence>();
  const proofRefs = new Map<string, OwnerOperationRecoveryEvidence>();
  async function fixtureRecoveryProof() {
    if (!reviewedApproval || reviewedApproval.expiresAt <= f.now) return undefined;
    const a = reviewedApproval;
    const proof = { recoveryId: a.recoveryId, reviewedApprovalRef: a.reviewedApprovalRef,
      approvalDigest: await sha256Text(canonicalOwnerJson(a)),
      decisionDigest: await sha256Text(canonicalOwnerJson({ operationId: a.operationId, recoveryId: a.recoveryId, sourceAccountId: a.sourceAccountId, targetAccountId: a.targetAccountId, planDigest: a.planDigest, mode: a.mode })),
      ownerEvidenceDigest: await sha256Text(`isolated-pre-review-owner-evidence:${a.operationId}:${a.recoveryId}`) };
    proofHistory.set(proof.approvalDigest, proof);
    proofRefs.set(`${a.operationId}:${a.recoveryId}:${a.reviewedApprovalRef}`, proof);
    return proof;
  }
  // Synthetic review evidence only; this fixture never qualifies a real issuer.
  const recoveryEvidence = {
    async readRecoveryEvidence() { return fixtureRecoveryProof(); },
    async readHistoricalRecoveryEvidence(input: { approvalDigest: string }) { return proofHistory.get(input.approvalDigest); },
    async readHistoricalRecoveryEvidenceByReviewRef(input: { operationId: string; recoveryId: string; reviewedApprovalRef: string }) { return proofRefs.get(`${input.operationId}:${input.recoveryId}:${input.reviewedApprovalRef}`); },
  };
  const durable = new Map<string, IdentityExternalOwnerReceipt>();
  let partial = false;
  let beforeOwner: undefined | (() => Promise<void>);
  let calls = 0;
  for (const kind of [
    "financial",
    "hosted-intents",
    "rp-sessions",
    "resource-bindings",
  ] as const)
    owners[kind] = {
      kind,
      ownerId: `fixture-${kind}`,
      ownerVersion: "fixture/v1",
      assertReady: async () => true,
      async reconcile(context) {
        calls++;
        await beforeOwner?.();
        beforeOwner = undefined;
        if (partial && kind === "hosted-intents") return undefined;
        const key = kind + ":" + context.operationId + ":" + context.kind;
        let receipt = durable.get(key);
        if (!receipt) {
          receipt = {
            ...context,
            receiptId: `fixture-${kind}-${durable.size}`,
            ownerId: `fixture-${kind}`,
            ownerVersion: "fixture/v1",
            recordedAt: f.now,
          };
          durable.set(key, receipt);
        }
        return receipt;
      },
      async read(context) {
        return durable.get(
          kind + ":" + context.operationId + ":" + context.kind,
        );
      },
    };
  const reconciler = createControlIdentityReconciler({
    store: f.store,
    control: core,
    now: () => f.now,
    ...(configureOwners ? { externalOwners: owners } : {}),
    recoveryApprovals,
    recoveryEvidence,
    authority,
    ownerOperationTarget: target,
    reviewIssuerAvailability: issuerAvailability.reader,
  });
  return {
    controlStore,
    authority,
    core,
    reconciler,
    anchors,
    owners,
    target,
    reviewIssuerAvailability: issuerAvailability.reader,
    availabilityChallenges: issuerAvailability.challenges,
    recoveryApprovals,
    recoveryEvidence,
    durable,
    ownerCalls: () => calls,
    review(approval: IdentityReviewedRecoveryApproval | undefined) {
      reviewedApproval = approval;
    },
    partial(value: boolean) {
      partial = value;
    },
    beforeOwner(fn: () => Promise<void>) {
      beforeOwner = fn;
    },
  };
}
const retryFixture = { pendingCapacity: 100, assertAvailable: async () => {} };

for (const unavailableAfterDelay of [false, true]) {
  test(`final consent status is issued after delayed Core validation${unavailableAfterDelay ? " and refuses an expired round trip before CAS" : " without reusing an earlier status"}`, async () => {
    const f = await identityContextFixture();
    try {
      const c = await composition(f), op = await accepted(f, c), beganAt = f.now;
      let delayed = false, reserveCalls = 0;
      const control = new Proxy(c.core, { get(target, property) {
        if (property === "assertMergePlanCurrent") return async (request: Parameters<typeof target.assertMergePlanCurrent>[0]) => {
          const plan = await target.assertMergePlanCurrent(request);
          if (!delayed) { delayed = true; f.now += 1500; }
          return plan;
        };
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      } });
      const store = new Proxy(f.store, { get(target, property) {
        if (property === "compareAndSetIdentityMerge") return async (mutation: Parameters<NonNullable<typeof target.compareAndSetIdentityMerge>>[0]) => { if (mutation.reserve) reserveCalls++; return await target.compareAndSetIdentityMerge!(mutation); };
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      } });
      const availability = await reviewIssuerAvailabilityFixture({ target: c.target, now: () => f.now, beforeResponse(challenge) {
        if (unavailableAfterDelay && f.now >= beganAt + 1500) f.now = challenge.issuedAt + 1000;
      } });
      const adapter = createControlIdentityReconciler({ store, control, authority: c.authority, ownerOperationTarget: c.target, externalOwners: c.owners, reviewIssuerAvailability: availability.reader, now: () => f.now });
      const action = consentIdentityMerge({ store, operation: op, session: f.session(), consent: true, reconciler: adapter, retryCapability: retryFixture, now: beganAt, clock: () => f.now });
      if (unavailableAfterDelay) {
        await expect(action).rejects.toThrow("merge_reconciliation_unavailable");
        expect(reserveCalls).toBe(0);
        expect(await f.store.getAccountAuthenticationGeneration!(contextA)).toBe(0);
        expect(await f.store.isAccountAuthenticationFenced!(contextB)).toBe(false);
      } else {
        expect((await action).consentAt).toBe(beganAt + 1500);
        expect(reserveCalls).toBe(1);
      }
      expect(availability.challenges).toHaveLength(1);
      expect(availability.challenges[0]!.issuedAt).toBe(beganAt + 1500);
      expect((await c.core.read(op.operationId))?.status).toBe("prepared");
      expect(c.ownerCalls()).toBe(0);
    } finally { await f.close(); }
  });
}

test("a genuine final signed status cannot reserve an actor session that expires during the round trip", async () => {
  const f = await identityContextFixture();
  try {
    const c = await composition(f), op = await accepted(f, c);
    const session = { ...f.session(), expiresAt: f.now + 1 };
    await f.store.saveAccountSession(session);
    let reserveCalls = 0;
    const store = new Proxy(f.store, { get(target, property) {
      if (property === "compareAndSetIdentityMerge") return async (mutation: Parameters<NonNullable<typeof target.compareAndSetIdentityMerge>>[0]) => { if (mutation.reserve) reserveCalls++; return await target.compareAndSetIdentityMerge!(mutation); };
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const availability = await reviewIssuerAvailabilityFixture({ target: c.target, now: () => f.now, beforeResponse() { f.now++; } });
    const adapter = createControlIdentityReconciler({ store, control: c.core, authority: c.authority, ownerOperationTarget: c.target, externalOwners: c.owners, reviewIssuerAvailability: availability.reader, now: () => f.now });
    await expect(consentIdentityMerge({ store, operation: op, session, consent: true, reconciler: adapter, retryCapability: retryFixture, now: f.now, clock: () => f.now })).rejects.toThrow("merge_conflict");
    expect(availability.challenges).toHaveLength(1);
    expect(reserveCalls).toBe(0);
    expect(await f.store.getAccountAuthenticationGeneration!(contextA)).toBe(0);
    expect(await f.store.isAccountAuthenticationFenced!(contextB)).toBe(false);
  } finally { await f.close(); }
});

for (const forged of [false, true]) {
  test(`actual consent refuses ${forged ? "a forged" : "an omitted"} final availability checkpoint before entering reservation`, async () => {
    const f = await identityContextFixture();
    try {
      const c = await composition(f), op = await accepted(f, c);
      let reserveCalls = 0;
      const store = new Proxy(f.store, { get(target, property) {
        if (property === "compareAndSetIdentityMerge") return async (mutation: Parameters<NonNullable<typeof target.compareAndSetIdentityMerge>>[0]) => { if (mutation.reserve) reserveCalls++; return await target.compareAndSetIdentityMerge!(mutation); };
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      } });
      const adapter = { ...c.reconciler, async assertReady() {
        return (forged ? { target: c.target, availabilityCheckpoint: Object.freeze({}) } : undefined) as unknown as Awaited<ReturnType<NonNullable<typeof c.reconciler.assertReady>>>;
      } };
      await expect(consentIdentityMerge({ store, operation: op, session: f.session(), consent: true,
        reconciler: adapter, retryCapability: retryFixture, now: f.now })).rejects.toThrow("merge_reconciliation_unavailable");
      expect(reserveCalls).toBe(0);
      expect(await f.store.getAccountAuthenticationGeneration!(contextA)).toBe(0);
      expect(await f.store.isAccountAuthenticationFenced!(contextB)).toBe(false);
      expect((await c.core.read(op.operationId))?.status).toBe("prepared");
      expect(c.ownerCalls()).toBe(0);
    } finally { await f.close(); }
  });
}

for (const [label, offset] of [["backward", -1], ["noninteger", 0.5], ["expired evidence", 300001]] as const) {
  test(`final consent refuses ${label} trusted time after the genuine status without reserving`, async () => {
    const f = await identityContextFixture();
    try {
      const c = await composition(f), op = await accepted(f, c), initialNow = f.now;
      let reserveCalls = 0;
      const store = new Proxy(f.store, { get(target, property) {
        if (property === "compareAndSetIdentityMerge") return async (mutation: Parameters<NonNullable<typeof target.compareAndSetIdentityMerge>>[0]) => { if (mutation.reserve) reserveCalls++; return await target.compareAndSetIdentityMerge!(mutation); };
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      } });
      const adapter = { ...c.reconciler, async assertReady(operation: IdentityMergeOperation) {
        const readiness = await c.reconciler.assertReady!(operation);
        f.now = initialNow + offset;
        return readiness;
      } };
      await expect(consentIdentityMerge({ store, operation: op, session: f.session(), consent: true,
        reconciler: adapter, retryCapability: retryFixture, now: initialNow, clock: () => f.now })).rejects.toThrow("merge_conflict");
      expect(c.availabilityChallenges).toHaveLength(1);
      expect(reserveCalls).toBe(0);
      expect(await f.store.getAccountAuthenticationGeneration!(contextA)).toBe(0);
      expect(await f.store.isAccountAuthenticationFenced!(contextB)).toBe(false);
      expect(c.ownerCalls()).toBe(0);
    } finally { await f.close(); }
  });
}

for (const expireApproval of [false, true]) {
  test(`recovery checks current evidence before final status${expireApproval ? " and refuses approval expiry before Core" : " without carrying status across an evidence wait"}`, async () => {
    const f = await identityContextFixture();
    try {
      const c = await composition(f), op = await accepted(f, c);
      const reserved = await consentIdentityMerge({ store: f.store, operation: op, session: f.session(), consent: true, reconciler: c.reconciler, retryCapability: retryFixture, now: f.now });
      c.partial(true); expect(await c.reconciler.reconcile(reserved)).toBeUndefined(); c.partial(false);
      const beganAt = f.now;
      const approval = { operationId: op.operationId, recoveryId: "isolated-recovery-timing", operationRevision: reserved.revision, sourceAccountId: contextB, targetAccountId: contextA, planDigest: op.contextPlan!.planDigest,
        sourceIdentityGeneration: 1, targetIdentityGeneration: 1, mode: "abort-before-active" as const, reviewedApprovalRef: "isolated-review-timing", createdAt: beganAt, expiresAt: beganAt + (expireApproval ? 1 : 300000) };
      c.review(approval);
      let recoverCalls = 0;
      const control = new Proxy(c.core, { get(target, property) {
        if (property === "recover") return async (request: Parameters<typeof target.recover>[0]) => { recoverCalls++; return await target.recover(request); };
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      } });
      const recoveryEvidence = { ...c.recoveryEvidence, async readRecoveryEvidence() {
        const proof = await c.recoveryEvidence.readRecoveryEvidence();
        if (!expireApproval) f.now += 1500;
        return proof;
      } };
      const availability = await reviewIssuerAvailabilityFixture({ target: c.target, now: () => f.now, beforeResponse(challenge) {
        if (expireApproval) f.now = approval.expiresAt;
        else if (f.now >= beganAt + 1500) f.now = challenge.issuedAt + 1000;
      } });
      const adapter = createControlIdentityReconciler({ store: f.store, control, authority: c.authority, ownerOperationTarget: c.target, externalOwners: c.owners, recoveryApprovals: c.recoveryApprovals,
        recoveryEvidence, reviewIssuerAvailability: availability.reader, now: () => f.now });
      expect(await adapter.reconcileRecovery!(reserved)).toBeUndefined();
      expect(recoverCalls).toBe(0);
      expect(availability.challenges).toHaveLength(1);
      expect(availability.challenges[0]!.issuedAt).toBe(beganAt + (expireApproval ? 0 : 1500));
      expect((await c.core.read(op.operationId))?.receipt?.kind).toBe("merge-applied");
      expect(await f.store.isAccountAuthenticationFenced!(contextA)).toBe(true);
    } finally { await f.close(); }
  });
}

test("all four owner ports cannot reserve without a genuine target-bound signed review issuer availability capability", async () => {
  const f = await identityContextFixture();
  try {
    const c = await composition(f);
    const op = await accepted(f, c);
    let forgedCalls = 0;
    const wrongTarget = await reviewIssuerAvailabilityFixture({ target: { ...c.target, targetBindingDigest: await sha256Text("isolated-other-target") }, now: () => f.now });
    const unavailable = await reviewIssuerAvailabilityFixture({ target: c.target, now: () => f.now, status: "unavailable" });
    const candidates = [undefined, true, { isAvailable: async () => { forgedCalls++; return true; } }, { ...c.reviewIssuerAvailability }, wrongTarget.reader, unavailable.reader];
    for (const candidate of candidates) {
      const adapter = createControlIdentityReconciler({ store: f.store, control: c.core, authority: c.authority, ownerOperationTarget: c.target, externalOwners: c.owners,
        reviewIssuerAvailability: candidate as ReviewedRecoveryIssuerAvailabilityReader | undefined, now: () => f.now });
      await expect(consentIdentityMerge({ store: f.store, operation: op, session: f.session(), consent: true, reconciler: adapter, retryCapability: retryFixture, now: f.now })).rejects.toThrow("merge_reconciliation_unavailable");
      expect((await c.core.read(op.operationId))?.status).toBe("prepared");
      expect(await f.store.getAccountAuthenticationGeneration!(contextA)).toBe(0);
      expect(await f.store.getAccountAuthenticationGeneration!(contextB)).toBe(0);
      expect(await f.store.isAccountAuthenticationFenced!(contextA)).toBe(false);
      expect(await f.store.isAccountAuthenticationFenced!(contextB)).toBe(false);
      expect((await f.store.findIdentityMergeOperation!(op.operationId))?.consentAt).toBeUndefined();
    }
    expect(forgedCalls).toBe(0);
    expect(wrongTarget.challenges).toHaveLength(0);
    expect(unavailable.challenges).toHaveLength(1);
    expect(c.ownerCalls()).toBe(0);
    expect(await c.reconciler.assertOwnerReadiness()).toBe(false);
    expect(c.availabilityChallenges).toHaveLength(0);
  } finally { await f.close(); }
});

test("owner waits precede the final issuer challenge and expiry during that signed round trip refuses before reservation", async () => {
  const f = await identityContextFixture();
  try {
    const c = await composition(f);
    const op = await accepted(f, c);
    const beganAt = f.now;
    let ownerChecks = 0;
    const owners = Object.fromEntries(Object.entries(c.owners).map(([kind, port]) => [kind, { ...port!, assertReady: async () => { await Promise.resolve(); ownerChecks++; f.now += 6000; return true; } }])) as IdentityExternalOwnerPorts;
    const availability = await reviewIssuerAvailabilityFixture({ target: c.target, now: () => f.now, beforeResponse(challenge) {
      expect(ownerChecks).toBe(4);
      expect(challenge.issuedAt).toBe(beganAt + 24000);
      f.now = challenge.expiresAt;
    } });
    const adapter = createControlIdentityReconciler({ store: f.store, control: c.core, authority: c.authority, ownerOperationTarget: c.target, externalOwners: owners,
      reviewIssuerAvailability: availability.reader, now: () => f.now });
    await expect(consentIdentityMerge({ store: f.store, operation: op, session: f.session(), consent: true, reconciler: adapter, retryCapability: retryFixture, now: beganAt, clock: () => f.now })).rejects.toThrow("merge_reconciliation_unavailable");
    expect(ownerChecks).toBe(4);
    expect(availability.challenges).toHaveLength(1);
    expect((await c.core.read(op.operationId))?.status).toBe("prepared");
    expect(c.ownerCalls()).toBe(0);
    expect(await f.store.getAccountAuthenticationGeneration!(contextA)).toBe(0);
    expect(await f.store.isAccountAuthenticationFenced!(contextB)).toBe(false);
  } finally { await f.close(); }
});


for (const failure of ["context", "owner-receipt"] as const) {
  test(`actual Core ${failure} journal failure stops external progress and replica retry reuses the same original receipts`, async () => {
    const f = await identityContextFixture();
    try {
      const c = await composition(f);
      const op = await accepted(f, c);
      expect(op.contextPlan!.planDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
      const reserved = await consentIdentityMerge({ store: f.store, operation: op, session: f.session(), consent: true, reconciler: c.reconciler, retryCapability: retryFixture, now: f.now });
      let ownerReads = 0;
      const owners = Object.fromEntries(Object.entries(c.owners).map(([kind, port]) => [kind, { ...port!, read: async (context: Parameters<NonNullable<typeof port>["read"]>[0]) => { ownerReads++; return await port!.read(context); } }])) as IdentityExternalOwnerPorts;
      const store = new Proxy(f.store, { get(target, property) {
        if (property === (failure === "context" ? "createOwnerOperationContextEvidence" : "createOwnerOperationReceiptEvidence")) return async () => false;
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      } });
      const interrupted = createControlIdentityReconciler({ store, control: c.core, authority: c.authority, ownerOperationTarget: c.target, externalOwners: owners, reviewIssuerAvailability: c.reviewIssuerAvailability, now: () => f.now });
      expect(await interrupted.reconcile(reserved)).toBeUndefined();
      const originalCore = (await c.core.read(op.operationId))!.receipt!;
      expect(originalCore.kind).toBe("merge-applied");
      if (failure === "context") { expect(ownerReads).toBe(0); expect(c.ownerCalls()).toBe(0); }
      else { expect(ownerReads).toBe(2); expect(c.ownerCalls()).toBe(1); }
      expect(await f.store.isAccountAuthenticationFenced!(contextA)).toBe(true);
      const active = await activateIdentityMerge({ store: f.store, operation: reserved, reconciler: c.reconciler, now: f.now });
      expect(active.status).toBe("active");
      expect(c.ownerCalls()).toBe(4);
      expect((await c.core.read(op.operationId))!.receipt).toEqual(originalCore);
      const reader = createAccountsOwnerOperationReader({ store: f.store, authority: c.authority, control: c.core, target: c.target, now: () => f.now });
      const released = await reader.readOwnerOperation({ operationId: op.operationId, kind: "merge", planDigest: op.contextPlan!.planDigest, purpose: "release" });
      expect(released?.admission).toBe("terminal-release");
      expect(released?.context.controlReceiptId).toBe(originalCore.receiptId);
    } finally { await f.close(); }
  });
}

for (const mode of ["abort-before-active", "restore-after-active"] as const) {
  test(`actual Core ${mode} terminal release retains original merge ancestry and all current owner receipts`, async () => {
    const { abortPendingIdentityMerge, quarantineIdentityMerge, restoreIdentityMerge } = await import("../../../../accounts/service/src/identity-merge.ts");
    const f = await identityContextFixture();
    try {
      const c = await composition(f);
      const op = await accepted(f, c);
      let current = await consentIdentityMerge({ store: f.store, operation: op, session: f.session(), consent: true, reconciler: c.reconciler, retryCapability: retryFixture, now: f.now });
      if (mode === "abort-before-active") { c.partial(true); expect(await c.reconciler.reconcile(current)).toBeUndefined(); c.partial(false); }
      else {
        current = await activateIdentityMerge({ store: f.store, operation: current, reconciler: c.reconciler, now: f.now });
        current = await quarantineIdentityMerge({ store: f.store, operation: current, reason: "isolated-reviewed-recovery", now: f.now });
      }
      const originalCore = (await f.store.findOwnerOperationContextEvidence!({ operationId: op.operationId, kind: "merge", planDigest: op.contextPlan!.planDigest, target: c.target }))!.coreReceipt;
      c.review({ operationId: op.operationId, recoveryId: `isolated-recovery-${mode}`, operationRevision: current.revision, sourceAccountId: contextB, targetAccountId: contextA,
        planDigest: op.contextPlan!.planDigest, sourceIdentityGeneration: await f.store.getAccountAuthenticationGeneration!(contextB), targetIdentityGeneration: await f.store.getAccountAuthenticationGeneration!(contextA),
        mode, reviewedApprovalRef: `isolated-reviewed-${mode}`, createdAt: f.now, expiresAt: f.now + 300000 });
      const recovered = mode === "abort-before-active" ? await abortPendingIdentityMerge({ store: f.store, operation: current, reconciler: c.reconciler, now: f.now }) : await restoreIdentityMerge({ store: f.store, operation: current, reconciler: c.reconciler, now: f.now });
      expect(recovered.status).toBe(mode === "abort-before-active" ? "aborted" : "restored");
      const challenges = c.availabilityChallenges.filter((challenge) => challenge.kind === mode);
      expect(challenges.length).toBeGreaterThan(0);
      for (const challenge of challenges) {
        expect(challenge.operationId).toBe(op.operationId);
        expect(challenge.planDigest).toBe(op.contextPlan!.planDigest);
      }
      const reader = createAccountsOwnerOperationReader({ store: f.store, authority: c.authority, control: c.core, target: c.target, recoveryApprovals: c.recoveryApprovals, recoveryEvidence: c.recoveryEvidence, now: () => f.now });
      const request = { operationId: op.operationId, kind: "merge", planDigest: op.contextPlan!.planDigest };
      const historical = await reader.readOwnerOperation({ ...request, purpose: "readback" });
      expect(historical?.admission).toBe("historical");
      expect(historical?.context.controlReceiptId).toBe(originalCore.receiptId);
      const release = await reader.readOwnerOperation({ ...request, purpose: "release" });
      expect(release?.admission).toBe("terminal-release");
      if (release?.admission === "terminal-release") {
        expect(release.contextEvidence.coreReceipt.receiptId).toBe(originalCore.receiptId);
        expect(release.terminal.contextEvidence.coreReceipt.receiptId).not.toBe(originalCore.receiptId);
        expect(Object.keys(release.terminal.ownerReceipts)).toHaveLength(4);
        expect(release.terminal.recovery?.recoveryId).toBe(recovered.undoOperationId);
      }
      expect(await reader.readOwnerOperation({ ...request, purpose: "reconcile" })).toBeUndefined();
      expect(await reader.readOwnerOperation({ ...request, kind: mode === "abort-before-active" ? "restore-after-active" : "abort-before-active", purpose: "release" })).toBeUndefined();
      expect((await f.store.findCanonicalAccount!(contextB))?.subject).toBe(contextB);
      expect(await f.store.isAccountAuthenticationFenced!(contextA)).toBe(false);
    } finally { await f.close(); }
  });
}

async function accepted(
  f: Awaited<ReturnType<typeof identityContextFixture>>,
  c: Awaited<ReturnType<typeof composition>>,
) {
  let op = (
    await prepareIdentityMergeContextPlan({
      store: f.store,
      operation: f.operation,
      reconciler: c.reconciler,
      now: f.now,
    })
  ).operation;
  op = await acceptIdentityMergeContextPlan({
    store: f.store,
    operation: op,
    session: f.session(),
    browserBindingHash: f.browserBindingHash,
    planDigest: op.contextPlan!.planDigest,
    consent: true,
    now: f.now,
  });
  await f.login(contextB);
  op = await acceptIdentityMergeContextPlan({
    store: f.store,
    operation: op,
    session: f.session(),
    browserBindingHash: f.browserBindingHash,
    planDigest: op.contextPlan!.planDigest,
    consent: true,
    now: f.now,
  });
  await f.login(contextA);
  return op;
}
for (const kind of ["memory", "d1", "postgres", "native-d1"] as const) {
  test(`${kind}: real Core plan, two current leg acceptances, atomic roster apply and fixture external receipts retain both personal contexts`, async () => {
    const f = await identityContextFixture(kind);
    try {
      const c = await composition(f);
      const originalB = c.anchors[1]!;
      const op = await accepted(f, c);
      expect(op.sourceContextAcceptance?.receiptId).not.toBe(
        op.targetContextAcceptance?.receiptId,
      );
      const reserved = await consentIdentityMerge({
        store: f.store,
        operation: op,
        session: f.session(),
        consent: true,
        reconciler: c.reconciler,
        retryCapability: retryFixture,
        now: f.now,
      });
      expect(
        await f.store.findAccountSession(f.session().sessionId),
      ).toBeUndefined();
      const admission = await c.authority.readMergeAdmission({
        operationId: op.operationId,
        phase: "reserved",
        planDigest: op.contextPlan!.planDigest,
      });
      expect(admission?.operationRevision).toBe(reserved.revision);
      expect(admission?.sourceProof.identityGeneration).toBe(0);
      expect(
        await c.authority.readMergeAdmission({
          operationId: op.operationId,
          phase: "planning",
        }),
      ).toBeUndefined();
      const active = await activateIdentityMerge({
        store: f.store,
        operation: reserved,
        reconciler: c.reconciler,
        now: f.now,
      });
      expect(active.status).toBe("active");
      expect((await f.store.findCanonicalAccount!(contextB))?.subject).toBe(
        contextA,
      );
      expect((await f.store.findAccount(contextB))?.subject).toBe(contextB);
      expect(await c.controlStore.getWorkspace(originalB.workspace.id)).toEqual(
        originalB.workspace,
      );
      expect(
        await c.controlStore.getWorkspaceMember(
          originalB.workspace.id,
          contextB,
        ),
      ).toEqual(originalB.member);
      expect(
        await c.controlStore.getWorkspaceMember(
          originalB.workspace.id,
          contextA,
        ),
      ).toMatchObject({ status: "active", roles: ["owner"] });
      expect(
        await c.controlStore.getWorkspaceBillingBinding(originalB.workspace.id),
      ).toEqual(originalB.binding);
      expect(active.acknowledgements?.personalWorkspaceId).toBe(
        c.anchors[0]!.workspace.id,
      );
      expect(
        (
          await c.controlStore.captureIdentityReconciliationInventory([
            contextB,
          ])
        ).workspaces.find((w) => w.workspace.id === originalB.workspace.id)
          ?.bootstrapOwnerId,
      ).toBe(contextB);
      if (f.pg)
        expect(
          (await f.pg.query("SELECT * FROM accounts_v1.context_protected_refs"))
            .rows,
        ).toEqual([
          {
            subject: contextB,
            workspace_id: "workspace_B",
            org_id: "org_B",
            balance: 123456,
            pending_original_key: "pending-original-B",
          },
        ]);
    } finally {
      await f.close();
    }
  }, 30000);
  test(`${kind}: no peer inventory before both original proofs and no target-only context acceptance`, async () => {
    const f = await identityContextFixture(kind);
    try {
      const c = await composition(f);
      let lookups = 0;
      const spy = {
        ...c.reconciler,
        prepareContextPlan: async (op: IdentityMergeOperation) => {
          lookups++;
          return c.reconciler.prepareContextPlan!(op);
        },
      };
      const pending = await createIdentityMerge({
        store: f.store,
        actor: contextA,
        sourceSubject: contextB,
        targetSubject: contextA,
        browserBindingHash: f.browserBindingHash,
        now: f.now,
      });
      await expect(
        prepareIdentityMergeContextPlan({
          store: f.store,
          operation: pending,
          reconciler: spy,
          now: f.now,
        }),
      ).rejects.toThrow("context_plan_unavailable");
      expect(lookups).toBe(0);
      let op = (
        await prepareIdentityMergeContextPlan({
          store: f.store,
          operation: f.operation,
          reconciler: c.reconciler,
          now: f.now,
        })
      ).operation;
      op = await acceptIdentityMergeContextPlan({
        store: f.store,
        operation: op,
        session: f.session(),
        browserBindingHash: f.browserBindingHash,
        planDigest: op.contextPlan!.planDigest,
        consent: true,
        now: f.now,
      });
      expect(op.targetContextAcceptance).toBeDefined();
      expect(op.sourceContextAcceptance).toBeUndefined();
      await expect(
        consentIdentityMerge({
          store: f.store,
          operation: op,
          session: f.session(),
          consent: true,
          reconciler: c.reconciler,
          retryCapability: retryFixture,
          now: f.now,
        }),
      ).rejects.toThrow("context_acceptance_required");
      expect(await f.store.isAccountAuthenticationFenced!(contextA)).toBe(
        false,
      );
      const request = new Request(
        `https://auth-staging.takos.jp/api/v1/account/identity-merges/${op.operationId}/context-accept`,
        {
          method: "POST",
          headers: {
            origin: "https://auth-staging.takos.jp",
            "content-type": "application/json",
            cookie: `__Host-takosumi_session=${f.session().sessionId}; __Host-takosumi-merge-browser=${"a".repeat(64)}`,
          },
          body: JSON.stringify({
            role: "source",
            planDigest: op.contextPlan!.planDigest,
            consent: true,
          }),
        },
      );
      expect(
        (
          await handleIdentityMergeRequest({
            request,
            store: f.store,
            session: f.session(),
            issuerOrigin: "https://auth-staging.takos.jp",
            reconciler: c.reconciler,
            now: f.now,
          })
        )?.status,
      ).toBe(400);
    } finally {
      await f.close();
    }
  }, 30000);
}

test("Control-only configuration can prepare/accept a real plan but missing external owners refuses before fences", async () => {
  const f = await identityContextFixture();
  try {
    const c = await composition(f, false);
    const op = await accepted(f, c);
    expect(await c.reconciler.assertOwnerReadiness(op)).toBe(false);
    await expect(
      consentIdentityMerge({
        store: f.store,
        operation: op,
        session: f.session(),
        consent: true,
        reconciler: c.reconciler,
        retryCapability: retryFixture,
        now: f.now,
      }),
    ).rejects.toThrow("merge_reconciliation_unavailable");
    expect(await f.store.isAccountAuthenticationFenced!(contextA)).toBe(false);
    expect(await f.store.getAccountAuthenticationGeneration!(contextA)).toBe(0);
    expect(
      await c.controlStore.getWorkspaceMember(
        c.anchors[1]!.workspace.id,
        contextA,
      ),
    ).toBeUndefined();
  } finally {
    await f.close();
  }
});

test("partial external ACK after reservation retains fences; same original operation retry reads exact Core custody", async () => {
  const f = await identityContextFixture();
  try {
    const c = await composition(f);
    const op = await accepted(f, c);
    const reserved = await consentIdentityMerge({
      store: f.store,
      operation: op,
      session: f.session(),
      consent: true,
      reconciler: c.reconciler,
      retryCapability: retryFixture,
      now: f.now,
    });
    c.partial(true);
    await expect(
      activateIdentityMerge({
        store: f.store,
        operation: reserved,
        reconciler: c.reconciler,
        now: f.now,
      }),
    ).rejects.toThrow("merge_reconciliation_pending");
    expect(await f.store.isAccountAuthenticationFenced!(contextA)).toBe(true);
    expect((await f.store.findCanonicalAccount!(contextB))?.subject).toBe(
      contextB,
    );
    const coreReceipt = (await c.core.read(op.operationId))!.receipt!.receiptId;
    c.partial(false);
    const active = await activateIdentityMerge({
      store: f.store,
      operation: reserved,
      reconciler: c.reconciler,
      now: f.now,
    });
    expect(active.status).toBe("active");
    expect((await c.core.read(op.operationId))!.receipt!.receiptId).toBe(
      coreReceipt,
    );
    expect(
      (
        await c.controlStore.listWorkspaceMembers(c.anchors[1]!.workspace.id)
      ).filter((m) => m.accountId === contextA),
    ).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("a roster change during external owner wait cannot activate against the old context plan", async () => {
  const f = await identityContextFixture();
  try {
    const c = await composition(f);
    const op = await accepted(f, c);
    const reserved = await consentIdentityMerge({
      store: f.store,
      operation: op,
      session: f.session(),
      consent: true,
      reconciler: c.reconciler,
      retryCapability: retryFixture,
      now: f.now,
    });
    c.beforeOwner(async () => {
      await c.controlStore.putWorkspaceMember({
        ...c.anchors[1]!.member,
        roles: ["owner", "admin"],
      });
    });
    await expect(
      activateIdentityMerge({
        store: f.store,
        operation: reserved,
        reconciler: c.reconciler,
        now: f.now,
      }),
    ).rejects.toThrow();
    expect((await f.store.findCanonicalAccount!(contextB))?.subject).toBe(
      contextB,
    );
    expect(await f.store.isAccountAuthenticationFenced!(contextA)).toBe(true);
  } finally {
    await f.close();
  }
});

test("reserved reader refuses duplicate context legs, wrong proof generation, foreign locks and moving revisions", async () => {
  const f = await identityContextFixture();
  try {
    const c = await composition(f);
    const op = await accepted(f, c);
    await expect(
      readIdentityMergeContextEvidence(
        f.store,
        { ...op, targetContextAcceptance: op.sourceContextAcceptance },
        f.now,
        0,
      ),
    ).rejects.toThrow("context_acceptance_required");
    const reserved = await consentIdentityMerge({
      store: f.store,
      operation: op,
      session: f.session(),
      consent: true,
      reconciler: c.reconciler,
      retryCapability: retryFixture,
      now: f.now,
    });
    const find = f.store.findIdentityMergeOperation!.bind(f.store);
    for (const changed of [
      {
        ...reserved,
        targetContextAcceptance: reserved.sourceContextAcceptance,
      },
      {
        ...reserved,
        sourceProof: { ...reserved.sourceProof!, identityGeneration: 9 },
      },
    ]) {
      f.store.findIdentityMergeOperation = async () => changed;
      expect(
        await c.authority.readMergeAdmission({
          operationId: op.operationId,
          phase: "reserved",
        }),
      ).toBeUndefined();
    }
    let reads = 0;
    f.store.findIdentityMergeOperation = async () =>
      reads++ ? { ...reserved, revision: reserved.revision + 1 } : reserved;
    expect(
      await c.authority.readMergeAdmission({
        operationId: op.operationId,
        phase: "reserved",
      }),
    ).toBeUndefined();
    f.store.findIdentityMergeOperation = find;
    const lock = f.store.findIdentityMergeLock!.bind(f.store);
    f.store.findIdentityMergeLock = async (subject) => ({
      subject,
      operationId: "foreign",
    });
    expect(
      await c.authority.readMergeAdmission({
        operationId: op.operationId,
        phase: "reserved",
      }),
    ).toBeUndefined();
    f.store.findIdentityMergeLock = lock;
    expect(
      await c.authority.readMergeAdmission({
        operationId: op.operationId,
        phase: "reserved",
      }),
    ).toBeDefined();
  } finally {
    await f.close();
  }
});

test("recovery reader rejects malformed approvals and forged caller context before any owner side effect", async () => {
  const f = await identityContextFixture();
  try {
    const c = await composition(f);
    const op = await accepted(f, c);
    const reserved = await consentIdentityMerge({
      store: f.store,
      operation: op,
      session: f.session(),
      consent: true,
      reconciler: c.reconciler,
      retryCapability: retryFixture,
      now: f.now,
    });
    let approval: IdentityReviewedRecoveryApproval = {
      operationId: op.operationId,
      recoveryId: "reviewed-undo",
      operationRevision: reserved.revision,
      sourceAccountId: contextB,
      targetAccountId: contextA,
      planDigest: op.contextPlan!.planDigest,
      sourceIdentityGeneration: 1,
      targetIdentityGeneration: 1,
      mode: "abort-before-active",
      reviewedApprovalRef: "fixture-reviewed",
      createdAt: f.now,
      expiresAt: f.now + 300000,
    };
    const recoveryApprovals = {
      read: async () => approval,
      findForOperation: async () => approval,
    };
    const authority = createAccountsIdentityReconciliationAuthority({
      store: f.store,
      now: () => f.now,
      recoveryApprovals,
    });
    for (const change of [
      { expiresAt: NaN },
      { expiresAt: undefined },
      { mode: "unknown" },
      { sourceAccountId: "tsub_foreign" },
    ] as const) {
      const saved = approval;
      approval = { ...saved, ...change } as IdentityReviewedRecoveryApproval;
      expect(
        await authority.readRecoveryAdmission({
          operationId: op.operationId,
          recoveryId: "reviewed-undo",
        }),
      ).toBeUndefined();
      approval = saved;
    }
    let effects = 0;
    const control: ControlIdentityReconciliationPort = {
      ...c.core,
      prepareMerge: c.core.prepareMerge.bind(c.core),
      assertMergePlanCurrent: c.core.assertMergePlanCurrent.bind(c.core),
      applyMerge: c.core.applyMerge.bind(c.core),
      read: c.core.read.bind(c.core),
      acknowledgeUnlink: c.core.acknowledgeUnlink.bind(c.core),
      recover: async () => {
        effects++;
        throw new Error("must not call");
      },
    };
    const adapter = createControlIdentityReconciler({
      store: f.store,
      control,
      externalOwners: c.owners,
      recoveryApprovals,
      now: () => f.now,
    });
    expect(
      await adapter.reconcileRecovery!({
        ...reserved,
        sourceSubject: "tsub_forged",
      }),
    ).toBeUndefined();
    expect(effects).toBe(0);
    expect(c.ownerCalls()).toBe(0);
  } finally {
    await f.close();
  }
});

test("staging-only context continuation binds exact operation/browser/provider identity and current original root", async () => {
  const f = await identityContextFixture();
  try {
    const c = await composition(f);
    const op = (
      await prepareIdentityMergeContextPlan({
        store: f.store,
        operation: f.operation,
        reconciler: c.reconciler,
        now: f.now,
      })
    ).operation;
    const path = `/identity-merges/${op.operationId}/contexts`;
    const request = (
      cookie = f.session().sessionId,
      browser = "a".repeat(64),
      origin = "https://auth-staging.takos.jp",
    ) =>
      new Request(`${origin}/oauth/upstream/authorize`, {
        headers: {
          cookie: `__Host-takosumi_session=${cookie}; __Host-takosumi-merge-browser=${browser}`,
        },
      });
    const continuation = await createIdentityContextContinuation({
      request: request(),
      store: f.store,
      target: new URL(path, "https://auth-staging.takos.jp"),
      providerId: "github",
      now: f.now,
    });
    await validateIdentityContextContinuation({
      request: request(),
      store: f.store,
      continuation,
      now: f.now,
      exchange: {
        providerId: "github",
        upstreamIssuer: "https://github.com",
        upstreamSubject: "4711",
      },
      accountSubject: contextB,
    });
    for (const target of [
      new URL(path + "?role=source", "https://auth-staging.takos.jp"),
      new URL(path, "https://auth.takos.jp"),
      new URL(path + "#x", "https://auth-staging.takos.jp"),
    ])
      await expect(
        createIdentityContextContinuation({
          request: request(),
          store: f.store,
          target,
          providerId: "github",
          now: f.now,
        }),
      ).rejects.toThrow();
    await expect(
      validateIdentityContextContinuation({
        request: request(undefined, "b".repeat(64)),
        store: f.store,
        continuation,
        now: f.now,
      }),
    ).rejects.toThrow();
    await expect(
      validateIdentityContextContinuation({
        request: request(),
        store: f.store,
        continuation,
        now: f.now,
        exchange: {
          providerId: "github",
          upstreamIssuer: "https://github.com",
          upstreamSubject: "third-root",
        },
      }),
    ).rejects.toThrow("wrong_context_identity");
    expect(
      await f.store.findAccountSession(f.session().sessionId),
    ).toBeDefined();
  } finally {
    await f.close();
  }
});

test("actual HTTP identity workflow has a separate bounded40 budget while PAT issuance retains10", async () => {
  const { createAccountsHandler } = await import(
    "../../../../accounts/service/src/mod.ts"
  );
  const f = await identityContextFixture();
  try {
    const c = await composition(f, false);
    const handler = createAccountsHandler({
      store: f.store,
      issuer: "https://auth-staging.takos.jp",
      hostedSessionPolicy: true,
      identityMergeReconciler: c.reconciler,
      identityMergeRetry: retryFixture,
    });
    let count = 0;
    const send = async (path: string, body?: unknown) => {
      const request = new Request("https://auth-staging.takos.jp" + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          origin: "https://auth-staging.takos.jp",
          "content-type": "application/json",
          "cf-connecting-ip": "198.51.100.17",
          cookie: `__Host-takosumi_session=${f.session().sessionId}; __Host-takosumi-merge-browser=${"a".repeat(64)}`,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (path.includes("identity-merges")) count++;
      return handler(request);
    };
    const base = `/api/v1/account/identity-merges/${f.operation.operationId}`;
    for (let i = 0; i < 12; i++) {
      expect((await send(base)).status).toBe(200);
      expect((await send("/api/v1/account/session/me")).status).toBe(200);
    }
    const prepared = await send(base + "/context-plan", {});
    expect(prepared.status).toBe(200);
    const body = (await prepared.json()) as {
      operation: IdentityMergeOperation;
      plan: { digest: string };
    };
    expect(
      (
        await send(base + "/context-accept", {
          planDigest: body.plan.digest,
          consent: true,
        })
      ).status,
    ).toBe(200);
    await f.login(contextB);
    for (let i = 0; i < 3; i++) expect((await send(base)).status).toBe(200);
    expect(
      (
        await send(base + "/context-accept", {
          planDigest: body.plan.digest,
          consent: true,
        })
      ).status,
    ).toBe(200);
    await f.login(contextA);
    for (let i = 0; i < 3; i++) expect((await send(base)).status).toBe(200);
    const consent = await send(base + "/consent", { consent: true });
    expect(consent.status).toBe(409);
    expect(
      ((await consent.json()) as { error: { code: string } }).error.code,
    ).toBe("merge_reconciliation_unavailable");
    expect(await f.store.isAccountAuthenticationFenced!(contextA)).toBe(false);
    while (count < 40) expect((await send(base)).status).toBe(200);
    const limited = await send(base);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeDefined();
    for (let i = 0; i < 10; i++)
      expect((await send("/api/v1/account/tokens", {})).status).not.toBe(429);
    expect((await send("/api/v1/account/tokens", {})).status).toBe(429);
  } finally {
    await f.close();
  }
});

test("actual verified GitHub HTTP callback switches only the other original root and returns to the context portal", async () => {
  const { handleUpstreamAuthorizeRequest, handleUpstreamCallbackRequest } =
    await import("../../../../accounts/service/src/upstream-oauth-routes.ts");
  const { verifiedSocialOAuthProvider } = await import(
    "../../../../accounts/service/src/upstream-verification.ts"
  );
  const f = await identityContextFixture();
  let userId = 4711;
  const calls: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      calls.push(path);
      if (path === "/token")
        return Response.json({
          access_token: "fixture-only-github-access",
          token_type: "bearer",
        });
      if (path === "/user")
        return Response.json({ id: userId, login: "fixture-account" });
      if (path === "/emails")
        return Response.json([
          {
            email: "Owner@example.test",
            verified: true,
            primary: true,
            visibility: null,
          },
        ]);
      return new Response(null, { status: 404 });
    },
  });
  try {
    const c = await composition(f);
    const op = (
      await prepareIdentityMergeContextPlan({
        store: f.store,
        operation: f.operation,
        reconciler: c.reconciler,
        now: f.now,
      })
    ).operation;
    const path = `/identity-merges/${op.operationId}/contexts`;
    const github = verifiedSocialOAuthProvider({
      id: "github",
      profile: "github-oauth",
    });
    const transport = (async (value, init) => {
      const request = new Request(value, init);
      const url = new URL(request.url);
      const route =
        url.origin + url.pathname === github.tokenEndpoint
          ? "/token"
          : url.origin + url.pathname === github.userInfoEndpoint
            ? "/user"
            : "/emails";
      return fetch(new URL(route, server.url), {
        method: request.method,
        headers: request.headers,
        body: request.method === "POST" ? await request.text() : undefined,
        redirect: "manual",
      });
    }) as typeof fetch;
    const upstreamOAuth = {
      hostedSessionPolicy: true,
      subjectSecret: "fixture-only-context-secret",
      providers: [
        {
          providerId: "github",
          label: "GitHub",
          provider: github,
          clientId: "fixture-context-client",
          clientSecret: "fixture-context-secret",
          redirectUri: "https://auth-staging.takos.jp/oauth/upstream/callback",
        },
      ],
      fetch: transport,
    };
    const browserCookie = `__Host-takosumi_session=${f.session().sessionId}; __Host-takosumi-merge-browser=${"a".repeat(64)}`;
    const begin = async () => {
      const url = new URL(
        "https://auth-staging.takos.jp/oauth/upstream/authorize",
      );
      url.searchParams.set("provider", "github");
      url.searchParams.set("return_to", path);
      return await handleUpstreamAuthorizeRequest({
        url,
        request: new Request(url, { headers: { cookie: browserCookie } }),
        store: f.store,
        upstreamOAuth,
        secureCookie: true,
      });
    };
    const callback = async (response: Response) => {
      const authorize = new URL(response.headers.get("location")!);
      const state = authorize.searchParams.get("state")!;
      const url = new URL(
        `https://auth-staging.takos.jp/oauth/upstream/callback?state=${state}&code=fixture-code`,
      );
      const stateCookie = response.headers.get("set-cookie")!.split(";")[0];
      return await handleUpstreamCallbackRequest({
        url,
        request: new Request(url, {
          headers: { cookie: browserCookie + "; " + stateCookie },
        }),
        store: f.store,
        upstreamOAuth,
        secureCookie: true,
      });
    };
    const wrongBegin = await begin();
    expect(wrongBegin.status).toBe(302);
    userId = 9999;
    const wrong = await callback(wrongBegin);
    expect(wrong.status).not.toBe(302);
    expect(
      await f.store.findAccountSession(f.session().sessionId),
    ).toBeDefined();
    expect(
      await f.store.findUpstreamIdentity({
        providerId: "github",
        upstreamIssuer: "https://github.com",
        upstreamSubject: "9999",
      }),
    ).toBeUndefined();
    userId = 4711;
    const validBegin = await begin();
    expect(validBegin.status).toBe(302);
    const response = await callback(validBegin);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(path);
    expect(response.headers.get("location")).not.toContain("receipt");
    expect(
      await f.store.findAccountSession(f.session().sessionId),
    ).toBeUndefined();
    const match = /__Host-takosumi_session=([^; ,]+)/u.exec(
      response.headers.get("set-cookie")!,
    );
    expect((await f.store.findAccountSession(match![1]!))?.subject).toBe(
      contextB,
    );
    expect(calls).toEqual([
      "/token",
      "/user",
      "/emails",
      "/token",
      "/user",
      "/emails",
    ]);
    const callsBefore = calls.length;
    expect((await callback(validBegin)).status).toBe(400);
    expect(calls).toHaveLength(callsBefore);
  } finally {
    server.stop(true);
    await f.close();
  }
}, 30000);

for (const kind of ["memory", "d1", "postgres", "native-d1"] as const)
  test(`${kind}: preparing the same immutable plan recovers after document save but operation CAS failure`, async () => {
    const f = await identityContextFixture(kind);
    try {
      const c = await composition(f);
      const compare = f.store.compareAndSetIdentityMerge!.bind(f.store);
      let failed = false;
      f.store.compareAndSetIdentityMerge = async (input) => {
        if (input.contextPlanRecord && !failed) {
          failed = true;
          return false;
        }
        return compare(input);
      };
      await expect(
        prepareIdentityMergeContextPlan({
          store: f.store,
          operation: f.operation,
          reconciler: c.reconciler,
          now: f.now,
        }),
      ).rejects.toThrow("merge_conflict");
      expect(await f.store.isAccountAuthenticationFenced!(contextA)).toBe(
        false,
      );
      const original = await c.core.read(f.operation.operationId);
      expect(original?.status).toBe("prepared");
      const result = await prepareIdentityMergeContextPlan({
        store: f.store,
        operation: f.operation,
        reconciler: c.reconciler,
        now: f.now + 100,
      });
      expect(result.plan.planId).toBe(original!.plan!.planId);
      expect(result.operation.contextPlan?.planDigest).toBe(
        original!.plan!.digest,
      );
      expect(
        (await f.store.findIdentityMergeContextPlan!(result.plan.planId))
          ?.createdAt,
      ).toBe(Date.parse(result.plan.createdAt));
    } finally {
      await f.close();
    }
  }, 30000);

test("actual Core unlink preservation consumes the selected retained proof without splitting memberships or original account references", async () => {
  const { createCredentialUnlinkIntent, completeCredentialUnlink } =
    await import("../../../../accounts/service/src/identity-unlink.ts");
  const { sha256Text } = await import(
    "../../../../accounts/service/src/encoding.ts"
  );
  const f = await identityContextFixture();
  try {
    const c = await composition(f);
    const op = await accepted(f, c);
    const reserved = await consentIdentityMerge({
      store: f.store,
      operation: op,
      session: f.session(),
      consent: true,
      reconciler: c.reconciler,
      retryCapability: retryFixture,
      now: f.now,
    });
    await activateIdentityMerge({
      store: f.store,
      operation: reserved,
      reconciler: c.reconciler,
      now: f.now,
    });
    await f.login(contextA);
    const before = await c.controlStore.captureIdentityReconciliationInventory([
      contextA,
    ]);
    const removedIdentity = {
      providerId: "google",
      upstreamIssuer: "https://accounts.google.com",
      upstreamSubject: "context-google-A",
    };
    const retainedIdentity = {
      providerId: "github",
      upstreamIssuer: "https://github.com",
      upstreamSubject: "4711",
    };
    const intent = await createCredentialUnlinkIntent({
      store: f.store,
      session: f.session(),
      removedIdentity,
      retainedIdentity,
      browserBindingHash: await sha256Text("unlink-browser:" + "b".repeat(64)),
      now: f.now,
    });
    const receipt = {
      receiptId: `iupr_${crypto.randomUUID()}`,
      operationId: intent.operationId,
      subject: intent.subject,
      removedIdentity,
      retainedIdentity,
      browserBindingHash: intent.browserBindingHash,
      issuerSessionHash: intent.issuerSessionHash,
      identityGeneration: intent.identityGeneration,
      policyVersion: intent.policyVersion,
      transactionDigest: await sha256Text("fixture-unlink-transaction"),
      startedAt: f.now,
      expiresAt: intent.expiresAt,
      legConsent: true as const,
      legConsentAt: f.now,
      completedAt: f.now,
      method: "upstream-oauth-operation" as const,
    };
    await f.store.createCredentialUnlinkReceipt!(receipt);
    const done = await completeCredentialUnlink({
      store: f.store,
      intent,
      receiptId: receipt.receiptId,
      reconciler: c.reconciler,
      now: f.now,
    });
    expect(done.status).toBe("completed");
    const issuerChallenges = c.availabilityChallenges.filter((challenge) => challenge.kind === "unlink");
    expect(issuerChallenges.length).toBeGreaterThan(0);
    for (const challenge of issuerChallenges) {
      expect(challenge.operationId).toBe(intent.operationId);
      expect(challenge.planDigest).toBe((await c.core.read(intent.operationId))!.receipt!.planDigest);
    }
    const ownerReader = createAccountsOwnerOperationReader({ store: f.store, authority: c.authority, control: c.core, target: c.target, recoveryApprovals: c.recoveryApprovals, recoveryEvidence: c.recoveryEvidence, now: () => f.now });
    const ownerRequest = { operationId: intent.operationId, kind: "unlink", planDigest: (await c.core.read(intent.operationId))!.receipt!.planDigest };
    expect((await ownerReader.readOwnerOperation({ ...ownerRequest, purpose: "readback" }))?.admission).toBe("historical");
    expect((await ownerReader.readOwnerOperation({ ...ownerRequest, purpose: "release" }))?.admission).toBe("terminal-release");
    expect(await ownerReader.readOwnerOperation({ ...ownerRequest, purpose: "reconcile" })).toBeUndefined();
    expect((await c.core.read(intent.operationId))?.receipt?.kind).toBe(
      "unlink-preserved",
    );
    expect(
      await c.controlStore.captureIdentityReconciliationInventory([contextA]),
    ).toEqual(before);
    expect(
      (await f.store.findUpstreamIdentity(retainedIdentity))?.subject,
    ).toBe(contextB);
    expect((await f.store.findCanonicalAccount!(contextB))?.subject).toBe(
      contextA,
    );
    expect(
      (await f.store.findUpstreamIdentityStatus!(removedIdentity))?.disabledAt,
    ).toBeDefined();
    expect(
      (await f.store.findUpstreamIdentityStatus!(retainedIdentity))?.disabledAt,
    ).toBeUndefined();
    expect(await f.store.getAccountAuthenticationGeneration!(contextA)).toBe(3);
    expect(
      (await f.store.findCredentialUnlinkAuthorityTicket!(intent.operationId))
        ?.receiptId,
    ).toBe(receipt.receiptId);
  } finally {
    await f.close();
  }
});

test("expired partial recovery resumes the same Core decision only after renewed real approval and retains original event custody", async () => {
  const { abortPendingIdentityMerge } = await import(
    "../../../../accounts/service/src/identity-merge.ts"
  );
  const f = await identityContextFixture();
  try {
    const c = await composition(f);
    const op = await accepted(f, c);
    let reserved = await consentIdentityMerge({
      store: f.store,
      operation: op,
      session: f.session(),
      consent: true,
      reconciler: c.reconciler,
      retryCapability: retryFixture,
      now: f.now,
    });
    c.partial(true);
    await expect(
      activateIdentityMerge({
        store: f.store,
        operation: reserved,
        reconciler: c.reconciler,
        now: f.now,
      }),
    ).rejects.toThrow("merge_reconciliation_pending");
    f.now += 400001;
    const marked = {
      ...reserved,
      conflict: "reviewed_recovery_required",
      revision: reserved.revision + 1,
      mutationId: crypto.randomUUID(),
      updatedAt: f.now,
    };
    expect(
      await f.store.compareAndSetIdentityMerge!({
        expectedRevision: reserved.revision,
        next: marked,
        now: f.now,
        requireRecovery: true,
      }),
    ).toBe(true);
    reserved = marked;
    let approval: IdentityReviewedRecoveryApproval = {
      operationId: op.operationId,
      recoveryId: "fixture-reviewed-abort",
      operationRevision: reserved.revision,
      sourceAccountId: contextB,
      targetAccountId: contextA,
      planDigest: op.contextPlan!.planDigest,
      sourceIdentityGeneration: 1,
      targetIdentityGeneration: 1,
      mode: "abort-before-active",
      reviewedApprovalRef: "fixture-review-original",
      createdAt: f.now,
      expiresAt: f.now + 300000,
    };
    c.review(approval);
    await expect(
      abortPendingIdentityMerge({
        store: f.store,
        operation: reserved,
        reconciler: c.reconciler,
        now: f.now,
      }),
    ).rejects.toThrow("recovery_review_required");
    const originalReceipt = (await c.core.read(op.operationId))!.receipt!;
    expect(originalReceipt.kind).toBe("merge-aborted");
    expect(await f.store.isAccountAuthenticationFenced!(contextA)).toBe(true);
    f.now += 300001;
    expect(
      await c.authority.readRecoveryAdmission({
        operationId: op.operationId,
        recoveryId: approval.recoveryId,
      }),
    ).toBeUndefined();
    await expect(
      abortPendingIdentityMerge({
        store: f.store,
        operation: reserved,
        reconciler: c.reconciler,
        now: f.now,
      }),
    ).rejects.toThrow("recovery_review_required");
    approval = {
      ...approval,
      reviewedApprovalRef: "fixture-review-renewed",
      createdAt: f.now,
      expiresAt: f.now + 300000,
    };
    c.review({ ...approval, mode: "restore-after-active" });
    expect(
      await c.authority.readRecoveryAdmission({
        operationId: op.operationId,
        recoveryId: approval.recoveryId,
      }),
    ).toBeUndefined();
    c.review(approval);
    c.partial(false);
    const aborted = await abortPendingIdentityMerge({
      store: f.store,
      operation: reserved,
      reconciler: c.reconciler,
      now: f.now,
    });
    expect(aborted.status).toBe("aborted");
    expect(aborted.recoveryAcknowledgements?.reviewedRecoveryRef).toBe(
      "fixture-review-renewed",
    );
    expect((await c.core.read(op.operationId))!.receipt).toEqual(
      originalReceipt,
    );
    expect(
      (
        await c.controlStore.listIdentityReconciliationEvents(op.operationId)
      ).find((e) => e.decision === "merge-aborted")?.approvalRef,
    ).toBe("fixture-review-original");
    expect(
      (
        await c.controlStore.getWorkspaceMember(
          c.anchors[1]!.workspace.id,
          contextA,
        )
      )?.status,
    ).toBe("suspended");
    expect(
      await c.controlStore.getWorkspaceMember(
        c.anchors[1]!.workspace.id,
        contextB,
      ),
    ).toEqual(c.anchors[1]!.member);
    expect((await f.store.findCanonicalAccount!(contextB))?.subject).toBe(
      contextB,
    );
    expect(await f.store.isAccountAuthenticationFenced!(contextA)).toBe(false);
    expect(await f.store.getAccountAuthenticationGeneration!(contextA)).toBe(2);
  } finally {
    await f.close();
  }
});

test("unsupported source team inventory added after dual context acceptance refuses before Accounts fences", async () => {
  const f = await identityContextFixture();
  try {
    const c = await composition(f);
    const op = await accepted(f, c);
    await c.controlStore.putWorkspace({
      ...c.anchors[1]!.workspace,
      id: "workspace_extra_team",
      handle: "extra-team",
      type: "team",
    });
    await expect(
      consentIdentityMerge({
        store: f.store,
        operation: op,
        session: f.session(),
        consent: true,
        reconciler: c.reconciler,
        retryCapability: retryFixture,
        now: f.now,
      }),
    ).rejects.toThrow();
    expect(await f.store.isAccountAuthenticationFenced!(contextA)).toBe(false);
    expect(await f.store.getAccountAuthenticationGeneration!(contextA)).toBe(0);
    expect(
      await c.controlStore.getWorkspaceMember(
        c.anchors[1]!.workspace.id,
        contextA,
      ),
    ).toBeUndefined();
  } finally {
    await f.close();
  }
});

test("context acceptance refuses forged leg, digest and browser while readiness waits cannot refresh the consented roster", async () => {
  const f = await identityContextFixture();
  try {
    const c = await composition(f);
    let op = (
      await prepareIdentityMergeContextPlan({
        store: f.store,
        operation: f.operation,
        reconciler: c.reconciler,
        now: f.now,
      })
    ).operation;
    for (const changed of [
      { planDigest: "sha256:wrong" },
      { browserBindingHash: "sha256:wrong" },
      { session: { ...f.session(), subject: contextB } },
      { consent: false },
    ])
      await expect(
        acceptIdentityMergeContextPlan({
          store: f.store,
          operation: op,
          session: f.session(),
          browserBindingHash: f.browserBindingHash,
          planDigest: op.contextPlan!.planDigest,
          consent: true,
          now: f.now,
          ...changed,
        }),
      ).rejects.toThrow();
    expect(
      (await f.store.findIdentityMergeOperation!(op.operationId))
        ?.sourceContextAcceptance,
    ).toBeUndefined();
    expect(
      (await f.store.findIdentityMergeOperation!(op.operationId))
        ?.targetContextAcceptance,
    ).toBeUndefined();
    op = await acceptIdentityMergeContextPlan({
      store: f.store,
      operation: op,
      session: f.session(),
      browserBindingHash: f.browserBindingHash,
      planDigest: op.contextPlan!.planDigest,
      consent: true,
      now: f.now,
    });
    await f.login(contextB);
    op = await acceptIdentityMergeContextPlan({
      store: f.store,
      operation: op,
      session: f.session(),
      browserBindingHash: f.browserBindingHash,
      planDigest: op.contextPlan!.planDigest,
      consent: true,
      now: f.now,
    });
    await f.login(contextA);
    c.owners.financial!.assertReady = async () => {
      await c.controlStore.putWorkspaceMember({
        ...c.anchors[1]!.member,
        roles: ["owner", "admin"],
      });
      return true;
    };
    await expect(
      consentIdentityMerge({
        store: f.store,
        operation: op,
        session: f.session(),
        consent: true,
        reconciler: c.reconciler,
        retryCapability: retryFixture,
        now: f.now,
      }),
    ).rejects.toThrow("context_plan_conflict");
    expect(await f.store.isAccountAuthenticationFenced!(contextA)).toBe(false);
    expect(await f.store.getAccountAuthenticationGeneration!(contextA)).toBe(0);
    expect(
      (await f.store.findIdentityMergeOperation!(op.operationId))?.contextPlan
        ?.planDigest,
    ).toBe(op.contextPlan!.planDigest);
  } finally {
    await f.close();
  }
});
