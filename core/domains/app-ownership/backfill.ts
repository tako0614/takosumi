import type { OpenTofuControlStore } from "../deploy-control/store.ts";
import type { AccountBillingBinding, AppOwnershipStore, CapsuleMember, CapsuleOwnership } from "./store.ts";
import { stableJsonDigest } from "../../adapters/source/digest.ts";
import { capsuleScopeRef } from "takosumi-contract/capsules";

export interface OwnershipBackfillContext {
  readonly control: OpenTofuControlStore;
  readonly ownership: AppOwnershipStore;
  /** Set only after the operator adapter verifies the target's mutation freeze. */
  readonly workspaceMutationsFrozen?: true;
}

export type OwnershipBackfillWrite =
  | { readonly kind: "ownership"; readonly record: CapsuleOwnership }
  | { readonly kind: "member"; readonly record: CapsuleMember }
  | { readonly kind: "connection"; readonly id: string; readonly ownerAccountId: string }
  | { readonly kind: "usage"; readonly id: string; readonly payerAccountId: string }
  | { readonly kind: "billing"; readonly record: AccountBillingBinding };

export interface OwnershipBackfillPlan {
  readonly writes: readonly OwnershipBackfillWrite[];
  readonly confirmationRequired: readonly { readonly workspaceId: string; readonly accountId: string; readonly roles: readonly string[]; readonly status: string }[];
  readonly collisions: readonly { readonly ownerAccountId: string; readonly slug: string; readonly environment: string; readonly capsuleIds: readonly string[] }[];
  readonly billingConflicts: readonly { readonly accountId: string; readonly workspaceIds: readonly string[] }[];
  readonly orphanCapsules: readonly { readonly capsuleId: string; readonly workspaceId: string }[];
  readonly unresolvedUsagePayers: readonly { readonly eventId: string; readonly workspaceId: string; readonly capsuleId: string; readonly reason: "capsule_missing" | "workspace_mismatch" }[];
  /**
   * Payer-less events of apps whose ownership has been transferred. The
   * current owner is not the historical payer, so they stay unattributed. This
   * is a report only and does not block apply.
   */
  readonly transferredAppUsage: readonly { readonly eventId: string; readonly capsuleId: string }[];
  readonly digest: string;
}

