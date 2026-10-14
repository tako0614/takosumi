import { expect, test } from "bun:test";
import { identityContextFixture, acceptIsolatedIdentityContexts, isolatedContextReconciler, contextA, contextB } from "../fixtures/identity-context-fixture.ts";
import { createAccountsIdentityReconciliationAuthority, identityMergeOwnerContext } from "../../../../accounts/service/src/control-identity-reconciler.ts";
import { createAccountsOwnerOperationReader } from "../../../../accounts/service/src/owner-operation-admission.ts";
import { consentIdentityMerge, activateIdentityMerge } from "../../../../accounts/service/src/identity-merge.ts";
import { ownerOperationContextEvidenceId } from "../../../../accounts/service/src/owner-operation-evidence.ts";
import { sha256Text } from "../../../../accounts/service/src/encoding.ts";
import type { AccountsStore } from "../../../../accounts/service/src/store.ts";
import type { OwnerOperationContextEvidence, OwnerOperationReceiptEvidence, OwnerOperationRequest } from "../../../../accounts/service/src/owner-operation-contract.ts";
import type { ControlIdentityReceipt } from "../../../../contract/identity-reconciliation.ts";

const ownerKinds = ["financial", "hosted-intents", "rp-sessions", "resource-bindings"] as const;
const retryFixture = { pendingCapacity: 100, assertAvailable: async () => {} };

/** Synthetic Core and external receipts exercise Accounts read custody only.
 * Actual Core application/crash/rollback coverage is in the adjacent suite. */
async function fixture(kind: "memory" | "d1" | "postgres" | "native-d1" = "memory") {
  const f = await identityContextFixture(kind);
  let operation = await acceptIsolatedIdentityContexts(f.store, f.operation, f.now);
  let clock = f.now;
  let coreReceipt: ControlIdentityReceipt | undefined;
  const target = { ownerKind: "hosted-intents" as const, ownerClientId: "isolated-owner-admission", targetBindingDigest: await sha256Text("isolated-owner-admission-graph") };
  const authority = createAccountsIdentityReconciliationAuthority({ store: f.store, now: () => clock });
  const plan = (await f.store.findIdentityMergeContextPlan!(operation.contextPlan!.planId))!;
  const control = { async read() { return { plan: plan.controlPlan, ...(coreReceipt ? { receipt: coreReceipt } : {}), status: coreReceipt ? "applied" as const : "prepared" as const, revision: coreReceipt?.revision ?? 0 }; } };
  const reader = createAccountsOwnerOperationReader({ store: f.store, authority, control, target, now: () => clock });
  const request = (purpose: OwnerOperationRequest["purpose"]): OwnerOperationRequest => ({ operationId: operation.operationId, kind: "merge", planDigest: operation.contextPlan!.planDigest, purpose });
  let contextEvidence: OwnerOperationContextEvidence;
  async function reserve() {
    operation = await consentIdentityMerge({ store: f.store, operation, session: f.session(), now: f.now, consent: true,
      retryCapability: retryFixture, reconciler: isolatedContextReconciler(f.store, f.now) });
    const admission = (await authority.readMergeAdmission({ operationId: operation.operationId, phase: "reserved", planDigest: operation.contextPlan!.planDigest }))!;
    coreReceipt = { operationId: operation.operationId, receiptId: "isolated-core-original", authorityVersion: "control-identity-reconciliation/v1", kind: "merge-applied",
      planDigest: operation.contextPlan!.planDigest, inventoryDigest: await sha256Text("isolated-core-after-census"), revision: 1, recordedAt: new Date(f.now).toISOString(), personalWorkspaceId: plan.controlPlan.personalWorkspaceId };
    const context = { ...await identityMergeOwnerContext(operation, admission, plan), controlReceiptId: coreReceipt.receiptId };
    const body = { version: "takosumi.accounts.owner-context@v1" as const, context, coreReceipt, target, capturedOperationRevision: operation.revision, capturedAt: f.now };
    contextEvidence = { ...body, evidenceId: await ownerOperationContextEvidenceId(body) };
    expect(await f.store.createOwnerOperationContextEvidence!(contextEvidence)).toBe(true);
    return contextEvidence;
  }
  async function owners() {
    const result = {} as Record<typeof ownerKinds[number], OwnerOperationReceiptEvidence>;
    for (const ownerKind of ownerKinds) {
      const r = { contextEvidenceId: contextEvidence.evidenceId, ownerKind,
        receipt: { ...contextEvidence.context, receiptId: `isolated-${ownerKind}-original`, ownerId: `isolated-${ownerKind}`, ownerVersion: "fixture/v1", recordedAt: f.now }, observedAt: f.now };
      expect(await f.store.createOwnerOperationReceiptEvidence!(r)).toBe(true);
      result[ownerKind] = r;
    }
    return result;
  }
  async function activate() {
    const r = await owners();
    operation = await activateIdentityMerge({ store: f.store, operation, now: f.now, reconciler: { reconcile: async () => ({
      operationId: operation.operationId, sourceSubject: contextB, targetSubject: contextA, externalBindings: r["resource-bindings"].receipt.receiptId,
      workspaceMembership: coreReceipt!.receiptId, billingLedger: r.financial.receipt.receiptId, consumerIntentCustody: r["hosted-intents"].receipt.receiptId,
      rpSessions: r["rp-sessions"].receipt.receiptId, personalWorkspaceId: plan.controlPlan.personalWorkspaceId, reconciledAt: f.now,
    }) } });
  }
  return { ...f, authority, control, target, reader, request, reserve, activate, operation: () => operation,
    evidence: () => contextEvidence, time(value: number) { clock = value; }, nowValue: () => clock };
}

