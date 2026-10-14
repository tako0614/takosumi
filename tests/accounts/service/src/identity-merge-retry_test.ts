import { acceptIsolatedIdentityContexts, isolatedContextReconciler } from "../fixtures/identity-context-fixture.ts";
import { expect, test } from "bun:test";
import {
  InMemoryAccountsStore,
  type AccountsStore,
  type AccountSessionRecord,
} from "../../../../accounts/service/src/store.ts";
import { D1AccountsStore, type D1Database } from "../../../../accounts/service/src/d1-store.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";
import {
  createIdentityMerge,
  proveIdentityMerge,
  consentIdentityMerge,
  type IdentityMergeReconciler,
} from "../../../../accounts/service/src/identity-merge.ts";
import { createIdentityMergeRetryService as createRetryService } from "../../../../accounts/service/src/identity-merge-retry.ts";
import type {
  IdentityMergeAcknowledgements,
  IdentityMergeOperation,
  IdentityOperationReceiptRecord,
} from "../../../../accounts/service/src/identity-state.ts";

const initialNow = 1_000_000;
const sourceSubject = "tsub_retry_source";
const targetSubject = "tsub_retry_target";
const stage = {
  environment: "staging",
  issuerOrigin: "https://auth-staging.takos.jp",
  hostedSessionPolicy: true,
  accountsSchemaHead: 5,
  accountsSchemaMode: "predeployed",
};
const runtimeContext = {
  workerVersion: "stage-runtime-version-1",
  authorityContextDigest: `sha256:${"a".repeat(64)}`,
};
const scheduledInvocation = { kind: "scheduled" as const, ...runtimeContext };

function createIdentityMergeRetryService(input: Parameters<typeof createRetryService>[0]) {
  return createRetryService({ runtimeContext, ...input });
}

async function fixture(kind: "memory" | "d1" = "memory", scheduledHeartbeat = true) {
  const db = kind === "d1" ? new SqliteFakeD1() : undefined;
  const store: AccountsStore = db
    ? new D1AccountsStore(db as unknown as D1Database)
    : new InMemoryAccountsStore();
  for (const [subject, providerId] of [[sourceSubject, "github"], [targetSubject, "google"]] as const) {
    await store.saveAccount({
      subject,
      email: "Owner@example.test",
      emailVerified: true,
      termsVersion: "preserved",
      createdAt: 1,
      updatedAt: 1,
    });
    const binding = { subject, providerId, upstreamIssuer: `https://${providerId}.example.test`, upstreamSubject: subject, createdAt: 1, updatedAt: 1 };
    await store.linkUpstreamIdentity(binding);
    await store.saveAccountEmailProof!({
      ...binding,
      address: "Owner@example.test",
      normalizedAddress: "Owner@example.test",
      verification: "provider",
      authoritative: true,
      observedAt: initialNow,
      validUntil: initialNow + 300_000,
    });
  }
  const session: AccountSessionRecord = {
    sessionId: "retry-target-session",
    issuerSessionId: await store.hashAccountSessionId!("retry-issuer-session"),
    subject: targetSubject,
    policy: "hosted",
    authTime: initialNow / 1000,
    createdAt: initialNow,
    expiresAt: initialNow + 300_000,
    absoluteExpiresAt: initialNow + 600_000,
  };
  await store.saveAccountSession(session);
  if (db) {
    await db.exec(`CREATE TABLE protected_retry_references (
      id TEXT PRIMARY KEY, account_bucket TEXT NOT NULL, account_key TEXT NOT NULL,
      workspace_id TEXT NOT NULL, organization_id TEXT NOT NULL, micro_usd INTEGER NOT NULL,
      intent_key TEXT NOT NULL, intent_status TEXT NOT NULL,
      FOREIGN KEY(account_bucket,account_key) REFERENCES takosumi_accounts_documents(bucket,key)
    )`);
    await db.prepare("INSERT INTO protected_retry_references VALUES(?,?,?,?,?,?,?,?)")
      .bind("resource_B", "accounts", sourceSubject, "workspace_B", "organization_B", 123456, "billing-intent_B", "unknown")
      .run();
  }
  if (scheduledHeartbeat) {
    // Only a real local scheduled invocation through the runner records its
    // durable heartbeat. The fixture never writes a fabricated heartbeat row.
    await createIdentityMergeRetryService({ store, stage, now: () => initialNow - 60_000 })
      .runBatch(scheduledInvocation);
  }
  return { store, db, session };
}

