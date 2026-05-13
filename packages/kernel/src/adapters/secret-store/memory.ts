import type {
  CloudPartition,
  SecretRecord,
  SecretRotationPolicy,
  SecretStorePort,
  SecretVersionRef,
} from "./types.ts";
import { CLOUD_PARTITIONS } from "./types.ts";
import { isDevMode } from "../../config/dev_mode.ts";

export interface MemoryEncryptedSecretStoreOptions {
  readonly clock?: () => Date;
  readonly idGenerator?: () => string;
  readonly crypto?: SecretBoundaryCrypto;
  /**
   * Optional environment hint used to choose a default secret-boundary crypto.
   * When supplied (and `crypto` is not), the constructor invokes
   * {@link selectSecretBoundaryCrypto}, which fails closed on
   * production / staging environments lacking an encryption key.
   */
  readonly env?: SecretCryptoEnvLike;
  /**
   * Version retention configuration applied by `runVersionGc`. When omitted,
   * defaults to `{ keepLatest: 5, accessedWithinDays: 90 }`.
   */
  readonly versionRetention?: SecretVersionRetentionConfig;
}

export interface SecretVersionRetentionConfig {
  readonly keepLatest: number;
  readonly accessedWithinDays: number;
}

export interface SecretBoundaryCrypto {
  /**
   * Seal `plaintext` for the given cloud partition. Implementations MUST
   * use a partition-bound key so that opening the resulting ciphertext
   * with another partition's key fails.
   */
  seal(plaintext: string, cloudPartition: CloudPartition): Promise<Uint8Array>;
  /** Opens ciphertext that was sealed with the same partition. */
  open(ciphertext: Uint8Array, cloudPartition: CloudPartition): Promise<string>;
}

/** Minimal env shape consumed by {@link selectSecretBoundaryCrypto}. */
export type SecretCryptoEnvLike = Readonly<
  Record<string, string | undefined>
>;

/**
 * Error thrown when the secret-boundary crypto cannot be selected without
 * silently downgrading to a non-encrypting placeholder. Surfaces a clear
 * remediation message so operators can wire an encryption key (or, in
 * non-production environments, explicitly opt in to plaintext storage).
 */
export class SecretEncryptionConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretEncryptionConfigurationError";
  }
}

/**
 * Environment variable names recognised as supplying a secret-store
 * encryption passphrase / key for the `global` partition. Per-cloud
 * passphrases are derived from {@link cloudPartitionEnvKeys}.
 */
export const SECRET_STORE_KEY_ENV_KEYS: readonly string[] = [
  "TAKOSUMI_SECRET_STORE_PASSPHRASE",
  "TAKOSUMI_SECRET_STORE_KEY",
];

/**
 * Returns the env keys searched for a per-cloud partition passphrase.
 *
 * For partition `aws` the keys are `TAKOSUMI_SECRET_STORE_PASSPHRASE_AWS`,
 * `TAKOSUMI_SECRET_STORE_KEY_AWS`, etc. The plain `TAKOSUMI_SECRET_STORE_PASSPHRASE`
 * (without suffix) is treated as the `global` partition's key, which also
 * acts as a fallback for partitions that do not have a dedicated key.
 */
export function cloudPartitionEnvKeys(
  partition: CloudPartition,
): readonly string[] {
  if (partition === "global") return SECRET_STORE_KEY_ENV_KEYS;
  const suffix = partition.toUpperCase();
  return SECRET_STORE_KEY_ENV_KEYS.map((key) => `${key}_${suffix}`);
}

const PRODUCTION_LIKE_ENVIRONMENTS = new Set([
  "production",
  "prod",
  "staging",
  "stage",
]);

export interface SelectSecretBoundaryCryptoOptions {
  readonly env: SecretCryptoEnvLike;
}

/**
 * Selects a {@link SecretBoundaryCrypto} implementation given the boot
 * environment. Behavior:
 *
 *  - Production / staging require AT LEAST a global passphrase via
 *    {@link SECRET_STORE_KEY_ENV_KEYS}. Per-cloud overrides are picked up
 *    from {@link cloudPartitionEnvKeys} when present, so a compromise of
 *    one cloud key does not affect other partitions (Phase 18.2 H14).
 *  - Production / staging without a global key throw
 *    {@link SecretEncryptionConfigurationError}.
 *  - Local / dev / test require explicit opt-in via
 *    `TAKOSUMI_DEV_MODE=1` before using
 *    {@link PlaceholderSecretBoundaryCrypto}.
 */
