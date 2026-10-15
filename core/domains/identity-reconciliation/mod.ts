import {
  CONTROL_IDENTITY_AUTHORITY_VERSION,
  type ControlIdentityAuthorityReader, type ControlIdentityContextPlan, type ControlIdentityReceipt,
  type ControlIdentityReconciliationPort, type ControlMergeAdmission,
} from "../../../contract/identity-reconciliation.ts";
import type { WorkspaceMember } from "takosumi-contract/workspaces";
import { stableJsonDigest, stableStringify } from "../../adapters/source/digest.ts";
import { OpenTofuControllerError } from "../deploy-control/errors.ts";
import { isCanonicalActiveWorkspaceOwner } from "../deploy-control/store.ts";
import {
  type ControlIdentityReconciliationStore, type ControlIdentityInventory, type StoredIdentityReconciliationOperation,
  identityInventoryAfterMember, identityInventoryMatches,
} from "./store.ts";

function refuse(message: string): never { throw new OpenTofuControllerError("failed_precondition", message); }
function same(left: unknown, right: unknown): boolean { return stableStringify(left) === stableStringify(right); }

/** Moving operation revisions and reservation phase are intentionally excluded. */
export function controlIdentityProofBinding(admission: ControlMergeAdmission) {
  return {
    operationId: admission.operationId, planningRevision: admission.planningRevision,
    sourceAccountId: admission.sourceAccountId, targetAccountId: admission.targetAccountId,
    sourceProof: admission.sourceProof, targetProof: admission.targetProof,
    browserBindingHash: admission.browserBindingHash, policyVersion: admission.policyVersion,
    createdAt: admission.createdAt, expiresAt: admission.expiresAt,
  };
}

export class IdentityReconciliationService implements ControlIdentityReconciliationPort {
  readonly #store: ControlIdentityReconciliationStore;
  readonly #authority: ControlIdentityAuthorityReader;
  readonly #now: () => Date;
  readonly #newId: (prefix: string) => string;

  constructor(deps: { readonly store: ControlIdentityReconciliationStore; readonly authority: ControlIdentityAuthorityReader; readonly now?: () => Date; readonly newId?: (prefix: string) => string }) {
    this.#store = deps.store;
    this.#authority = deps.authority;
    this.#now = deps.now ?? (() => new Date());
    this.#newId = deps.newId ?? ((prefix) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`);
  }

