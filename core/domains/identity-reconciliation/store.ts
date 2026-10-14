import type { Workspace, WorkspaceMember } from "takosumi-contract/workspaces";
import type { WorkspaceBillingBinding } from "takosumi-contract";
import type { ControlIdentityContextPlan, ControlIdentityReceipt } from "../../../contract/identity-reconciliation.ts";
import { stableStringify } from "../../adapters/source/digest.ts";

export interface IdentityWorkspaceSnapshot {
  readonly workspace: Workspace;
  readonly management: { readonly workspaceId: string; readonly managementState: "active" | "draining" | "frozen" | "released"; readonly managementEpoch: number };
  readonly bootstrapOwnerId?: string;
}

/** Full original-root census, including the entire affected Workspace roster,
 * inactive/orphan root memberships and all retained Principal references.
 * A bounded overflow is never success. */
export interface ControlIdentityInventory {
  readonly accountIds: readonly string[];
  readonly workspaces: readonly IdentityWorkspaceSnapshot[];
  readonly members: readonly WorkspaceMember[];
  readonly bindings: readonly WorkspaceBillingBinding[];
  readonly principalReferences: readonly { readonly id: string; readonly workspaceId: string; readonly subjectId: string; readonly record: unknown }[];
  readonly overflow: boolean;
}