export function selectSecretBoundaryCrypto(
  options: SelectSecretBoundaryCryptoOptions,
): SecretBoundaryCrypto {
  const env = options.env;
  const globalPassphrase = firstNonEmpty(env, SECRET_STORE_KEY_ENV_KEYS);
  if (globalPassphrase !== undefined) {
    return MultiCloudSecretBoundaryCrypto.fromEnv(env, globalPassphrase);
  }
  const environment = normalizeEnvironment(
    env.TAKOSUMI_ENVIRONMENT ?? env.NODE_ENV ?? env.ENVIRONMENT,
  );
  if (PRODUCTION_LIKE_ENVIRONMENTS.has(environment)) {
    throw new SecretEncryptionConfigurationError(
      `secret-store encryption key missing in ${environment}: ` +
        `set one of ${SECRET_STORE_KEY_ENV_KEYS.join(", ")} ` +
        `to a 32+ byte high-entropy passphrase ` +
        `(per-cloud overrides via *_AWS / *_GCP / *_CLOUDFLARE / *_K8S / *_SELFHOSTED). ` +
        `Refusing to fall back to plaintext (base64) secret storage.`,
    );
  }
  if (!isDevMode(env)) {
    throw new SecretEncryptionConfigurationError(
      `secret-store encryption key missing in ${environment}: ` +
        `set one of ${SECRET_STORE_KEY_ENV_KEYS.join(", ")} ` +
        `or explicitly opt in to dev mode with ` +
        `TAKOSUMI_DEV_MODE=1 (local/dev only).`,
    );
  }
  return new PlaceholderSecretBoundaryCrypto();
}

