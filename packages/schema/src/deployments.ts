/**
 * Deployment + StateSnapshot contract (Core Specification §20 / §21 / §27
 * `deployments` / `state_snapshots`).
 *
 * NOTE (model migration): these are the Space-direct shapes of the 2026-06-06
 * spec. The legacy shapes in deploy-control-api.ts (App/Environment keyed)
 * remain until the lanes model is deleted; import these via the
 * `takosumi-contract/deployments` subpath until index.ts flips over.
 */

export type DeploymentStatus =
  | "active"
  | "superseded"
  | "rolled_back"
  | "destroyed";

/** Successful apply record (spec §21). Immutable once written. */
export interface Deployment {
  readonly id: string;
  readonly spaceId: string;
  readonly installationId: string;
  readonly environment: string;
  readonly applyRunId: string;
  readonly sourceSnapshotId: string;
  readonly dependencySnapshotId?: string;
  readonly stateGeneration: number;
  readonly outputSnapshotId: string;
  readonly outputsPublic: Readonly<Record<string, unknown>>;
  readonly status: DeploymentStatus;
  readonly createdAt: string;
}

/**
 * One tfstate generation (spec §20). The encrypted object lives in R2_STATE
 * under `spaces/{spaceId}/installations/{installationId}/envs/{environment}/
 * states/{generation(8 digits)}.tfstate.enc` with an atomic `current.json`.
 * UNIQUE(installation_id, environment, generation) is the generation guard.
 */
export interface StateSnapshot {
  readonly id: string;
  readonly spaceId: string;
  readonly installationId: string;
  readonly environment: string;
  readonly generation: number;
  readonly objectKey: string;
  readonly digest: string;
  readonly createdByRunId: string;
  readonly createdAt: string;
}