async function proved(store: AccountsStore, session: AccountSessionRecord, receiptExpiresAt?: number): Promise<IdentityMergeOperation> {
  let operation = await createIdentityMerge({ store, actor: targetSubject, sourceSubject, targetSubject, browserBindingHash: "retry-browser", now: initialNow });
  for (const role of ["source", "target"] as const) {
    const subject = role === "source" ? sourceSubject : targetSubject;
    const providerId = role === "source" ? "github" : "google";
    const receipt: IdentityOperationReceiptRecord = {
      receiptId: `ircp_${crypto.randomUUID()}`,
      operationId: operation.operationId,
      role,
      sourceSubject,
      targetSubject,
      subject,
      providerId,
      upstreamIssuer: `https://${providerId}.example.test`,
      upstreamSubject: subject,
      browserBindingHash: operation.browserBindingHash,
      policyVersion: operation.policyVersion,
      identityGeneration: 0,
      transactionDigest: `sha256:${crypto.randomUUID()}`,
      startedAt: initialNow,
      completedAt: initialNow,
      expiresAt: receiptExpiresAt ?? operation.expiresAt,
      emailDigest: operation.addressDigest,
      legConsent: true,
      legConsentAt: initialNow,
      method: "upstream-oauth-operation",
      issuerSessionHash: await store.hashAccountSessionId!("retry-proof-anchor"),
    };
    await store.createIdentityOperationReceipt!(receipt);
    operation = await proveIdentityMerge({ store, operation, session: { ...session, subject }, receiptId: receipt.receiptId, now: initialNow });
  }
  // Isolated context owner: real issuer sessions perform both acceptance legs.
  return await acceptIsolatedIdentityContexts(store, operation, initialNow);
}

function acknowledgement(operation: IdentityMergeOperation, now = initialNow): IdentityMergeAcknowledgements {
  return {
    operationId: operation.operationId,
    sourceSubject: operation.sourceSubject,
    targetSubject: operation.targetSubject,
    externalBindings: "reviewed-bindings",
    workspaceMembership: "reviewed-membership",
    billingLedger: "existing-single-ledger",
    consumerIntentCustody: "original-intent-and-org-pins",
    rpSessions: "revoked-old-rp-sessions",
    personalWorkspaceId: "workspace_A",
    reconciledAt: now,
  };
}

for (const kind of ["memory", "d1"] as const) {
  test(`${kind}: persisted partial ACK retries after issuer sessions vanish and preserves original references`, async () => {
    const f = await fixture(kind);
    let complete = false;
    const ownerCalls: string[] = [];
    const reconciler: IdentityMergeReconciler = {
      ...isolatedContextReconciler(f.store, initialNow),
      reconcile: async (operation) => {
        ownerCalls.push(operation.operationId);
        return complete ? acknowledgement(operation) : { ...acknowledgement(operation), consumerIntentCustody: "" };
      },
    };
    const first = createIdentityMergeRetryService({ store: f.store, reconciler, stage, assertOwnerReadiness: async () => true, now: () => initialNow });
    const operation = await consentIdentityMerge({ store: f.store, operation: await proved(f.store, f.session), session: f.session, consent: true, reconciler, retryCapability: first, now: initialNow });
    expect(await f.store.findAccountSession(f.session.sessionId)).toBeUndefined();
    expect(await first.runBatch()).toMatchObject({ scanned: 1, pending: 1, activated: 0 });
    expect((await f.store.findCanonicalAccount!(sourceSubject))?.subject).toBe(sourceSubject);
    expect(await f.store.isAccountAuthenticationFenced!(sourceSubject)).toBe(true);
    complete = true;
    const replica = f.db ? new D1AccountsStore(f.db as unknown as D1Database) : f.store;
    const second = createIdentityMergeRetryService({ store: replica, reconciler, stage, assertOwnerReadiness: async () => true, now: () => initialNow + 60_000 });
    const result = await second.runBatch();
    expect(result).toMatchObject({ scanned: 1, activated: 1, pending: 0 });
    expect(result.operations).toEqual([{ operationId: operation.operationId, status: "activated" }]);
    expect(ownerCalls).toEqual([operation.operationId, operation.operationId]);
    expect((await replica.findCanonicalAccount!(sourceSubject))?.subject).toBe(targetSubject);
    expect((await replica.findAccount(sourceSubject))?.termsVersion).toBe("preserved");
    expect((await replica.findUpstreamIdentity({ providerId: "github", upstreamIssuer: "https://github.example.test", upstreamSubject: sourceSubject }))?.subject).toBe(sourceSubject);
    if (f.db) expect((await f.db.prepare("SELECT * FROM protected_retry_references").all()).results).toEqual([{
      id: "resource_B", account_bucket: "accounts", account_key: sourceSubject, workspace_id: "workspace_B", organization_id: "organization_B", micro_usd: 123456, intent_key: "billing-intent_B", intent_status: "unknown",
    }]);
    expect(JSON.stringify(result)).not.toContain("Owner@example.test");
    expect(JSON.stringify(result)).not.toContain("session");
  });
}

