import type {
  SecretPartition,
  SecretRecord,
  SecretRotationPolicy,
  SecretStorePort,
  SecretVersionRef,
} from "./types.ts";
import { isSecretPartition } from "./types.ts";
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
   * Seal `plaintext` for the given opaque secret partition. Implementations MUST
   * use a partition-bound key so that opening the resulting ciphertext
   * with another partition's key fails.
   *
   * `aad` is an optional canonical additional-authenticated-data context that
   * the implementation folds into the cipher's authentication. When supplied,
   * {@link open} MUST be given the byte-identical `aad` or decryption fails —
   * binding the ciphertext to the caller's row identity (e.g. the owning
   * connection), so a swapped or tampered blob fails to decrypt.
   */
  seal(
    plaintext: string,
    secretPartition: SecretPartition,
    aad?: Uint8Array,
  ): Promise<Uint8Array>;
  /**
   * Opens ciphertext that was sealed with the same partition (and the same
   * `aad` context, when one was supplied at seal time).
   */
  open(
    ciphertext: Uint8Array,
    secretPartition: SecretPartition,
    aad?: Uint8Array,
  ): Promise<string>;
  /**
   * Optional stable fingerprint of the ACTIVE key material for `secretPartition`,
   * recorded alongside sealed blobs so a key rotation is detectable (the value
   * changes when the passphrase changes). It is a one-way fold and never leaks
   * the key. Implementations without keyed material may omit this; callers fall
   * back to a constant version.
   */
  keyVersion?(secretPartition: SecretPartition): number;
}

/** Minimal env shape consumed by {@link selectSecretBoundaryCrypto}. */
export type SecretCryptoEnvLike = Readonly<Record<string, string | undefined>>;

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
 * encryption passphrase / key for the `global` partition.
 */
export const SECRET_STORE_KEY_ENV_KEYS: readonly string[] = [
  "TAKOSUMI_SECRET_STORE_PASSPHRASE",
  "TAKOSUMI_SECRET_STORE_KEY",
];

/** Optional JSON object env containing explicit `partition -> passphrase` overrides. */
export const SECRET_STORE_PARTITION_KEYS_ENV =
  "TAKOSUMI_SECRET_STORE_PARTITION_PASSPHRASES";

const PRODUCTION_LIKE_ENVIRONMENTS = new Set([
  "production",
  "prod",
  "staging",
  "stage",
]);

/**
 * Minimum accepted secret-store passphrase length, in UTF-8 bytes. The AES key
 * is `SHA-256(passphrase)` (a 32-byte / 256-bit key), so a passphrase shorter
 * than 32 bytes cannot carry the entropy the key width implies. The crypto
 * constructor fails closed below this threshold so a weak key is rejected at
 * boot rather than silently producing an under-entropy key.
 */
export const MIN_SECRET_STORE_PASSPHRASE_BYTES = 32;

export interface SelectSecretBoundaryCryptoOptions {
  readonly env: SecretCryptoEnvLike;
}