for (const kind of ["memory", "d1", "postgres", "native-d1"] as const) {
  test(`${kind}: fresh planning/reserved and terminal release derive durable original custody without promoting historical evidence`, async () => {
    const f = await fixture(kind);
    try {
      const ready = await f.reader.readOwnerOperation(f.request("readiness"));
      expect(ready?.admission).toBe("fresh");
      expect(ready?.lifecyclePhase).toBe("planning");
      expect(await f.reader.readOwnerOperation(f.request("readback"))).toBeUndefined();
      const evidence = await f.reserve();
      const reserved = await f.reader.readOwnerOperation(f.request("reconcile"));
      expect(reserved?.admission).toBe("fresh");
      expect(reserved?.lifecyclePhase).toBe("reserved");
      expect(reserved?.context).toEqual(evidence.context);
      await f.activate();
      const released = await f.reader.readOwnerOperation(f.request("release"));
      expect(released?.admission).toBe("terminal-release");
      expect(released?.lifecyclePhase).toBe("active");
      if (released?.admission === "terminal-release") {
        expect(Object.keys(released.terminal.ownerReceipts)).toHaveLength(4);
        expect(released.terminal.contextEvidence.evidenceId).toBe(evidence.evidenceId);
      }
      f.time(f.operation().expiresAt + 1);
      const historical = await f.reader.readOwnerOperation(f.request("readback"));
      expect(historical?.admission).toBe("historical");
      expect(historical && "freshUntil" in historical).toBe(false);
      expect(await f.reader.readOwnerOperation(f.request("reconcile"))).toBeUndefined();
      expect((await f.reader.readOwnerOperation(f.request("release")))?.admission).toBe("terminal-release");
      expect((await f.store.findAccount(contextB))?.subject).toBe(contextB);
      if (f.pg) expect((await f.pg.query("SELECT workspace_id,org_id,balance,pending_original_key FROM accounts_v1.context_protected_refs")).rows).toEqual([
        { workspace_id: "workspace_B", org_id: "org_B", balance: 123456, pending_original_key: "pending-original-B" },
      ]);
    } finally { await f.close(); }
  }, 30_000);
}

test("expired partial ACK remains historical-readable, never fresh or terminal-release capable", async () => {
  const f = await fixture();
  try {
    await f.reserve();
    f.time(f.operation().expiresAt);
    expect((await f.reader.readOwnerOperation(f.request("readback")))?.admission).toBe("historical");
    expect(await f.reader.readOwnerOperation(f.request("readiness"))).toBeUndefined();
    expect(await f.reader.readOwnerOperation(f.request("reconcile"))).toBeUndefined();
    expect(await f.reader.readOwnerOperation(f.request("release"))).toBeUndefined();
    expect(await f.store.isAccountAuthenticationFenced!(contextA)).toBe(true);
    expect(await f.store.isAccountAuthenticationFenced!(contextB)).toBe(true);
  } finally { await f.close(); }
});