test("expired consent records reviewed recovery without activating or unfencing", async () => {
  const f = await fixture("d1");
  let now = initialNow;
  let calls = 0;
  const reconciler = { ...isolatedContextReconciler(f.store, initialNow), reconcile: async (operation: IdentityMergeOperation) => { calls++; return acknowledgement(operation); } };
  const service = createIdentityMergeRetryService({ store: f.store, reconciler, stage, assertOwnerReadiness: async () => true, now: () => now });
  const operation = await consentIdentityMerge({ store: f.store, operation: await proved(f.store, f.session), session: f.session, consent: true, reconciler, retryCapability: service, now });
  const generation = await f.store.getAccountAuthenticationGeneration!(sourceSubject);
  now = operation.expiresAt;
  expect(await service.runBatch()).toMatchObject({ activated: 0, recoveryRequired: 1 });
  const expired = await f.store.findIdentityMergeOperation!(operation.operationId);
  expect(expired?.conflict).toBe("reviewed_recovery_required");
  expect(expired?.status).toBe("proved");
  expect(calls).toBe(0);
  expect(await f.store.getAccountAuthenticationGeneration!(sourceSubject)).toBe(generation);
  expect(await f.store.isAccountAuthenticationFenced!(sourceSubject)).toBe(true);
  expect((await f.store.findCanonicalAccount!(sourceSubject))?.subject).toBe(sourceSubject);
  now += 60_000;
  expect(await service.runBatch()).toMatchObject({ activated: 0, recoveryRequired: 0 });
  expect((await f.store.findIdentityMergeOperation!(operation.operationId))?.revision).toBe(expired?.revision);
});

test("absence or failure of actual owner readiness rejects consent before any locks or revocations", async () => {
  for (const readiness of [undefined, async () => false, async () => { throw new Error("private-owner-detail"); }]) {
    const f = await fixture();
    const operation = await proved(f.store, f.session);
    const reconciler = { ...isolatedContextReconciler(f.store, initialNow), reconcile: async () => undefined };
    const service = createIdentityMergeRetryService({ store: f.store, reconciler, stage, assertOwnerReadiness: readiness, now: () => initialNow });
    await expect(consentIdentityMerge({ store: f.store, operation, session: f.session, consent: true, reconciler, retryCapability: service, now: initialNow })).rejects.toThrow("merge_retry_unavailable");
    expect(await f.store.isAccountAuthenticationFenced!(sourceSubject)).toBe(false);
    expect(await f.store.getAccountAuthenticationGeneration!(sourceSubject)).toBe(0);
    expect(await f.store.findAccountSession(f.session.sessionId)).toBeDefined();
    expect((await f.store.findIdentityMergeOperation!(operation.operationId))?.consentAt).toBeUndefined();
  }
});

test("an earlier email-evidence deadline requires reviewed recovery while the operation itself is fresh", async () => {
  const f = await fixture("d1");
  let now = initialNow;
  const reconciler = { ...isolatedContextReconciler(f.store, initialNow), reconcile: async (operation: IdentityMergeOperation) => acknowledgement(operation, now) };
  const service = createIdentityMergeRetryService({ store: f.store, reconciler, stage, assertOwnerReadiness: async () => true, now: () => now });
  const operation = await consentIdentityMerge({ store: f.store, operation: await proved(f.store, f.session), session: f.session, consent: true, reconciler, retryCapability: service, now });
  const prior = await f.store.findAccountEmailProof!(sourceSubject);
  await f.store.saveAccountEmailProof!({ ...prior!, validUntil: initialNow + 30_000 });
  now += 30_000;
  expect(operation.expiresAt).toBeGreaterThan(now);
  expect(await service.runBatch()).toMatchObject({ recoveryRequired: 1, activated: 0 });
  expect((await f.store.findIdentityMergeOperation!(operation.operationId))?.conflict).toBe("reviewed_recovery_required");
  expect(await f.store.isAccountAuthenticationFenced!(sourceSubject)).toBe(true);
});