/**
 * Selects a {@link SecretBoundaryCrypto} implementation given the boot
 * environment. Behavior:
 *
 *  - Production / staging require at least a global passphrase via
 *    {@link SECRET_STORE_KEY_ENV_KEYS}. Optional partition overrides are an
 *    explicit JSON map in {@link SECRET_STORE_PARTITION_KEYS_ENV}; the core
 *    never guesses provider names or provider-specific environment variables.
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
    return PartitionedSecretBoundaryCrypto.fromEnv(env, globalPassphrase);
  }
  const environment = normalizeEnvironment(
    env.TAKOSUMI_ENVIRONMENT ?? env.NODE_ENV ?? env.ENVIRONMENT,
  );
  if (PRODUCTION_LIKE_ENVIRONMENTS.has(environment)) {
    throw new SecretEncryptionConfigurationError(
      `secret-store encryption key missing in ${environment}: ` +
        `set one of ${SECRET_STORE_KEY_ENV_KEYS.join(", ")} ` +
        `to a 32+ byte high-entropy passphrase ` +
        `(optional partition overrides use ${SECRET_STORE_PARTITION_KEYS_ENV}). ` +
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

function parsePartitionPassphrasesEnv(
  env: SecretCryptoEnvLike,
): Readonly<Record<SecretPartition, string>> {
  const raw = env[SECRET_STORE_PARTITION_KEYS_ENV];
  if (raw === undefined || raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SecretEncryptionConfigurationError(
      `${SECRET_STORE_PARTITION_KEYS_ENV} must be a JSON object of ` +
        `{"partition":"32+ byte passphrase"}`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SecretEncryptionConfigurationError(
      `${SECRET_STORE_PARTITION_KEYS_ENV} must be a JSON object`,
    );
  }
  const result: Record<SecretPartition, string> = {};
  for (const [partition, passphrase] of Object.entries(parsed)) {
    if (!isSecretPartition(partition) || typeof passphrase !== "string") {
      throw new SecretEncryptionConfigurationError(
        `${SECRET_STORE_PARTITION_KEYS_ENV} contains an invalid partition or passphrase`,
      );
    }
    result[partition] = passphrase;
  }
  return result;
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
  readonly secretPartition: SecretPartition;
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
    this.#versionRetention =
      options.versionRetention ?? DEFAULT_VERSION_RETENTION;
  }

  async putSecret(input: {
    readonly name: string;
    readonly value: string;
    readonly metadata?: Record<string, unknown>;
    readonly secretPartition?: SecretPartition;
    readonly rotationPolicy?: SecretRotationPolicy;
  }): Promise<SecretRecord> {
    const partition: SecretPartition = input.secretPartition ?? "global";
    if (!isSecretPartition(partition)) {
      throw new Error(`invalid secret partition: ${partition}`);
    }
    const version = `secret_version_${this.#idGenerator()}`;
    const record: StoredSecret = {
      name: input.name,
      version,
      secretPartition: partition,
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
      record.secretPartition,
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
    readonly secretPartition?: SecretPartition;
    readonly name?: string;
  }): Promise<readonly SecretRecord[]> {
    const records = [...this.#records.values()].filter((record) => {
      if (
        filter?.secretPartition &&
        record.secretPartition !== filter.secretPartition
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
      const state: SecretRotationStatus["state"] =
        now.getTime() >= expiresAt.getTime()
          ? "expired"
          : now.getTime() >= dueAt.getTime()
            ? "due"
            : "active";
      results.push({
        name: record.name,
        version: record.version,
        secretPartition: record.secretPartition,
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

  seal(
    plaintext: string,
    secretPartition: SecretPartition,
    aad?: Uint8Array,
  ): Promise<Uint8Array> {
    // The placeholder mirrors the AES-GCM impl's binding by tagging the
    // partition and the canonical aad context (base64 of the hex digest, so
    // `|` can never appear inside it) into the payload prefix.
    const payload = `${secretPartition}|${aadTag(aad)}|${plaintext}`;
    return Promise.resolve(
      new TextEncoder().encode(`${this.#prefix}${btoa(payload)}`),
    );
  }

  // `async` so a partition / aad mismatch surfaces as a rejected promise
  // (matching the AES-GCM impl's contract) rather than a synchronous throw.
  open(
    ciphertext: Uint8Array,
    secretPartition: SecretPartition,
    aad?: Uint8Array,
  ): Promise<string> {
    return Promise.resolve().then(() => {
      const encoded = new TextDecoder().decode(ciphertext);
      if (!encoded.startsWith(this.#prefix)) {
        throw new Error("invalid placeholder secret payload");
      }
      const payload = atob(encoded.slice(this.#prefix.length));
      const sep = payload.indexOf("|");
      if (sep === -1) {
        throw new Error(
          "invalid placeholder secret payload (missing partition)",
        );
      }
      const sealedPartition = payload.slice(0, sep);
      if (sealedPartition !== secretPartition) {
        throw new Error(
          `placeholder secret partition mismatch: sealed=${sealedPartition} requested=${secretPartition}`,
        );
      }
      const rest = payload.slice(sep + 1);
      const aadSep = rest.indexOf("|");
      if (aadSep === -1) {
        throw new Error("invalid placeholder secret payload (missing aad)");
      }
      const sealedAad = rest.slice(0, aadSep);
      if (sealedAad !== aadTag(aad)) {
        throw new Error("placeholder secret aad mismatch");
      }
      return rest.slice(aadSep + 1);
    });
  }
}

/** Stable, separator-free tag for the optional canonical aad context. */
function aadTag(aad: Uint8Array | undefined): string {
  if (aad === undefined || aad.length === 0) return "-";
  let binary = "";
  for (const byte of aad) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * AES-GCM crypto that derives an independent key per opaque secret partition.
 *
 * Construction takes a map `partition -> passphrase`. The `global`
 * partition's passphrase MUST be supplied; partitions without an explicit
 * override fall back to the global passphrase mixed with the partition
 * label (HKDF-style salt) so that a leaked global passphrase cannot
 * be reused as-is to open another partition's ciphertext that was sealed with a
 * different override key (Phase 18.2 H14).
 *
 * Authentication is reinforced by binding the partition label into the
 * AES-GCM additional authenticated data (AAD), so swapping the
 * partition tag of a sealed payload causes `open` to fail.
 */
export class PartitionedSecretBoundaryCrypto implements SecretBoundaryCrypto {
  readonly #passphrases: Map<SecretPartition, string>;
  readonly #keyPromises = new Map<SecretPartition, Promise<CryptoKey>>();
  readonly #fallbackPassphrase: string;

  constructor(options: {
    readonly globalPassphrase: string;
    readonly perPartitionPassphrases?: Readonly<Record<SecretPartition, string>>;
  }) {
    if (!options.globalPassphrase || options.globalPassphrase.trim() === "") {
      throw new SecretEncryptionConfigurationError(
        "PartitionedSecretBoundaryCrypto requires a non-empty globalPassphrase",
      );
    }
    guardPassphraseLength(options.globalPassphrase, "globalPassphrase");
    this.#fallbackPassphrase = options.globalPassphrase;
    this.#passphrases = new Map();
    for (const [partition, override] of Object.entries(
      options.perPartitionPassphrases ?? {},
    )) {
      if (!isSecretPartition(partition) || !override || override.trim() === "") {
        continue;
      }
      guardPassphraseLength(override, `perPartitionPassphrases.${partition}`);
      this.#passphrases.set(partition, override);
    }
  }

  static fromEnv(
    env: SecretCryptoEnvLike,
    globalPassphrase: string,
  ): PartitionedSecretBoundaryCrypto {
    const perPartitionPassphrases = parsePartitionPassphrasesEnv(env);
    return new PartitionedSecretBoundaryCrypto({
      globalPassphrase,
      perPartitionPassphrases,
    });
  }

  #derivePartitionPassphrase(partition: SecretPartition): string {
    // Keep the v1 derivation label byte-identical so existing ciphertext remains
    // readable; "cloud" here is a historical crypto wire label, not a provider
    // registry or an active partition taxonomy.
    return `${this.#fallbackPassphrase}|takos.cloud.partition=${partition}`;
  }

  async seal(
    plaintext: string,
    secretPartition: SecretPartition,
    aad?: Uint8Array,
  ): Promise<Uint8Array> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const additionalData = additionalDataFor(secretPartition, aad);
    const encrypted = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: toArrayBuffer(additionalData) },
        await this.#key(secretPartition),
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
    secretPartition: SecretPartition,
    aad?: Uint8Array,
  ): Promise<string> {
    const iv = ciphertext.slice(0, 12);
    const payload = ciphertext.slice(12);
    const additionalData = additionalDataFor(secretPartition, aad);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: toArrayBuffer(additionalData) },
      await this.#key(secretPartition),
      toArrayBuffer(payload),
    );
    return new TextDecoder().decode(plaintext);
  }

  /**
   * Stable fingerprint of the active passphrase for `partition`, so a rotation
   * (global or a per-partition override) is detectable in recorded blobs. The fold
   * is one-way and the digest is truncated to a positive 31-bit integer, so the
   * passphrase is never recoverable from the version tag.
   */
  keyVersion(secretPartition: SecretPartition): number {
    return passphraseFingerprint(this.#passphrase(secretPartition));
  }

  #key(partition: SecretPartition): Promise<CryptoKey> {
    let promise = this.#keyPromises.get(partition);
    if (!promise) {
      promise = deriveAesKey(this.#passphrase(partition));
      this.#keyPromises.set(partition, promise);
    }
    return promise;
  }

  #passphrase(partition: SecretPartition): string {
    if (!isSecretPartition(partition)) {
      throw new Error(`invalid secret partition: ${partition}`);
    }
    const configured = this.#passphrases.get(partition);
    if (configured) return configured;
    const derived = this.#derivePartitionPassphrase(partition);
    this.#passphrases.set(partition, derived);
    return derived;
  }
}