export interface StoredIdentityReconciliationOperation {
  readonly operationId: string;
  readonly kind: "merge" | "unlink";
  readonly immutableKey: string;
  readonly revision: number;
  readonly status: "prepared" | "applied" | "preserved" | "recovered";
  readonly mutationId: string;
  readonly plan?: ControlIdentityContextPlan;
  readonly before: ControlIdentityInventory;
  readonly after?: ControlIdentityInventory;
  readonly addedMember?: WorkspaceMember;
  readonly receipt?: ControlIdentityReceipt;
  readonly recoveryKey?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface IdentityReconciliationEvent {
  readonly operationId: string;
  readonly revision: number;
  readonly mutationId: string;
  readonly decision: "prepared" | "merge-applied" | "unlink-preserved" | "merge-aborted" | "merge-restored";
  readonly snapshotDigest: string;
  readonly receipt?: ControlIdentityReceipt;
  readonly approvalRef?: string;
  readonly recordedAt: string;
}

export interface CommitIdentityReconciliationInput {
  readonly expected?: StoredIdentityReconciliationOperation;
  readonly next: StoredIdentityReconciliationOperation;
  readonly event: IdentityReconciliationEvent;
  readonly expectedInventory: ControlIdentityInventory;
  readonly memberChange?: { readonly before?: WorkspaceMember; readonly after: WorkspaceMember };
}

export interface ControlIdentityReconciliationStore {
  captureIdentityReconciliationInventory(accountIds: readonly string[]): Promise<ControlIdentityInventory>;
  getIdentityReconciliationOperation(operationId: string): Promise<StoredIdentityReconciliationOperation | undefined>;
  listIdentityReconciliationEvents(operationId: string): Promise<readonly IdentityReconciliationEvent[]>;
  /** One local DB boundary: operation CAS, full predicate census, member CAS,
   * and append-only event. No remote await or missing-inventory fallback. */
  commitIdentityReconciliation(input: CommitIdentityReconciliationInput): Promise<boolean>;
}

export const IDENTITY_INVENTORY_LIMIT = 64;

export function normalizeIdentityInventory(inventory: ControlIdentityInventory): ControlIdentityInventory {
  return {
    accountIds: [...new Set(inventory.accountIds)].sort(),
    workspaces: [...inventory.workspaces].sort((a, b) => a.workspace.id.localeCompare(b.workspace.id)),
    members: [...inventory.members].sort((a, b) => a.id.localeCompare(b.id)),
    bindings: [...inventory.bindings].sort((a, b) => a.workspaceId.localeCompare(b.workspaceId)),
    principalReferences: [...inventory.principalReferences].sort((a, b) => a.id.localeCompare(b.id)),
    overflow: inventory.overflow,
  };
}

export function identityInventoryMatches(left: ControlIdentityInventory, right: ControlIdentityInventory): boolean {
  return !left.overflow && !right.overflow && stableStringify(normalizeIdentityInventory(left)) === stableStringify(normalizeIdentityInventory(right));
}

export function identityInventoryAfterMember(inventory: ControlIdentityInventory, member: WorkspaceMember): ControlIdentityInventory {
  return normalizeIdentityInventory({ ...inventory, members: [...inventory.members.filter((row) => row.workspaceId !== member.workspaceId || row.accountId !== member.accountId), member] });
}

export function validateIdentityCommit(input: CommitIdentityReconciliationInput): void {
  const { expected, next, event, memberChange } = input;
  if (!next.operationId || !next.immutableKey || !next.mutationId || next.revision !== (expected?.revision ?? 0) + 1 ||
    event.operationId !== next.operationId || event.revision !== next.revision || event.mutationId !== next.mutationId ||
    (expected && (next.operationId !== expected.operationId || next.kind !== expected.kind || next.immutableKey !== expected.immutableKey || next.mutationId === expected.mutationId)) || input.expectedInventory.overflow) throw new TypeError("Identity reconciliation transition is invalid");
  const same = (left: unknown, right: unknown) => stableStringify(left) === stableStringify(right);
  if (expected) {
    if (next.createdAt !== expected.createdAt || !same(next.before, expected.before) || !same(next.plan, expected.plan) ||
      !identityInventoryMatches(input.expectedInventory, expected.after ?? expected.before) ||
      !((expected.kind === "merge" && expected.status === "prepared" && (next.status === "applied" || next.status === "recovered")) ||
        (expected.kind === "merge" && expected.status === "applied" && next.status === "recovered"))) throw new TypeError("Identity custody cannot replace its original snapshot or terminal decision");
  } else if (!identityInventoryMatches(input.expectedInventory, next.before) ||
    !((next.kind === "merge" && next.status === "prepared" && event.decision === "prepared" && !next.receipt && !next.after && !next.addedMember) ||
      (next.kind === "unlink" && next.status === "preserved" && event.decision === "unlink-preserved" && !next.plan && !next.addedMember))) {
    throw new TypeError("Initial identity custody decision is invalid");
  }
  if (next.status === "applied" && (!memberChange || memberChange.before || !same(next.addedMember, memberChange.after) || event.decision !== "merge-applied")) throw new TypeError("Identity apply must insert exactly its recorded membership");
  if (next.status === "recovered" && (!next.recoveryKey || !event.approvalRef || !["merge-aborted", "merge-restored"].includes(event.decision) ||
    !same(next.addedMember, expected?.addedMember) || Boolean(expected?.addedMember) !== Boolean(memberChange) ||
    (memberChange && !same(memberChange.before, expected?.addedMember)))) throw new TypeError("Reviewed recovery cannot replace a concurrent membership");
  if (next.receipt && (!same(next.receipt, event.receipt) || next.receipt.revision !== next.revision ||
    next.receipt.kind !== event.decision || (next.plan && next.receipt.planDigest !== next.plan.digest))) throw new TypeError("Identity receipt differs from its retained event");
  if (memberChange) {
    const { before, after } = memberChange;
    if (next.kind !== "merge" || !next.plan || after.workspaceId !== next.plan.contexts[1]?.workspaceId || after.accountId !== next.plan.targetAccountId ||
      (before && (before.id !== after.id || before.workspaceId !== after.workspaceId || before.accountId !== after.accountId || before.createdAt !== after.createdAt)) ||
      (!before && (expected?.status !== "prepared" || next.status !== "applied" || after.status !== "active")) ||
      (before && (expected?.status !== "applied" || next.status !== "recovered" || after.status !== "suspended")) ||
      stableStringify(after.roles) !== stableStringify(next.plan.contexts[1]?.roles)) throw new TypeError("Identity reconciliation member delta is invalid");
    if (!identityInventoryMatches(next.after!, identityInventoryAfterMember(input.expectedInventory, after))) throw new TypeError("Identity result snapshot differs from its exact member delta");
  } else if (next.after && !identityInventoryMatches(next.after, input.expectedInventory)) {
    throw new TypeError("Identity preservation cannot alter its inventory");
  }
}