test("concurrent replicas claim one durable poll lease and call the same operation owner once", async () => {
  const f = await fixture("d1");
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const wait = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const reconciler = { ...isolatedContextReconciler(f.store, initialNow), reconcile: async (operation: IdentityMergeOperation) => { calls++; started(); await wait; return acknowledgement(operation); } };
  const first = createIdentityMergeRetryService({ store: f.store, reconciler, stage, assertOwnerReadiness: async () => true, now: () => initialNow });
  const operation = await consentIdentityMerge({ store: f.store, operation: await proved(f.store, f.session), session: f.session, consent: true, reconciler, retryCapability: first, now: initialNow });
  const second = createIdentityMergeRetryService({ store: new D1AccountsStore(f.db as unknown as D1Database), reconciler, stage, assertOwnerReadiness: async () => true, now: () => initialNow });
  const running = first.runBatch();
  await entered;
  expect(await second.runBatch()).toMatchObject({ status: "busy", scanned: 0 });
  release();
  expect(await running).toMatchObject({ activated: 1 });
  expect(await second.runBatch()).toMatchObject({ activated: 0 });
  expect(calls).toBe(1);
  expect((await f.store.findIdentityMergeOperation!(operation.operationId))?.status).toBe("active");
});

test("a superseded lease cannot clear the replacement lease or activate the operation twice", async () => {
  const f = await fixture("d1");
  let now = initialNow;
  const entered: (() => void)[] = [];
  const releases: (() => void)[] = [];
  const waits = [0, 1].map((index) => ({
    entered: new Promise<void>((resolve) => { entered[index] = resolve; }),
    held: new Promise<void>((resolve) => { releases[index] = resolve; }),
  }));
  const contexts: IdentityMergeOperation[] = [];
  // The real owner contract is idempotent under the immutable operation ID.
  // Its reviewed result is stable even if a crashed caller outlives its lease.
  const ownerResults = new Map<string, IdentityMergeAcknowledgements>();
  const reconciler = { ...isolatedContextReconciler(f.store, initialNow), reconcile: async (operation: IdentityMergeOperation) => {
    const index = contexts.length;
    contexts.push(structuredClone(operation));
    if (!ownerResults.has(operation.operationId)) ownerResults.set(operation.operationId, acknowledgement(operation, now));
    entered[index]!();
    await waits[index]!.held;
    return ownerResults.get(operation.operationId)!;
  } };
  const input = { reconciler, stage, assertOwnerReadiness: async () => true, now: () => now };
  const first = createIdentityMergeRetryService({ ...input, store: f.store });
  const operation = await consentIdentityMerge({ store: f.store, operation: await proved(f.store, f.session), session: f.session, consent: true, reconciler, retryCapability: first, now });
  const second = createIdentityMergeRetryService({ ...input, store: new D1AccountsStore(f.db as unknown as D1Database) });
  const oldRun = first.runBatch();
  await waits[0]!.entered;
  now += 61_000;
  const replacementRun = second.runBatch();
  await waits[1]!.entered;
  expect(contexts.map((op) => [op.operationId, op.revision, op.sourceSubject, op.targetSubject])).toEqual([
    [operation.operationId, operation.revision, sourceSubject, targetSubject],
    [operation.operationId, operation.revision, sourceSubject, targetSubject],
  ]);
  releases[0]!();
  expect(await oldRun).toMatchObject({ activated: 1 });
  expect(await first.runBatch()).toMatchObject({ status: "busy", scanned: 0 });
  releases[1]!();
  expect(await replacementRun).toMatchObject({ activated: 0, conflicts: 1 });
  expect(ownerResults.size).toBe(1);
  expect((await f.store.findCanonicalAccount!(sourceSubject))?.subject).toBe(targetSubject);
  expect((await f.store.findIdentityMergeOperation!(operation.operationId))?.revision).toBe(operation.revision + 2);
});