test("exact four-field request and captured target reject caller roots, roles, owner props and a different deployment audience", async () => {
  const f = await fixture();
  try {
    await f.reserve();
    const good = f.request("reconcile");
    for (const extra of [{ subject: contextA }, { owner: "hosted-intents" }, { props: { role: "owner" } }, { recoveryId: "caller-picked" }, { target: f.target }]) {
      expect(await f.reader.readOwnerOperation({ ...good, ...extra })).toBeUndefined();
    }
    for (const override of [{ kind: "invalid" }, { purpose: "repair" }, { planDigest: await sha256Text("wrong-plan") }, { operationId: `imrg_${crypto.randomUUID()}` }]) {
      expect(await f.reader.readOwnerOperation({ ...good, ...override })).toBeUndefined();
    }
    const absent = createAccountsOwnerOperationReader({ store: f.store, authority: f.authority, control: f.control, now: () => f.now });
    expect(await absent.readOwnerOperation(good)).toBeUndefined();
    const other = createAccountsOwnerOperationReader({ store: f.store, authority: f.authority, control: f.control, target: { ...f.target, targetBindingDigest: await sha256Text("other-graph") }, now: () => f.now });
    expect(await other.readOwnerOperation(good)).toBeUndefined();
    expect(await other.readOwnerOperation(f.request("readback"))).toBeUndefined();
    expect(await other.readOwnerOperation(f.request("readiness"))).toBeUndefined();
  } finally { await f.close(); }
});

function withStore(store: AccountsStore, override: (property: PropertyKey, target: AccountsStore) => unknown): AccountsStore {
  return new Proxy(store, { get(target, property) {
    const custom = override(property, target);
    if (custom !== undefined) return custom;
    const original: unknown = Reflect.get(target, property, target);
    return typeof original === "function" ? original.bind(target) : original;
  } });
}

test("return-time expiry and invalid/backwards trusted clock cannot emit a fresh admission after async reads", async () => {
  const f = await fixture();
  try {
    await f.reserve();
    const control = { async read(id: string) { const value = await f.control.read(); f.time(f.operation().expiresAt); return value; } };
    const reader = createAccountsOwnerOperationReader({ store: f.store, authority: f.authority, control, target: f.target, now: f.nowValue });
    expect(await reader.readOwnerOperation(f.request("reconcile"))).toBeUndefined();
    for (const invalid of [NaN, Infinity, -1, f.now + 0.5]) {
      const bad = createAccountsOwnerOperationReader({ store: f.store, authority: f.authority, control: f.control, target: f.target, now: () => invalid });
      expect(await bad.readOwnerOperation(f.request("readback"))).toBeUndefined();
    }
    let reads = 0;
    const backwards = createAccountsOwnerOperationReader({ store: f.store, authority: f.authority, control: f.control, target: f.target, now: () => f.now - reads++ });
    expect(await backwards.readOwnerOperation(f.request("readback"))).toBeUndefined();
  } finally { await f.close(); }
});

test("logout arriving during the final journal read invalidates fresh operation proof before return", async () => {
  const f = await fixture();
  try {
    await f.reserve();
    const sourceReceipt = (await f.store.findIdentityOperationReceipt!(f.operation().sourceProof!.receiptId))!;
    let reads = 0;
    const store = withStore(f.store, (property, target) => property === "findOwnerOperationContextEvidence" ? async (key: Parameters<NonNullable<AccountsStore["findOwnerOperationContextEvidence"]>>[0]) => {
      const record = await target.findOwnerOperationContextEvidence!(key);
      if (++reads === 2) await target.revokeHostedOidcSessionGrants!(sourceReceipt.issuerSessionHash, f.now);
      return record;
    } : undefined);
    const authority = createAccountsIdentityReconciliationAuthority({ store, now: f.nowValue });
    const reader = createAccountsOwnerOperationReader({ store, authority, control: f.control, target: f.target, now: f.nowValue });
    expect(await reader.readOwnerOperation(f.request("reconcile"))).toBeUndefined();
    expect(reads).toBe(2);
    expect((await f.store.findIdentityMergeOperation!(f.operation().operationId))?.status).toBe("proved");
    expect(await f.store.isAccountAuthenticationFenced!(contextA)).toBe(true);
  } finally { await f.close(); }
});

