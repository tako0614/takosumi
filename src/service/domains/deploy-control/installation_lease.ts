/**
 * Installation lease seam (core-spec.md §22 / §23).
 *
 * One WRITE run (plan / apply / destroy_plan / destroy_apply) may execute per
 * (Installation, environment) at a time. The lease is keyed
 * `installation:{installationId}:{environment}` and is acquired by the queue
 * consumer before it dispatches a write run, then released in a `finally`.
 * `source_sync` runs do NOT take the lease.
 *
 * The Workers implementation fronts the `COORDINATION` Durable Object
 * (`acquire-lease` / `release-lease`); the in-memory implementation here is for
 * tests and non-DO substrates. Both share the same narrow seam so the consumer
 * is agnostic to the substrate.
 */

/** The lease key for an installation write run. */
export function installationLeaseScope(
  installationId: string,
  environment: string,
): string {
  return `installation:${installationId}:${environment}`;
}

/** An acquired lease handle. `acquired=false` means the lease was busy. */
export interface InstallationLease {
  readonly scope: string;
  readonly holderId: string;
  readonly token: string;
  readonly acquired: boolean;
  readonly expiresAt: string;
}

export interface AcquireInstallationLeaseInput {
  readonly scope: string;
  readonly holderId: string;
  readonly ttlMs: number;
}

export interface ReleaseInstallationLeaseInput {
  readonly scope: string;
  readonly holderId: string;
  readonly token: string;
}

/**
 * Narrow coordination seam the consumer depends on. Mirrors the
 * CoordinationObject's `acquire-lease` / `release-lease` POST API but is
 * substrate-agnostic so tests can inject an in-memory impl.
 */
export interface InstallationCoordination {
  acquireLease(
    input: AcquireInstallationLeaseInput,
  ): Promise<InstallationLease>;
  releaseLease(
    input: ReleaseInstallationLeaseInput,
  ): Promise<boolean>;
}

/**
 * Raised when an installation write run cannot acquire the lease because
 * another write run for the same (installation, environment) holds it. The
 * consumer should rethrow this so the queue redelivers the message (the lease
 * holder releases on completion).
 */
export class InstallationLeaseBusyError extends Error {
  readonly scope: string;
  constructor(scope: string) {
    super(`installation lease busy: ${scope}`);
    this.name = "InstallationLeaseBusyError";
    this.scope = scope;
  }
}

/** Default lease TTL: long enough to cover a slow runner dispatch. */
export const DEFAULT_INSTALLATION_LEASE_TTL_MS = 15 * 60 * 1000;

/**
 * Acquires the installation lease, runs `work`, and releases in `finally`.
 * Throws {@link InstallationLeaseBusyError} when the lease is held by another
 * holder (the run is left for redelivery). Returns the `work` result on
 * success.
 */
export async function withInstallationLease<T>(
  coordination: InstallationCoordination,
  input: {
    readonly installationId: string;
    readonly environment: string;
    readonly holderId: string;
    readonly ttlMs?: number;
  },
  work: () => Promise<T>,
): Promise<T> {
  const scope = installationLeaseScope(input.installationId, input.environment);
  const lease = await coordination.acquireLease({
    scope,
    holderId: input.holderId,
    ttlMs: input.ttlMs ?? DEFAULT_INSTALLATION_LEASE_TTL_MS,
  });
  if (!lease.acquired) {
    throw new InstallationLeaseBusyError(scope);
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
 * In-memory {@link InstallationCoordination} for tests / single-process
 * substrates. Mirrors the CoordinationObject semantics: a non-expired lease held
 * by another holder cannot be re-acquired; the holder's own re-acquire returns
 * `acquired=false` too (one holder, one run). Release is holder+token gated.
 */
export class InMemoryInstallationCoordination implements InstallationCoordination {
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
    input: AcquireInstallationLeaseInput,
  ): Promise<InstallationLease> {
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

  releaseLease(input: ReleaseInstallationLeaseInput): Promise<boolean> {
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
