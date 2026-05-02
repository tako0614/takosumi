/**
 * Logical cloud partition that isolates secret material by deployment cloud.
 *
 * Each partition is encrypted with an independent boundary key so that a
 * compromise of one cloud's master key does not propagate to other clouds
 * (Phase 18.2 H14).
 */
export type CloudPartition =
  | "global"
  | "cloudflare"
  | "aws"
  | "gcp"
  | "k8s"
  | "selfhosted";

export const CLOUD_PARTITIONS: readonly CloudPartition[] = [
  "global",
  "cloudflare",
  "aws",
  "gcp",
  "k8s",
  "selfhosted",
];

export function isCloudPartition(value: unknown): value is CloudPartition {
  return typeof value === "string" &&
    (CLOUD_PARTITIONS as readonly string[]).includes(value);
}

/**
 * Rotation policy attached to a secret. Background rotation jobs use this
 * to mark secrets as expired / due for rotation (Phase 18.2 H15).
 */
export interface SecretRotationPolicy {
  /** Maximum age (in days) before a secret is considered due for rotation. */
  readonly intervalDays: number;
  /** Grace window (in days) after `intervalDays` before hard expiry. */
  readonly gracePeriodDays: number;
}

export interface SecretVersionRef {
  readonly name: string;
  readonly version: string;
}

export interface SecretRecord extends SecretVersionRef {
  readonly createdAt: string;
  readonly metadata: Record<string, unknown>;
  /**
   * Logical cloud partition that owns this secret. Defaults to `global`
   * when `putSecret` does not specify one.
   */
  readonly cloudPartition: CloudPartition;
  /** Optional rotation policy. */
  readonly rotationPolicy?: SecretRotationPolicy;
  /** ISO timestamp of the last successful read. Updated by `getSecret`. */
  readonly lastAccessedAt?: string;
}

export interface SecretStorePort {
  putSecret(input: {
    readonly name: string;
    readonly value: string;
    readonly metadata?: Record<string, unknown>;
    readonly cloudPartition?: CloudPartition;
    readonly rotationPolicy?: SecretRotationPolicy;
  }): Promise<SecretRecord>;
  getSecret(ref: SecretVersionRef): Promise<string | undefined>;
  getSecretRecord(ref: SecretVersionRef): Promise<SecretRecord | undefined>;
  latestSecret(name: string): Promise<SecretRecord | undefined>;
  listSecrets(filter?: {
    readonly cloudPartition?: CloudPartition;
    readonly name?: string;
  }): Promise<readonly SecretRecord[]>;
  deleteSecret(ref: SecretVersionRef): Promise<boolean>;
}