test("over 500 terminal history records do not delay a newly consented operation", async () => {
  const f = await fixture("d1");
  const template = await proved(f.store, f.session);
  for (let index = 0; index < 504; index++) await f.store.createIdentityMergeOperation!({ ...template, operationId: `imrg_history_${String(index).padStart(3, "0")}`, status: "active" });
  const reconciler = { ...isolatedContextReconciler(f.store, initialNow), reconcile: async (operation: IdentityMergeOperation) => acknowledgement(operation) };
  const service = createIdentityMergeRetryService({ store: f.store, reconciler, stage, assertOwnerReadiness: async () => true, now: () => initialNow });
  const operation = await consentIdentityMerge({ store: f.store, operation: template, session: f.session, consent: true, reconciler, retryCapability: service, now: initialNow });
  expect(await service.runBatch()).toMatchObject({ scanned: 1, activated: 1 });
  expect((await f.store.findIdentityMergeOperation!(operation.operationId))?.status).toBe("active");
});

test("bounded durable cursor skips stale index references without treating them as authority", async () => {
  const f = await fixture("d1");
  const template = await proved(f.store, f.session);
  for (let index = 0; index < 105; index++) {
    const operationId = `imrg_stale_${String(index).padStart(3, "0")}`;
    await f.store.createIdentityMergeOperation!({ ...template, operationId, status: "active" });
    await f.db!.prepare("INSERT INTO takosumi_accounts_documents(bucket,key,document,updated_at) VALUES('identity_merge_retry_pending',?,?,?)")
      .bind(operationId, JSON.stringify({ operationId }), initialNow).run();
  }
  let now = initialNow;
  const input = { stage, batchSize: 100, now: () => now };
  const first = createIdentityMergeRetryService({ ...input, store: f.store });
  expect(await first.runBatch()).toMatchObject({ scanned: 100, activated: 0 });
  expect(await first.runBatch()).toMatchObject({ status: "busy", scanned: 0 });
  now += 60_000;
  const replica = new D1AccountsStore(f.db as unknown as D1Database);
  const second = createIdentityMergeRetryService({ ...input, store: replica });
  expect(await second.runBatch()).toMatchObject({ scanned: 5, activated: 0 });
  now += 60_000;
  expect(await first.runBatch()).toMatchObject({ scanned: 100, activated: 0 });
  await expect(first.assertAvailable()).rejects.toThrow("merge_retry_unavailable");
  expect((await f.store.findCanonicalAccount!(sourceSubject))?.subject).toBe(sourceSubject);
});

test("an unknown owner ACK times out without activating and cannot retry within the same cadence", async () => {
  const f = await fixture("d1");
  let now = initialNow;
  let release!: (ack: IdentityMergeAcknowledgements) => void;
  const held = new Promise<IdentityMergeAcknowledgements>((resolve) => { release = resolve; });
  let calls = 0;
  const reconciler = { ...isolatedContextReconciler(f.store, initialNow), reconcile: async (operation: IdentityMergeOperation) => {
    calls++;
    return calls === 1 ? held : acknowledgement(operation, now);
  } };
  const service = createIdentityMergeRetryService({ store: f.store, reconciler, stage, assertOwnerReadiness: async () => true, ownerAttemptTimeoutMs: 5, now: () => now });
  const operation = await consentIdentityMerge({ store: f.store, operation: await proved(f.store, f.session), session: f.session, consent: true, reconciler, retryCapability: service, now });
  expect(await service.runBatch()).toMatchObject({ pending: 1, activated: 0 });
  release(acknowledgement(operation));
  await Promise.resolve();
  expect((await f.store.findCanonicalAccount!(sourceSubject))?.subject).toBe(sourceSubject);
  expect(await service.runBatch()).toMatchObject({ status: "busy", scanned: 0 });
  expect(calls).toBe(1);
  now += 60_000;
  expect(await service.runBatch()).toMatchObject({ activated: 1 });
  expect(calls).toBe(2);
});

