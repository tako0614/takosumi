/**
 * OutputSnapshot + OutputShare contract (`output_snapshots` /
 * `output_shares`).
 *
 * After a successful apply, `tofu output -json` is captured and projected
 * raw outputs stay an ENCRYPTED artifact (rawOutputArtifactKey);
 * the InstallConfig outputAllowlist + sensitive-flag check + type validation
 * produce `spaceOutputs` (same-Space dependency consumption) and
 * `publicOutputs` (UI / install summary / external display). Sensitive values
 * never enter either projection without explicit policy, and cross-Space
 * sharing always goes through an OutputShare.
 */

export interface OutputSnapshot {
  readonly id: string;
  readonly spaceId: string;
  readonly installationId: string;
  readonly stateGeneration: number;
  /** R2_ARTIFACTS key of the encrypted raw `tofu output -json` artifact. */
  readonly rawOutputArtifactKey: string;
  readonly publicOutputs: Readonly<Record<string, unknown>>;
  readonly spaceOutputs: Readonly<Record<string, unknown>>;
  /** Digest over the projected outputs; drives stale propagation. */
  readonly outputDigest: string;
  readonly createdAt: string;
}

export type OutputShareStatus = "pending" | "active" | "revoked";

/**
 * One shared output on an {@link OutputShare} grant.
 *
 * SECURITY INVARIANT (names-only at rest): an entry carries the producer output
 * `name`, an optional consumer-side `alias`, an optional `type` hint, and the
 * `sensitive` flag — and DELIBERATELY no `value` field. The producer's resolved
 * output value (sensitive or not) is NEVER copied onto a grant: the share record
 * is the authorization, not the payload. The value stays in the producer's
 * encrypted raw-output artifact (`OutputSnapshot.rawOutputArtifactKey`) and is
 * re-resolved (and re-checked against the active grant) only at plan-time
 * `published_output` injection. Because the persisted `output_shares` row is
 * structurally names-only, it needs no separate at-rest encryption — there is no
 * cleartext secret on the grant to seal. (At-rest sealing of the resolved
 * sensitive value that DOES get inlined into a consumer's pinned inputs belongs
 * to the `dependency_snapshots` / `DependencySnapshotEntry.values` path, not
 * here.)
 */
export interface OutputShareEntry {
  readonly name: string;
  readonly alias?: string;
  readonly type?: string;
  readonly sensitive: boolean;
}

/**
 * Cross-Space output sharing grant.
 *
 * Carries grant identity, the producer Installation, the shared {@link
 * OutputShareEntry} list (names / aliases / flags only — see the entry's
 * security invariant), and the pending -> active -> revoked lifecycle. No output
 * VALUE is ever stored on the grant.
 */
export interface OutputShare {
  readonly id: string;
  readonly fromSpaceId: string;
  readonly toSpaceId: string;
  readonly producerInstallationId: string;
  readonly outputs: readonly OutputShareEntry[];
  readonly status: OutputShareStatus;
  readonly createdAt: string;
  readonly acceptedAt?: string;
  readonly revokedAt?: string;
}
