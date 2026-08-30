/**
 * Capsule lease seam (core-spec.md §22 / §23).
 *
 * One WRITE run (plan / apply / destroy_plan / destroy_apply) may execute per
 * (Capsule, environment) at a time. The lease is keyed
 * `capsule:{capsuleId}:{environment}` and is acquired by the queue
 * consumer before it dispatches a write run, then released in a `finally`.
 * `source_sync` runs do NOT take the lease.
 *
 * The Workers implementation fronts the `COORDINATION` Durable Object
 * (`acquire-lease` / `release-lease`); the in-memory implementation here is for
 * tests and non-DO substrates. Both share the same narrow seam so the consumer
 * is agnostic to the substrate.
 */

/** The lease key for a Capsule write run. */
export function capsuleLeaseScope(
  capsuleId: string,
  environment: string,
): string {
  return `capsule:${capsuleId}:${environment}`;
}

/**
 * The lease key for a `create` plan apply. A `create` plan carries NO
 * capsuleId yet, so the `capsule:{id}:{env}` lease cannot cover it;
 * two concurrent create-applies would otherwise each allocate a brand-new
 * Capsule + StateVersion (apply-once / S5). The apply consumer takes this
 * `plan:{planRunId}` lease around the create-apply critical section instead.
 */
export function planLeaseScope(planRunId: string): string {
  return `plan:${planRunId}`;
}

/**
 * The lease key for a Workspace's dependency-graph mutation. Dependency creation is
 * a check-then-write (`list edges → detectCycle → put edge`) over the Workspace's
 * existing edges, so two concurrent creates of the inverse edges (A→B and B→A)
 * could each see an acyclic graph and both persist, wedging the DAG with a
 * cycle. This `workspace-graph:{workspaceId}` lease serializes the critical section per
 * Workspace so at most one of the racing edges is committed.
 */
export function workspaceLeaseScope(workspaceId: string): string {
  return `workspace-graph:${workspaceId}`;
}

/** An acquired lease handle. `acquired=false` means the lease was busy. */
export interface CapsuleLease {
  readonly scope: string;
  readonly holderId: string;
  readonly token: string;
  /** One successful acquisition/join within this lease generation. */
  readonly referenceId?: string;
  readonly acquired: boolean;
  readonly expiresAt: string;
}

export interface AcquireCapsuleLeaseInput {
  readonly scope: string;
  readonly holderId: string;
  readonly ttlMs: number;
  /**
   * Allows another acquisition of the same explicitly joinable logical
   * operation. Both the existing lease and this request must opt in.
   */
  readonly joinExistingHolder?: boolean;
}

export interface ReleaseCapsuleLeaseInput {
  readonly scope: string;
  readonly holderId: string;
  readonly token: string;
  /** Idempotent member release for a joinable lease generation. */
  readonly referenceId?: string;
}

export interface RenewCapsuleLeaseInput {
  readonly scope: string;
  readonly holderId: string;
  readonly token: string;
  /** Active member identity for a reference-tracked generation. */
  readonly referenceId?: string;
  readonly ttlMs: number;
}

/**
 * Narrow coordination seam the consumer depends on. Mirrors the
 * CoordinationObject's `acquire-lease` / `renew-lease` / `release-lease` POST
 * API but is substrate-agnostic so tests can inject an in-memory impl.
 */
export interface CapsuleCoordination {
  acquireLease(
    input: AcquireCapsuleLeaseInput,
  ): Promise<CapsuleLease>;
  /**
   * Extends a HELD lease's expiry (holder + token gated) so a long-running write
   * run keeps the lease alive past its initial TTL. Returns the renewed lease,
   * or `acquired=false` when the lease is no longer held by this holder+token
   * (e.g. it already expired and was taken over). Renewal NEVER acquires a fresh
   * lease — a non-held renew fails closed so the work fn can observe it was
   * fenced out.
   */
  renewLease(
    input: RenewCapsuleLeaseInput,
  ): Promise<CapsuleLease>;
  releaseLease(
    input: ReleaseCapsuleLeaseInput,
  ): Promise<boolean>;
}

/**
 * Raised when a Capsule write run cannot acquire the lease because
 * another write run for the same (Capsule, environment) holds it. The
 * consumer should rethrow this so the queue redelivers the message (the lease
 * holder releases on completion).
 */