test("saturated pending capacity rejects new consent before reserving either account", async () => {
  const f = await fixture("d1");
  const operation = await proved(f.store, f.session);
  const reconciler = { ...isolatedContextReconciler(f.store, initialNow), reconcile: async () => undefined };
  const service = createIdentityMergeRetryService({ store: f.store, reconciler, stage, assertOwnerReadiness: async () => true, now: () => initialNow });
  expect(service.pendingCapacity).toBe(15);
  for (let index = 0; index < service.pendingCapacity; index++) {
    const operationId = `imrg_capacity_${index}`;
    await f.store.createIdentityMergeOperation!({ ...operation, operationId });
    await f.db!.prepare("INSERT INTO takosumi_accounts_documents(bucket,key,document,updated_at) VALUES('identity_merge_retry_pending',?,?,?)")
      .bind(operationId, JSON.stringify({ operationId }), initialNow).run();
  }
  await expect(consentIdentityMerge({ store: f.store, operation, session: f.session, consent: true, reconciler, retryCapability: service, now: initialNow })).rejects.toThrow("merge_retry_unavailable");
  expect(await f.store.isAccountAuthenticationFenced!(sourceSubject)).toBe(false);
  expect(await f.store.getAccountAuthenticationGeneration!(sourceSubject)).toBe(0);
  expect(await f.store.findAccountSession(f.session.sessionId)).toBeDefined();
});

test("owner readiness receives a cloned operation and cannot edit its authority context", async () => {
  const f = await fixture();
  const operation = await proved(f.store, f.session);
  const service = createIdentityMergeRetryService({
    store: f.store,
    stage,
    now: () => initialNow,
    reconciler: { reconcile: async () => undefined },
    assertOwnerReadiness: async (received) => {
      received!.sourceSubject = "tsub_untrusted";
      received!.revision = 999;
      return true;
    },
  });
  await service.assertAvailable(operation);
  expect(operation.sourceSubject).toBe(sourceSubject);
  expect((await f.store.findIdentityMergeOperation!(operation.operationId))?.revision).toBe(operation.revision);
});

test("near-expiry dual proofs refuse consent while both issuer accounts remain usable", async () => {
  const f = await fixture("d1");
  const operation = await proved(f.store, f.session, initialNow + 100_000);
  const reconciler = { ...isolatedContextReconciler(f.store, initialNow), reconcile: async () => undefined };
  const service = createIdentityMergeRetryService({ store: f.store, stage, reconciler, assertOwnerReadiness: async () => true, now: () => initialNow });
  await expect(consentIdentityMerge({ store: f.store, operation, session: f.session, consent: true, reconciler, retryCapability: service, now: initialNow })).rejects.toThrow("merge_retry_unavailable");
  expect(await f.store.isAccountAuthenticationFenced!(sourceSubject)).toBe(false);
  expect(await f.store.getAccountAuthenticationGeneration!(sourceSubject)).toBe(0);
  expect(await f.store.findAccountSession(f.session.sessionId)).toBeDefined();
});

for (const kind of ["memory", "d1"] as const) {
  test(`${kind}: only a completed matching scheduled execution admits consent`, async () => {
    const f = await fixture(kind, false);
    let now = initialNow;
    const operation = await proved(f.store, f.session);
    const reconciler = { ...isolatedContextReconciler(f.store, initialNow), reconcile: async () => undefined };
    const service = createIdentityMergeRetryService({ store: f.store, stage, reconciler, assertOwnerReadiness: async () => true, now: () => now });
    const consent = () => consentIdentityMerge({ store: f.store, operation, session: f.session, consent: true, reconciler, retryCapability: service, now });
    await expect(consent()).rejects.toThrow("merge_retry_unavailable");
    expect(await f.store.isAccountAuthenticationFenced!(sourceSubject)).toBe(false);
    expect(await service.runBatch()).toMatchObject({ status: "completed" });
    expect((await f.store.findIdentityMergeRetryCheckpoint!("auth-staging.identity-merge-retry@v1"))?.heartbeat).toBeUndefined();
    await expect(consent()).rejects.toThrow("merge_retry_unavailable");
    now += 60_000;
    const scheduled = await service.runBatch(scheduledInvocation);
    expect(scheduled.status).toBe("completed");
    expect((await f.store.findIdentityMergeRetryCheckpoint!("auth-staging.identity-merge-retry@v1"))?.heartbeat).toEqual({ ...runtimeContext, completedAt: now });
    expect(JSON.stringify(scheduled)).not.toContain(runtimeContext.workerVersion);
    expect(JSON.stringify(scheduled)).not.toContain(runtimeContext.authorityContextDigest);
    expect((await consent()).consentAt).toBe(now);
    expect(await f.store.isAccountAuthenticationFenced!(sourceSubject)).toBe(true);
  });
}