/**
 * Fails closed when a supplied passphrase is shorter than
 * {@link MIN_SECRET_STORE_PASSPHRASE_BYTES} UTF-8 bytes, so a weak key is
 * rejected at construction rather than producing an under-entropy AES key.
 */
function guardPassphraseLength(passphrase: string, label: string): void {
  const byteLength = new TextEncoder().encode(passphrase).length;
  if (byteLength < MIN_SECRET_STORE_PASSPHRASE_BYTES) {
    throw new SecretEncryptionConfigurationError(
      `secret-store ${label} is too short: ${byteLength} bytes ` +
        `(need >= ${MIN_SECRET_STORE_PASSPHRASE_BYTES}). Use a 32+ byte ` +
        `high-entropy passphrase. Refusing to derive an under-entropy key.`,
    );
  }
}

/**
 * One-way FNV-1a fold of a passphrase into a positive 31-bit integer used as a
 * rotation-detection key-version tag. It is NOT a key and NOT reversible; it
 * exists only so a recorded version changes when the passphrase rotates.
 */
function passphraseFingerprint(passphrase: string): number {
  const bytes = new TextEncoder().encode(passphrase);
  let hash = 0x811c9dc5; // FNV offset basis
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193); // FNV prime
  }
  // Mask to a positive 31-bit integer (stays in JS safe-integer / DB int range).
  return (hash >>> 0) & 0x7fffffff;
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

