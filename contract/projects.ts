/**
 * Project contract (`projects`).
 *
 * A Project is a Workspace-owned grouping for one product, service,
 * application, or infrastructure group. Capsules live under a Project
 * (`capsules.projectId`); a default Project (`prj_default`) is backfilled per
 * Workspace so existing Workspace-direct Capsules keep a stable owner.
 *
 * NEW in the Workspace / Project / Capsule final model — there is no transient
 * deprecated alias for an older noun, because Project did not previously exist.
 */

/**
 * Project ledger record. `projectJson` is an opaque, additive bag for
 * service-side Project configuration (display metadata, default policy
 * pointers, …) so the row shape stays stable as Project config grows.
 */
export interface Project {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  /** Unique slug within the owning Workspace. */
  readonly slug: string;
  readonly projectJson: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Public Project projection returned by `/api` and dashboard session routes.
 * Currently identical to {@link Project}; kept as a distinct type so an internal
 * field can be projected out later without a breaking rename.
 */
export type PublicProject = Project;