function firstNonEmpty(
  env: SecretCryptoEnvLike,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = env[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return undefined;
}

function normalizeEnvironment(raw: string | undefined): string {
  return (raw ?? "local").trim().toLowerCase() || "local";
}

interface StoredSecret extends SecretRecord {
  readonly ciphertext: Uint8Array;
  // mutable shadow of `lastAccessedAt` — `SecretRecord.lastAccessedAt`
  // is readonly so we keep the mutable copy here.
  mutableLastAccessedAt?: string;
}

export interface SecretRotationStatus {
  readonly name: string;
  readonly version: string;
  readonly cloudPartition: CloudPartition;
  readonly createdAt: string;
  readonly intervalDays: number;
  readonly gracePeriodDays: number;
  /** ISO timestamp at which the secret first becomes due for rotation. */
  readonly dueAt: string;
  /** ISO timestamp at which the secret hard-expires (past grace). */
  readonly expiresAt: string;
  readonly state: "active" | "due" | "expired";
}

export interface SecretGcReport {
  readonly evaluated: number;
  readonly retained: number;
  readonly deleted: readonly SecretVersionRef[];
}

const DEFAULT_VERSION_RETENTION: SecretVersionRetentionConfig = {
  keepLatest: 5,
  accessedWithinDays: 90,
};

export class MemoryEncryptedSecretStore implements SecretStorePort {
  readonly #records = new Map<string, StoredSecret>();
  readonly #latest = new Map<string, string>();
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;
  readonly #crypto: SecretBoundaryCrypto;
  readonly #versionRetention: SecretVersionRetentionConfig;

  constructor(options: MemoryEncryptedSecretStoreOptions = {}) {
    this.#clock = options.clock ?? (() => new Date());
    this.#idGenerator = options.idGenerator ?? (() => crypto.randomUUID());
    if (options.crypto) {
      this.#crypto = options.crypto;
    } else if (options.env) {
      this.#crypto = selectSecretBoundaryCrypto({ env: options.env });
    } else {
      this.#crypto = new PlaceholderSecretBoundaryCrypto();
    }
    this.#versionRetention = options.versionRetention ??
      DEFAULT_VERSION_RETENTION;
  }

  async putSecret(
    input: {
      readonly name: string;
      readonly value: string;
      readonly metadata?: Record<string, unknown>;
      readonly cloudPartition?: CloudPartition;
      readonly rotationPolicy?: SecretRotationPolicy;
    },
  ): Promise<SecretRecord> {
    const partition: CloudPartition = input.cloudPartition ?? "global";
    if (!CLOUD_PARTITIONS.includes(partition)) {
      throw new Error(`unsupported cloud partition: ${partition}`);
    }
    const version = `secret_version_${this.#idGenerator()}`;
    const record: StoredSecret = {
      name: input.name,
      version,
      cloudPartition: partition,
      createdAt: this.#clock().toISOString(),
      metadata: { ...(input.metadata ?? {}) },
      rotationPolicy: input.rotationPolicy
        ? Object.freeze({ ...input.rotationPolicy })
        : undefined,
      ciphertext: await this.#crypto.seal(input.value, partition),
    };
    this.#records.set(key(record), record);
    this.#latest.set(input.name, version);
    return publicRecord(record);
  }

  async getSecret(ref: SecretVersionRef): Promise<string | undefined> {
    const record = this.#records.get(key(ref));
    if (!record) return undefined;
    const plaintext = await this.#crypto.open(
      record.ciphertext,
      record.cloudPartition,
    );
    record.mutableLastAccessedAt = this.#clock().toISOString();
    return plaintext;
  }

  getSecretRecord(ref: SecretVersionRef): Promise<SecretRecord | undefined> {
    const record = this.#records.get(key(ref));
    return Promise.resolve(record ? publicRecord(record) : undefined);
  }

  latestSecret(name: string): Promise<SecretRecord | undefined> {
    const version = this.#latest.get(name);
    const record = version
      ? this.#records.get(key({ name, version }))
      : undefined;
    return Promise.resolve(record ? publicRecord(record) : undefined);
  }

  listSecrets(filter?: {
    readonly cloudPartition?: CloudPartition;
    readonly name?: string;
  }): Promise<readonly SecretRecord[]> {
    const records = [...this.#records.values()].filter((record) => {
      if (
        filter?.cloudPartition &&
        record.cloudPartition !== filter.cloudPartition
      ) {
        return false;
      }
      if (filter?.name && record.name !== filter.name) return false;
      return true;
    });
    return Promise.resolve(records.map(publicRecord));
  }

  deleteSecret(ref: SecretVersionRef): Promise<boolean> {
    const deleted = this.#records.delete(key(ref));
    if (this.#latest.get(ref.name) === ref.version) {
      // Recompute latest for the name (in case other versions remain).
      const remaining = [...this.#records.values()]
        .filter((record) => record.name === ref.name)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const newLatest = remaining[remaining.length - 1];
      if (newLatest) this.#latest.set(ref.name, newLatest.version);
      else this.#latest.delete(ref.name);
    }
    return Promise.resolve(deleted);
  }

  /**
   * Returns rotation status for every stored secret that has a
   * `rotationPolicy` configured (Phase 18.2 H15).
   */
  rotationStatus(): SecretRotationStatus[] {
    const now = this.#clock();
    const results: SecretRotationStatus[] = [];
    for (const record of this.#records.values()) {
      const policy = record.rotationPolicy;
      if (!policy) continue;
      const created = new Date(record.createdAt).getTime();
      const dueAt = new Date(created + policy.intervalDays * DAY_MS);
      const expiresAt = new Date(
        created + (policy.intervalDays + policy.gracePeriodDays) * DAY_MS,
      );
      const state: SecretRotationStatus["state"] = now.getTime() >=
          expiresAt.getTime()
        ? "expired"
        : now.getTime() >= dueAt.getTime()
        ? "due"
        : "active";
      results.push({
        name: record.name,
        version: record.version,
        cloudPartition: record.cloudPartition,
        createdAt: record.createdAt,
        intervalDays: policy.intervalDays,
        gracePeriodDays: policy.gracePeriodDays,
        dueAt: dueAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
        state,
      });
    }
    return results;
  }

  /**
   * Garbage-collects secret versions, keeping the configured "latest N"
   * window plus any version accessed within `accessedWithinDays`. The
   * currently-marked latest version is always retained.
   */
  runVersionGc(): SecretGcReport {
    const retention = this.#versionRetention;
    const now = this.#clock().getTime();
    const cutoff = now - retention.accessedWithinDays * DAY_MS;
    const byName = new Map<string, StoredSecret[]>();
    for (const record of this.#records.values()) {
      const list = byName.get(record.name);
      if (list) list.push(record);
      else byName.set(record.name, [record]);
    }
    let evaluated = 0;
    let retained = 0;
    const deleted: SecretVersionRef[] = [];
    for (const [name, versions] of byName) {
      versions.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const latestVersion = this.#latest.get(name);
      versions.forEach((record, index) => {
        evaluated += 1;
        const isLatest = record.version === latestVersion;
        const withinKeepWindow = index < retention.keepLatest;
        const lastAccessed = record.mutableLastAccessedAt;
        const recentlyAccessed = lastAccessed
          ? new Date(lastAccessed).getTime() >= cutoff
          : false;
        if (isLatest || withinKeepWindow || recentlyAccessed) {
          retained += 1;
          return;
        }
        this.#records.delete(key(record));
        deleted.push({ name: record.name, version: record.version });
      });
    }
    return Object.freeze({
      evaluated,
      retained,
      deleted: Object.freeze(deleted),
    });
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

export class PlaceholderSecretBoundaryCrypto implements SecretBoundaryCrypto {
  readonly #prefix = "takos-secret-placeholder-v1:";

  seal(plaintext: string, cloudPartition: CloudPartition): Promise<Uint8Array> {
    const payload = `${cloudPartition}|${plaintext}`;
    return Promise.resolve(
      new TextEncoder().encode(`${this.#prefix}${btoa(payload)}`),
    );
  }

  open(
    ciphertext: Uint8Array,
    cloudPartition: CloudPartition,
  ): Promise<string> {
    const encoded = new TextDecoder().decode(ciphertext);
    if (!encoded.startsWith(this.#prefix)) {
      throw new Error("invalid placeholder secret payload");
    }
    const payload = atob(encoded.slice(this.#prefix.length));
    const sep = payload.indexOf("|");
    if (sep === -1) {
      throw new Error("invalid placeholder secret payload (missing partition)");
    }
    const sealedPartition = payload.slice(0, sep);
    if (sealedPartition !== cloudPartition) {
      throw new Error(
        `placeholder secret partition mismatch: sealed=${sealedPartition} requested=${cloudPartition}`,
      );
    }
    return Promise.resolve(payload.slice(sep + 1));
  }
}

/**
 * Single-key AES-GCM crypto. Does NOT enforce per-cloud isolation; production
 * deployments should use {@link MultiCloudSecretBoundaryCrypto}.
 */
export class WebCryptoAesGcmSecretBoundaryCrypto
  implements SecretBoundaryCrypto {
  readonly #passphrase: string;
  #keyPromise: Promise<CryptoKey> | undefined;

  constructor(passphrase: string) {
    this.#passphrase = passphrase;
  }

  async seal(
    plaintext: string,
    _cloudPartition: CloudPartition,
  ): Promise<Uint8Array> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        await this.#key(),
        toArrayBuffer(new TextEncoder().encode(plaintext)),
      ),
    );
    const out = new Uint8Array(iv.length + encrypted.length);
    out.set(iv);
    out.set(encrypted, iv.length);
    return out;
  }

  async open(
    ciphertext: Uint8Array,
    _cloudPartition: CloudPartition,
  ): Promise<string> {
    const iv = ciphertext.slice(0, 12);
    const payload = ciphertext.slice(12);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      await this.#key(),
      toArrayBuffer(payload),
    );
    return new TextDecoder().decode(plaintext);
  }

  #key(): Promise<CryptoKey> {
    this.#keyPromise ??= deriveAesKey(this.#passphrase);
    return this.#keyPromise;
  }
}

