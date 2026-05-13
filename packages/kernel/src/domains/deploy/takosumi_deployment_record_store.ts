import type {
  JsonObject,
  JsonValue,
  ManifestResource,
  ResourceHandle,
} from "takosumi-contract";

/**
 * Persisted state for a single `takosumi deploy` submission against the
 * public `/v1/deployments` endpoint.
 *
 * The CLI re-issues the same manifest for `apply` and `destroy`. To make
 * `destroy` work against real provider handles (ARN, object id, …) the
 * kernel must remember what `applyV2` returned. This record carries that
 * state plus enough of the original submission to surface deployment status
 * via `GET /v1/deployments`.
 *
 * Distinct from the kernel-internal `Deployment` (DeploymentService): that
 * tracks the control-plane deployment graph; this tracks the public-deploy
 * CLI lifecycle and is the read-side for `takosumi status`.
 */
export interface TakosumiDeploymentRecord {
  /** Surrogate uuid; (tenantId, name) is the natural key. */
  readonly id: string;
  /** Tenant / Space scope selected for the public deploy route. */
  readonly tenantId: string;
  /** Deployment name from `manifest.metadata.name` or fallback hash. */
  readonly name: string;
  /** Full submitted manifest (resources[] or expanded template). */
  readonly manifest: JsonObject;
  /** Per-resource state derived from `applyV2.outcome.applied[]`. */
  readonly appliedResources: readonly TakosumiAppliedResourceRecord[];
  /** Lifecycle status of the most recent attempt. */
  readonly status: TakosumiDeploymentStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type TakosumiDeploymentStatus = "applied" | "destroyed" | "failed";

export interface TakosumiAppliedResourceRecord {
  readonly resourceName: string;
  readonly shape: string;
  readonly providerId: string;
  readonly handle: ResourceHandle;
  readonly outputs: JsonObject;
  readonly appliedAt: string;
  /**
   * Stable hash of `(shape, providerId, name, spec)` captured by
   * `applyV2.computeSpecFingerprint` at apply time. Persisted so that a
   * subsequent apply submission of the same manifest can short-circuit
   * `provider.apply` when the fingerprint is unchanged. Unset rows force a
   * re-apply (`provider.apply` is called) on the next submission, which is
   * safe but not idempotent.
   */
  readonly specFingerprint?: string;
}

export interface TakosumiDeploymentUpsertInput {
  readonly tenantId: string;
  readonly name: string;
  readonly manifest: JsonObject;
  readonly appliedResources: readonly TakosumiAppliedResourceRecord[];
  readonly status: TakosumiDeploymentStatus;
  readonly now: string;
}

export interface TakosumiDeploymentRecordStore {
  /**
   * Upsert by `(tenantId, name)`: when an existing row matches the natural
   * key the row is updated in place; otherwise a new row is inserted with a
   * fresh id.
   */
  upsert(
    input: TakosumiDeploymentUpsertInput,
  ): Promise<TakosumiDeploymentRecord>;
  get(
    tenantId: string,
    name: string,
  ): Promise<TakosumiDeploymentRecord | undefined>;
  list(tenantId: string): Promise<readonly TakosumiDeploymentRecord[]>;
  /**
   * Mark a row as destroyed (status = 'destroyed', applied_resources = []).
   * Returns undefined when no row matches the natural key. The row is kept
   * around so that operators can audit prior destroy events; callers that
   * want hard-delete semantics can call `remove` instead.
   */
  markDestroyed(
    tenantId: string,
    name: string,
    now: string,
  ): Promise<TakosumiDeploymentRecord | undefined>;
  remove(tenantId: string, name: string): Promise<boolean>;
  /**
   * Acquire a deployment-scoped exclusive lock keyed by `(tenantId, name)`.
   * Waits if another caller already holds the lock and resolves only when
   * its `releaseLock` call has run. Used by the public deploy route to
   * serialise concurrent `apply` / `destroy` submissions of the same
   * deployment so two callers do not race on `provider.apply` and the
   * record store. The in-memory implementation backs the lock with a
   * `Map<key, Promise>` chain. SQL-backed implementations use an
   * atomic lease row (or an equivalent strongly-consistent compare-and-set
   * primitive) so separate kernel pods share the same fence.
   */
  acquireLock(tenantId: string, name: string): Promise<void>;
  /**
   * Release a previously-acquired lock. Idempotent: releasing an unheld
   * lock is a no-op so callers can always release in `finally` even
   * when acquire failed.
   */
  releaseLock(tenantId: string, name: string): Promise<void>;
  /**
   * Walk every persisted record's manifest and per-resource `outputs` and
   * return the union of `sha256:...` artifact hashes still referenced from
   * anywhere — both literal `artifact: { hash }` shapes and bare
   * `sha256:<hex>` strings appearing as `${ref:...}`-resolved values.
   *
   * The set is the read side of artifact mark-and-sweep GC: any artifact
   * whose hash is NOT in the returned set is unreachable through any
   * persisted deployment record and may be deleted from object storage.
   *
   * Records with `status = 'destroyed'` carry an empty `appliedResources`
   * but their `manifest` is preserved for audit; we still scan that
   * manifest because a future re-apply may republish the same artifact
   * and we don't want to race-delete an artifact that is still pinned by
   * a recent submission. Operators that want hard-delete semantics can
   * call `remove` first to drop the row, then GC.
   */
  listReferencedArtifactHashes(): Promise<Set<string>>;
}

interface LockEntry {
  /** Promise the next waiter awaits. Resolves when `release` is called. */
  readonly waitFor: Promise<void>;
  /** Resolver for `waitFor`. */
  readonly release: () => void;
}

/**
 * In-memory implementation used by tests and any kernel deploy that has not
 * configured a SQL-backed store. Keys by `(tenantId, name)` so the natural
 * key is unique even though we expose a surrogate id.
 */
export class InMemoryTakosumiDeploymentRecordStore
  implements TakosumiDeploymentRecordStore {
  readonly #rows = new Map<string, TakosumiDeploymentRecord>();
  readonly #idFactory: () => string;
  /**
   * Per-deployment lock chain keyed by `(tenantId, name)`. Each held lock
   * is a Promise that resolves when its holder calls `releaseLock`. New
   * `acquireLock` calls await the tail of the chain and replace it with
   * their own Promise so subsequent acquirers wait in arrival order.
   */
  readonly #locks = new Map<string, LockEntry>();

  constructor(options: { readonly idFactory?: () => string } = {}) {
    this.#idFactory = options.idFactory ?? (() => crypto.randomUUID());
  }

  upsert(
    input: TakosumiDeploymentUpsertInput,
  ): Promise<TakosumiDeploymentRecord> {
    const key = naturalKey(input.tenantId, input.name);
    const existing = this.#rows.get(key);
    const record: TakosumiDeploymentRecord = {
      id: existing?.id ?? this.#idFactory(),
      tenantId: input.tenantId,
      name: input.name,
      manifest: input.manifest,
      appliedResources: input.appliedResources,
      status: input.status,
      createdAt: existing?.createdAt ?? input.now,
      updatedAt: input.now,
    };
    this.#rows.set(key, record);
    return Promise.resolve(record);
  }

  get(
    tenantId: string,
    name: string,
  ): Promise<TakosumiDeploymentRecord | undefined> {
    return Promise.resolve(this.#rows.get(naturalKey(tenantId, name)));
  }

  list(tenantId: string): Promise<readonly TakosumiDeploymentRecord[]> {
    return Promise.resolve(
      [...this.#rows.values()]
        .filter((row) => row.tenantId === tenantId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    );
  }

  markDestroyed(
    tenantId: string,
    name: string,
    now: string,
  ): Promise<TakosumiDeploymentRecord | undefined> {
    const key = naturalKey(tenantId, name);
    const existing = this.#rows.get(key);
    if (!existing) return Promise.resolve(undefined);
    const updated: TakosumiDeploymentRecord = {
      ...existing,
      appliedResources: [],
      status: "destroyed",
      updatedAt: now,
    };
    this.#rows.set(key, updated);
    return Promise.resolve(updated);
  }

  remove(tenantId: string, name: string): Promise<boolean> {
    return Promise.resolve(this.#rows.delete(naturalKey(tenantId, name)));
  }

  async acquireLock(tenantId: string, name: string): Promise<void> {
    const key = naturalKey(tenantId, name);
    // While the deployment is held, await the chain tail before installing
    // our own entry. The loop handles the case where multiple acquirers
    // queue concurrently: each one awaits the previous tail, then claims
    // the slot only when no other entry is in-flight.
    while (this.#locks.has(key)) {
      const tail = this.#locks.get(key);
      if (!tail) break;
      await tail.waitFor;
    }
    let release!: () => void;
    const waitFor = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#locks.set(key, { waitFor, release });
  }

  releaseLock(tenantId: string, name: string): Promise<void> {
    const key = naturalKey(tenantId, name);
    const entry = this.#locks.get(key);
    if (!entry) return Promise.resolve();
    this.#locks.delete(key);
    entry.release();
    return Promise.resolve();
  }

  listReferencedArtifactHashes(): Promise<Set<string>> {
    const hashes = new Set<string>();
    for (const row of this.#rows.values()) {
      collectArtifactHashes(row.manifest as JsonValue, hashes);
      for (const applied of row.appliedResources) {
        collectArtifactHashes(applied.outputs as JsonValue, hashes);
      }
    }
    return Promise.resolve(hashes);
  }
}

const ARTIFACT_HASH_REGEX = /^sha256:[0-9a-f]{64}$/;

/**
 * Walks an arbitrary JSON tree and adds every `sha256:<64-hex>` string it
 * sees to the accumulator. We accept BOTH:
 *  - `{ artifact: { hash: "sha256:..." } }` — the canonical shape spec
 *    form recognised by Workers / Lambda / static-bundle connectors.
 *  - bare `sha256:...` strings anywhere in the tree — covers nested
 *    `${ref:...}`-resolved values that the kernel substitutes into the
 *    manifest before persisting.
 *
 * Liberal capture is the safe direction: a false positive only retains an
 * artifact that was never live, which costs storage but never breaks a
 * deploy. A false negative would race-delete a still-pinned artifact and
 * silently break the next apply.
 */
function collectArtifactHashes(value: JsonValue, into: Set<string>): void {
  if (value === null || value === undefined) return;
  if (typeof value === "string") {
    if (ARTIFACT_HASH_REGEX.test(value)) into.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectArtifactHashes(entry, into);
    return;
  }
  if (typeof value === "object") {
    for (const inner of Object.values(value)) {
      collectArtifactHashes(inner as JsonValue, into);
    }
  }
}

/**
 * Helper used by callers that have an `ApplyV2Outcome.applied[]` and a
 * `ManifestResource[]`. Looks up each applied entry's shape from the
 * resources array so the persisted record carries the shape id alongside
 * the provider id. The `specFingerprint` stamped on the applied entry by
 * `applyV2` is propagated through verbatim so a re-submission of the
 * same manifest can short-circuit `provider.apply`.
 */
export function recordsFromAppliedResources(
  applied: readonly {
    readonly name: string;
    readonly providerId: string;
    readonly handle: ResourceHandle;
    readonly outputs: JsonObject;
    readonly specFingerprint?: string;
  }[],
  resources: readonly ManifestResource[],
  now: string,
): readonly TakosumiAppliedResourceRecord[] {
  const shapeByName = new Map<string, string>();
  for (const resource of resources) {
    shapeByName.set(resource.name, resource.shape);
  }
  return applied.map((entry) => ({
    resourceName: entry.name,
    shape: shapeByName.get(entry.name) ?? "",
    providerId: entry.providerId,
    handle: entry.handle,
    outputs: entry.outputs,
    appliedAt: now,
    ...(entry.specFingerprint
      ? { specFingerprint: entry.specFingerprint }
      : {}),
  }));
}

function naturalKey(tenantId: string, name: string): string {
  return JSON.stringify([tenantId, name]);
}