export class CapsuleLeaseBusyError extends Error {
  readonly scope: string;
  /** The active logical holder only; the private generation token is omitted. */
  readonly activeHolderId: string;
  constructor(scope: string, activeHolderId = "unknown") {
    super(`capsule lease busy: ${scope}`);
    this.name = "CapsuleLeaseBusyError";
    this.scope = scope;
    this.activeHolderId = activeHolderId;
  }
}

/** Default lease TTL: long enough to cover a slow runner dispatch. */
export const DEFAULT_CAPSULE_LEASE_TTL_MS = 15 * 60 * 1000;
const MAX_JOINED_CAPSULE_LEASE_REFERENCES = 64;
const JOINED_LEASE_WAIT_TOTAL_MS = 5_000;
const JOINED_LEASE_WAIT_INITIAL_MS = 50;
const JOINED_LEASE_WAIT_MAX_MS = 250;

/**
 * The held-lease handle threaded into a leased `work` fn so a long-running run
 * can extend its own lease while it executes (the renewal harness in the apply
 * path). `scope` / `holderId` / `token` identify the held lease; `renew(ttlMs)`
 * extends its expiry (holder + token gated). A renew that fails closed
 * (`acquired=false`) means the lease was lost (expired + taken over); the caller
 * should stop renewing rather than re-acquire.
 */
export interface LeaseHandle {
  readonly scope: string;
  readonly holderId: string;
  readonly token: string;
  renew(ttlMs?: number): Promise<CapsuleLease>;
}

/**
 * Acquires the Capsule lease, runs `work`, and releases in `finally`.
 * Throws {@link CapsuleLeaseBusyError} when the lease is held by another
 * holder (the run is left for redelivery). Returns the `work` result on
 * success. The held-lease handle is threaded into `work` so a long apply can
 * renew the lease (and re-stamp the run heartbeat) while it runs.
 */
export async function withCapsuleLease<T>(
  coordination: CapsuleCoordination,
  input: {
    readonly capsuleId: string;
    readonly environment: string;
    readonly holderId: string;
    readonly ttlMs?: number;
    readonly joinExistingHolder?: boolean;
  },
  work: (handle: LeaseHandle) => Promise<T>,
): Promise<T> {
  const scope = capsuleLeaseScope(input.capsuleId, input.environment);
  return await withScopedLease(
    coordination,
    scope,
    input.holderId,
    input.ttlMs,
    input.joinExistingHolder,
    work,
  );
}

/**
 * Acquires the `plan:{planRunId}` lease (create-apply critical section),
 * runs `work`, and releases in `finally`. Used by the apply consumer for a
 * `create` plan that has no capsuleId yet, so cross-isolate create-applies
 * of the SAME plan are serialized (apply-once / S5). Throws
 * {@link CapsuleLeaseBusyError} when another holder holds it (redelivery).
 */
export async function withPlanLease<T>(
  coordination: CapsuleCoordination,
  input: {
    readonly planRunId: string;
    readonly holderId: string;
    readonly ttlMs?: number;
  },
  work: (handle: LeaseHandle) => Promise<T>,
): Promise<T> {
  const scope = planLeaseScope(input.planRunId);
  return await withScopedLease(
    coordination,
    scope,
    input.holderId,
    input.ttlMs,
    undefined,
    work,
  );
}

/**
 * Acquires the `workspace-graph:{workspaceId}` lease (dependency-graph mutation
 * critical section), runs `work`, and releases in `finally`. Serializes the
 * (list edges → detectCycle → put edge) check-then-write per Workspace so two
 * concurrent inverse-edge creates cannot both pass the acyclic check and wedge
 * the DAG. Throws {@link CapsuleLeaseBusyError} when another holder holds
 * it so the caller can retry rather than racing.
 */
export async function withWorkspaceLease<T>(
  coordination: CapsuleCoordination,
  input: {
    readonly workspaceId: string;
    readonly holderId: string;
    readonly ttlMs?: number;
  },
  work: (handle: LeaseHandle) => Promise<T>,
): Promise<T> {
  const scope = workspaceLeaseScope(input.workspaceId);
  return await withScopedLease(
    coordination,
    scope,
    input.holderId,
    input.ttlMs,
    undefined,
    work,
  );
}

