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

export interface OutputShareEntry {
  readonly name: string;
  readonly alias?: string;
  readonly type?: string;
  readonly sensitive: boolean;
}

/** Cross-Space output sharing grant. */
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