test("generation, foreign lock and canonical changes between async reads deny fresh admission and terminal release", async () => {
  const f = await fixture();
  try {
    await f.reserve();
    await f.activate();
    for (const attack of ["generation", "lock", "canonical"] as const) {
      let calls = 0;
      const store = withStore(f.store, (property, target) => {
        if (property === "getAccountAuthenticationGeneration" && attack === "generation") return async (subject: Parameters<NonNullable<AccountsStore["getAccountAuthenticationGeneration"]>>[0]) => (await target.getAccountAuthenticationGeneration!(subject)) + (calls++ > 1 ? 1 : 0);
        if (property === "findIdentityMergeLock" && attack === "lock") return async (subject: string) => ({ subject, operationId: `imrg_${"1".repeat(8)}-1111-1111-1111-${"1".repeat(12)}` });
        if (property === "findCanonicalAccount" && attack === "canonical") return async (subject: Parameters<NonNullable<AccountsStore["findCanonicalAccount"]>>[0]) => ({ ...await target.findCanonicalAccount!(subject), subject: "tsub_unrelated" });
      });
      const reader = createAccountsOwnerOperationReader({ store, authority: f.authority, control: f.control, target: f.target, now: f.nowValue });
      expect(await reader.readOwnerOperation(f.request("release"))).toBeUndefined();
    }
    const store = withStore(f.store, (property, target) => property === "getAccountAuthenticationGeneration" ? async (subject: Parameters<NonNullable<AccountsStore["getAccountAuthenticationGeneration"]>>[0]) => (await target.getAccountAuthenticationGeneration!(subject)) + 4 : undefined);
    const laterGeneration = createAccountsOwnerOperationReader({ store, authority: f.authority, control: f.control, target: f.target, now: f.nowValue });
    expect((await laterGeneration.readOwnerOperation(f.request("release")))?.admission).toBe("terminal-release");
  } finally { await f.close(); }
});

test("terminal-looking operation with missing, swapped or mutated durable owner receipts cannot release", async () => {
  const f = await fixture();
  try {
    await f.reserve(); await f.activate();
    for (const attack of ["missing", "swapped", "mutated"] as const) {
      const store = withStore(f.store, (property, target) => property === "findOwnerOperationReceiptEvidence" ? async (key: Parameters<NonNullable<AccountsStore["findOwnerOperationReceiptEvidence"]>>[0]) => {
        const r = await target.findOwnerOperationReceiptEvidence!(key);
        if (key.ownerKind !== "hosted-intents" || !r) return r;
        if (attack === "missing") return undefined;
        return { ...r, receipt: { ...r.receipt, ...(attack === "swapped" ? { receiptId: "unrelated-receipt" } : { targetAccountId: contextB }) } };
      } : undefined);
      const reader = createAccountsOwnerOperationReader({ store, authority: f.authority, control: f.control, target: f.target, now: f.nowValue });
      expect(await reader.readOwnerOperation(f.request("release"))).toBeUndefined();
    }
  } finally { await f.close(); }
});

test("reader performs find/get/read only and never mutates, acknowledges, applies or repairs retained state", async () => {
  const f = await fixture();
  try {
    await f.reserve(); await f.activate();
    let writes = 0;
    const store = withStore(f.store, (property) => typeof property === "string" && /^(save|create|compare|complete|delete|revoke|touch|link|unlink)/u.test(property) ? () => { writes++; throw new Error("readonly violation"); } : undefined);
    const reader = createAccountsOwnerOperationReader({ store, authority: f.authority, control: f.control, target: f.target, now: f.nowValue });
    expect((await reader.readOwnerOperation(f.request("readback")))?.admission).toBe("historical");
    expect((await reader.readOwnerOperation(f.request("release")))?.admission).toBe("terminal-release");
    expect(writes).toBe(0);
  } finally { await f.close(); }
});