test("stale, future, foreign-version and foreign-authority heartbeat cannot reserve accounts", async () => {
  const f = await fixture("d1");
  const operation = await proved(f.store, f.session);
  const reconciler = { ...isolatedContextReconciler(f.store, initialNow), reconcile: async () => undefined };
  for (const context of [
    { runtimeContext, now: () => initialNow + 60_001 },
    { runtimeContext, now: () => initialNow - 60_001 },
    { runtimeContext: { ...runtimeContext, workerVersion: "stage-runtime-version-2" }, now: () => initialNow },
    { runtimeContext: { ...runtimeContext, authorityContextDigest: `sha256:${"b".repeat(64)}` }, now: () => initialNow },
    { runtimeContext: undefined, now: () => initialNow },
    { runtimeContext: { ...runtimeContext, authorityContextDigest: "unqualified-context" }, now: () => initialNow },
  ]) {
    const service = createIdentityMergeRetryService({ store: f.store, stage, reconciler, assertOwnerReadiness: async () => true, ...context });
    await expect(consentIdentityMerge({ store: f.store, operation, session: f.session, consent: true, reconciler, retryCapability: service, now: initialNow })).rejects.toThrow("merge_retry_unavailable");
  }
  expect(await f.store.isAccountAuthenticationFenced!(sourceSubject)).toBe(false);
  expect(await f.store.getAccountAuthenticationGeneration!(sourceSubject)).toBe(0);
  expect(await f.store.findAccountSession(f.session.sessionId)).toBeDefined();
});

test("a mismatched scheduled invocation cannot mint a qualified heartbeat", async () => {
  const f = await fixture("d1", false);
  const service = createIdentityMergeRetryService({ store: f.store, stage, now: () => initialNow });
  expect(await service.runBatch({ ...scheduledInvocation, workerVersion: "other-runtime" })).toMatchObject({ status: "completed" });
  expect((await f.store.findIdentityMergeRetryCheckpoint!("auth-staging.identity-merge-retry@v1"))?.heartbeat).toBeUndefined();
});

test("legacy pending retries and expiry recovery run without any heartbeat", async () => {
  for (const expire of [false, true]) {
    const f = await fixture("d1", false);
    let now = initialNow;
    let complete = false;
    const reconciler = { ...isolatedContextReconciler(f.store, initialNow), reconcile: async (operation: IdentityMergeOperation) => complete ? acknowledgement(operation, now) : undefined };
    const operation = await consentIdentityMerge({
      store: f.store, operation: await proved(f.store, f.session), session: f.session, consent: true, reconciler,
      retryCapability: { pendingCapacity: 15, assertAvailable: async () => {} }, now,
    });
    const service = createIdentityMergeRetryService({ store: f.store, stage, reconciler, assertOwnerReadiness: async () => true, runtimeContext: undefined, now: () => now });
    expect(await service.runBatch()).toMatchObject({ pending: 1, activated: 0 });
    complete = true;
    now = expire ? operation.expiresAt : now + 60_000;
    expect(await service.runBatch()).toMatchObject(expire ? { recoveryRequired: 1, activated: 0 } : { activated: 1 });
    expect((await f.store.findIdentityMergeRetryCheckpoint!("auth-staging.identity-merge-retry@v1"))?.heartbeat).toBeUndefined();
    expect((await f.store.findCanonicalAccount!(sourceSubject))?.subject).toBe(expire ? sourceSubject : targetSubject);
    if (expire) expect(await f.store.isAccountAuthenticationFenced!(sourceSubject)).toBe(true);
  }
});