/**
 * AES-GCM crypto that derives an INDEPENDENT key per cloud partition.
 *
 * Construction takes a map `partition -> passphrase`. The `global`
 * partition's passphrase MUST be supplied; partitions without an explicit
 * override fall back to the global passphrase mixed with the partition
 * label (HKDF-style salt) so that a leaked global passphrase cannot
 * be reused as-is to open per-cloud ciphertext that was sealed with a
 * different override key (Phase 18.2 H14).
 *
 * Authentication is reinforced by binding the partition label into the
 * AES-GCM additional authenticated data (AAD), so swapping the
 * partition tag of a sealed payload causes `open` to fail.
 */
export class MultiCloudSecretBoundaryCrypto implements SecretBoundaryCrypto {
  readonly #passphrases: Map<CloudPartition, string>;
  readonly #keyPromises = new Map<CloudPartition, Promise<CryptoKey>>();
  readonly #fallbackPassphrase: string;

  constructor(
    options: {
      readonly globalPassphrase: string;
      readonly perCloudPassphrases?: Partial<Record<CloudPartition, string>>;
    },
  ) {
    if (!options.globalPassphrase || options.globalPassphrase.trim() === "") {
      throw new SecretEncryptionConfigurationError(
        "MultiCloudSecretBoundaryCrypto requires a non-empty globalPassphrase",
      );
    }
    this.#fallbackPassphrase = options.globalPassphrase;
    this.#passphrases = new Map();
    for (const partition of CLOUD_PARTITIONS) {
      const override = options.perCloudPassphrases?.[partition];
      const passphrase = (override && override.trim() !== "")
        ? override
        : this.#derivePartitionPassphrase(partition);
      this.#passphrases.set(partition, passphrase);
    }
  }

