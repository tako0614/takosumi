/**
 * Dependency DAG contract (Core Specification §14 / §15 / §17 / §27
 * `installation_dependencies` / `dependency_snapshots`).
 *
 * Installations within a Space form a DAG: a Dependency edge connects a
 * producer Installation's outputs to a consumer Installation's inputs.
 * The canonical store is the D1 ledger, not the filesystem.
 *
 * Modes (spec §15):
 *   - `variable_injection` (standard): Takosumi reads the producer
 *     OutputSnapshot and generates the consumer's `.auto.tfvars.json`.
 *   - `remote_state`: same-Space only; the producer state is materialized
 *     read-only at `/work/deps/<name>.tfstate` for `terraform_remote_state`.
 *   - `published_output`: cross-Space via an OutputShare, then injected as
 *     variables. (remote_state / published_output are post-MVP.)
 */

import type { OutputValueType } from "./installations.ts";

export const INSTALLATION_DEPENDENCIES_PATH = (installationId: string): string =>
  `/v1/installations/${encodeURIComponent(installationId)}/dependencies`;
export const DEPENDENCY_PATH = (dependencyId: string): string =>
  `/v1/dependencies/${encodeURIComponent(dependencyId)}`;

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
 * Plan-time pin of one dependency's inputs (spec §17). Apply verifies the
 * snapshot (invariant 9); `strict` mode additionally fails when the producer
 * state generation moved since plan.
 */
export interface DependencySnapshotEntry {
  readonly dependencyId: string;
  readonly producerInstallationId: string;
  readonly producerStateGeneration: number;
  readonly producerOutputSnapshotId: string;
  readonly producerOutputDigest: string;
  readonly valuesDigest: string;
  readonly values: Readonly<Record<string, unknown>>;
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