/** Read-only inventory. Never infers app management access from member/viewer. */
export async function planAppOwnershipBackfill(context: OwnershipBackfillContext): Promise<OwnershipBackfillPlan> {
  const writes: OwnershipBackfillWrite[] = [];
  const confirmationRequired: OwnershipBackfillPlan["confirmationRequired"][number][] = [];
  const collisions: OwnershipBackfillPlan["collisions"][number][] = [];
  const billingConflicts: OwnershipBackfillPlan["billingConflicts"][number][] = [];
  const orphanCapsules: OwnershipBackfillPlan["orphanCapsules"][number][] = [];
  const unresolvedUsagePayers: OwnershipBackfillPlan["unresolvedUsagePayers"][number][] = [];
  const transferredAppUsage: OwnershipBackfillPlan["transferredAppUsage"][number][] = [];
  const transferredCapsuleIds = new Set<string>();
  const names = new Map<string, { ownerAccountId: string; slug: string; environment: string; capsuleIds: string[] }>();
  const billings = new Map<string, { workspaceId: string; record: AccountBillingBinding }[]>();
  const workspaces = [...await context.control.listWorkspaces()].sort((a, b) => a.id.localeCompare(b.id));
  const workspaceIds = new Set(workspaces.map((row) => row.id));
  const allCapsules = [...await context.control.listCapsules()].sort((a, b) => a.id.localeCompare(b.id));
  const capsulesByWorkspace = new Map<string, typeof allCapsules>();
  const capsuleById = new Map(allCapsules.map((row) => [row.id, row]));
  const ownerByCapsuleId = new Map<string, string>();
  for (const capsule of allCapsules) {
    if (!workspaceIds.has(capsule.workspaceId)) {
      orphanCapsules.push({ capsuleId: capsule.id, workspaceId: capsule.workspaceId });
      continue;
    }
    const rows = capsulesByWorkspace.get(capsule.workspaceId) ?? [];
    rows.push(capsule);
    capsulesByWorkspace.set(capsule.workspaceId, rows);
  }
  for (const workspace of workspaces) {
    if (!workspace.ownerUserId) throw new Error("Backfill requires a Workspace owner");
    const members = [...await context.control.listWorkspaceMembers(workspace.id)].sort((a, b) => a.accountId.localeCompare(b.accountId));
    for (const member of members) {
      if (member.accountId !== workspace.ownerUserId && !(member.status === "active" && member.roles.some((role) => role === "owner" || role === "admin"))) {
        confirmationRequired.push({ workspaceId: workspace.id, accountId: member.accountId, roles: member.roles, status: member.status });
      }
    }
    const capsules = capsulesByWorkspace.get(workspace.id) ?? [];
    for (const capsule of capsules) {
      const existing = await context.ownership.getOwnership(capsule.id);
      // The root every existing object was written under: the Capsule's frozen
      // scope (its Workspace id when the object was written), never a Workspace
      // id read later.
      const legacyRoot = `workspaces/${capsuleScopeRef(capsule)}/capsules/${capsule.id}`;
      const ownerAccountId = existing?.ownerAccountId ?? workspace.ownerUserId;
      ownerByCapsuleId.set(capsule.id, ownerAccountId);
      if ((existing?.ownershipEpoch ?? 0) !== 0) transferredCapsuleIds.add(capsule.id);
      if (!existing) writes.push({ kind: "ownership", record: {
        capsuleId: capsule.id, ownerAccountId, ownershipEpoch: 0,
        managementState: "active", managementEpoch: 0, storageRoot: legacyRoot,
      } });
      // New apps and transferred apps have their own explicit roster already.
      if (!existing || (existing.ownerAccountId === workspace.ownerUserId && existing.ownershipEpoch === 0 && existing.storageRoot === legacyRoot)) {
        const currentMembers = await context.ownership.listMembers(capsule.id);
        for (const member of members) {
          if (member.accountId === ownerAccountId || member.status !== "active" || !member.roles.some((role) => role === "owner" || role === "admin") || currentMembers.some((row) => row.accountId === member.accountId)) continue;
          writes.push({ kind: "member", record: {
            capsuleId: capsule.id, accountId: member.accountId, status: "active", addedBy: ownerAccountId,
            createdAt: member.createdAt, updatedAt: member.updatedAt,
          } });
        }
      }
      if (capsule.status !== "destroyed") {
        const key = JSON.stringify([ownerAccountId, capsule.slug, capsule.environment]);
        const group = names.get(key) ?? { ownerAccountId, slug: capsule.slug, environment: capsule.environment, capsuleIds: [] };
        group.capsuleIds.push(capsule.id);
        names.set(key, group);
      }
    }
    for (const connection of [...await context.control.listConnections(workspace.id)].sort((a, b) => a.id.localeCompare(b.id))) {
      if (connection.scope !== "operator" && connection.workspaceId === workspace.id && !connection.ownerAccountId) {
        writes.push({ kind: "connection", id: connection.id, ownerAccountId: workspace.ownerUserId });
      }
    }
    for (const event of [...await context.control.listUsageEvents(workspace.id)].sort((a, b) => a.id.localeCompare(b.id))) {
      // An existing payer is retained audit authority, even if its old app was removed.
      if (event.payerAccountId) continue;
      let payerAccountId = workspace.ownerUserId;
      if (event.capsuleId) {
        const capsule = capsuleById.get(event.capsuleId);
        if (!capsule || capsule.workspaceId !== workspace.id) {
          unresolvedUsagePayers.push({ eventId: event.id, workspaceId: workspace.id,
            capsuleId: event.capsuleId, reason: capsule ? "workspace_mismatch" : "capsule_missing" });
          continue;
        }
        // Only an app that was never transferred has one owner for all its
        // history. After a transfer, the current owner is not the payer of an
        // earlier or intentionally unattributed event. Re-running the backfill
        // must never convert those events into charges.
        if (transferredCapsuleIds.has(event.capsuleId)) {
          transferredAppUsage.push({ eventId: event.id, capsuleId: event.capsuleId });
          continue;
        }
        payerAccountId = ownerByCapsuleId.get(event.capsuleId)!;
      }
      writes.push({ kind: "usage", id: event.id, payerAccountId });
    }
    const binding = await context.control.getWorkspaceBillingBinding(workspace.id);
    if (binding) {
      const rows = billings.get(workspace.ownerUserId) ?? [];
      rows.push({ workspaceId: workspace.id, record: {
        accountId: workspace.ownerUserId, billingAuthority: binding.billingAuthority, billingRef: binding.workspaceRef,
        organizationRef: binding.organizationRef, createdAt: binding.boundAt, updatedAt: binding.boundAt,
      } });
      billings.set(workspace.ownerUserId, rows);
    }
  }
  for (const group of names.values()) if (group.capsuleIds.length > 1) collisions.push(group);
  for (const [accountId, rows] of billings) {
    const existing = await context.ownership.getAccountBillingBinding(accountId);
    const keys = new Set(rows.map(({ record }) => JSON.stringify([record.billingAuthority, record.billingRef, record.organizationRef])));
    if (existing) keys.add(JSON.stringify([existing.billingAuthority, existing.billingRef, existing.organizationRef]));
    if (keys.size > 1) billingConflicts.push({ accountId, workspaceIds: rows.map((row) => row.workspaceId) });
    else if (!existing) writes.push({ kind: "billing", record: rows[0]!.record });
  }
  const result = { writes, confirmationRequired, collisions, billingConflicts,
    orphanCapsules, unresolvedUsagePayers, transferredAppUsage };
  return { ...result, digest: await stableJsonDigest(result) };
}

