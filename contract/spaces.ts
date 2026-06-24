/**
 * Space owner-namespace contract.
 *
 * A Space is the owner namespace directly under which Installations live —
 * close to a GitHub user/org (`@acme`, `@company`). It holds members, sources,
 * connections, installations, the dependency graph, policy, activity, and
 * optional billing. A personal Space is auto-created on first login.
 *
 * Takosumi Space (owner namespace) and the Takos product's "space" (a product
 * workspace) are DIFFERENT concepts; never conflate them.
 */

import type { PolicyConfig } from "./installations.ts";
import type { BillingSettings } from "./billing.ts";

export type SpaceType = "personal" | "organization";

export interface Space {
  readonly id: string;
  /** Unique handle without the `@` prefix (`acme` for `@acme`). */
  readonly handle: string;
  readonly displayName: string;
  readonly type: SpaceType;
  readonly ownerUserId: string;
  /** Optional billing attachment. Billing can be disabled, showback, or enforced. */
  readonly billingAccountId?: string;
  readonly billingSettings?: BillingSettings;
  /**
   * Soft-archive marker. Archived Spaces remain addressable by id for audit,
   * restores, and direct admin reads, but default Workspace lists hide them so
   * old smoke/test Workspaces do not pollute the normal product switcher.
   */
  readonly archivedAt?: string;
  /**
   * Optional Space-wide policy defaults / ceilings. The
   * deploy-control plane composes this with the target InstallConfig policy at
   * plan-completion time; per-run ledgers store only the resulting decision.
   */
  readonly policy?: PolicyConfig;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Installation full name (`@space/name`) helper shape. */
export interface InstallationFullName {
  readonly spaceHandle: string;
  readonly installationName: string;
}

/** Formats `@space/name`. */
export function formatInstallationFullName(name: InstallationFullName): string {
  return `@${name.spaceHandle}/${name.installationName}`;
}
