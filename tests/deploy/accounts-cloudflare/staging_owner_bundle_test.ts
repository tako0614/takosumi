import { expect, test } from "bun:test";
import { authStagingOwnerBundle, createAuthStagingOwnerBundle, type AuthStagingEnv, type AuthStagingOwnerPorts } from "../../../deploy/accounts-cloudflare/src/staging-owner-bundle.ts";
import { InMemoryAccountsStore } from "../../../accounts/service/src/store.ts";
import type { ControlIdentityReconciliationPort } from "../../../contract/identity-reconciliation.ts";
import { sha256Text } from "../../../accounts/service/src/encoding.ts";
import { AUTH_STAGING_CLIENTS } from "../../../deploy/accounts-cloudflare/src/staging-target.ts";

const target = { ownerKind: "hosted-intents" as const, ownerClientId: "fixture-private-hosted-owner", targetBindingDigest: await sha256Text("fixture-private-target") };
const unavailable = async (): Promise<never> => { throw new Error("unexpected Core write"); };
const control: ControlIdentityReconciliationPort = { read: async () => undefined, prepareMerge: unavailable, assertMergePlanCurrent: unavailable, applyMerge: unavailable, acknowledgeUnlink: unavailable, recover: unavailable };
const env = () => ({ TAKOSUMI_ACCOUNTS_DB: {}, TAKOSUMI_CONTROL_DB: {}, TAKOSUMI_ACCOUNT_SESSION_HASH_SALT: "fixture-bundle-salt", TAKOSUMI_VERSION_METADATA: { id: "fixture-version" } }) as unknown as AuthStagingEnv;

test("unconfigured bundle has one frozen authority and refuses owner readiness without issuing a store read or a fence", async () => {
  const store = new Proxy(new InMemoryAccountsStore(), { get() { throw new Error("unconfigured read"); } });
  const bundle = createAuthStagingOwnerBundle({ store, control });
  expect(Object.isFrozen(bundle)).toBe(true); expect(Object.isFrozen(bundle.authority)).toBe(true);
  expect(await bundle.ownerOperationReader.readOwnerOperation({ operationId: "imrg_11111111-1111-1111-1111-111111111111", kind: "merge", purpose: "readiness", planDigest: "opaque" })).toBeUndefined();
  expect(await bundle.ports.assertOwnerReadiness()).toBe(false);
  expect(bundle.ports.identityMergeReconciler).toBe(bundle.ports.credentialUnlinkReconciler);
});

test("configured target creates one unavailable recovery reader for approval and all historical proof methods", async () => {
  const store = new Proxy(new InMemoryAccountsStore(), { get() { throw new Error("missing issuer must not read"); } });
  const bundle = createAuthStagingOwnerBundle({ store, control, ports: { ownerOperationTarget: target } });
  expect(bundle.recoveryApprovals).toBe(bundle.recoveryEvidence);
  const key = { operationId: "fixture-operation", recoveryId: "fixture-recovery" };
  expect(await bundle.recoveryApprovals!.findForOperation(key.operationId)).toBeUndefined();
  expect(await bundle.recoveryEvidence!.readRecoveryEvidence(key)).toBeUndefined();
  expect(await bundle.recoveryEvidence!.readHistoricalRecoveryEvidence({ ...key, approvalDigest: target.targetBindingDigest })).toBeUndefined();
  expect(await bundle.recoveryEvidence!.readHistoricalRecoveryEvidenceByReviewRef({ ...key, reviewedApprovalRef: "fixture-review" })).toBeUndefined();
  expect(await bundle.ports.assertOwnerReadiness()).toBe(false);
});

test("explicit recovery readers bind all methods to one immutable captured identity", async () => {
  const calls: string[] = [];
  const approvals = { marker: "approval", async findForOperation() { calls.push(this.marker); return undefined; }, async read() { calls.push(this.marker); return undefined; } };
  const evidence = { marker: "evidence", async readRecoveryEvidence() { calls.push(this.marker + ":fresh"); return undefined; },
    async readHistoricalRecoveryEvidence() { calls.push(this.marker + ":hash"); return undefined; }, async readHistoricalRecoveryEvidenceByReviewRef() { calls.push(this.marker + ":ref"); return undefined; } };
  const bundle = createAuthStagingOwnerBundle({ store: new InMemoryAccountsStore(), control, ports: { ownerOperationTarget: { ...target }, recoveryApprovals: approvals, recoveryEvidence: evidence } });
  expect(bundle.recoveryApprovals).toBe(bundle.recoveryEvidence);
  expect(bundle.ports.recoveryApprovals).toBe(bundle.recoveryApprovals); expect(bundle.ports.recoveryEvidence).toBe(bundle.recoveryEvidence);
  await bundle.recoveryApprovals!.read({ operationId: "operation", recoveryId: "recovery" });
  await bundle.recoveryEvidence!.readRecoveryEvidence({ operationId: "operation", recoveryId: "recovery" });
  await bundle.recoveryEvidence!.readHistoricalRecoveryEvidence({ operationId: "operation", recoveryId: "recovery", approvalDigest: target.targetBindingDigest });
  await bundle.recoveryEvidence!.readHistoricalRecoveryEvidenceByReviewRef({ operationId: "operation", recoveryId: "recovery", reviewedApprovalRef: "review" });
  expect(calls).toEqual(["approval", "evidence:fresh", "evidence:hash", "evidence:ref"]);
});

