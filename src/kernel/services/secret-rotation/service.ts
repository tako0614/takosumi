import type {
  CloudPartition,
  SecretRecord,
  SecretRotationPolicy,
  SecretStorePort,
} from "../../adapters/secret-store/types.ts";
import type {
  MemoryEncryptedSecretStore,
  SecretGcReport,
  SecretRotationStatus,
} from "../../adapters/secret-store/memory.ts";
import type { ObservabilitySink } from "../observability/mod.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Reason emitted in rotation notifications. Mirrors {@link SecretRotationStatus.state}
 * but excludes the no-op `active` case.
 */
export type RotationNoticeReason = "due" | "expired";

export interface RotationNotice {
  readonly name: string;
  readonly version: string;
  readonly cloudPartition: CloudPartition;
  readonly reason: RotationNoticeReason;
  readonly dueAt: string;
  readonly expiresAt: string;
}

export interface RotationCheckReport {
  readonly checkedAt: string;
  readonly notices: readonly RotationNotice[];
  readonly gc?: SecretGcReport;
}

export interface RotateSecretInput {
  readonly name: string;
  readonly newValue: string;
  readonly cloudPartition?: CloudPartition;
  /** Reason recorded in the audit log (e.g. "scheduled", "compromise"). */
  readonly reason?: string;
  /** Optional override for the rotation policy of the new version. */
  readonly rotationPolicy?: SecretRotationPolicy;
  /** Actor identifier to attribute the rotation to in audit logs. */
  readonly actor?: string;
}

export interface RotateSecretOutput {
  readonly previous?: SecretRecord;
  readonly current: SecretRecord;
}

export interface SecretRotationServiceOptions {
  readonly store: SecretStorePort & {
    readonly rotationStatus?: () => SecretRotationStatus[];
    readonly runVersionGc?: () => SecretGcReport;
  };
  readonly clock?: () => Date;
  readonly observability?: ObservabilitySink;
  /**
   * Default rotation policy applied to secrets created via
   * {@link rotateSecret} that do not specify a policy.
   */
  readonly defaultPolicy?: SecretRotationPolicy;
}

/**
 * Phase 18.2 H15 — secret rotation policy + version GC.
 *
 * Provides three operator-facing entry points:
 *
 *  - `checkRotation()`: scan the store for rotation_policy expiry and emit
 *    operator notifications + audit events.
 *  - `runGc()`: trigger version GC on the underlying store.
 *  - `rotateSecret()`: write a new secret version, recording an audit log.
 */
export class SecretRotationService {
  readonly #store: SecretRotationServiceOptions["store"];
  readonly #clock: () => Date;
  readonly #observability: ObservabilitySink | undefined;
  readonly #defaultPolicy: SecretRotationPolicy | undefined;

  constructor(options: SecretRotationServiceOptions) {
    this.#store = options.store;
    this.#clock = options.clock ?? (() => new Date());
    this.#observability = options.observability;
    this.#defaultPolicy = options.defaultPolicy;
  }

