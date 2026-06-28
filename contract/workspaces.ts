/**
 * Workspace owner-namespace contract.
 *
 * A Workspace is the owner namespace directly under which Projects and Capsules
 * live — close to a GitHub user/org (`@acme`, `@company`). It holds members,
 * sources, connections, projects, capsules, the dependency graph, policy,
 * activity, and optional billing. A personal Workspace is auto-created on first
 * login.
 *
 * (Formerly `Space`. The transient `Space` alias lives in `./spaces.ts` until
 * the rename converges.)
 */

import type { PolicyConfig } from "./installations.ts";
import type { BillingSettings } from "./billing.ts";

export type WorkspaceType = "personal" | "organization";

export interface Workspace {
  readonly id: string;
  /** Unique handle without the `@` prefix (`acme` for `@acme`). */
  readonly handle: string;
  readonly displayName: string;
  readonly type: WorkspaceType;
  readonly ownerUserId: string;
  /** Optional billing attachment. Billing can be disabled, showback, or enforced. */
  readonly billingAccountId?: string;
  readonly billingSettings?: BillingSettings;
  /**
   * Soft-archive marker. Archived Workspaces remain addressable by id for audit,
   * restores, and direct admin reads, but default Workspace lists hide them so
   * old smoke/test Workspaces do not pollute the normal product switcher.
   */
  readonly archivedAt?: string;
  /**
   * Optional Workspace-wide policy defaults / ceilings. The deploy-control plane
   * composes this with the target InstallConfig policy at plan-completion time;
   * per-run ledgers store only the resulting decision.
   */
  readonly policy?: PolicyConfig;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Capsule full name (`@workspace/name`) helper shape. */
export interface CapsuleFullName {
  readonly workspaceHandle: string;
  readonly capsuleName: string;
}

/** Formats `@workspace/name`. */
export function formatCapsuleFullName(name: CapsuleFullName): string {
  return `@${name.workspaceHandle}/${name.capsuleName}`;
}