/** Idempotent resume: re-plan each invocation; existing owners/rosters are never replaced. */
export async function applyAppOwnershipBackfill(context: OwnershipBackfillContext, expectedDigest: string, batchSize = 100): Promise<{ applied: number }> {
  if (context.workspaceMutationsFrozen !== true) throw new Error("Backfill apply requires verified workspaceMutationsFrozen: true in the operator context");
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 100) throw new Error("Backfill batch size must be 1..100");
  const plan = await planAppOwnershipBackfill(context);
  if (plan.digest !== expectedDigest) throw new Error("Backfill inventory changed; review a new dry-run");
  if (plan.unresolvedUsagePayers.length) {
    throw new Error("Backfill inventory has unresolved usage payers; repair and review a new dry-run");
  }
  let applied = 0;
  for (const write of plan.writes.slice(0, batchSize)) {
    let written = false;
    switch (write.kind) {
      case "ownership":
        written = await context.ownership.initializeOwnershipIfMissing(write.record);
        if (!written) {
          const current = await context.ownership.getOwnership(write.record.capsuleId);
          written = current?.ownerAccountId === write.record.ownerAccountId &&
            current.ownershipEpoch === write.record.ownershipEpoch && current.storageRoot === write.record.storageRoot;
        }
        break;
      case "member":
        if ((await context.ownership.listMembers(write.record.capsuleId)).some((member) => member.accountId === write.record.accountId)) break;
        written = await context.ownership.putMember(write.record);
        break;
      case "connection": written = await context.ownership.setConnectionOwnerIfMissing(write.id, write.ownerAccountId); break;
      case "usage": written = await context.ownership.setUsagePayerIfMissing(write.id, write.payerAccountId); break;
      case "billing":
        if (await context.ownership.getAccountBillingBinding(write.record.accountId)) break;
        written = await context.ownership.putAccountBillingBinding(write.record);
        break;
    }
    if (!written) throw new Error(`Backfill stopped after ${applied} writes; verify schema and re-run dry-run`);
    applied++;
  }
  return { applied };
}
