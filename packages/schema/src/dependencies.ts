/**
 * Dependency DAG contract (`installation_dependencies` /
 * `dependency_snapshots`).
 *
 * Installations within a Space form a DAG: a Dependency edge connects a
 * producer Installation's outputs to a consumer Installation's inputs.
 * The canonical store is the D1 ledger, not the filesystem.
 *
 * Modes:
 *   - `variable_injection` (standard): Takosumi reads the producer
 *     OutputSnapshot and generates the consumer's `.auto.tfvars.json`.
 *   - `remote_state`: same-Space only; the plan-pinned producer StateSnapshot
 *     is materialized read-only at `/work/deps/<name>.tfstate` for
 *     `terraform_remote_state`.
 *   - `published_output`: cross-Space via an OutputShare, then injected as
 *     variables.
 */

import type { OutputValueType } from "./installations.ts";

export const INSTALLATION_DEPENDENCIES_PATH = (
  installationId: string,
): string =>
  `/api/installations/${encodeURIComponent(installationId)}/dependencies`;
export const DEPENDENCY_PATH = (dependencyId: string): string =>
  `/api/dependencies/${encodeURIComponent(dependencyId)}`;

export type DependencyMode =
  | "remote_state"
  | "variable_injection"
  | "published_output";

export type DependencyVisibility = "space" | "cross_space";

/** One producer-output -> consumer-input mapping on a Dependency edge. */
export interface DependencyOutputMapping {
  readonly from: string;
  readonly to: string;
  readonly required: boolean;
  readonly type?: OutputValueType;
}

export interface Dependency {
  readonly id: string;
  readonly spaceId: string;
  readonly producerInstallationId: string;
  readonly consumerInstallationId: string;
  readonly mode: DependencyMode;
  readonly outputs: Readonly<Record<string, DependencyOutputMapping>>;
  readonly visibility: DependencyVisibility;
  readonly createdAt: string;
}

/**
 * At-rest sealed blob for the SENSITIVE subset of a {@link
 * DependencySnapshotEntry}'s pinned values (spec §11 / §18 invariant: secret
 * outputs are never stored as cleartext ledger values).
 *
 * A `published_output` edge may inline a producer's *sensitive* output value
 * into the consumer's pinned inputs. That value MUST NOT sit in cleartext in
 * the `dependency_snapshots` ledger row. When the host injects a value sealer,
 * the controller moves every sensitive value off the cleartext `values` map and
 * into this blob, sealed with the SAME AES-GCM at-rest envelope used for state /
 * plan / raw-output artifacts (no new key management). The blob carries the
 * sealed `names` (cleartext metadata, never the values) so apply can recover the
 * full plaintext value map and re-verify the per-entry `valuesDigest`, which is
 * always computed over the FULL plaintext value map (sensitive + non-sensitive)
 * exactly as it would be without sealing.
 */
export interface SealedDependencyValues {
  /** Base64 of the AES-GCM ciphertext (iv || ciphertext+tag) of `{ name: value }`. */
  readonly ciphertext: string;
  /** `sha256:<hex>` over the sealed plaintext bytes (tamper check after decrypt). */
  readonly contentDigest: string;
  /** The value keys carried inside the sealed blob. Cleartext metadata, no values. */
  readonly names: readonly string[];
}

/**
 * Plan-time pin of one dependency's inputs. Apply verifies the
 * snapshot (invariant 9); `strict` mode additionally fails when the producer
 * state generation moved since plan.
 */
export interface DependencySnapshotEntry {
  readonly dependencyId: string;
  readonly producerInstallationId: string;
  readonly producerStateGeneration: number;
  /**
   * Pinned StateSnapshot for `remote_state` edges. Variable-injection and
   * published-output edges may omit these because they pin output values instead
   * of state bytes.
   */
  readonly producerStateSnapshotId?: string;
  readonly producerStateObjectKey?: string;
  readonly producerStateDigest?: string;
  readonly producerOutputSnapshotId: string;
  readonly producerOutputDigest: string;
  /**
   * `sha256:<hex>` over the FULL plaintext value map — the non-sensitive entries
   * in {@link values} PLUS the sensitive entries that live sealed in {@link
   * sealedValues}. Apply recomputes it over the recovered full plaintext, so the
   * digest is independent of whether the entry's secrets are sealed at rest.
   */
  readonly valuesDigest: string;
  /**
   * The plaintext, NON-SENSITIVE pinned values keyed by the consumer input name.
   * A sensitive value (resolved from a `published_output` share) is NEVER stored
   * here; it lives sealed in {@link sealedValues}.
   */
  readonly values: Readonly<Record<string, unknown>>;
  /**
   * Sealed sensitive values for this edge (omitted when the edge pinned no
   * sensitive value). The cleartext sensitive values are recovered from here at
   * apply time and never persisted to {@link values}.
   */
  readonly sealedValues?: SealedDependencyValues;
}

/** `strict` is the production default; `pinned` the preview/dev default. */
export type DependencySnapshotMode = "strict" | "pinned";

export interface DependencySnapshot {
  readonly id: string;
  readonly runId: string;
  readonly dependencies: readonly DependencySnapshotEntry[];
  readonly mode: DependencySnapshotMode;
  readonly createdAt: string;
}
