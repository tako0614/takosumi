import { expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import type { WorkspaceBillingBinding } from "takosumi-contract";
import type { InterfaceBinding } from "takosumi-contract/interfaces";
import type {
  ControlIdentityAuthorityReader, ControlIdentityContextPlan, ControlMergeAdmission,
  ControlRecoveryAdmission, ControlUnlinkAdmission,
} from "../../../../contract/identity-reconciliation.ts";
import { IdentityReconciliationService } from "../../../../core/domains/identity-reconciliation/mod.ts";
import { InMemoryOpenTofuControlStore, type OpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import { WorkspacesService } from "../../../../core/domains/workspaces/mod.ts";
import {
  InMemoryInterfaceBindingStore, InMemoryInterfaceStore, type InterfaceBindingStore,
} from "../../../../core/domains/interfaces/stores.ts";
import { createSqlInterfaceStores } from "../../../../core/domains/interfaces/sql_stores.ts";
import { createD1InterfaceStores } from "../../../../core/domains/interfaces/d1_stores.ts";
import { CloudflareD1OpenTofuControlStore } from "../../../../worker/src/d1_opentofu_store.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { workerdD1Database, workerdD1Module } from "../../../helpers/deploy-control/workerd_d1.ts";

const NOW = Date.parse("2026-10-16T12:00:00.000Z");
const ISO = new Date(NOW).toISOString();
const BILLING_AUTHORITY = "retained-financial-owner";

interface Backend {
  readonly label: string;
  open(): Promise<{
    readonly first: OpenTofuControlStore;
    readonly second: OpenTofuControlStore;
    readonly bindings: InterfaceBindingStore;
    readonly corruptPin?: (binding: WorkspaceBillingBinding) => Promise<void>;
    readonly close: () => Promise<void>;
  }>;
}

const backends: readonly Backend[] = [
  {
    label: "memory",
    async open() {
      const store = new InMemoryOpenTofuControlStore();
      const bindings = new InMemoryInterfaceBindingStore(new InMemoryInterfaceStore());
      store.attachIdentityReconciliationPrincipalStore(bindings);
      return { first: store, second: store, bindings, close: async () => {} };
    },
  },
  {
    label: "postgres",
    async open() {
      const client = await PGliteSqlClient.create();
      return {
        first: new SqlOpenTofuControlStore({ client }),
        second: new SqlOpenTofuControlStore({ client }),
        bindings: createSqlInterfaceStores(client).bindings,
        async corruptPin(binding) {
          await client.query(`update takosumi_workspace_billing_bindings
            set organization_ref = $1, record_json = $2::jsonb where workspace_id = $3`,
          [binding.organizationRef, JSON.stringify(binding), binding.workspaceId]);
        },
        close: () => client.close(),
      };
    },
  },
  {
    label: "native-d1",
    async open() {
      const runtime = new Miniflare({
        compatibilityDate: "2026-07-17",
        modules: [workerdD1Module("control-identity-reconciliation.mjs")],
        d1Databases: { CONTROL: "control-identity-reconciliation" },
      });
      const db = workerdD1Database(runtime);
      return {
        first: new CloudflareD1OpenTofuControlStore(db),
        second: new CloudflareD1OpenTofuControlStore(db),
        bindings: createD1InterfaceStores(db).bindings,
        async corruptPin(binding) {
          await db.prepare(`update workspace_billing_bindings
            set organization_ref = ?, record_json = ? where workspace_id = ?`)
            .bind(binding.organizationRef, JSON.stringify(binding), binding.workspaceId).run();
        },
        close: () => runtime.dispose(),
      };
    },
  },
];

type Resources = Awaited<ReturnType<Backend["open"]>>;
let caseSequence = 0;

async function context(resources: Resources, pendingSourceBilling = false) {
  const prefix = `identity_case_${++caseSequence}`;
  let sequence = 0;
  const newId = (kind: string) => `${kind}_${prefix}_${++sequence}`;
  const targetAccountId = `${prefix}_a`, sourceAccountId = `${prefix}_b`;
  const operationId = `${prefix}_operation`;
  const workspaces = new WorkspacesService({ store: resources.first, newId, now: () => new Date(NOW) });
  const target = await workspaces.ensurePersonalWorkspaceForSharedAccount(targetAccountId, `identity-a-${caseSequence}`);
  const source = await workspaces.ensurePersonalWorkspaceForSharedAccount(sourceAccountId, `identity-b-${caseSequence}`);
  for (const [workspace, accountId, roles] of [
    [target, targetAccountId, ["owner", "admin"]],
    [source, sourceAccountId, ["owner", "viewer"]],
  ] as const) {
    const original = (await resources.first.getWorkspaceMember(workspace.id, accountId))!;
    await resources.first.putWorkspaceMember({ ...original, roles });
    // This fixture records existing owner acknowledgements through the actual
    // Control port. It neither creates an external Organization nor fakes an ACK transport.
    const intent = await workspaces.billingBindings.prepare({ workspaceId: workspace.id, actorAccountId: accountId, billingAuthority: BILLING_AUTHORITY });
    if (pendingSourceBilling && accountId === sourceAccountId) continue;
    await workspaces.billingBindings.claim({ workspaceId: workspace.id, actorAccountId: accountId, intentId: intent.intentId,
      organizationRef: `original_org_${workspace.id}`, ownerAcknowledgementRef: `existing_owner_ack_${workspace.id}` });
  }
  const state: {
    merge: ControlMergeAdmission;
    unlink?: ControlUnlinkAdmission;
    recovery?: ControlRecoveryAdmission;
  } = {
    merge: {
      operationId, operationRevision: 1, planningRevision: 1, targetAccountId, sourceAccountId,
      sourceProof: { receiptId: `${prefix}_source_proof`, identityGeneration: 4, provedAt: NOW - 10_000 },
      targetProof: { receiptId: `${prefix}_target_proof`, identityGeneration: 7, provedAt: NOW - 10_000 },
      browserBindingHash: `${prefix}_browser`, policyVersion: "dual-consent-fixture/v1",
      createdAt: NOW - 20_000, expiresAt: NOW + 300_000, phase: "planning",
    },
  };
  // This is the trusted private owner contract fixture, not an Accounts/RP
  // success mock. Accounts proof/fence integration is tested by its owner.
  const authority: ControlIdentityAuthorityReader = {
    async readMergeAdmission(input) {
      if (input.operationId !== state.merge.operationId || input.phase !== state.merge.phase ||
        (input.planDigest !== undefined && input.planDigest !== state.merge.contextPlan?.digest)) return undefined;
      return structuredClone(state.merge);
    },
    async readUnlinkAdmission({ intentId }) {
      return state.unlink?.intentId === intentId ? structuredClone(state.unlink) : undefined;
    },
    async readRecoveryAdmission({ operationId, recoveryId }) {
      return state.recovery?.operationId === operationId && state.recovery.recoveryId === recoveryId
        ? structuredClone(state.recovery) : undefined;
    },
  };
  const service = new IdentityReconciliationService({ store: resources.first, authority, newId, now: () => new Date(NOW) });
  const restarted = new IdentityReconciliationService({ store: resources.second, authority, newId, now: () => new Date(NOW) });
  const before = await resources.first.captureIdentityReconciliationInventory([targetAccountId, sourceAccountId]);
  expect(before.workspaces).toHaveLength(2);
  expect(before.members).toHaveLength(2);
  expect(before.bindings).toHaveLength(pendingSourceBilling ? 1 : 2);
  expect(before.principalReferences).toEqual([]);
  const reserve = (plan: ControlIdentityContextPlan) => {
    state.merge = {
      ...state.merge, phase: "reserved", operationRevision: 2,
      contextPlan: { planId: plan.planId, digest: plan.digest, planningRevision: plan.planningRevision, authorityVersion: plan.authorityVersion },
      contextAcceptances: {
        source: { receiptId: `${prefix}_source_acceptance`, proofReceiptId: state.merge.sourceProof.receiptId,
          identityGeneration: state.merge.sourceProof.identityGeneration, acceptedAt: NOW - 1_000, planDigest: plan.digest },
        target: { receiptId: `${prefix}_target_acceptance`, proofReceiptId: state.merge.targetProof.receiptId,
          identityGeneration: state.merge.targetProof.identityGeneration, acceptedAt: NOW - 1_000, planDigest: plan.digest },
      },
      consentAt: NOW,
    };
    return structuredClone(state.merge);
  };
  const reviewedRecovery = (plan: ControlIdentityContextPlan, mode: ControlRecoveryAdmission["mode"] = "abort-before-active") => {
    state.recovery = { operationId, recoveryId: `${prefix}_reviewed_recovery`, sourceAccountId, targetAccountId,
      planDigest: plan.digest, mode, reviewedApprovalRef: `${prefix}_independent_approval`, expiresAt: NOW + 60_000 };
    return { operationId, recoveryId: state.recovery.recoveryId };
  };
  return { prefix, operationId, targetAccountId, sourceAccountId, target, source, before, authority,
    workspaces, state, service, restarted, reserve, reviewedRecovery, newId };
}

type Context = Awaited<ReturnType<typeof context>>;

async function originalCustodyUnchanged(resources: Resources, c: Context) {
  const inventory = await resources.first.captureIdentityReconciliationInventory([c.targetAccountId, c.sourceAccountId]);
  expect(inventory.workspaces).toEqual(c.before.workspaces);
  expect(inventory.bindings).toEqual(c.before.bindings);
  for (const member of c.before.members) {
    expect(await resources.first.getWorkspaceMember(member.workspaceId, member.accountId)).toEqual(member);
  }
  return inventory;
}

async function retainedPrincipal(resources: Resources, c: Context, subjectId = c.sourceAccountId) {
  const record: InterfaceBinding = {
    apiVersion: "takosumi.dev/v1alpha1", kind: "InterfaceBinding",
    metadata: { id: `${c.prefix}_revoked_principal`, workspaceId: `${c.prefix}_unrelated_workspace`, generation: 1, createdAt: ISO, updatedAt: ISO },
    spec: { interfaceId: `${c.prefix}_orphan_interface`, subjectRef: { kind: "Principal", id: subjectId }, permissions: ["invoke"], delivery: { type: "none" } },
    status: { phase: "Revoked", observedInterfaceRevision: 1 },
  };
  expect(await resources.bindings.create(record)).toBe(true);
  expect(await resources.bindings.get(record.metadata.id)).toEqual(record);
}

async function thirdPartyMember(resources: Resources, c: Context, status: "active" | "invited" | "suspended" = "active") {
  const member = { id: c.newId("third_party_wsm"), workspaceId: c.source.id,
    accountId: `${c.prefix}_third_party`, roles: ["viewer"] as const, status, createdAt: ISO, updatedAt: ISO };
  await resources.second.putWorkspaceMember(member);
  return member;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const inventoryMutations: readonly {
  readonly label: string;
  readonly durableOnly?: true;
  readonly change: (resources: Resources, c: Context) => Promise<void>;
}[] = [
  {
    label: "extra-owned-workspace",
    async change(_resources, c) {
      await c.workspaces.createWorkspaceForSharedAccount({ handle: `extra-${caseSequence}`, displayName: "Extra original context", type: "organization", ownerUserId: c.targetAccountId });
    },
  },
  {
    label: "inactive-orphan-membership",
    async change(resources, c) {
      await resources.second.putWorkspaceMember({ id: c.newId("orphan_wsm"), accountId: c.sourceAccountId,
        workspaceId: `${c.prefix}_missing_workspace`, status: "suspended", roles: ["viewer"], createdAt: ISO, updatedAt: ISO });
    },
  },
  { label: "revoked-principal-in-other-workspace", change: retainedPrincipal },
  { label: "third-party-in-original-roster", async change(resources, c) { await thirdPartyMember(resources, c); } },
  {
    label: "management-epoch",
    async change(resources, c) {
      const current = (await resources.second.getWorkspaceManagement(c.source.id))!;
      expect(current.managementState).toBe("active");
      const result = await resources.second.beginWorkspaceDraining(c.source.id, { ...current, managementState: "active" });
      expect(result.status).toBe("started");
    },
  },
  {
    label: "original-owner-role",
    async change(resources, c) {
      const member = (await resources.second.getWorkspaceMember(c.source.id, c.sourceAccountId))!;
      await resources.second.putWorkspaceMember({ ...member, roles: ["admin"], updatedAt: new Date(NOW + 1).toISOString() });
    },
  },
  {
    label: "namespace-owner",
    async change(resources, c) {
      await resources.second.putWorkspace({ ...c.source, ownerUserId: `${c.prefix}_other_owner` });
    },
  },
  {
    label: "workspace-incarnation",
    async change(resources, c) {
      await resources.second.putWorkspace({ ...c.source, createdAt: new Date(NOW + 1).toISOString() });
    },
  },
  {
    label: "immutable-billing-pin",
    durableOnly: true,
    async change(resources, c) {
      const binding = c.before.bindings.find((row) => row.workspaceId === c.source.id)!;
      await resources.corruptPin!({ ...binding, organizationRef: `${binding.organizationRef}_changed` });
    },
  },
];

for (const backend of backends) {
  test(`merge retains both original personal contexts and first concurrent receipt (${backend.label})`, async () => {
    const resources = await backend.open();
    try {
      const c = await context(resources);
      const plan = await c.service.prepareMerge({ operationId: c.operationId });
      expect(await c.restarted.prepareMerge({ operationId: c.operationId })).toEqual(plan);
      expect(plan.personalWorkspaceId).toBe(c.target.id);
      expect(plan.contexts.map((row) => ({ id: row.workspaceId, owner: row.originalOwnerAccountId, disposition: row.disposition, roles: row.roles }))).toEqual([
        { id: c.target.id, owner: c.targetAccountId, disposition: "retain-personal-anchor", roles: ["owner", "admin"] },
        { id: c.source.id, owner: c.sourceAccountId, disposition: "insert-additional-membership", roles: ["owner", "viewer"] },
      ]);
      for (const entry of plan.contexts) {
        const binding = c.before.bindings.find((row) => row.workspaceId === entry.workspaceId)!;
        expect([entry.billingAuthority, entry.workspaceRef, entry.organizationRef]).toEqual([binding.billingAuthority, binding.workspaceRef, binding.organizationRef]);
      }
      expect((await originalCustodyUnchanged(resources, c)).members).toEqual(c.before.members);
      c.reserve(plan);
      const input = { operationId: c.operationId, planDigest: plan.digest };
      const receipts = await Promise.all([c.service.applyMerge(input), c.restarted.applyMerge(input), c.service.applyMerge(input)]);
      expect(receipts).toEqual([receipts[0], receipts[0], receipts[0]]);
      expect(receipts[0]).toMatchObject({ kind: "merge-applied", revision: 2, personalWorkspaceId: c.target.id, planDigest: plan.digest });
      const added = (await resources.first.getWorkspaceMember(c.source.id, c.targetAccountId))!;
      expect(added).toMatchObject({ accountId: c.targetAccountId, workspaceId: c.source.id, roles: ["owner", "viewer"], status: "active" });
      expect(c.before.members.map((row) => row.id)).not.toContain(added.id);
      expect((await originalCustodyUnchanged(resources, c)).members).toHaveLength(3);
      expect(await c.workspaces.ensurePersonalWorkspaceForSharedAccount(c.targetAccountId, "ignored-later-handle")).toEqual(c.target);
      expect(await c.workspaces.ensurePersonalWorkspaceForSharedAccount(c.sourceAccountId, "ignored-other-handle")).toEqual(c.source);
      expect((await resources.first.listIdentityReconciliationEvents(c.operationId)).map((row) => row.decision)).toEqual(["prepared", "merge-applied"]);
      expect((await c.restarted.read(c.operationId))?.receipt).toEqual(receipts[0]);
    } finally { await resources.close(); }
  }, 60_000);

  test(`wrong proof pair and missing exact dual context consent never mutate custody (${backend.label})`, async () => {
    const resources = await backend.open();
    try {
      const c = await context(resources);
      const original = structuredClone(c.state.merge);
      for (const patch of [
        { sourceAccountId: c.targetAccountId },
        { sourceAccountId: "unproved_account" },
        { sourceProof: original.targetProof },
        { expiresAt: NOW },
      ]) {
        c.state.merge = { ...original, ...patch };
        await expect(c.service.prepareMerge({ operationId: c.operationId })).rejects.toMatchObject({ code: "failed_precondition" });
        expect(await c.service.read(c.operationId)).toBeUndefined();
      }
      c.state.merge = original;
      const plan = await c.service.prepareMerge({ operationId: c.operationId });
      const valid = c.reserve(plan);
      for (const patch of [
        { sourceAccountId: c.targetAccountId, targetAccountId: c.sourceAccountId },
        { sourceProof: { ...valid.sourceProof, receiptId: "another_source_proof" } },
        { sourceProof: { ...valid.sourceProof, receiptId: "new_matching_proof" },
          contextAcceptances: { ...valid.contextAcceptances!, source: { ...valid.contextAcceptances!.source, proofReceiptId: "new_matching_proof" } } },
        { targetProof: { ...valid.targetProof, identityGeneration: valid.targetProof.identityGeneration + 1 } },
        { contextAcceptances: undefined },
        { contextAcceptances: { ...valid.contextAcceptances!, source: { ...valid.contextAcceptances!.source, proofReceiptId: valid.targetProof.receiptId } } },
        { contextAcceptances: { ...valid.contextAcceptances!, target: { ...valid.contextAcceptances!.target, receiptId: valid.contextAcceptances!.source.receiptId } } },
        { contextPlan: { ...valid.contextPlan!, planningRevision: 2 } },
        { consentAt: NOW + 1 },
      ]) {
        c.state.merge = { ...valid, ...patch };
        await expect(c.service.applyMerge({ operationId: c.operationId, planDigest: plan.digest })).rejects.toMatchObject({ code: "failed_precondition" });
        expect((await c.service.read(c.operationId))?.status).toBe("prepared");
        expect(await resources.first.getWorkspaceMember(c.source.id, c.targetAccountId)).toBeUndefined();
      }
      expect((await originalCustodyUnchanged(resources, c)).members).toEqual(c.before.members);
      expect(await resources.first.listIdentityReconciliationEvents(c.operationId)).toHaveLength(1);
    } finally { await resources.close(); }
  }, 60_000);

  test(`preexisting canonical membership and suspended source owner refuse planning without repair (${backend.label})`, async () => {
    const resources = await backend.open();
    try {
      for (const invalid of ["canonical-suspended", "canonical-admin", "source-suspended", "source-admin", "retained-revoked-principal", "third-party-active", "third-party-invited", "third-party-suspended"] as const) {
        const c = await context(resources);
        if (invalid.startsWith("canonical-")) {
          await resources.first.putWorkspaceMember({ id: c.newId("existing_wsm"), workspaceId: c.source.id, accountId: c.targetAccountId,
            roles: invalid === "canonical-admin" ? ["admin"] : ["owner"], status: invalid === "canonical-suspended" ? "suspended" : "active", createdAt: ISO, updatedAt: ISO });
        } else if (invalid === "retained-revoked-principal") {
          await retainedPrincipal(resources, c);
        } else if (invalid.startsWith("third-party-")) {
          const status = invalid === "third-party-active" ? "active" : invalid === "third-party-invited" ? "invited" : "suspended";
          await thirdPartyMember(resources, c, status);
        } else {
          const sourceOwner = (await resources.first.getWorkspaceMember(c.source.id, c.sourceAccountId))!;
          await resources.first.putWorkspaceMember({ ...sourceOwner, ...(invalid === "source-suspended" ? { status: "suspended" as const } : { roles: ["admin"] }) });
        }
        const observed = await resources.first.captureIdentityReconciliationInventory([c.targetAccountId, c.sourceAccountId]);
        await expect(c.service.prepareMerge({ operationId: c.operationId })).rejects.toMatchObject({ code: "failed_precondition" });
        expect(await c.service.read(c.operationId), invalid).toBeUndefined();
        expect(await resources.first.listIdentityReconciliationEvents(c.operationId), invalid).toEqual([]);
        expect(await resources.first.captureIdentityReconciliationInventory([c.targetAccountId, c.sourceAccountId]), invalid).toEqual(observed);
      }
    } finally { await resources.close(); }
  }, 60_000);

  test(`full affected roster census does not recursively claim a third party's other context (${backend.label})`, async () => {
    const resources = await backend.open();
    try {
      const c = await context(resources);
      const third = await thirdPartyMember(resources, c);
      const unrelated = await c.workspaces.ensurePersonalWorkspaceForSharedAccount(third.accountId, `third-party-${caseSequence}`);
      const observed = await resources.first.captureIdentityReconciliationInventory([c.targetAccountId, c.sourceAccountId]);
      expect(observed.workspaces).toEqual(c.before.workspaces);
      expect(observed.members).toHaveLength(3);
      expect(observed.members).toContainEqual(third);
      expect(observed.members.some((row) => row.workspaceId === unrelated.id)).toBe(false);
      await expect(c.service.prepareMerge({ operationId: c.operationId })).rejects.toMatchObject({ code: "failed_precondition" });
      expect(await c.service.read(c.operationId)).toBeUndefined();
    } finally { await resources.close(); }
  }, 60_000);

  test(`complete predicate census rejects changes after preflight and at final apply boundary (${backend.label})`, async () => {
    const resources = await backend.open();
    try {
      for (const timing of ["after-preflight", "before-final-commit"] as const) {
        for (const mutation of inventoryMutations) {
          if (mutation.durableOnly && !resources.corruptPin) continue;
          const c = await context(resources);
          const plan = await c.service.prepareMerge({ operationId: c.operationId });
          if (timing === "after-preflight") {
            await mutation.change(resources, c);
            await expect(c.service.assertMergePlanCurrent({ operationId: c.operationId, planDigest: plan.digest }), mutation.label)
              .rejects.toMatchObject({ code: "failed_precondition" });
          }
          c.reserve(plan);
          const commit = resources.first.commitIdentityReconciliation.bind(resources.first);
          let injected = false;
          if (timing === "before-final-commit") {
            resources.first.commitIdentityReconciliation = async (input) => {
              if (input.next.operationId === c.operationId && input.next.status === "applied" && !injected) {
                injected = true;
                // Mutate the real paired backend after all domain prechecks,
                // then enter the original atomic store primitive unchanged.
                await mutation.change(resources, c);
              }
              return await commit(input);
            };
          }
          try {
            await expect(c.service.applyMerge({ operationId: c.operationId, planDigest: plan.digest }), `${timing}:${mutation.label}`)
              .rejects.toMatchObject({ code: "failed_precondition" });
          } finally { resources.first.commitIdentityReconciliation = commit; }
          if (timing === "before-final-commit") expect(injected, mutation.label).toBe(true);
          expect(await resources.first.getWorkspaceMember(c.source.id, c.targetAccountId), mutation.label).toBeUndefined();
          expect((await c.service.read(c.operationId))?.status, mutation.label).toBe("prepared");
          expect((await resources.first.listIdentityReconciliationEvents(c.operationId)).map((row) => row.decision), mutation.label).toEqual(["prepared"]);
        }
      }
    } finally { await resources.close(); }
  }, 60_000);

  test(`phantom before initial plan commit retains no stale operation or success event (${backend.label})`, async () => {
    const resources = await backend.open();
    try {
      const c = await context(resources);
      const commit = resources.first.commitIdentityReconciliation.bind(resources.first);
      let injected = false;
      resources.first.commitIdentityReconciliation = async (input) => {
        if (input.next.operationId === c.operationId && !input.expected && !injected) {
          injected = true;
          await retainedPrincipal(resources, c);
        }
        return await commit(input);
      };
      await expect(c.service.prepareMerge({ operationId: c.operationId })).rejects.toMatchObject({ code: "failed_precondition" });
      expect(injected).toBe(true);
      expect(await c.service.read(c.operationId)).toBeUndefined();
      expect(await resources.first.listIdentityReconciliationEvents(c.operationId)).toEqual([]);
      expect(await resources.first.getWorkspaceMember(c.source.id, c.targetAccountId)).toBeUndefined();
      await originalCustodyUnchanged(resources, c);
    } finally { await resources.close(); }
  }, 60_000);

  test(`member identity collision leaves the retained operation and event ledger unchanged (${backend.label})`, async () => {
    const resources = await backend.open();
    try {
      const c = await context(resources);
      const plan = await c.service.prepareMerge({ operationId: c.operationId });
      c.reserve(plan);
      const original = await resources.first.getIdentityReconciliationOperation(c.operationId);
      const sourceMember = c.before.members.find((row) => row.accountId === c.sourceAccountId)!;
      const colliding = new IdentityReconciliationService({
        store: resources.first, authority: c.authority, now: () => new Date(NOW),
        newId: (kind) => kind === "wsm" ? sourceMember.id : c.newId(kind),
      });
      // In native D1 the operation update precedes the colliding member insert;
      // the real batch must roll it back rather than retain a false success ticket.
      await expect(colliding.applyMerge({ operationId: c.operationId, planDigest: plan.digest })).rejects.toBeDefined();
      expect(await resources.first.getIdentityReconciliationOperation(c.operationId)).toEqual(original);
      expect((await resources.first.listIdentityReconciliationEvents(c.operationId)).map((row) => row.decision)).toEqual(["prepared"]);
      expect(await resources.first.getWorkspaceMember(c.source.id, c.targetAccountId)).toBeUndefined();
      expect((await originalCustodyUnchanged(resources, c)).members).toEqual(c.before.members);
    } finally { await resources.close(); }
  }, 60_000);

  test(`missing source billing acknowledgement refuses preparation without inventing an Organization (${backend.label})`, async () => {
    const resources = await backend.open();
    try {
      const c = await context(resources, true);
      const pending = await resources.first.getWorkspaceBillingBindingIntent(c.source.id);
      expect(pending).toBeDefined();
      await expect(c.service.prepareMerge({ operationId: c.operationId })).rejects.toMatchObject({ code: "failed_precondition" });
      expect(await c.service.read(c.operationId)).toBeUndefined();
      expect(await resources.first.getWorkspaceBillingBindingIntent(c.source.id)).toEqual(pending);
      expect(await resources.first.getWorkspaceBillingBinding(c.source.id)).toBeUndefined();
      expect((await originalCustodyUnchanged(resources, c)).members).toEqual(c.before.members);
    } finally { await resources.close(); }
  }, 60_000);

  test(`reviewed abort suspends only the operation-added row and preserves source custody (${backend.label})`, async () => {
    const resources = await backend.open();
    try {
      const c = await context(resources);
      const plan = await c.service.prepareMerge({ operationId: c.operationId });
      c.reserve(plan);
      await c.service.applyMerge({ operationId: c.operationId, planDigest: plan.digest });
      const added = (await resources.first.getWorkspaceMember(c.source.id, c.targetAccountId))!;
      const input = c.reviewedRecovery(plan);
      const reviewed = structuredClone(c.state.recovery!);
      c.state.recovery = { ...reviewed, reviewedApprovalRef: "" };
      await expect(c.service.recover(input)).rejects.toMatchObject({ code: "failed_precondition" });
      expect(await resources.first.getWorkspaceMember(c.source.id, c.targetAccountId)).toEqual(added);
      c.state.recovery = reviewed;
      const receipt = await c.service.recover(input);
      expect(receipt).toMatchObject({ kind: "merge-aborted", revision: 3, personalWorkspaceId: c.target.id });
      expect(await c.restarted.recover(input)).toEqual(receipt);
      expect(await resources.first.getWorkspaceMember(c.source.id, c.targetAccountId)).toEqual({ ...added, status: "suspended", updatedAt: ISO });
      expect((await originalCustodyUnchanged(resources, c)).members).toHaveLength(3);
      expect((await resources.first.listIdentityReconciliationEvents(c.operationId)).map((row) => [row.decision, row.approvalRef]))
        .toEqual([["prepared", undefined], ["merge-applied", undefined], ["merge-aborted", reviewed.reviewedApprovalRef]]);
      const originalEvents = await resources.first.listIdentityReconciliationEvents(c.operationId);
      const recoveredMember = await resources.first.getWorkspaceMember(c.source.id, c.targetAccountId);
      c.state.recovery = { ...reviewed, expiresAt: NOW - 1 };
      await expect(c.restarted.recover(input)).rejects.toMatchObject({ code: "failed_precondition" });
      const renewed = { ...reviewed, reviewedApprovalRef: "renewed_independent_approval", expiresAt: NOW + 120_000 };
      c.state.recovery = renewed;
      expect(await c.restarted.recover(input)).toEqual(receipt);
      for (const patch of [
        { mode: "restore-after-active" as const },
        { sourceAccountId: c.targetAccountId, targetAccountId: c.sourceAccountId },
        { planDigest: `sha256:${"0".repeat(64)}` },
      ]) {
        c.state.recovery = { ...renewed, ...patch };
        await expect(c.restarted.recover(input)).rejects.toMatchObject({ code: "failed_precondition" });
      }
      expect(await resources.first.listIdentityReconciliationEvents(c.operationId)).toEqual(originalEvents);
      expect(await resources.first.getWorkspaceMember(c.source.id, c.targetAccountId)).toEqual(recoveredMember);
      await originalCustodyUnchanged(resources, c);
    } finally { await resources.close(); }
  }, 60_000);

  test(`recovery refuses concurrent member edits and new roster rows without overwriting authority (${backend.label})`, async () => {
    const resources = await backend.open();
    try {
      for (const mutation of ["added-member-edit", "third-party-roster-row"] as const) {
        const c = await context(resources);
        const plan = await c.service.prepareMerge({ operationId: c.operationId });
        c.reserve(plan);
        const applied = await c.service.applyMerge({ operationId: c.operationId, planDigest: plan.digest });
        const added = (await resources.first.getWorkspaceMember(c.source.id, c.targetAccountId))!;
        const current = mutation === "added-member-edit" ? { ...added, roles: ["viewer"] as const, updatedAt: new Date(NOW + 1).toISOString() } : added;
        const input = c.reviewedRecovery(plan);
        const commit = resources.first.commitIdentityReconciliation.bind(resources.first);
        resources.first.commitIdentityReconciliation = async (candidate) => {
          if (candidate.next.operationId === c.operationId && candidate.next.status === "recovered") {
            if (mutation === "added-member-edit") await resources.second.putWorkspaceMember(current);
            else await thirdPartyMember(resources, c);
          }
          return await commit(candidate);
        };
        await expect(c.service.recover(input)).rejects.toMatchObject({ code: "failed_precondition" });
        resources.first.commitIdentityReconciliation = commit;
        expect(await resources.first.getWorkspaceMember(c.source.id, c.targetAccountId)).toEqual(current);
        expect(await c.service.read(c.operationId)).toMatchObject({ status: "applied", revision: 2, receipt: applied });
        expect(await resources.first.listIdentityReconciliationEvents(c.operationId)).toHaveLength(2);
        await originalCustodyUnchanged(resources, c);
      }
    } finally { await resources.close(); }
  }, 60_000);

  test(`unlink acknowledges exact unchanged contexts idempotently and rejects changed custody (${backend.label})`, async () => {
    const resources = await backend.open();
    try {
      const c = await context(resources);
      const plan = await c.service.prepareMerge({ operationId: c.operationId });
      c.reserve(plan);
      await c.service.applyMerge({ operationId: c.operationId, planDigest: plan.digest });
      const before = await resources.first.captureIdentityReconciliationInventory([c.targetAccountId, c.sourceAccountId]);
      const intentId = `${c.prefix}_unlink`;
      c.state.unlink = { intentId, intentRevision: 1, accountId: c.targetAccountId,
        removedIdentityDigest: "removed_identity_digest", retainedIdentityDigest: "retained_identity_digest",
        retainedProofReceiptId: `${c.prefix}_retained_proof`, identityGeneration: 9, createdAt: NOW - 1_000, expiresAt: NOW + 60_000 };
      const original = structuredClone(c.state.unlink);
      c.state.unlink = { ...original, retainedProofReceiptId: "" };
      await expect(c.service.acknowledgeUnlink({ intentId })).rejects.toMatchObject({ code: "failed_precondition" });
      expect(await c.service.read(intentId)).toBeUndefined();
      c.state.unlink = original;
      const receipts = await Promise.all([c.service.acknowledgeUnlink({ intentId }), c.restarted.acknowledgeUnlink({ intentId })]);
      expect(receipts[0]).toEqual(receipts[1]);
      expect(receipts[0]).toMatchObject({ operationId: intentId, kind: "unlink-preserved", revision: 1 });
      c.state.unlink = { ...original, intentRevision: 2 };
      expect(await c.restarted.acknowledgeUnlink({ intentId })).toEqual(receipts[0]);
      c.state.unlink = { ...original, removedIdentityDigest: "other_removed_identity" };
      await expect(c.service.acknowledgeUnlink({ intentId })).rejects.toMatchObject({ code: "failed_precondition" });
      expect(await resources.first.captureIdentityReconciliationInventory([c.targetAccountId, c.sourceAccountId])).toEqual(before);
      expect(await resources.first.listIdentityReconciliationEvents(intentId)).toHaveLength(1);
    } finally { await resources.close(); }
  }, 60_000);

  test(`reviewed abort wins over a delayed apply without adding membership (${backend.label})`, async () => {
    const resources = await backend.open();
    const gate = deferred();
    try {
      const c = await context(resources);
      const plan = await c.service.prepareMerge({ operationId: c.operationId });
      c.reserve(plan);
      const input = c.reviewedRecovery(plan);
      const entered = deferred();
      const commit = resources.first.commitIdentityReconciliation.bind(resources.first);
      resources.first.commitIdentityReconciliation = async (candidate) => {
        if (candidate.next.operationId === c.operationId && candidate.next.status === "applied") {
          entered.resolve();
          // Pause outside the real DB transaction, as a timed-out caller might.
          await gate.promise;
        }
        return await commit(candidate);
      };
      const applying = c.service.applyMerge({ operationId: c.operationId, planDigest: plan.digest })
        .then((value) => ({ value }), (error: unknown) => ({ error }));
      await Promise.race([entered.promise, applying.then(() => { throw new Error("Apply did not reach its atomic commit"); })]);
      const aborted = await c.restarted.recover(input);
      expect(aborted).toMatchObject({ kind: "merge-aborted", revision: 2 });
      gate.resolve();
      expect(await applying).toMatchObject({ error: { code: "failed_precondition" } });
      expect(await resources.first.getWorkspaceMember(c.source.id, c.targetAccountId)).toBeUndefined();
      expect(await c.service.read(c.operationId)).toMatchObject({ status: "recovered", revision: 2, receipt: aborted });
      expect((await resources.first.listIdentityReconciliationEvents(c.operationId)).map((row) => row.decision))
        .toEqual(["prepared", "merge-aborted"]);
      expect((await originalCustodyUnchanged(resources, c)).members).toEqual(c.before.members);
    } finally { gate.resolve(); await resources.close(); }
  }, 60_000);

  test(`apply wins over a stale prepared abort and fresh reviewed recovery suspends its actual row (${backend.label})`, async () => {
    const resources = await backend.open();
    const gate = deferred();
    try {
      const c = await context(resources);
      const plan = await c.service.prepareMerge({ operationId: c.operationId });
      c.reserve(plan);
      const input = c.reviewedRecovery(plan);
      const entered = deferred();
      const commit = resources.first.commitIdentityReconciliation.bind(resources.first);
      resources.first.commitIdentityReconciliation = async (candidate) => {
        if (candidate.next.operationId === c.operationId && candidate.next.status === "recovered" && candidate.expected?.status === "prepared") {
          entered.resolve();
          await gate.promise;
        }
        return await commit(candidate);
      };
      const aborting = c.service.recover(input).then((value) => ({ value }), (error: unknown) => ({ error }));
      await Promise.race([entered.promise, aborting.then(() => { throw new Error("Abort did not reach its atomic commit"); })]);
      const applied = await c.restarted.applyMerge({ operationId: c.operationId, planDigest: plan.digest });
      const added = (await resources.first.getWorkspaceMember(c.source.id, c.targetAccountId))!;
      gate.resolve();
      expect(await aborting).toMatchObject({ error: { code: "failed_precondition" } });
      expect(await c.service.read(c.operationId)).toMatchObject({ status: "applied", revision: 2, receipt: applied });
      expect(await resources.first.getWorkspaceMember(c.source.id, c.targetAccountId)).toEqual(added);
      expect((await resources.first.listIdentityReconciliationEvents(c.operationId)).map((row) => row.decision))
        .toEqual(["prepared", "merge-applied"]);
      const recovered = await c.service.recover(input);
      expect(recovered).toMatchObject({ kind: "merge-aborted", revision: 3 });
      expect(await resources.first.getWorkspaceMember(c.source.id, c.targetAccountId)).toEqual({ ...added, status: "suspended", updatedAt: ISO });
      expect((await resources.first.listIdentityReconciliationEvents(c.operationId)).map((row) => row.decision))
        .toEqual(["prepared", "merge-applied", "merge-aborted"]);
      expect((await originalCustodyUnchanged(resources, c)).members).toHaveLength(3);
    } finally { gate.resolve(); await resources.close(); }
  }, 60_000);

  test(`actual immutable billing claim refuses relink before reconciliation (${backend.label})`, async () => {
    const resources = await backend.open();
    try {
      const c = await context(resources);
      const binding = c.before.bindings.find((row) => row.workspaceId === c.source.id)!;
      await expect(c.workspaces.billingBindings.claim({ workspaceId: c.source.id, actorAccountId: c.sourceAccountId,
        intentId: binding.intentId, organizationRef: `${binding.organizationRef}_relink`, ownerAcknowledgementRef: binding.ownerAcknowledgementRef }))
        .rejects.toMatchObject({ code: "failed_precondition" });
      const plan = await c.service.prepareMerge({ operationId: c.operationId });
      c.reserve(plan);
      await c.service.applyMerge({ operationId: c.operationId, planDigest: plan.digest });
      await originalCustodyUnchanged(resources, c);
    } finally { await resources.close(); }
  }, 60_000);

  test(`completed merge and unlink receipts are not reused after current predicate custody changes (${backend.label})`, async () => {
    const resources = await backend.open();
    try {
      for (const mutation of ["retained-principal", "third-party-roster-row"] as const) {
        const c = await context(resources);
        const plan = await c.service.prepareMerge({ operationId: c.operationId });
        c.reserve(plan);
        await c.service.applyMerge({ operationId: c.operationId, planDigest: plan.digest });
        const intentId = `${c.prefix}_unlink_replay`;
        c.state.unlink = { intentId, intentRevision: 1, accountId: c.targetAccountId,
          removedIdentityDigest: "removed_identity", retainedIdentityDigest: "retained_identity",
          retainedProofReceiptId: `${c.prefix}_retained`, identityGeneration: 9, createdAt: NOW, expiresAt: NOW + 60_000 };
        await c.service.acknowledgeUnlink({ intentId });
        if (mutation === "retained-principal") await retainedPrincipal(resources, c, c.targetAccountId);
        else await thirdPartyMember(resources, c);
        await expect(c.restarted.applyMerge({ operationId: c.operationId, planDigest: plan.digest })).rejects.toMatchObject({ code: "failed_precondition" });
        await expect(c.restarted.acknowledgeUnlink({ intentId })).rejects.toMatchObject({ code: "failed_precondition" });
        expect(await resources.first.listIdentityReconciliationEvents(c.operationId)).toHaveLength(2);
        expect(await resources.first.listIdentityReconciliationEvents(intentId)).toHaveLength(1);
        await originalCustodyUnchanged(resources, c);
      }
    } finally { await resources.close(); }
  }, 60_000);

  test(`unlink final commit refuses a new Principal reference without recording preservation (${backend.label})`, async () => {
    const resources = await backend.open();
    try {
      const c = await context(resources);
      const intentId = `${c.prefix}_unlink_race`;
      c.state.unlink = { intentId, intentRevision: 1, accountId: c.targetAccountId,
        removedIdentityDigest: "removed_identity", retainedIdentityDigest: "retained_identity",
        retainedProofReceiptId: `${c.prefix}_retained`, identityGeneration: 9, createdAt: NOW, expiresAt: NOW + 60_000 };
      const commit = resources.first.commitIdentityReconciliation.bind(resources.first);
      resources.first.commitIdentityReconciliation = async (input) => {
        if (input.next.operationId === intentId) await retainedPrincipal(resources, c, c.targetAccountId);
        return await commit(input);
      };
      await expect(c.service.acknowledgeUnlink({ intentId })).rejects.toMatchObject({ code: "failed_precondition" });
      expect(await c.service.read(intentId)).toBeUndefined();
      expect(await resources.first.listIdentityReconciliationEvents(intentId)).toEqual([]);
      await originalCustodyUnchanged(resources, c);
    } finally { await resources.close(); }
  }, 60_000);
}

test("memory reconciliation refuses an omitted actual Principal store instead of inventing an empty census", async () => {
  const store = new InMemoryOpenTofuControlStore();
  await expect(store.captureIdentityReconciliationInventory(["unpaired_account"]))
    .rejects.toThrow("actual retained Principal inventory");
});
