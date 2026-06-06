/**
 * Environment lease seam (Core Specification §10.2).
 *
 * One WRITE run (plan / apply / destroy_plan / destroy_apply) may execute per
 * Environment at a time. The lease is keyed `environment:{environmentId}` and is
 * acquired by the queue consumer before it dispatches a write run, then released
 * in a `finally`. `source_sync` runs do NOT take the lease.
 *
 * The Workers implementation fronts the `TAKOS_COORDINATION` Durable Object
 * (`acquire-lease` / `release-lease`); the in-memory implementation here is for
 * tests and non-DO substrates. Both share the same narrow seam so the consumer
 * is agnostic to the substrate.
 */

/** The lease key for an environment write run. */
export function environmentLeaseScope(environmentId: string): string {
  return `environment:${environmentId}`;
}

/** An acquired lease handle. `acquired=false` means the lease was busy. */
export interface EnvironmentLease {
  readonly scope: string;
  readonly holderId: string;
  readonly token: string;
  readonly acquired: boolean;
  readonly expiresAt: string;
}

export interface AcquireEnvironmentLeaseInput {
  readonly scope: string;
  readonly holderId: string;
  readonly ttlMs: number;
}

export interface ReleaseEnvironmentLeaseInput {
  readonly scope: string;
  readonly holderId: string;
  readonly token: string;
}

/**
 * Narrow coordination seam the consumer depends on. Mirrors the
 * CoordinationObject's `acquire-lease` / `release-lease` POST API but is
 * substrate-agnostic so tests can inject an in-memory impl.
 */
export interface EnvironmentCoordination {
  acquireLease(
    input: AcquireEnvironmentLeaseInput,
  ): Promise<EnvironmentLease>;
  releaseLease(
    input: ReleaseEnvironmentLeaseInput,
  ): Promise<boolean>;
}

/**
 * Raised when an environment write run cannot acquire the lease because another
 * write run for the same environment holds it. The consumer should rethrow this
 * so the queue redelivers the message (the lease holder releases on completion).
 */
export class EnvironmentLeaseBusyError extends Error {
  readonly scope: string;
  constructor(scope: string) {
    super(`environment lease busy: ${scope}`);
    this.name = "EnvironmentLeaseBusyError";
    this.scope = scope;
  }
}

/** Default lease TTL: long enough to cover a slow runner dispatch. */
export const DEFAULT_ENVIRONMENT_LEASE_TTL_MS = 15 * 60 * 1000;

/**
 * Acquires the environment lease, runs `work`, and releases in `finally`. Throws
 * {@link EnvironmentLeaseBusyError} when the lease is held by another holder
 * (the run is left for redelivery). Returns the `work` result on success.
 */
export async function withEnvironmentLease<T>(
  coordination: EnvironmentCoordination,
  input: {
    readonly environmentId: string;
    readonly holderId: string;
    readonly ttlMs?: number;
  },
  work: () => Promise<T>,
): Promise<T> {
  const scope = environmentLeaseScope(input.environmentId);
  const lease = await coordination.acquireLease({
    scope,
    holderId: input.holderId,
    ttlMs: input.ttlMs ?? DEFAULT_ENVIRONMENT_LEASE_TTL_MS,
  });
  if (!lease.acquired) {
    throw new EnvironmentLeaseBusyError(scope);
  }
  try {
    return await work();
  } finally {
    await coordination.releaseLease({
      scope,
      holderId: input.holderId,
      token: lease.token,
    });
  }
}

interface StoredLease {
  readonly holderId: string;
  readonly token: string;
  readonly expiresAt: number;
}

/**
 * In-memory {@link EnvironmentCoordination} for tests / single-process
 * substrates. Mirrors the CoordinationObject semantics: a non-expired lease held
 * by another holder cannot be re-acquired; the holder's own re-acquire returns
 * `acquired=false` too (one holder, one run). Release is holder+token gated.
 */
export class InMemoryEnvironmentCoordination implements EnvironmentCoordination {
  readonly #leases = new Map<string, StoredLease>();
  readonly #now: () => number;
  readonly #newToken: () => string;

  constructor(deps: {
    readonly now?: () => number;
    readonly newToken?: () => string;
  } = {}) {
    this.#now = deps.now ?? (() => Date.now());
    this.#newToken = deps.newToken ?? (() => crypto.randomUUID());
  }

  acquireLease(
    input: AcquireEnvironmentLeaseInput,
  ): Promise<EnvironmentLease> {
    const now = this.#now();
    const existing = this.#leases.get(input.scope);
    if (existing && existing.expiresAt > now) {
      return Promise.resolve({
        scope: input.scope,
        holderId: existing.holderId,
        token: existing.token,
        acquired: false,
        expiresAt: new Date(existing.expiresAt).toISOString(),
      });
    }
    const token = this.#newToken();
    const expiresAt = now + input.ttlMs;
    this.#leases.set(input.scope, {
      holderId: input.holderId,
      token,
      expiresAt,
    });
    return Promise.resolve({
      scope: input.scope,
      holderId: input.holderId,
      token,
      acquired: true,
      expiresAt: new Date(expiresAt).toISOString(),
    });
  }

  releaseLease(input: ReleaseEnvironmentLeaseInput): Promise<boolean> {
    const existing = this.#leases.get(input.scope);
    if (
      !existing ||
      existing.holderId !== input.holderId ||
      existing.token !== input.token
    ) {
      return Promise.resolve(false);
    }
    this.#leases.delete(input.scope);
    return Promise.resolve(true);
  }
}