test("failed execution preserves an older heartbeat and never fabricates its renewal", async () => {
  const f = await fixture("d1", false);
  let now = initialNow;
  const service = createIdentityMergeRetryService({ store: f.store, stage, now: () => now });
  const original = f.store.listIdentityMergeOperations!.bind(f.store);
  f.store.listIdentityMergeOperations = async () => { throw new Error("synthetic_store_failure"); };
  await expect(service.runBatch(scheduledInvocation)).rejects.toThrow("synthetic_store_failure");
  expect((await f.store.findIdentityMergeRetryCheckpoint!("auth-staging.identity-merge-retry@v1"))?.heartbeat).toBeUndefined();
  f.store.listIdentityMergeOperations = original;
  now += 60_000;
  await service.runBatch(scheduledInvocation);
  const prior = (await f.store.findIdentityMergeRetryCheckpoint!("auth-staging.identity-merge-retry@v1"))?.heartbeat;
  f.store.listIdentityMergeOperations = async () => { throw new Error("synthetic_store_failure"); };
  now += 60_000;
  await expect(service.runBatch(scheduledInvocation)).rejects.toThrow("synthetic_store_failure");
  expect((await f.store.findIdentityMergeRetryCheckpoint!("auth-staging.identity-merge-retry@v1"))?.heartbeat).toEqual(prior);
});

test("a failed owner attempt returns only bounded status and cannot mint a successful heartbeat", async () => {
  const f = await fixture("d1", false);
  const reconciler = { ...isolatedContextReconciler(f.store, initialNow), reconcile: async () => { throw new Error("private_owner_failure"); } };
  await consentIdentityMerge({
    store: f.store, operation: await proved(f.store, f.session), session: f.session, consent: true, reconciler,
    retryCapability: { pendingCapacity: 15, assertAvailable: async () => {} }, now: initialNow,
  });
  const service = createIdentityMergeRetryService({ store: f.store, stage, reconciler, assertOwnerReadiness: async () => true, now: () => initialNow });
  const result = await service.runBatch(scheduledInvocation);
  expect(result).toMatchObject({ failed: 1, activated: 0 });
  expect(JSON.stringify(result)).not.toContain("private_owner_failure");
  expect(JSON.stringify(result)).not.toContain(runtimeContext.authorityContextDigest);
  expect((await f.store.findIdentityMergeRetryCheckpoint!("auth-staging.identity-merge-retry@v1"))?.heartbeat).toBeUndefined();
  await expect(service.assertAvailable()).rejects.toThrow("merge_retry_unavailable");
  expect(await f.store.isAccountAuthenticationFenced!(sourceSubject)).toBe(true);
});

test("release CAS loss cannot persist a fresh heartbeat or report a completed scheduler run", async () => {
  const f = await fixture("d1", false);
  let mutations = 0;
  const original = f.store.compareAndSetIdentityMergeRetryCheckpoint!.bind(f.store);
  f.store.compareAndSetIdentityMergeRetryCheckpoint = async (input) => ++mutations === 2 ? false : original(input);
  const service = createIdentityMergeRetryService({ store: f.store, stage, reconciler: { reconcile: async () => undefined }, assertOwnerReadiness: async () => true, now: () => initialNow });
  expect(await service.runBatch(scheduledInvocation)).toMatchObject({ status: "busy" });
  expect((await f.store.findIdentityMergeRetryCheckpoint!("auth-staging.identity-merge-retry@v1"))?.heartbeat).toBeUndefined();
  await expect(service.assertAvailable()).rejects.toThrow("merge_retry_unavailable");
});

test("stage guards reject production, wrong issuer, bootstrap schema and oversized batches", () => {
  const store = new InMemoryAccountsStore();
  for (const invalid of [
    { ...stage, environment: "production" },
    { ...stage, issuerOrigin: "https://auth.takos.jp" },
    { ...stage, issuerOrigin: "https://auth-staging.takos.jp/" },
    { ...stage, accountsSchemaHead: 4 },
    { ...stage, accountsSchemaMode: "bootstrap" },
    { ...stage, hostedSessionPolicy: false },
  ]) expect(() => createIdentityMergeRetryService({ store, stage: invalid })).toThrow("identity_merge_retry_stage_required");
  for (const batchSize of [0, 101, 1.5, NaN]) expect(() => createIdentityMergeRetryService({ store, stage, batchSize })).toThrow("invalid_identity_merge_retry_batch_size");
  for (const budget of [
    { ownerAttemptTimeoutMs: 0 },
    { ownerAttemptTimeoutMs: 10_001 },
    { maxBatchDurationMs: 45_001 },
    { maxBatchDurationMs: 1000 },
  ]) expect(() => createIdentityMergeRetryService({ store, stage, ...budget })).toThrow("invalid_identity_merge_retry_time_budget");
});