  static fromEnv(
    env: SecretCryptoEnvLike,
    globalPassphrase: string,
  ): MultiCloudSecretBoundaryCrypto {
    const perCloud: Partial<Record<CloudPartition, string>> = {};
    for (const partition of CLOUD_PARTITIONS) {
      if (partition === "global") continue;
      const value = firstNonEmpty(env, cloudPartitionEnvKeys(partition));
      if (value) perCloud[partition] = value;
    }
    return new MultiCloudSecretBoundaryCrypto({
      globalPassphrase,
      perCloudPassphrases: perCloud,
    });
  }

  #derivePartitionPassphrase(partition: CloudPartition): string {
    return `${this.#fallbackPassphrase}|takos.cloud.partition=${partition}`;
  }

  async seal(
    plaintext: string,
    cloudPartition: CloudPartition,
  ): Promise<Uint8Array> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const aad = new TextEncoder().encode(`takos.cloud:${cloudPartition}`);
    const encrypted = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: toArrayBuffer(aad) },
        await this.#key(cloudPartition),
        toArrayBuffer(new TextEncoder().encode(plaintext)),
      ),
    );
    const out = new Uint8Array(iv.length + encrypted.length);
    out.set(iv);
    out.set(encrypted, iv.length);
    return out;
  }

  async open(
    ciphertext: Uint8Array,
    cloudPartition: CloudPartition,
  ): Promise<string> {
    const iv = ciphertext.slice(0, 12);
    const payload = ciphertext.slice(12);
    const aad = new TextEncoder().encode(`takos.cloud:${cloudPartition}`);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: toArrayBuffer(aad) },
      await this.#key(cloudPartition),
      toArrayBuffer(payload),
    );
    return new TextDecoder().decode(plaintext);
  }

  #key(partition: CloudPartition): Promise<CryptoKey> {
    const passphrase = this.#passphrases.get(partition);
    if (!passphrase) {
      throw new Error(`unsupported cloud partition: ${partition}`);
    }
    let promise = this.#keyPromises.get(partition);
    if (!promise) {
      promise = deriveAesKey(passphrase);
      this.#keyPromises.set(partition, promise);
    }
    return promise;
  }
}

async function deriveAesKey(passphrase: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(passphrase),
  );
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

function key(ref: SecretVersionRef): string {
  return `${ref.name}\0${ref.version}`;
}

function publicRecord(record: StoredSecret): SecretRecord {
  return Object.freeze(structuredClone({
    name: record.name,
    version: record.version,
    cloudPartition: record.cloudPartition,
    createdAt: record.createdAt,
    metadata: record.metadata,
    rotationPolicy: record.rotationPolicy,
    lastAccessedAt: record.mutableLastAccessedAt,
  }));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}