/**
 * Builds the AES-GCM additional-authenticated-data: the partition label plus
 * the optional canonical aad context.
 *
 * When no `aad` is supplied the additionalData is the bare partition label
 * (byte-identical to the pre-aad scheme, so callers that never bind a context —
 * e.g. at-rest state/plan artifacts — round-trip unchanged). When an `aad` is
 * supplied the label is length-framed (4-byte big-endian prefix) before the
 * aad bytes, so a partition / aad boundary can never be shifted by an attacker:
 * `(partitionA, aadB)` cannot collide with `(partitionA||aadB, undefined)`.
 */
function additionalDataFor(
  secretPartition: SecretPartition,
  aad: Uint8Array | undefined,
): Uint8Array {
  // Historical v1 AAD wire label. Changing it would make existing ciphertext
  // unreadable; active APIs still expose only the generic SecretPartition.
  const label = new TextEncoder().encode(`takos.cloud:${secretPartition}`);
  if (aad === undefined || aad.length === 0) return label;
  const out = new Uint8Array(4 + label.length + aad.length);
  new DataView(out.buffer).setUint32(0, label.length);
  out.set(label, 4);
  out.set(aad, 4 + label.length);
  return out;
}

function key(ref: SecretVersionRef): string {
  return `${ref.name}\0${ref.version}`;
}

function publicRecord(record: StoredSecret): SecretRecord {
  return Object.freeze(
    structuredClone({
      name: record.name,
      version: record.version,
      secretPartition: record.secretPartition,
      createdAt: record.createdAt,
      metadata: record.metadata,
      rotationPolicy: record.rotationPolicy,
      lastAccessedAt: record.mutableLastAccessedAt,
    }),
  );
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}
