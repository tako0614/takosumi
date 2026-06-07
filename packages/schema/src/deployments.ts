/**
 * Deployment + StateSnapshot contract (`deployments` / `state_snapshots`).
 *
 * These are the OpenTofu Capsule DAG shapes: a successful apply records one
 * Deployment, one StateSnapshot generation, and the OutputSnapshot produced by
 * `tofu output -json`.
 */

export type DeploymentStatus =
  | "active"
  | "superseded"
  | "rolled_back"
  | "destroyed";

/**
 * Successful apply record. Immutable once written.
 */
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
 * One tfstate generation. The encrypted object lives in R2_STATE
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