/**
 * Shared acquire → run(handle) → release-in-finally body for the three scoped
 * lease helpers. Acquires the `scope` lease, builds the {@link LeaseHandle}
 * (whose `renew` extends the same held lease), runs `work`, and releases on
 * every exit path. A busy lease throws {@link CapsuleLeaseBusyError}.
 */
async function withScopedLease<T>(
  coordination: CapsuleCoordination,
  scope: string,
  holderId: string,
  ttlMs: number | undefined,
  joinExistingHolder: boolean | undefined,
  work: (handle: LeaseHandle) => Promise<T>,
): Promise<T> {
  const leaseTtl = ttlMs ?? DEFAULT_CAPSULE_LEASE_TTL_MS;
  const lease = await acquireScopedLease(
    coordination,
    scope,
    holderId,
    leaseTtl,
    joinExistingHolder,
  );
  if (!lease.acquired) {
    throw new CapsuleLeaseBusyError(scope, lease.holderId);
  }
  const handle: LeaseHandle = {
    scope,
    holderId,
    token: lease.token,
    renew: (renewTtlMs) =>
      coordination.renewLease({
        scope,
        holderId,
        token: lease.token,
        ...(lease.referenceId ? { referenceId: lease.referenceId } : {}),
        ttlMs: renewTtlMs ?? leaseTtl,
      }),
  };
  try {
    return await work(handle);
  } finally {
    await coordination.releaseLease({
      scope,
      holderId,
      token: lease.token,
      ...(lease.referenceId ? { referenceId: lease.referenceId } : {}),
    });
  }
}

/**
 * Acquire a scoped lease, waiting only for the old-DO compatibility case where
 * an explicitly joinable request is denied by the same stable holder. Older
 * CoordinationObject versions do not understand `joinExistingHolder` and
 * report an ordinary busy lease instead; a bounded retry lets that generation
 * drain without ever running while it is held. A different holder remains an
 * immediate busy result.
 */
