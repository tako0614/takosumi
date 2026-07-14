/**
 * Opaque logical partition that isolates secret material by recipe/connection.
 *
 * Each partition is encrypted with an independent boundary key so that a
 * compromise of one cloud's master key does not propagate to other clouds
 * (Phase 18.2 H14).
 */
export type SecretPartition = string;

export function isSecretPartition(value: unknown): value is SecretPartition {
  return typeof value === "string" && value.trim() !== "" && !/\s/u.test(value);
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
  /** Opaque logical partition. Defaults to `global` when omitted on write. */
  readonly secretPartition: SecretPartition;
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
    readonly secretPartition?: SecretPartition;
    readonly rotationPolicy?: SecretRotationPolicy;
  }): Promise<SecretRecord>;
  getSecret(ref: SecretVersionRef): Promise<string | undefined>;
  getSecretRecord(ref: SecretVersionRef): Promise<SecretRecord | undefined>;
  latestSecret(name: string): Promise<SecretRecord | undefined>;
  listSecrets(filter?: {
    readonly secretPartition?: SecretPartition;
    readonly name?: string;
  }): Promise<readonly SecretRecord[]>;
  deleteSecret(ref: SecretVersionRef): Promise<boolean>;
}
