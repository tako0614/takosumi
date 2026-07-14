/**
 * StateVersion contract (`state_versions`).
 *
 * A StateVersion is one persisted Capsule tfstate generation. A successful
 * apply Run records one StateVersion generation and the Output produced by
 * `tofu output -json`.
 */

/**
 * One tfstate generation. `stateRef` is an opaque reference allocated by the
 * host storage adapter; Core never derives a bucket or object-key layout from
 * Workspace/Capsule identity. UNIQUE(capsule_id, environment, generation) is
 * the generation guard.
 */
export interface StateVersion {
  readonly id: string;
  readonly workspaceId: string;
  readonly capsuleId: string;
  readonly environment: string;
  readonly generation: number;
  readonly stateRef: string;
  readonly digest: string;
  readonly createdByRunId: string;
  readonly createdAt: string;
}

/**
 * Session-safe StateVersion projection. Storage coordinates and digests are
 * internal runner details; the user-facing control API exposes only ledger
 * identity, ownership, generation, provenance, and creation time.
 */
export interface PublicStateVersion {
  readonly id: string;
  readonly workspaceId: string;
  readonly capsuleId: string;
  readonly environment: string;
  readonly generation: number;
  readonly createdByRunId: string;
  readonly createdAt: string;
}
