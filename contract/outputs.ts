/**
 * Output + OutputShare contract (`outputs` / `output_shares`).
 *
 * After a successful apply, `tofu output -json` is captured and projected: raw
 * outputs stay an ENCRYPTED artifact (`rawArtifactRef`). A bounded,
 * non-sensitive root-output capture produces `workspaceOutputs` for
 * same-Workspace Dependency and Interface resolution. The explicit
 * InstallConfig outputAllowlist separately produces `publicOutputs` for UI,
 * install summaries, and external display. A workspace-captured value never
 * becomes public merely because it is an ordinary OpenTofu Output. Sensitive
 * values enter neither projection, and cross-Workspace sharing always goes
 * through an OutputShare.
 */

import type { JsonValue } from "./types.ts";

export interface Output {
  readonly id: string;
  readonly workspaceId: string;
  readonly capsuleId: string;
  readonly stateGeneration: number;
  /** Opaque storage reference for encrypted raw `tofu output -json`. */
  readonly rawArtifactRef: string;
  /** Explicit InstallConfig projection safe for UI/external display. */
  readonly publicOutputs: Readonly<Record<string, JsonValue>>;
  /** Bounded non-secret capture scoped to this Workspace. */
  readonly workspaceOutputs: Readonly<Record<string, JsonValue>>;
  /** Digest over the projected outputs; drives stale propagation. */
  readonly outputDigest: string;
  readonly createdAt: string;
}

/**
 * Public Output projection. The raw encrypted artifact key is an internal
 * storage handle and is not part of edge/session API reads.
 */
export type PublicOutput = Omit<Output, "rawArtifactRef">;

/** Current public Output projection for one Capsule, or null before apply. */
export interface OutputResponse {
  readonly output: PublicOutput | null;
}

/** Stable failed-precondition reason for a broken Capsule -> Output cursor. */
export const CURRENT_OUTPUT_INCONSISTENT_REASON =
  "current_output_inconsistent" as const;

export type OutputShareStatus = "pending" | "active" | "revoked";

/**
 * One shared output on an {@link OutputShare} grant.
 *
 * SECURITY INVARIANT (names-only at rest): an entry carries the producer output
 * `name`, an optional consumer-side `alias`, an optional `type` hint, and the
 * `sensitive` flag — and DELIBERATELY no `value` field. The producer's resolved
 * output value (sensitive or not) is NEVER copied onto a grant: the share record
 * is the authorization, not the payload. The value stays in the producer's
 * encrypted raw-output artifact (`Output.rawArtifactRef`) and is
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
  readonly fromWorkspaceId: string;
  readonly toWorkspaceId: string;
  readonly producerCapsuleId: string;
  readonly outputs: readonly OutputShareEntry[];
  readonly status: OutputShareStatus;
  readonly createdAt: string;
  readonly acceptedAt?: string;
  readonly revokedAt?: string;
}
