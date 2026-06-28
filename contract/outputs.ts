/**
 * Output + OutputShare contract (`outputs` / `output_shares`).
 *
 * After a successful apply, `tofu output -json` is captured and projected: raw
 * outputs stay an ENCRYPTED artifact (`rawOutputArtifactKey`); the InstallConfig
 * outputAllowlist + sensitive-flag check + type validation produce
 * `workspaceOutputs` (same-Workspace dependency consumption) and `publicOutputs`
 * (UI / install summary / external display). Sensitive values never enter
 * either projection without explicit policy, and cross-Workspace sharing always
 * goes through an OutputShare.
 *
 * (Formerly `OutputSnapshot`. The transient `OutputSnapshot` alias is
 * re-exported from `./output-snapshots.ts` until the rename converges.)
 */

export interface Output {
  readonly id: string;
  readonly workspaceId: string;
  /** @deprecated Use workspaceId. */
  readonly spaceId: string;
  readonly capsuleId: string;
  /** @deprecated Use capsuleId. */
  readonly installationId: string;
  readonly stateGeneration: number;
  /** R2_ARTIFACTS key of the encrypted raw `tofu output -json` artifact. */
  readonly rawOutputArtifactKey: string;
  readonly publicOutputs: Readonly<Record<string, unknown>>;
  readonly workspaceOutputs: Readonly<Record<string, unknown>>;
  /** @deprecated Use workspaceOutputs. */
  readonly spaceOutputs: Readonly<Record<string, unknown>>;
  /** Digest over the projected outputs; drives stale propagation. */
  readonly outputDigest: string;
  readonly createdAt: string;
}

/**
 * Public Output projection. The raw encrypted artifact key is an internal
 * storage handle and is not part of edge/session API reads.
 */
export type PublicOutput = Omit<Output, "rawOutputArtifactKey">;

export type OutputShareStatus = "pending" | "active" | "revoked";

/**
 * One shared output on an {@link OutputShare} grant.
 *
 * SECURITY INVARIANT (names-only at rest): an entry carries the producer output
 * `name`, an optional consumer-side `alias`, an optional `type` hint, and the
 * `sensitive` flag — and DELIBERATELY no `value` field. The producer's resolved
 * output value (sensitive or not) is NEVER copied onto a grant: the share record
 * is the authorization, not the payload. The value stays in the producer's
 * encrypted raw-output artifact (`Output.rawOutputArtifactKey`) and is
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
 * Cross-Workspace output sharing grant.
 *
 * Carries grant identity, the producer Capsule, the shared {@link
 * OutputShareEntry} list (names / aliases / flags only — see the entry's
 * security invariant), and the pending -> active -> revoked lifecycle. No output
 * VALUE is ever stored on the grant.
 */
export interface OutputShare {
  readonly id: string;
  readonly fromWorkspaceId?: string;
  readonly toWorkspaceId?: string;
  /** @deprecated Use fromWorkspaceId. */
  readonly fromSpaceId: string;
  /** @deprecated Use toWorkspaceId. */
  readonly toSpaceId: string;
  readonly producerCapsuleId?: string;
  /** @deprecated Use producerCapsuleId. */
  readonly producerInstallationId: string;
  readonly outputs: readonly OutputShareEntry[];
  readonly status: OutputShareStatus;
  readonly createdAt: string;
  readonly acceptedAt?: string;
  readonly revokedAt?: string;
}
