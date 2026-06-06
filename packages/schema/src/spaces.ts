/**
 * Space contract (Core Specification §4 / §27 `spaces`).
 *
 * A Space is the owner namespace directly under which Installations live —
 * close to a GitHub user/org (`@shota`, `@company`). It holds members, sources,
 * connections, installations, the dependency graph, policy, activity, and
 * optional billing. A personal Space is auto-created on first login.
 *
 * Takosumi Space (owner namespace) and the Takos product's "space" (a product
 * workspace) are DIFFERENT concepts; never conflate them.
 */

export type SpaceType = "personal" | "organization";

export interface Space {
  readonly id: string;
  /** Unique handle without the `@` prefix (`shota` for `@shota`). */
  readonly handle: string;
  readonly displayName: string;
  readonly type: SpaceType;
  readonly ownerUserId: string;
  /** Optional billing attachment (spec §4: billing is optional). */
  readonly billingAccountId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Installation full name (`@space/name`) helper shape. */
export interface InstallationFullName {
  readonly spaceHandle: string;
  readonly installationName: string;
}

/** Formats `@space/name` (spec §5). */
export function formatInstallationFullName(name: InstallationFullName): string {
  return `@${name.spaceHandle}/${name.installationName}`;
}
