/**
 * @deprecated retired Deployment ledger (read-only for audit) + StateVersion
 * alias.
 *
 * The Takosumi `Deployment` ledger is RETIRED, not renamed: a successful apply
 * Run + {@link StateVersion} + Output is now the record. The `Deployment` type
 * is kept here ONLY so legacy `deployments` rows stay readable for audit, so its
 * field names (`spaceId` / `installationId` / `outputSnapshotId`) deliberately
 * still match the frozen legacy columns and are NOT migrated to the
 * workspace/capsule vocabulary.
 *
 * `StateSnapshot` is renamed to `StateVersion` (see `./state-versions.ts`); the
 * old name is re-exported below while the rename converges.
 */

/** @deprecated `StateSnapshot` is renamed to `StateVersion`. */
export type {
  StateVersion,
  StateVersion as StateSnapshot,
} from "./state-versions.ts";

export type DeploymentStatus =
  | "active"
  | "superseded"
  | "rolled_back"
  | "destroyed";

/**
 * @deprecated Retired successful-apply record. Immutable once written; read-only
 * for audit. New applies record a {@link StateVersion} + Output instead.
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
 * @deprecated Public projection of the retired {@link Deployment} ledger. The
 * raw `outputSnapshotId` handle stays on the internal ledger shape; public reads
 * use the allowlisted `outputsPublic` projection or explicit OutputShare flows.
 */
export type PublicDeployment = Omit<Deployment, "outputSnapshotId">;