async function acquireScopedLease(
  coordination: CapsuleCoordination,
  scope: string,
  holderId: string,
  ttlMs: number,
  joinExistingHolder: boolean | undefined,
): Promise<CapsuleLease> {
  const input: AcquireCapsuleLeaseInput = {
    scope,
    holderId,
    ttlMs,
    ...(joinExistingHolder === true ? { joinExistingHolder: true } : {}),
  };
  let lease = await coordination.acquireLease(input);
  if (
    lease.acquired ||
    joinExistingHolder !== true ||
    lease.holderId !== holderId
  ) {
    return lease;
  }

  const startedAt = Date.now();
  let delayMs = JOINED_LEASE_WAIT_INITIAL_MS;
  while (Date.now() - startedAt < JOINED_LEASE_WAIT_TOTAL_MS) {
    const remainingMs = JOINED_LEASE_WAIT_TOTAL_MS - (Date.now() - startedAt);
    await delay(Math.min(delayMs, remainingMs));
    lease = await coordination.acquireLease(input);
    if (lease.acquired || lease.holderId !== holderId) return lease;
    delayMs = Math.min(delayMs * 2, JOINED_LEASE_WAIT_MAX_MS);
  }
  return lease;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

interface StoredLease {
  readonly holderId: string;
  readonly token: string;
  readonly expiresAt: number;
  readonly joinable: boolean;
  readonly referenceIds: ReadonlySet<string>;
}

/**
 * In-memory {@link CapsuleCoordination} for tests / single-process
 * substrates. Mirrors the CoordinationObject semantics: a non-expired lease
 * remains exclusive unless both the stored generation and a same-holder
 * acquisition explicitly opt into logical-operation joining. Release is
 * holder+generation-token+member-reference gated.
 */
export class InMemoryCapsuleCoordination implements CapsuleCoordination {
  readonly #leases = new Map<string, StoredLease>();
  readonly #now: () => number;
  readonly #newToken: () => string;
  readonly #newReferenceId: () => string;

  constructor(deps: {
    readonly now?: () => number;
    readonly newToken?: () => string;
    readonly newReferenceId?: () => string;
  } = {}) {
    this.#now = deps.now ?? (() => Date.now());
    this.#newToken = deps.newToken ?? (() => crypto.randomUUID());
    this.#newReferenceId =
      deps.newReferenceId ?? (() => crypto.randomUUID());
  }

  acquireLease(
    input: AcquireCapsuleLeaseInput,
  ): Promise<CapsuleLease> {
    const now = this.#now();
    const existing = this.#leases.get(input.scope);
    if (existing && existing.expiresAt > now) {
      if (
        input.joinExistingHolder === true &&
        existing.joinable &&
        existing.holderId === input.holderId &&
        existing.referenceIds.size < MAX_JOINED_CAPSULE_LEASE_REFERENCES
      ) {
        const referenceId = this.#newReferenceId();
        const expiresAt = Math.max(existing.expiresAt, now + input.ttlMs);
        this.#leases.set(input.scope, {
          ...existing,
          expiresAt,
          referenceIds: new Set([...existing.referenceIds, referenceId]),
        });
        return Promise.resolve({
          scope: input.scope,
          holderId: existing.holderId,
          token: existing.token,
          referenceId,
          acquired: true,
          expiresAt: new Date(expiresAt).toISOString(),
        });
      }
      return Promise.resolve({
        scope: input.scope,
        holderId: existing.holderId,
        token: existing.token,
        acquired: false,
        expiresAt: new Date(existing.expiresAt).toISOString(),
      });
    }
    const token = this.#newToken();
    const joinable = input.joinExistingHolder === true;
    const referenceId = joinable ? this.#newReferenceId() : undefined;
    const expiresAt = now + input.ttlMs;
    this.#leases.set(input.scope, {
      holderId: input.holderId,
      token,
      expiresAt,
      joinable,
      referenceIds: referenceId ? new Set([referenceId]) : new Set(),
    });
    return Promise.resolve({
      scope: input.scope,
      holderId: input.holderId,
      token,
      ...(referenceId ? { referenceId } : {}),
      acquired: true,
      expiresAt: new Date(expiresAt).toISOString(),
    });
  }

  renewLease(input: RenewCapsuleLeaseInput): Promise<CapsuleLease> {
    const now = this.#now();
    const existing = this.#leases.get(input.scope);
    // Renewal is holder + token gated AND requires the lease to still be live:
    // an expired lease is not renewed (it may have been taken over). A non-held
    // renew fails closed (acquired=false) — it NEVER mints a fresh lease.
    if (
      !existing ||
      existing.holderId !== input.holderId ||
      existing.token !== input.token ||
      (existing.referenceIds.size > 0 &&
        (input.referenceId === undefined ||
          !existing.referenceIds.has(input.referenceId))) ||
      existing.expiresAt <= now
    ) {
      return Promise.resolve({
        scope: input.scope,
        holderId: input.holderId,
        token: input.token,
        acquired: false,
        expiresAt: new Date(existing?.expiresAt ?? now).toISOString(),
      });
    }
    const expiresAt = Math.max(existing.expiresAt, now + input.ttlMs);
    this.#leases.set(input.scope, {
      ...existing,
      expiresAt,
    });
    return Promise.resolve({
      scope: input.scope,
      holderId: existing.holderId,
      token: existing.token,
      acquired: true,
      expiresAt: new Date(expiresAt).toISOString(),
    });
  }

  releaseLease(input: ReleaseCapsuleLeaseInput): Promise<boolean> {
    const existing = this.#leases.get(input.scope);
    if (
      !existing ||
      existing.holderId !== input.holderId ||
      existing.token !== input.token
    ) {
      return Promise.resolve(false);
    }
    if (existing.referenceIds.size > 0) {
      if (
        input.referenceId === undefined ||
        !existing.referenceIds.has(input.referenceId)
      ) {
        return Promise.resolve(false);
      }
      const remaining = new Set(existing.referenceIds);
      remaining.delete(input.referenceId);
      if (remaining.size > 0) {
        this.#leases.set(input.scope, {
          ...existing,
          referenceIds: remaining,
        });
        return Promise.resolve(true);
      }
    }
    this.#leases.delete(input.scope);
    return Promise.resolve(true);
  }
}