  /**
   * Inspect every secret in the store for rotation policy expiry. Records
   * a structured audit event per due / expired version and returns the
   * set of notifications that operators should surface.
   *
   * Optionally runs the underlying store's version GC sweep when
   * `withGc=true`.
   */
  async checkRotation(
    options: { readonly withGc?: boolean } = {},
  ): Promise<RotationCheckReport> {
    const checkedAt = this.#clock().toISOString();
    const status = await this.#statusOrFallback();
    const notices: RotationNotice[] = [];
    for (const item of status) {
      if (item.state === "active") continue;
      notices.push({
        name: item.name,
        version: item.version,
        cloudPartition: item.cloudPartition,
        reason: item.state,
        dueAt: item.dueAt,
        expiresAt: item.expiresAt,
      });
      if (this.#observability) {
        await this.#observability.appendAudit({
          id: `audit_${cryptoUuid()}`,
          eventClass: "security",
          type: "secret.rotation.notice",
          severity: item.state === "expired" ? "critical" : "warning",
          targetType: "Secret",
          targetId: `${item.name}@${item.version}`,
          payload: {
            name: item.name,
            version: item.version,
            cloudPartition: item.cloudPartition,
            reason: item.state,
            dueAt: item.dueAt,
            expiresAt: item.expiresAt,
          },
          occurredAt: checkedAt,
        });
      }
    }
    let gc: SecretGcReport | undefined;
    if (options.withGc && this.#store.runVersionGc) {
      gc = this.#store.runVersionGc();
      if (this.#observability && gc.deleted.length > 0) {
        await this.#observability.appendAudit({
          id: `audit_${cryptoUuid()}`,
          eventClass: "compliance",
          type: "secret.version.gc",
          severity: "info",
          targetType: "Secret",
          payload: {
            evaluated: gc.evaluated,
            retained: gc.retained,
            deleted: gc.deleted.map((ref) => `${ref.name}@${ref.version}`),
          },
          occurredAt: checkedAt,
        });
      }
    }
    return Object.freeze({
      checkedAt,
      notices: Object.freeze(notices),
      gc,
    });
  }

  /**
   * Issue a rotated secret version. The previous latest record is returned
   * (for caller-side cleanup), and a `secret.rotation.executed` audit event
   * is emitted.
   *
   * The new version inherits the partition / policy from the explicit
   * input; when no policy is given the service-wide default is applied.
   */
  async rotateSecret(input: RotateSecretInput): Promise<RotateSecretOutput> {
    const previous = await this.#store.latestSecret(input.name);
    const partition: CloudPartition = input.cloudPartition ??
      previous?.cloudPartition ?? "global";
    const policy = input.rotationPolicy ??
      previous?.rotationPolicy ??
      this.#defaultPolicy;
    const current = await this.#store.putSecret({
      name: input.name,
      value: input.newValue,
      cloudPartition: partition,
      rotationPolicy: policy,
      metadata: {
        rotatedAt: this.#clock().toISOString(),
        rotatedFromVersion: previous?.version,
        rotationReason: input.reason,
      },
    });
    if (this.#observability) {
      await this.#observability.appendAudit({
        id: `audit_${cryptoUuid()}`,
        eventClass: "security",
        type: "secret.rotation.executed",
        severity: "info",
        actor: input.actor
          ? {
            actorAccountId: input.actor,
            roles: [],
            requestId: `secret-rotation-${cryptoUuid()}`,
            principalKind: "system",
          }
          : undefined,
        targetType: "Secret",
        targetId: `${current.name}@${current.version}`,
        payload: {
          name: current.name,
          newVersion: current.version,
          ...(previous ? { previousVersion: previous.version } : {}),
          cloudPartition: partition,
          reason: input.reason ?? "manual",
        },
        occurredAt: this.#clock().toISOString(),
      });
    }
    return Object.freeze({ previous, current });
  }

  runGc(): SecretGcReport | undefined {
    if (!this.#store.runVersionGc) return undefined;
    return this.#store.runVersionGc();
  }

  async #statusOrFallback(): Promise<readonly SecretRotationStatus[]> {
    if (this.#store.rotationStatus) {
      return this.#store.rotationStatus();
    }
    // Fallback: derive status from listSecrets() metadata for adapters
    // that don't expose a rotation index directly.
    const records = await this.#store.listSecrets();
    const now = this.#clock().getTime();
    const out: SecretRotationStatus[] = [];
    for (const record of records) {
      const policy = record.rotationPolicy;
      if (!policy) continue;
      const created = new Date(record.createdAt).getTime();
      const dueAt = new Date(created + policy.intervalDays * DAY_MS);
      const expiresAt = new Date(
        created + (policy.intervalDays + policy.gracePeriodDays) * DAY_MS,
      );
      const state: SecretRotationStatus["state"] = now >= expiresAt.getTime()
        ? "expired"
        : now >= dueAt.getTime()
        ? "due"
        : "active";
      out.push({
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
    return out;
  }
}

function cryptoUuid(): string {
  // Generate a cryptographically random UUID. The kernel targets modern
  // Deno / Node runtimes where `crypto.randomUUID` is always defined; fall
  // back to a manual v4 UUID built from `crypto.getRandomValues` (still
  // cryptographically random) just in case a host has stripped randomUUID
  // off the global. Never fall back to Math.random — that would silently
  // downgrade audit-event / request IDs to a non-cryptographic source.
  const g = (globalThis as { crypto?: Crypto }).crypto;
  if (g && typeof g.randomUUID === "function") {
    return g.randomUUID();
  }
  if (g && typeof g.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    g.getRandomValues(bytes);
    // Set version (4) and variant (RFC 4122) bits.
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex: string[] = [];
    for (const b of bytes) hex.push(b.toString(16).padStart(2, "0"));
    return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${
      hex.slice(6, 8).join("")
    }-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
  }
  throw new Error(
    "cryptoUuid: no Web Crypto available; refusing to downgrade to Math.random",
  );
}

// Re-export downstream type aliases for convenience.
export type { SecretGcReport, SecretRotationStatus };

/**
 * Convenience helper for binding a memory-backed store. Centralises the
 * shape narrowing so callers can pass a `MemoryEncryptedSecretStore`
 * directly without upcasting.
 */
export function bindMemoryStore(
  store: MemoryEncryptedSecretStore,
): SecretRotationServiceOptions["store"] {
  return store;
}