  async #mergeAdmission(operationId: string, phase: "planning" | "reserved", planDigest?: string): Promise<ControlMergeAdmission> {
    const admission = await this.#authority.readMergeAdmission({ operationId, phase, ...(planDigest ? { planDigest } : {}) });
    const now = this.#now().getTime();
    if (!admission || admission.operationId !== operationId || admission.phase !== phase ||
      !admission.sourceAccountId || !admission.targetAccountId || admission.sourceAccountId === admission.targetAccountId ||
      !admission.browserBindingHash || !admission.policyVersion || !Number.isSafeInteger(admission.operationRevision) || admission.operationRevision < 1 ||
      !Number.isSafeInteger(admission.planningRevision) || admission.planningRevision < 1 || admission.operationRevision < admission.planningRevision ||
      !Number.isFinite(admission.expiresAt) || admission.expiresAt <= now || !Number.isFinite(admission.createdAt) || admission.createdAt > now || admission.expiresAt <= admission.createdAt ||
      [admission.sourceProof, admission.targetProof].some((proof) => !proof?.receiptId || !Number.isSafeInteger(proof.identityGeneration) || proof.identityGeneration < 0 || !Number.isFinite(proof.provedAt) || proof.provedAt > now) ||
      admission.sourceProof.receiptId === admission.targetProof.receiptId) refuse("Current operation-bound identity admission is unavailable");
    return structuredClone(admission);
  }

  async #recheckMerge(original: ControlMergeAdmission, phase: "planning" | "reserved", planDigest?: string): Promise<void> {
    const current = await this.#mergeAdmission(original.operationId, phase, planDigest);
    if (!same(current, original)) refuse("Identity operation changed during Control preparation");
  }

  async #assertInventory(expected: ControlIdentityInventory): Promise<void> {
    const current = await this.#store.captureIdentityReconciliationInventory(expected.accountIds);
    if (!identityInventoryMatches(current, expected)) refuse("Retained identity custody changed; reviewed forward repair is required");
  }

  async #validateRetainedPlan(record: StoredIdentityReconciliationOperation): Promise<void> {
    const plan = record.plan;
    if (!plan) refuse("Original context plan is absent");
    const { digest, ...body } = plan;
    if (plan.inventoryDigest !== await stableJsonDigest(record.before) || plan.proofBindingDigest !== record.immutableKey || digest !== await stableJsonDigest(body)) refuse("Retained context-plan integrity differs");
  }

  #supported(inventory: ControlIdentityInventory, admission: ControlMergeAdmission) {
    if (inventory.overflow || inventory.workspaces.length !== 2 || inventory.members.length !== 2 || inventory.bindings.length !== 2 || inventory.principalReferences.length !== 0 ||
      !same([...inventory.accountIds].sort(), [admission.sourceAccountId, admission.targetAccountId].sort())) refuse("Unsupported identity context inventory");
    const context = (accountId: string) => {
      const rows = inventory.workspaces.filter((row) => row.workspace.ownerUserId === accountId);
      const snapshot = rows[0];
      if (rows.length !== 1 || !snapshot || snapshot.workspace.type !== "personal" || snapshot.workspace.archivedAt || snapshot.bootstrapOwnerId !== accountId ||
        snapshot.management?.workspaceId !== snapshot.workspace.id || snapshot.management.managementState !== "active" || !Number.isSafeInteger(snapshot.management.managementEpoch) || snapshot.management.managementEpoch < 1) refuse("An exact existing active personal bootstrap is required");
      const member = inventory.members.find((row) => row.workspaceId === snapshot.workspace.id && row.accountId === accountId);
      const binding = inventory.bindings.find((row) => row.workspaceId === snapshot.workspace.id);
      if (!member || !isCanonicalActiveWorkspaceOwner(member) || !binding || binding.workspaceCreatedAt !== snapshot.workspace.createdAt || !binding.workspaceRef || !binding.organizationRef || !binding.billingAuthority) refuse("Current original owner and immutable billing custody are required");
      return { snapshot, member, binding };
    };
    const target = context(admission.targetAccountId), source = context(admission.sourceAccountId);
    if (target.snapshot.workspace.id === source.snapshot.workspace.id || inventory.members.some((member) =>
      (member.accountId === admission.targetAccountId && member.workspaceId !== target.snapshot.workspace.id) ||
      (member.accountId === admission.sourceAccountId && member.workspaceId !== source.snapshot.workspace.id))) refuse("Only disjoint original personal contexts are supported");
    return { target, source };
  }

  async prepareMerge({ operationId }: { readonly operationId: string }): Promise<ControlIdentityContextPlan> {
    const admission = await this.#mergeAdmission(operationId, "planning");
    const immutableKey = await stableJsonDigest(controlIdentityProofBinding(admission));
    const existing = await this.#store.getIdentityReconciliationOperation(operationId);
    if (existing) return await this.#currentPlan(existing, admission, immutableKey);
    const inventory = await this.#store.captureIdentityReconciliationInventory([admission.targetAccountId, admission.sourceAccountId]);
    const { source, target } = this.#supported(inventory, admission);
    const createdAt = this.#now().toISOString();
    const base = {
      planId: this.#newId("identity_plan"), operationId, authorityVersion: CONTROL_IDENTITY_AUTHORITY_VERSION,
      planningRevision: admission.planningRevision, sourceAccountId: admission.sourceAccountId, targetAccountId: admission.targetAccountId,
      proofBindingDigest: immutableKey, inventoryDigest: await stableJsonDigest(inventory),
      supportedInventory: "two-disjoint-personal-contexts/v1" as const,
      personalWorkspaceId: target.snapshot.workspace.id,
      contexts: [
        { workspaceId: target.snapshot.workspace.id, workspaceRef: target.binding.workspaceRef, billingAuthority: target.binding.billingAuthority, organizationRef: target.binding.organizationRef, originalOwnerAccountId: admission.targetAccountId, canonicalAccountId: admission.targetAccountId, roles: target.member.roles, disposition: "retain-personal-anchor" as const },
        { workspaceId: source.snapshot.workspace.id, workspaceRef: source.binding.workspaceRef, billingAuthority: source.binding.billingAuthority, organizationRef: source.binding.organizationRef, originalOwnerAccountId: admission.sourceAccountId, canonicalAccountId: admission.targetAccountId, roles: source.member.roles, disposition: "insert-additional-membership" as const },
      ], createdAt,
    };
    const plan: ControlIdentityContextPlan = { ...base, digest: await stableJsonDigest(base) };
    const next: StoredIdentityReconciliationOperation = { operationId, kind: "merge", immutableKey, revision: 1, status: "prepared", mutationId: this.#newId("identity_mutation"), plan, before: inventory, createdAt, updatedAt: createdAt };
    await this.#recheckMerge(admission, "planning");
    const committed = await this.#store.commitIdentityReconciliation({ next, expectedInventory: inventory, event: { operationId, revision: 1, mutationId: next.mutationId, decision: "prepared", snapshotDigest: plan.inventoryDigest, recordedAt: createdAt } });
    if (!committed) {
      const winner = await this.#store.getIdentityReconciliationOperation(operationId);
      if (!winner) refuse("Identity inventory changed before context plan retention");
      return await this.#currentPlan(winner, admission, immutableKey);
    }
    await this.#recheckMerge(admission, "planning");
    return structuredClone(plan);
  }

  async #currentPlan(record: StoredIdentityReconciliationOperation, admission: ControlMergeAdmission, immutableKey: string): Promise<ControlIdentityContextPlan> {
    if (record.kind !== "merge" || record.status !== "prepared" || !record.plan || record.immutableKey !== immutableKey) refuse("Identity operation already has different or completed custody");
    await this.#validateRetainedPlan(record);
    const current = await this.#store.captureIdentityReconciliationInventory(record.before.accountIds);
    if (!identityInventoryMatches(current, record.before)) refuse("Consented identity inventory has changed");
    this.#supported(current, admission);
    await this.#recheckMerge(admission, "planning");
    return structuredClone(record.plan);
  }

  async assertMergePlanCurrent({ operationId, planDigest }: { readonly operationId: string; readonly planDigest: string }): Promise<ControlIdentityContextPlan> {
    const plan = await this.prepareMerge({ operationId });
    if (plan.digest !== planDigest) refuse("Identity context plan digest differs");
    return plan;
  }

  #consented(record: StoredIdentityReconciliationOperation, admission: ControlMergeAdmission, planDigest: string): asserts record is StoredIdentityReconciliationOperation & { readonly plan: ControlIdentityContextPlan } {
    const plan = record.plan;
    const pointer = admission.contextPlan, acceptances = admission.contextAcceptances;
    if (record.kind !== "merge" || !plan || plan.digest !== planDigest || !pointer || pointer.planId !== plan.planId || pointer.digest !== planDigest || pointer.planningRevision !== plan.planningRevision || pointer.authorityVersion !== plan.authorityVersion ||
      plan.sourceAccountId !== admission.sourceAccountId || plan.targetAccountId !== admission.targetAccountId || !acceptances || !Number.isFinite(admission.consentAt) || admission.consentAt! > this.#now().getTime()) refuse("Both exact context-plan acceptances are required");
    for (const leg of ["source", "target"] as const) {
      const acceptance = acceptances[leg], proof = admission[`${leg}Proof`];
      if (!acceptance.receiptId || acceptance.proofReceiptId !== proof.receiptId || acceptance.identityGeneration !== proof.identityGeneration || acceptance.planDigest !== planDigest || !Number.isFinite(acceptance.acceptedAt) || acceptance.acceptedAt < proof.provedAt || acceptance.acceptedAt > admission.consentAt!) refuse("Context acceptance does not match its original proof");
    }
    if (acceptances.source.receiptId === acceptances.target.receiptId) refuse("Context acceptances must be distinct");
  }

  async applyMerge({ operationId, planDigest }: { readonly operationId: string; readonly planDigest: string }): Promise<ControlIdentityReceipt> {
    const admission = await this.#mergeAdmission(operationId, "reserved", planDigest);
    const record = await this.#store.getIdentityReconciliationOperation(operationId);
    if (!record) refuse("Original retained context plan is absent");
    await this.#validateRetainedPlan(record);
    this.#consented(record, admission, planDigest);
    if (record.immutableKey !== await stableJsonDigest(controlIdentityProofBinding(admission))) refuse("Original identity proof binding changed");
    if (record.status === "applied" && record.receipt && record.after) {
      await this.#assertInventory(record.after);
      await this.#recheckMerge(admission, "reserved", planDigest);
      return structuredClone(record.receipt);
    }
    if (record.status !== "prepared") refuse("Identity operation cannot apply in its current state");
    const { source } = this.#supported(record.before, admission);
    const now = this.#now().toISOString();
    const addedMember: WorkspaceMember = { id: this.#newId("wsm"), workspaceId: source.snapshot.workspace.id, accountId: admission.targetAccountId, roles: [...source.member.roles], status: "active", createdAt: now, updatedAt: now };
    const after = identityInventoryAfterMember(record.before, addedMember);
    const receipt: ControlIdentityReceipt = { receiptId: this.#newId("identity_receipt"), operationId, authorityVersion: CONTROL_IDENTITY_AUTHORITY_VERSION, kind: "merge-applied", planDigest, inventoryDigest: await stableJsonDigest(after), revision: record.revision + 1, recordedAt: now, personalWorkspaceId: record.plan.personalWorkspaceId };
    const next: StoredIdentityReconciliationOperation = { ...record, status: "applied", revision: receipt.revision, mutationId: this.#newId("identity_mutation"), addedMember, after, receipt, updatedAt: now };
    await this.#recheckMerge(admission, "reserved", planDigest);
    const committed = await this.#store.commitIdentityReconciliation({ expected: record, next, expectedInventory: record.before, memberChange: { after: addedMember }, event: { operationId, revision: next.revision, mutationId: next.mutationId, decision: "merge-applied", snapshotDigest: receipt.inventoryDigest, receipt, recordedAt: now } });
    await this.#recheckMerge(admission, "reserved", planDigest);
    if (!committed) {
      const winner = await this.#store.getIdentityReconciliationOperation(operationId);
      if (winner?.status === "applied" && winner.immutableKey === record.immutableKey && winner.plan?.digest === planDigest && winner.receipt && winner.after) {
        await this.#assertInventory(winner.after);
        await this.#recheckMerge(admission, "reserved", planDigest);
        return structuredClone(winner.receipt);
      }
      refuse("Identity custody or membership changed before atomic apply");
    }
    await this.#assertInventory(after);
    await this.#recheckMerge(admission, "reserved", planDigest);
    return structuredClone(receipt);
  }

  async read(operationId: string) {
    const record = await this.#store.getIdentityReconciliationOperation(operationId);
    return record ? structuredClone({ ...(record.plan ? { plan: record.plan } : {}), ...(record.receipt ? { receipt: record.receipt } : {}), revision: record.revision, status: record.status }) : undefined;
  }

  async acknowledgeUnlink({ intentId }: { readonly intentId: string }): Promise<ControlIdentityReceipt> {
    const admission = await this.#authority.readUnlinkAdmission({ intentId });
    const now = this.#now();
    if (!admission || admission.intentId !== intentId || !admission.accountId || !admission.retainedProofReceiptId || !admission.removedIdentityDigest || !admission.retainedIdentityDigest || admission.removedIdentityDigest === admission.retainedIdentityDigest || !Number.isSafeInteger(admission.identityGeneration) || admission.identityGeneration < 0 || admission.expiresAt <= now.getTime()) refuse("Current exact unlink preservation admission is required");
    const { intentRevision: _revision, ...binding } = admission;
    const immutableKey = await stableJsonDigest(binding);
    const operationId = intentId;
    const existing = await this.#store.getIdentityReconciliationOperation(operationId);
    if (existing) {
      if (existing.kind !== "unlink" || existing.immutableKey !== immutableKey || !existing.receipt) refuse("Unlink intent already has different custody");
      await this.#assertInventory(existing.before);
      if (!same(await this.#authority.readUnlinkAdmission({ intentId }), admission)) refuse("Unlink authority changed");
      return structuredClone(existing.receipt);
    }
    const inventory = await this.#store.captureIdentityReconciliationInventory([admission.accountId]);
    if (inventory.overflow) refuse("Unlink preservation inventory exceeds the bounded custody phase");
    const recordedAt = now.toISOString();
    const receipt: ControlIdentityReceipt = { receiptId: this.#newId("identity_receipt"), operationId: intentId, authorityVersion: CONTROL_IDENTITY_AUTHORITY_VERSION, kind: "unlink-preserved", planDigest: immutableKey, inventoryDigest: await stableJsonDigest(inventory), revision: 1, recordedAt };
    const next: StoredIdentityReconciliationOperation = { operationId, kind: "unlink", immutableKey, revision: 1, status: "preserved", mutationId: this.#newId("identity_mutation"), before: inventory, receipt, createdAt: recordedAt, updatedAt: recordedAt };
    if (!same(await this.#authority.readUnlinkAdmission({ intentId }), admission)) refuse("Unlink authority changed");
    const committed = await this.#store.commitIdentityReconciliation({ next, expectedInventory: inventory, event: { operationId, revision: 1, mutationId: next.mutationId, decision: "unlink-preserved", snapshotDigest: receipt.inventoryDigest, receipt, recordedAt } });
    if (!same(await this.#authority.readUnlinkAdmission({ intentId }), admission)) refuse("Unlink authority changed after custody retention");
    if (!committed) {
      const winner = await this.#store.getIdentityReconciliationOperation(operationId);
      if (winner?.kind === "unlink" && winner.immutableKey === immutableKey && winner.receipt) {
        await this.#assertInventory(winner.before);
        return structuredClone(winner.receipt);
      }
      refuse("Unlink inventory changed before preservation");
    }
    await this.#assertInventory(inventory);
    return receipt;
  }

  async recover({ operationId, recoveryId }: { readonly operationId: string; readonly recoveryId: string }): Promise<ControlIdentityReceipt> {
    const admission = await this.#authority.readRecoveryAdmission({ operationId, recoveryId });
    if (!admission || admission.operationId !== operationId || admission.recoveryId !== recoveryId || !admission.reviewedApprovalRef || !["abort-before-active", "restore-after-active"].includes(admission.mode) || !Number.isFinite(admission.expiresAt) || admission.expiresAt <= this.#now().getTime()) refuse("Reviewed exact recovery admission is required");
    const record = await this.#store.getIdentityReconciliationOperation(operationId);
    if (!record || !record.plan || record.kind !== "merge" || record.plan.sourceAccountId !== admission.sourceAccountId || record.plan.targetAccountId !== admission.targetAccountId || record.plan.digest !== admission.planDigest) refuse("Reviewed recovery does not match original custody");
    await this.#validateRetainedPlan(record);
    const recoveryKey = await stableJsonDigest({
      operationId: admission.operationId, recoveryId: admission.recoveryId,
      sourceAccountId: admission.sourceAccountId, targetAccountId: admission.targetAccountId,
      planDigest: admission.planDigest, mode: admission.mode,
    });
    if (record.status === "recovered") {
      if (record.recoveryKey !== recoveryKey || !record.receipt) refuse("Recovery identity conflicts with retained decision");
      await this.#assertInventory(record.after ?? record.before);
      if (!same(await this.#authority.readRecoveryAdmission({ operationId, recoveryId }), admission)) refuse("Reviewed recovery authority changed");
      return record.receipt;
    }
    if ((record.status !== "prepared" && record.status !== "applied") || (admission.mode === "restore-after-active" && record.status !== "applied")) refuse("Recovery mode is unavailable for this custody state");
    const expectedInventory = record.after ?? record.before;
    const now = this.#now().toISOString();
    const member = record.addedMember ? { ...record.addedMember, status: "suspended" as const, updatedAt: now } : undefined;
    const after = member ? identityInventoryAfterMember(expectedInventory, member) : expectedInventory;
    const kind = admission.mode === "abort-before-active" ? "merge-aborted" as const : "merge-restored" as const;
    const receipt: ControlIdentityReceipt = { receiptId: this.#newId("identity_receipt"), operationId, authorityVersion: CONTROL_IDENTITY_AUTHORITY_VERSION, kind, planDigest: record.plan.digest, inventoryDigest: await stableJsonDigest(after), revision: record.revision + 1, recordedAt: now, personalWorkspaceId: record.plan.personalWorkspaceId };
    const next: StoredIdentityReconciliationOperation = { ...record, status: "recovered", revision: receipt.revision, mutationId: this.#newId("identity_mutation"), after, receipt, recoveryKey, updatedAt: now };
    if (!same(await this.#authority.readRecoveryAdmission({ operationId, recoveryId }), admission)) refuse("Reviewed recovery authority changed");
    const committed = await this.#store.commitIdentityReconciliation({ expected: record, next, expectedInventory, ...(member ? { memberChange: { before: record.addedMember!, after: member } } : {}), event: { operationId, revision: next.revision, mutationId: next.mutationId, decision: kind, snapshotDigest: receipt.inventoryDigest, receipt, approvalRef: admission.reviewedApprovalRef, recordedAt: now } });
    if (!same(await this.#authority.readRecoveryAdmission({ operationId, recoveryId }), admission)) refuse("Reviewed recovery authority changed after custody retention");
    if (!committed) {
      const winner = await this.#store.getIdentityReconciliationOperation(operationId);
      if (winner?.status === "recovered" && winner.recoveryKey === recoveryKey && winner.receipt) {
        await this.#assertInventory(winner.after ?? winner.before);
        return winner.receipt;
      }
      refuse("Recovery snapshot conflict; preserve current custody for reviewed forward repair");
    }
    await this.#assertInventory(after);
    if (!same(await this.#authority.readRecoveryAdmission({ operationId, recoveryId }), admission)) refuse("Reviewed recovery authority changed");
    return receipt;
  }
}
