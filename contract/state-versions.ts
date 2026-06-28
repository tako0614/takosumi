/**
 * StateVersion contract (`state_versions`).
 *
 * A StateVersion is one persisted Capsule tfstate generation. A successful
 * apply Run records one StateVersion generation and the Output produced by
 * `tofu output -json`.
 *
 * (Formerly `StateSnapshot`. The transient `StateSnapshot` alias is re-exported
 * from `./deployments.ts` until the rename converges.)
 */

/**
 * One tfstate generation. The encrypted object lives in R2_STATE under
 * `workspaces/{workspaceId}/capsules/{capsuleId}/envs/{environment}/states/
 * {generation(8 digits)}.tfstate.enc` with an atomic `current.json`.
 * UNIQUE(capsule_id, environment, generation) is the generation guard.
 */
export interface StateVersion {
  readonly id: string;
  readonly workspaceId: string;
  /** @deprecated Use workspaceId. */
  readonly spaceId?: string;
  readonly capsuleId: string;
  /** @deprecated Use capsuleId. */
  readonly installationId?: string;
  readonly environment: string;
  readonly generation: number;
  readonly objectKey: string;
  readonly digest: string;
  readonly createdByRunId: string;
  readonly createdAt: string;
}
