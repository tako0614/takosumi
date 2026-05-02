import type {
  CustomDomainReservation,
  CustomDomainReservationOwner,
  CustomDomainReservationStatus,
} from "./types.ts";

/**
 * Persistence port for {@link CustomDomainReservation} rows.
 *
 * Production implementations are backed by the
 * `custom_domain_reservations` Postgres table created in migration
 * `<timestamp>_custom_domain_reservations.sql`. The `hostname` column is the
 * primary key / unique constraint; `claim()` MUST be atomic so that two
 * concurrent provider materializations cannot both insert the same hostname.
 */
export interface CustomDomainReservationStore {
  /**
   * Atomically insert a new pending reservation, returning the existing
   * reservation when the hostname is already taken (regardless of owner).
   *
   * The caller compares the returned record's owner against the requested
   * owner to decide whether to proceed (idempotent re-claim) or reject the
   * request (cross-tenant collision).
   */
  claim(input: {
    readonly hostname: string;
    readonly owner: CustomDomainReservationOwner;
    readonly status: CustomDomainReservationStatus;
    readonly reservedAt: string;
  }): Promise<CustomDomainReservation>;

  /**
   * Update an existing reservation's status (typically `pending` →
   * `verified`). Returns `undefined` when no reservation exists for the
   * hostname.
   */
  updateStatus(input: {
    readonly hostname: string;
    readonly status: CustomDomainReservationStatus;
    readonly updatedAt: string;
  }): Promise<CustomDomainReservation | undefined>;

  release(
    hostname: string,
    releasedAt: string,
  ): Promise<CustomDomainReservation | undefined>;

  get(hostname: string): Promise<CustomDomainReservation | undefined>;

  listByOwner(
    tenantId: string,
    groupId?: string,
  ): Promise<readonly CustomDomainReservation[]>;
}

/**
 * In-memory implementation suitable for unit tests and the kernel's
 * single-process bootstrap. Production deployments swap this for a
 * Postgres-backed implementation that uses the `hostname` unique constraint
 * for atomic claim semantics.
 */
export class InMemoryCustomDomainReservationStore
  implements CustomDomainReservationStore {
  readonly #records = new Map<string, CustomDomainReservation>();

  claim(input: {
    readonly hostname: string;
    readonly owner: CustomDomainReservationOwner;
    readonly status: CustomDomainReservationStatus;
    readonly reservedAt: string;
  }): Promise<CustomDomainReservation> {
    const key = canonicalHostname(input.hostname);
    const existing = this.#records.get(key);
    if (existing && existing.status !== "released") {
      return Promise.resolve(existing);
    }
    const record: CustomDomainReservation = Object.freeze({
      hostname: key,
      owner: Object.freeze({ ...input.owner }),
      status: input.status,
      reservedAt: input.reservedAt,
      updatedAt: input.reservedAt,
    });
    this.#records.set(key, record);
    return Promise.resolve(record);
  }

  updateStatus(input: {
    readonly hostname: string;
    readonly status: CustomDomainReservationStatus;
    readonly updatedAt: string;
  }): Promise<CustomDomainReservation | undefined> {
    const key = canonicalHostname(input.hostname);
    const existing = this.#records.get(key);
    if (!existing) return Promise.resolve(undefined);
    const next: CustomDomainReservation = Object.freeze({
      ...existing,
      status: input.status,
      updatedAt: input.updatedAt,
    });
    this.#records.set(key, next);
    return Promise.resolve(next);
  }

  release(
    hostname: string,
    releasedAt: string,
  ): Promise<CustomDomainReservation | undefined> {
    const key = canonicalHostname(hostname);
    const existing = this.#records.get(key);
    if (!existing) return Promise.resolve(undefined);
    const released: CustomDomainReservation = Object.freeze({
      ...existing,
      status: "released" as const,
      updatedAt: releasedAt,
    });
    this.#records.set(key, released);
    return Promise.resolve(released);
  }

  get(hostname: string): Promise<CustomDomainReservation | undefined> {
    return Promise.resolve(this.#records.get(canonicalHostname(hostname)));
  }

  listByOwner(
    tenantId: string,
    groupId?: string,
  ): Promise<readonly CustomDomainReservation[]> {
    return Promise.resolve(
      [...this.#records.values()].filter((record) => {
        if (record.owner.tenantId !== tenantId) return false;
        if (groupId !== undefined && record.owner.groupId !== groupId) {
          return false;
        }
        return true;
      }),
    );
  }
}

/**
 * Hostnames are case-insensitive and routinely surface with trailing dots.
 * Normalize before comparing / storing so `Api.Example.com` and
 * `api.example.com.` share the same reservation key.
 */
export function canonicalHostname(hostname: string): string {
  const trimmed = hostname.trim().toLowerCase();
  if (trimmed.endsWith(".")) return trimmed.slice(0, -1);
  return trimmed;
}
