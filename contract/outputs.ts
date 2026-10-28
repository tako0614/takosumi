/**
 * Capsule-local Output contract (`outputs`).
 *
 * After a successful apply, `tofu output -json` is captured and projected: raw
 * outputs stay an ENCRYPTED artifact (`rawArtifactRef`). A bounded,
 * non-sensitive root-output capture produces `workspaceOutputs` for
 * the owning Capsule's Interface resolution. The explicit
 * InstallConfig outputAllowlist separately produces `publicOutputs` for UI,
 * install summaries, and external display. A workspace-captured value never
 * becomes public merely because it is an ordinary OpenTofu Output. Sensitive
 * values enter neither projection. Apps communicate through Interfaces rather
 * than consuming another app's state or Outputs.
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
  /** Digest over the projected outputs. */
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