test("global environment pin refuses different source identities, metadata mutation and mutation of historical methods", () => {
  const current = env(), ports = { ownerOperationTarget: { ...target } };
  const first = authStagingOwnerBundle(current, ports);
  expect(authStagingOwnerBundle(current, ports)).toBe(first);
  expect(() => authStagingOwnerBundle(current, { ...ports })).toThrow("changed");
  (current.TAKOSUMI_VERSION_METADATA as { id: string }).id = "other-version";
  expect(() => authStagingOwnerBundle(current, ports)).toThrow("changed");
  const another = env();
  const proof = { async readRecoveryEvidence() { return undefined; }, async readHistoricalRecoveryEvidence() { return undefined; }, async readHistoricalRecoveryEvidenceByReviewRef() { return undefined; } };
  const source = { ownerOperationTarget: { ...target }, recoveryEvidence: proof };
  authStagingOwnerBundle(another, source);
  proof.readHistoricalRecoveryEvidenceByReviewRef = async () => undefined;
  expect(() => authStagingOwnerBundle(another, source)).toThrow("changed");
  const targetEnv = env(), mutable = { ownerOperationTarget: { ...target } };
  authStagingOwnerBundle(targetEnv, mutable); mutable.ownerOperationTarget.ownerClientId = "other-owner";
  expect(() => authStagingOwnerBundle(targetEnv, mutable)).toThrow("changed");
});

test("constructor failure pins the failed attempt and configuration cannot substitute an OAuth client or a noncanonical digest", () => {
  const current = env(), mutable = { ownerOperationTarget: { ...target, targetBindingDigest: "invalid" } };
  expect(() => authStagingOwnerBundle(current, mutable)).toThrow("target_invalid");
  mutable.ownerOperationTarget.targetBindingDigest = target.targetBindingDigest;
  expect(() => authStagingOwnerBundle(current, mutable)).toThrow("changed");
  for (const ownerClientId of AUTH_STAGING_CLIENTS.map((client) => client.clientId)) expect(() => createAuthStagingOwnerBundle({ store: new InMemoryAccountsStore(), control, ports: { ownerOperationTarget: { ...target, ownerClientId } } })).toThrow();
  const canonical = "sha256:" + "A".repeat(43), noncanonical = canonical.slice(0, -1) + "B";
  expect(() => createAuthStagingOwnerBundle({ store: new InMemoryAccountsStore(), control, ports: { ownerOperationTarget: { ...target, targetBindingDigest: canonical } } })).not.toThrow();
  expect(() => createAuthStagingOwnerBundle({ store: new InMemoryAccountsStore(), control, ports: { ownerOperationTarget: { ...target, targetBindingDigest: noncanonical } } })).toThrow();
  const overrides = { identityMergeReconciler: {}, assertOwnerReadiness: async () => true } as unknown as AuthStagingOwnerPorts;
  expect(() => createAuthStagingOwnerBundle({ store: new InMemoryAccountsStore(), control, ports: overrides })).toThrow("bundle_invalid");
  const absent = env(); expect(authStagingOwnerBundle(absent).ports.ownerOperationTarget).toBeUndefined();
  expect(() => authStagingOwnerBundle(env(), { ownerOperationTarget: { ...target, ownerClientId: "" } })).toThrow();
});

test("issuer availability preserves the original opaque reader and refuses wrappers, target substitution and per-env replacement", async () => {
  const { createReviewedRecoveryIssuerAvailabilityReader } = await import("../../../accounts/service/src/reviewed-recovery-issuer-availability.ts");
  const { reviewIssuerAvailabilityFixture } = await import("../../accounts/service/fixtures/review-issuer-availability-fixture.ts");
  const mint = () => createReviewedRecoveryIssuerAvailabilityReader({ target, clientId: "fixture-private-review-client", environment: "staging" });
  const { reader } = await reviewIssuerAvailabilityFixture({ target, now: Date.now });
  const ports = { ownerOperationTarget: { ...target }, reviewIssuerAvailability: reader };
  const current = env(), bundle = authStagingOwnerBundle(current, ports);
  expect(bundle.reviewIssuerAvailability).toBe(reader); expect(bundle.ports.reviewIssuerAvailability).toBe(reader);
  expect(await reader.isAvailable({ operationId: "fixture-operation", kind: "merge", planDigest: "opaque-plan" })).toBe(true);
  expect(await bundle.ports.assertOwnerReadiness()).toBe(false);
  const wrapped = { ...reader };
  expect(() => createAuthStagingOwnerBundle({ store: new InMemoryAccountsStore(), control, ports: { ...ports, reviewIssuerAvailability: wrapped } })).toThrow("issuer_unavailable");
  expect(() => createAuthStagingOwnerBundle({ store: new InMemoryAccountsStore(), control, ports: { ...ports, ownerOperationTarget: { ...target, ownerClientId: "other-owner" } } })).toThrow("issuer_unavailable");
  expect(() => createAuthStagingOwnerBundle({ store: new InMemoryAccountsStore(), control, ports: { reviewIssuerAvailability: reader } })).toThrow("issuer_unavailable");
  ports.reviewIssuerAvailability = mint();
  expect(() => authStagingOwnerBundle(current, ports)).toThrow("changed");
});
