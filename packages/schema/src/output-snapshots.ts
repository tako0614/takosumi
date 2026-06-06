/**
 * OutputSnapshot + OutputShare contract (Core Specification §16 / §18 / §27
 * `output_snapshots` / `output_shares`).
 *
 * After a successful apply, `tofu output -json` is captured and projected
 * (spec §16): raw outputs stay an ENCRYPTED artifact (rawOutputArtifactKey);
 * the InstallConfig outputAllowlist + sensitive-flag check + type validation
 * produce `spaceOutputs` (same-Space dependency consumption) and
 * `publicOutputs` (UI / install summary / external display). Sensitive values
 * never enter either projection without explicit policy (invariants 11-12),
 * and cross-Space sharing always goes through an OutputShare (invariant 13).
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
  /** Digest over the projected outputs; drives stale propagation (spec §24). */
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

/** Cross-Space output sharing grant (spec §18). Post-MVP implementation. */
export interface OutputShare {
  readonly id: string;
  readonly fromSpaceId: string;
  readonly toSpaceId: string;
  readonly producerInstallationId: string;
  readonly outputs: readonly OutputShareEntry[];
  readonly status: OutputShareStatus;
  readonly createdAt: string;
  readonly revokedAt?: string;
}
