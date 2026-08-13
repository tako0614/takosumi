// Resource Shape store interfaces + in-memory implementations.
//
// The interfaces are the contract the service layer depends on. Durable
// implementations (Cloudflare D1 + Postgres) mirror these and are wired on the
// deploy-control persistence plane; the in-memory stores here keep the service
// runnable in tests through explicit injection without a database.

import type {
  InstalledFormReference,
  ResourceManagedBy,
  ResourceShapeKind,
} from "takosumi-contract";
import { shapeKindForPortableType } from "takosumi-contract";
import {
  pageSorted,
  type Page,
  type PageParams,
} from "takosumi-contract/pagination";
import type { SpaceId } from "../../shared/ids.ts";
import type {
  ResolutionLockRecord,
  ResourceIdentityFenceRecord,
  ResourceShapeRecord,
  ResourceShapeStateAdoptionDescriptor,
  ResourceShapeRecordId,
  SpacePolicyRecord,
  SpacePolicyRecordId,
  TargetPoolRecord,
  TargetPoolRecordId,
} from "./records.ts";
import {
  assertNativeResourceFormIdentity,
  assertResourceFormIdentity,
  bindNativeResourceFormIdentity,
  resourceFormIdentitiesEqual,
} from "./records.ts";

export type ResourceDeleteClaimResult =
  | { readonly status: "claimed"; readonly record: ResourceShapeRecord }
  | {
      readonly status: "already_deleting";
      readonly record: ResourceShapeRecord;
    }
  | { readonly status: "not_found" }
  | {
      readonly status: "conflict";
      readonly record: ResourceShapeRecord;
    }
  | {
      readonly status: "ownership_conflict";
      readonly record: ResourceShapeRecord;
    };

export type ResourceCompareAndSetResult =
  | { readonly status: "updated"; readonly record: ResourceShapeRecord }
  | { readonly status: "not_found" }
  | { readonly status: "conflict"; readonly record: ResourceShapeRecord };

export type ResourceCreateResult =
  | { readonly status: "created"; readonly record: ResourceShapeRecord }
  | { readonly status: "conflict"; readonly record: ResourceShapeRecord };

export interface ResourceRecordVersion {
  readonly generation: number;
  readonly phase: ResourceShapeRecord["phase"];
  readonly updatedAt: string;
  /** Optional only for callers compiled before durable revision CAS. */
  readonly revision?: number;
}

export interface ResourceApplyingVersion {
  readonly generation: number;
  readonly phase: "Applying";
  readonly updatedAt: string;
  /** Optional only for callers compiled before durable revision CAS. */
  readonly revision?: number;
}

export interface ResourceApplyBeginInput {
  readonly applyingRecord: ResourceShapeRecord;
  readonly plannedLock: ResolutionLockRecord;
  /** Exact TargetPool record used to resolve `plannedLock`. */
  readonly expectedTargetPool?: TargetPoolRecord;
  /** Omit only for a create-only claim. Present means CAS-only. */
  readonly expected?: ResourceRecordVersion;
  /**
   * Persisted fence observed by preview/import, or `null` for observed absence.
   * `undefined` is reserved for lifecycle continuations that do not allocate a
   * new desired generation (recovery/refresh and legacy internal callers).
   */
  readonly expectedIdentityFence?: ResourceIdentityFenceRecord | null;
}

export type ResourceApplyBeginResult =
  | {
      readonly status: "begun";
      readonly record: ResourceShapeRecord;
      readonly lock: ResolutionLockRecord;
    }
  | { readonly status: "not_found" }
  | { readonly status: "conflict"; readonly record: ResourceShapeRecord }
  | {
      readonly status: "target_pool_conflict";
      readonly record?: TargetPoolRecord;
    }
  | {
      readonly status: "ownership_conflict";
      readonly record: ResourceShapeRecord;
    }
  | {
      readonly status: "identity_fence_conflict";
      readonly fence?: ResourceIdentityFenceRecord;
    };

export interface ResourceApplyCommitInput {
  readonly readyRecord: ResourceShapeRecord;
  readonly finalLock: ResolutionLockRecord;
  readonly expectedApplying: ResourceApplyingVersion;
}

export type ResourceApplyCommitResult =
  | {
      readonly status: "committed";
      readonly record: ResourceShapeRecord;
      readonly lock: ResolutionLockRecord;
    }
  | { readonly status: "not_found" }
  | { readonly status: "conflict"; readonly record: ResourceShapeRecord };

/**
 * Pre-dispatch serialization claim for a host-owned aggregate mutation. The
 * Resource row is the visible claim, while the exact ResolutionLock and
 * incarnation fence are read-only CAS preconditions in the same transaction.
 */
export interface ResourceAggregateClaimInput {
  readonly record: ResourceShapeRecord;
  readonly expectedResource: ResourceRecordVersion;
  readonly expectedLock: ResolutionLockRecord;
  readonly expectedIdentityFence: ResourceIdentityFenceRecord | null;
}

export type ResourceAggregateClaimResult =
  | { readonly status: "claimed"; readonly record: ResourceShapeRecord }
  | { readonly status: "not_found" }
  | {
      readonly status: "conflict";
      readonly record?: ResourceShapeRecord;
      readonly lock?: ResolutionLockRecord;
      readonly identityFence?: ResourceIdentityFenceRecord;
    };

/**
 * Exact aggregate replacement used by host-owned lifecycle recovery after the
 * provider apply has already committed. Both the Resource and its immutable
 * resolution evidence are fenced and replaced together so Ready inventory
 * never observes a torn timestamp/revision pair.
 */
export interface ResourceAggregateReplaceInput {
  readonly record: ResourceShapeRecord;
  readonly lock: ResolutionLockRecord;
  readonly expectedResource: ResourceRecordVersion;
  readonly expectedLock: ResolutionLockRecord;
  /**
   * Advance the server-owned incarnation fence with the same CAS as the
   * Resource/ResolutionLock replacement. Omit for same-generation recovery
   * writes; Form transitions supply the exact fence observed at admission.
   */
  readonly identityFenceAdvance?: {
    readonly expected: ResourceIdentityFenceRecord | null;
  };
}

export type ResourceAggregateReplaceResult =
  | {
      readonly status: "replaced";
      readonly record: ResourceShapeRecord;
      readonly lock: ResolutionLockRecord;
      readonly identityFence?: ResourceIdentityFenceRecord;
    }
  | { readonly status: "not_found" }
  | {
      readonly status: "conflict";
      readonly record?: ResourceShapeRecord;
      readonly lock?: ResolutionLockRecord;
    };

export interface ResourceApplyAbortInput {
  readonly resourceId: ResourceShapeRecordId;
  readonly expectedApplying: ResourceApplyingVersion;
  /** Exact planned lock version installed by beginApply. */
  readonly expectedPlannedLock: ResolutionLockRecord;
  /**
   * `null` removes a create-only claim. A replacement restores the prior
   * Resource (or publishes a known-failure Resource); `lock: null` explicitly
   * restores the prior absence of a ResolutionLock.
   */
  readonly replacement: {
    readonly record: ResourceShapeRecord;
    readonly lock: ResolutionLockRecord | null;
  } | null;
  /**
   * Restore a fence consumed by beginApply only when backend mutation never
   * started. Known/uncertain backend outcomes intentionally omit this rollback.
   */
  readonly identityFenceRollback?: {
    readonly expected: ResourceIdentityFenceRecord;
    readonly replacement: ResourceIdentityFenceRecord | null;
  };
}

export type ResourceApplyAbortResult =
  | { readonly status: "rolled_back" }
  | { readonly status: "not_found" }
  | {
      readonly status: "conflict";
      readonly record?: ResourceShapeRecord;
      readonly lock?: ResolutionLockRecord;
    };

export interface ResourceAtomicRemoveInput {
  readonly resourceId: ResourceShapeRecordId;
  /** Exact Resource lifecycle version whose backend operation completed. */
  readonly expected: ResourceRecordVersion;
  /** Exact lock version observed by the caller, or explicit expected absence. */
  readonly expectedLock: ResolutionLockRecord | null;
}

export type ResourceAtomicRemoveResult =
  | { readonly status: "removed" }
  /** Both rows are already absent, so a concurrent finalizer won. */
  | { readonly status: "not_found" }
  | {
      readonly status: "conflict";
      readonly record?: ResourceShapeRecord;
      readonly lock?: ResolutionLockRecord;
    };

/** Durable lease request used by the bounded scheduled Resource observer. */
export interface ResourceObservationClaimInput {
  readonly leaseId: string;
  readonly claimedAt: string;
  /** Only Resources not attempted after this instant are due. */
  readonly dueBefore: string;
  /** An abandoned lease at or before this instant may be reclaimed. */
  readonly staleClaimBefore: string;
}

export interface ResourceFormIdentityPinInput {
  readonly resourceId: ResourceShapeRecordId;
  readonly form: InstalledFormReference;
  readonly expectedResource: ResourceRecordVersion;
  readonly expectedLock: ResolutionLockRecord;
}

export type ResourceFormIdentityPinResult =
  | {
      readonly status: "pinned" | "already_pinned";
      readonly record: ResourceShapeRecord;
      readonly lock: ResolutionLockRecord;
    }
  | { readonly status: "not_found" }
  | {
      readonly status: "conflict";
      readonly record?: ResourceShapeRecord;
      readonly lock?: ResolutionLockRecord;
    };

export interface ResourceShapeStore {
  /** Atomically inserts a new Resource without replacing an existing owner. */
  create(record: ResourceShapeRecord): Promise<ResourceCreateResult>;
  upsert(record: ResourceShapeRecord): Promise<ResourceShapeRecord>;
  get(id: ResourceShapeRecordId): Promise<ResourceShapeRecord | undefined>;
  /**
   * Bounded exact-id read used by cross-domain read projections. Callers keep
   * the batch at or below 100 so D1 never exceeds its variable limit.
   */
  getMany(
    ids: readonly ResourceShapeRecordId[],
  ): Promise<readonly ResourceShapeRecord[]>;
  getByName(
    spaceId: SpaceId,
    kind: ResourceShapeKind,
    name: string,
  ): Promise<ResourceShapeRecord | undefined>;
  listBySpace(spaceId: SpaceId): Promise<readonly ResourceShapeRecord[]>;
  /** Bounded keyset page for public Resource list reads. */
  listBySpacePage(
    spaceId: SpaceId,
    params: PageParams,
  ): Promise<Page<ResourceShapeRecord>>;
  /**
   * Bounded exact claim inventory for one Capsule id in a Workspace. This
   * reads every Resource phase (including Applying, Deleting, and Failed) and
   * deliberately preserves malformed or Workspace-mismatched owner objects
   * whose `id` claims the requested Capsule. The host must validate the full
   * structured owner and installing Principal and fail closed on mismatch.
   * The page cursor is the underlying Workspace keyset: a filtered page may
   * contain fewer rows than `limit` (or no rows), so callers must continue
   * while `nextCursor` is present to prove completeness.
   */
  listByCapsuleOwnerPage(
    spaceId: SpaceId,
    capsuleId: string,
    params: PageParams,
  ): Promise<Page<ResourceShapeRecord>>;
  /**
   * Internal bounded host inventory over an exact set of shape kinds. This is
   * never exposed as a customer list API; operator callers must still project
   * and authorize the returned records before emitting any response.
   */
  listByKindsPage(
    kinds: readonly ResourceShapeKind[],
    params: PageParams,
  ): Promise<Page<ResourceShapeRecord>>;
  /**
   * Internal, global inventory page for host-operated reconciliation jobs.
   * This is not a public Resource list route: callers select one exact shape
   * kind and receive only fully observed Ready records in stable keyset order.
   */
  listReadyByKindPage(
    kind: ResourceShapeKind,
    params: PageParams,
    spaceId?: SpaceId,
  ): Promise<Page<ResourceShapeRecord>>;
  /**
   * Internal bounded inventory for the explicit legacy exact-Form backfill.
   * This is not a customer list surface and returns only null-pin rows.
   */
  listUnpinnedBySpaceKindPage(
    spaceId: SpaceId,
    kind: ResourceShapeKind,
    params: PageParams,
  ): Promise<Page<ResourceShapeRecord>>;
  /**
   * Claims the globally oldest due, fully-applied Ready Resource. The lease is
   * internal scheduler state, not Resource status or another lifecycle ledger.
   */
  claimObservationCandidate(
    input: ResourceObservationClaimInput,
  ): Promise<ResourceShapeRecord | undefined>;
  /** Releases exactly one matching lease and records its attempt time. */
  finishObservationClaim(
    id: ResourceShapeRecordId,
    leaseId: string,
    attemptedAt: string,
  ): Promise<boolean>;
  /**
   * Atomically records a confirmed one-shot state adoption only while the
   * Resource still has neither Resource-owned execution state nor another
   * pending adoption. The timestamp fence prevents a stale report from
   * overwriting a Resource changed after candidate inspection.
   */
  confirmStateAdoption(
    id: ResourceShapeRecordId,
    descriptor: ResourceShapeStateAdoptionDescriptor,
    expectedUpdatedAt: string,
  ): Promise<
    | { readonly status: "confirmed"; readonly record: ResourceShapeRecord }
    | { readonly status: "not_found" }
    | { readonly status: "conflict"; readonly record: ResourceShapeRecord }
  >;
  /**
   * Atomically replaces an observed Resource projection only when the desired
   * generation and lifecycle phase still match the snapshot that was sent to
   * the backend observer. This prevents a slow observation from overwriting a
   * concurrent apply or delete.
   */
  compareAndSet(
    record: ResourceShapeRecord,
    expected: ResourceRecordVersion,
  ): Promise<ResourceCompareAndSetResult>;
  /** Deletes only the exact lifecycle version currently owned by a caller. */
  deleteIfVersion(
    id: ResourceShapeRecordId,
    expected: ResourceRecordVersion,
  ): Promise<boolean>;
  claimDelete(
    record: ResourceShapeRecord,
    expectedGeneration: number,
    expectedManagedBy: ResourceManagedBy,
  ): Promise<ResourceDeleteClaimResult>;
  delete(id: ResourceShapeRecordId): Promise<void>;
}

export interface ResolutionLockStore {
  put(lock: ResolutionLockRecord): Promise<ResolutionLockRecord>;
  get(
    resourceId: ResourceShapeRecordId,
  ): Promise<ResolutionLockRecord | undefined>;
  /**
   * Bounded exact-id read used by cross-domain read projections. Callers keep
   * the batch at or below 100 so D1 never exceeds its variable limit.
   */
  getMany(
    resourceIds: readonly ResourceShapeRecordId[],
  ): Promise<readonly ResolutionLockRecord[]>;
  delete(resourceId: ResourceShapeRecordId): Promise<void>;
}

export type TargetPoolCreateResult =
  | { readonly status: "created"; readonly record: TargetPoolRecord }
  | { readonly status: "conflict"; readonly record: TargetPoolRecord };

export interface TargetPoolPutInput {
  readonly record: TargetPoolRecord;
  /** Exact record observed by the resolver, or `null` for create-via-PUT. */
  readonly expected: TargetPoolRecord | null;
}

export type TargetPoolPutResult =
  | { readonly status: "put"; readonly record: TargetPoolRecord }
  | { readonly status: "in_use"; readonly lock: ResolutionLockRecord }
  | { readonly status: "conflict"; readonly record?: TargetPoolRecord };

export interface TargetPoolDeleteInput {
  readonly id: TargetPoolRecordId;
  readonly spaceId: SpaceId;
  readonly name: string;
  /** Exact record observed by the caller, or `null` for observed absence. */
  readonly expected: TargetPoolRecord | null;
}

export type TargetPoolDeleteResult =
  | { readonly status: "deleted" }
  | { readonly status: "absent" }
  | { readonly status: "in_use"; readonly lock: ResolutionLockRecord }
  | { readonly status: "conflict"; readonly record: TargetPoolRecord };

export interface TargetPoolStore {
  /** Atomically inserts a TargetPool without replacing any existing id/name. */
  create(record: TargetPoolRecord): Promise<TargetPoolCreateResult>;
  upsert(record: TargetPoolRecord): Promise<TargetPoolRecord>;
  get(id: TargetPoolRecordId): Promise<TargetPoolRecord | undefined>;
  getByName(
    spaceId: SpaceId,
    name: string,
  ): Promise<TargetPoolRecord | undefined>;
  listBySpace(spaceId: SpaceId): Promise<readonly TargetPoolRecord[]>;
  /** Bounded keyset page for public TargetPool list reads. */
  listBySpacePage(
    spaceId: SpaceId,
    params: PageParams,
  ): Promise<Page<TargetPoolRecord>>;
  delete(id: TargetPoolRecordId): Promise<void>;
}

export interface SpacePolicyStore {
  upsert(record: SpacePolicyRecord): Promise<SpacePolicyRecord>;
  get(id: SpacePolicyRecordId): Promise<SpacePolicyRecord | undefined>;
  getByName(
    spaceId: SpaceId,
    name: string,
  ): Promise<SpacePolicyRecord | undefined>;
  listBySpace(spaceId: SpaceId): Promise<readonly SpacePolicyRecord[]>;
  /** Bounded keyset page for public SpacePolicy list reads. */
  listBySpacePage(
    spaceId: SpaceId,
    params: PageParams,
  ): Promise<Page<SpacePolicyRecord>>;
  delete(id: SpacePolicyRecordId): Promise<void>;
}

/** The four Resource Shape stores, grouped for transaction wiring. */
export interface ResourceShapeStores {
  /** Composition-time persistence assertion used by strict runtime gates. */
  readonly persistence: "durable" | "ephemeral";
  readonly resources: ResourceShapeStore;
  readonly locks: ResolutionLockStore;
  readonly targetPools: TargetPoolStore;
  readonly spacePolicies: SpacePolicyStore;
  /** Read the durable incarnation authority without materializing a Resource. */
  getResourceIdentityFence(
    resourceId: ResourceShapeRecordId,
  ): Promise<ResourceIdentityFenceRecord | undefined>;
  /**
   * Atomically puts one exact TargetPool version only while no ResolutionLock
   * references the pool. An identical declaration is an allowed no-op even
   * while in use.
   */
  putTargetPool(input: TargetPoolPutInput): Promise<TargetPoolPutResult>;
  /**
   * Atomically deletes one exact TargetPool version only while no
   * ResolutionLock references it. An observed absence is also fenced so it
   * cannot hide a concurrent replacement.
   */
  deleteTargetPool(
    input: TargetPoolDeleteInput,
  ): Promise<TargetPoolDeleteResult>;
  /**
   * Atomically claims an apply by publishing the Applying Resource together
   * with the planned ResolutionLock. When `expectedTargetPool` is present, the
   * same transaction also fences the exact pool version used by resolution.
   * `expected` selects CAS-only behavior; omitting it selects create-only
   * behavior.
   */
  beginApply(input: ResourceApplyBeginInput): Promise<ResourceApplyBeginResult>;
  /**
   * Atomically publishes the final ResolutionLock and Ready Resource while
   * fencing the exact Applying lifecycle version that reached the backend.
   */
  commitApply(
    input: ResourceApplyCommitInput,
  ): Promise<ResourceApplyCommitResult>;
  /**
   * Atomically writes one Resource claim while fencing its exact current lock
   * and identity fence. No host mutation may begin before this succeeds.
   */
  claimResourceAggregate(
    input: ResourceAggregateClaimInput,
  ): Promise<ResourceAggregateClaimResult>;
  /** Atomically replaces one exact Resource/ResolutionLock aggregate. */
  replaceResourceAggregate(
    input: ResourceAggregateReplaceInput,
  ): Promise<ResourceAggregateReplaceResult>;
  /**
   * Atomically removes or replaces an unstarted/known-no-mutation Applying
   * claim and restores its prior lock state. Both the Applying Resource and
   * the planned lock are fenced so a stale rollback cannot erase another
   * apply's resolution.
   */
  abortApply(input: ResourceApplyAbortInput): Promise<ResourceApplyAbortResult>;
  /**
   * Atomically removes one exact Resource lifecycle version together with the
   * exact ResolutionLock observed by the backend operation. This is the only
   * delete finalization path; a stale finalizer cannot leave either row torn.
   */
  removeResource(
    input: ResourceAtomicRemoveInput,
  ): Promise<ResourceAtomicRemoveResult>;
  /**
   * Atomically fills the legacy null/null exact identity on both Resource and
   * ResolutionLock. Existing exact pins are immutable and never rebound.
   */
  pinExactFormIdentity(
    input: ResourceFormIdentityPinInput,
  ): Promise<ResourceFormIdentityPinResult>;
}

// --- In-memory implementations -----------------------------------------------

export class InMemoryResourceShapeStore implements ResourceShapeStore {
  readonly #byId = new Map<ResourceShapeRecordId, ResourceShapeRecord>();
  readonly #observationSchedule = new Map<
    ResourceShapeRecordId,
    {
      leaseId?: string;
      claimedAt?: string;
      lastAttemptAt?: string;
    }
  >();

  create(record: ResourceShapeRecord): Promise<ResourceCreateResult> {
    return Promise.resolve(this.createSync(record));
  }

  createSync(record: ResourceShapeRecord): ResourceCreateResult {
    const current = this.#byId.get(record.id);
    if (current) return { status: "conflict", record: current };
    const persisted = withResourceRevision(
      record,
      resourceRecordRevision(record),
    );
    this.#byId.set(record.id, persisted);
    return { status: "created", record: persisted };
  }

  upsert(record: ResourceShapeRecord): Promise<ResourceShapeRecord> {
    const current = this.#byId.get(record.id);
    const persisted = current
      ? withNextResourceRevision(record, current)
      : withResourceRevision(record, resourceRecordRevision(record));
    this.#byId.set(record.id, persisted);
    return Promise.resolve(persisted);
  }

  get(id: ResourceShapeRecordId): Promise<ResourceShapeRecord | undefined> {
    return Promise.resolve(this.#byId.get(id));
  }

  async getMany(
    ids: readonly ResourceShapeRecordId[],
  ): Promise<readonly ResourceShapeRecord[]> {
    const unique = [...new Set(ids)];
    if (unique.length > 100) {
      throw new RangeError("Resource getMany accepts at most 100 ids");
    }
    return unique
      .map((id) => this.#byId.get(id))
      .filter((record): record is ResourceShapeRecord => record !== undefined);
  }

  getSync(id: ResourceShapeRecordId): ResourceShapeRecord | undefined {
    return this.#byId.get(id);
  }

  replaceSync(record: ResourceShapeRecord): void {
    this.#byId.set(record.id, record);
  }

  getByName(
    spaceId: SpaceId,
    kind: ResourceShapeKind,
    name: string,
  ): Promise<ResourceShapeRecord | undefined> {
    for (const record of this.#byId.values()) {
      if (
        record.spaceId === spaceId &&
        record.kind === kind &&
        record.name === name
      ) {
        return Promise.resolve(record);
      }
    }
    return Promise.resolve(undefined);
  }

  listBySpace(spaceId: SpaceId): Promise<readonly ResourceShapeRecord[]> {
    return Promise.resolve(this.listBySpaceSync(spaceId));
  }

  listBySpaceSync(spaceId: SpaceId): readonly ResourceShapeRecord[] {
    return [...this.#byId.values()].filter(
      (record) => record.spaceId === spaceId,
    );
  }

  listBySpacePage(
    spaceId: SpaceId,
    params: PageParams,
  ): Promise<Page<ResourceShapeRecord>> {
    const records = [...this.#byId.values()]
      .filter((record) => record.spaceId === spaceId)
      .sort(compareCreatedAtAndId);
    return Promise.resolve(pageSorted(records, params));
  }

  async listByCapsuleOwnerPage(
    spaceId: SpaceId,
    capsuleId: string,
    params: PageParams,
  ): Promise<Page<ResourceShapeRecord>> {
    return filterCapsuleOwnerPage(
      await this.listBySpacePage(spaceId, params),
      spaceId,
      capsuleId,
    );
  }

  listByKindsPage(
    kinds: readonly ResourceShapeKind[],
    params: PageParams,
  ): Promise<Page<ResourceShapeRecord>> {
    const kindSet = new Set(kinds);
    const records = [...this.#byId.values()]
      .filter((record) => kindSet.has(record.kind))
      .sort(compareCreatedAtAndId);
    return Promise.resolve(pageSorted(records, params));
  }

  listReadyByKindPage(
    kind: ResourceShapeKind,
    params: PageParams,
    spaceId?: SpaceId,
  ): Promise<Page<ResourceShapeRecord>> {
    const records = [...this.#byId.values()]
      .filter(
        (record) =>
          record.kind === kind &&
          (spaceId === undefined || record.spaceId === spaceId) &&
          record.phase === "Ready" &&
          record.observedGeneration === record.generation,
      )
      .sort(compareCreatedAtAndId);
    return Promise.resolve(pageSorted(records, params));
  }

  listUnpinnedBySpaceKindPage(
    spaceId: SpaceId,
    kind: ResourceShapeKind,
    params: PageParams,
  ): Promise<Page<ResourceShapeRecord>> {
    const records = [...this.#byId.values()]
      .filter(
        (record) =>
          record.spaceId === spaceId &&
          record.kind === kind &&
          record.form === undefined,
      )
      .sort(compareCreatedAtAndId);
    return Promise.resolve(pageSorted(records, params));
  }

  claimObservationCandidate(
    input: ResourceObservationClaimInput,
  ): Promise<ResourceShapeRecord | undefined> {
    const candidates = [...this.#byId.values()]
      .filter((record) => {
        if (
          record.phase !== "Ready" ||
          record.observedGeneration !== record.generation
        ) {
          return false;
        }
        const schedule = this.#observationSchedule.get(record.id);
        if (
          schedule?.lastAttemptAt &&
          schedule.lastAttemptAt > input.dueBefore
        ) {
          return false;
        }
        return !(
          schedule?.leaseId &&
          schedule.claimedAt &&
          schedule.claimedAt > input.staleClaimBefore
        );
      })
      .sort((left, right) => {
        const leftAttempt =
          this.#observationSchedule.get(left.id)?.lastAttemptAt ??
          left.createdAt;
        const rightAttempt =
          this.#observationSchedule.get(right.id)?.lastAttemptAt ??
          right.createdAt;
        return (
          leftAttempt.localeCompare(rightAttempt) ||
          left.id.localeCompare(right.id)
        );
      });
    const candidate = candidates[0];
    if (!candidate) return Promise.resolve(undefined);
    const current = this.#observationSchedule.get(candidate.id);
    this.#observationSchedule.set(candidate.id, {
      ...(current?.lastAttemptAt
        ? { lastAttemptAt: current.lastAttemptAt }
        : {}),
      leaseId: input.leaseId,
      claimedAt: input.claimedAt,
    });
    return Promise.resolve(candidate);
  }

  finishObservationClaim(
    id: ResourceShapeRecordId,
    leaseId: string,
    attemptedAt: string,
  ): Promise<boolean> {
    const current = this.#observationSchedule.get(id);
    if (!current || current.leaseId !== leaseId) {
      return Promise.resolve(false);
    }
    this.#observationSchedule.set(id, { lastAttemptAt: attemptedAt });
    return Promise.resolve(true);
  }

  confirmStateAdoption(
    id: ResourceShapeRecordId,
    descriptor: ResourceShapeStateAdoptionDescriptor,
    expectedUpdatedAt: string,
  ): Promise<
    | { readonly status: "confirmed"; readonly record: ResourceShapeRecord }
    | { readonly status: "not_found" }
    | { readonly status: "conflict"; readonly record: ResourceShapeRecord }
  > {
    const current = this.#byId.get(id);
    if (!current) return Promise.resolve({ status: "not_found" });
    if (
      current.updatedAt !== expectedUpdatedAt ||
      current.execution !== undefined ||
      current.stateAdoption !== undefined
    ) {
      return Promise.resolve({ status: "conflict", record: current });
    }
    const record = {
      ...current,
      stateAdoption: descriptor,
      updatedAt: descriptor.confirmedAt,
      revision: nextResourceRevision(current),
    };
    this.#byId.set(id, record);
    return Promise.resolve({ status: "confirmed", record });
  }

  compareAndSet(
    record: ResourceShapeRecord,
    expected: ResourceRecordVersion,
  ): Promise<ResourceCompareAndSetResult> {
    const current = this.#byId.get(record.id);
    if (!current) return Promise.resolve({ status: "not_found" });
    const expectedRevision =
      expected.revision ?? resourceRecordRevision(record);
    if (!matchesVersion(current, { ...expected, revision: expectedRevision })) {
      return Promise.resolve({ status: "conflict", record: current });
    }
    const persisted = withNextResourceRevision(record, current);
    this.#byId.set(record.id, persisted);
    return Promise.resolve({ status: "updated", record: persisted });
  }

  deleteIfVersion(
    id: ResourceShapeRecordId,
    expected: ResourceRecordVersion,
  ): Promise<boolean> {
    const current = this.#byId.get(id);
    if (!current || !matchesVersion(current, expected)) {
      return Promise.resolve(false);
    }
    this.#byId.delete(id);
    this.#observationSchedule.delete(id);
    return Promise.resolve(true);
  }

  claimDelete(
    record: ResourceShapeRecord,
    expectedGeneration: number,
    expectedManagedBy: ResourceManagedBy,
  ): Promise<ResourceDeleteClaimResult> {
    const current = this.#byId.get(record.id);
    if (!current) return Promise.resolve({ status: "not_found" });
    if (current.managedBy !== expectedManagedBy) {
      return Promise.resolve({ status: "ownership_conflict", record: current });
    }
    if (current.phase === "Deleting") {
      return Promise.resolve({ status: "already_deleting", record: current });
    }
    if (current.generation !== expectedGeneration) {
      return Promise.resolve({ status: "conflict", record: current });
    }
    if (resourceRecordRevision(current) !== resourceRecordRevision(record)) {
      return Promise.resolve({ status: "conflict", record: current });
    }
    const persisted = withNextResourceRevision(record, current);
    this.#byId.set(record.id, persisted);
    return Promise.resolve({ status: "claimed", record: persisted });
  }

  delete(id: ResourceShapeRecordId): Promise<void> {
    this.deleteSync(id);
    return Promise.resolve();
  }

  deleteSync(id: ResourceShapeRecordId): void {
    this.#byId.delete(id);
    this.#observationSchedule.delete(id);
  }
}

export class InMemoryResolutionLockStore implements ResolutionLockStore {
  readonly #byResource = new Map<ResourceShapeRecordId, ResolutionLockRecord>();

  put(lock: ResolutionLockRecord): Promise<ResolutionLockRecord> {
    this.putSync(lock);
    return Promise.resolve(lock);
  }

  putSync(lock: ResolutionLockRecord): void {
    this.#byResource.set(lock.resourceId, lock);
  }

  get(
    resourceId: ResourceShapeRecordId,
  ): Promise<ResolutionLockRecord | undefined> {
    return Promise.resolve(this.#byResource.get(resourceId));
  }

  async getMany(
    resourceIds: readonly ResourceShapeRecordId[],
  ): Promise<readonly ResolutionLockRecord[]> {
    const unique = [...new Set(resourceIds)];
    if (unique.length > 100) {
      throw new RangeError("Resolution lock getMany accepts at most 100 ids");
    }
    return unique
      .map((resourceId) => this.#byResource.get(resourceId))
      .filter((lock): lock is ResolutionLockRecord => lock !== undefined);
  }

  getSync(resourceId: ResourceShapeRecordId): ResolutionLockRecord | undefined {
    return this.#byResource.get(resourceId);
  }

  delete(resourceId: ResourceShapeRecordId): Promise<void> {
    this.deleteSync(resourceId);
    return Promise.resolve();
  }

  deleteSync(resourceId: ResourceShapeRecordId): void {
    this.#byResource.delete(resourceId);
  }
}

export class InMemoryTargetPoolStore implements TargetPoolStore {
  readonly #byId = new Map<TargetPoolRecordId, TargetPoolRecord>();

  create(record: TargetPoolRecord): Promise<TargetPoolCreateResult> {
    const existingById = this.#byId.get(record.id);
    if (existingById) {
      return Promise.resolve({ status: "conflict", record: existingById });
    }
    for (const existing of this.#byId.values()) {
      if (
        existing.spaceId === record.spaceId &&
        existing.name === record.name
      ) {
        return Promise.resolve({ status: "conflict", record: existing });
      }
    }
    this.#byId.set(record.id, record);
    return Promise.resolve({ status: "created", record });
  }

  upsert(record: TargetPoolRecord): Promise<TargetPoolRecord> {
    this.replaceSync(record);
    return Promise.resolve(record);
  }

  replaceSync(record: TargetPoolRecord): void {
    this.#byId.set(record.id, record);
  }

  get(id: TargetPoolRecordId): Promise<TargetPoolRecord | undefined> {
    return Promise.resolve(this.getSync(id));
  }

  getSync(id: TargetPoolRecordId): TargetPoolRecord | undefined {
    return this.#byId.get(id);
  }

  getByName(
    spaceId: SpaceId,
    name: string,
  ): Promise<TargetPoolRecord | undefined> {
    return Promise.resolve(this.getByNameSync(spaceId, name));
  }

  getByNameSync(spaceId: SpaceId, name: string): TargetPoolRecord | undefined {
    for (const record of this.#byId.values()) {
      if (record.spaceId === spaceId && record.name === name) {
        return record;
      }
    }
    return undefined;
  }

  listBySpace(spaceId: SpaceId): Promise<readonly TargetPoolRecord[]> {
    return Promise.resolve(
      [...this.#byId.values()].filter((record) => record.spaceId === spaceId),
    );
  }

  listBySpacePage(
    spaceId: SpaceId,
    params: PageParams,
  ): Promise<Page<TargetPoolRecord>> {
    const records = [...this.#byId.values()]
      .filter((record) => record.spaceId === spaceId)
      .sort(compareCreatedAtAndId);
    return Promise.resolve(pageSorted(records, params));
  }

  delete(id: TargetPoolRecordId): Promise<void> {
    this.deleteSync(id);
    return Promise.resolve();
  }

  deleteSync(id: TargetPoolRecordId): void {
    this.#byId.delete(id);
  }
}

export class InMemorySpacePolicyStore implements SpacePolicyStore {
  readonly #byId = new Map<SpacePolicyRecordId, SpacePolicyRecord>();

  upsert(record: SpacePolicyRecord): Promise<SpacePolicyRecord> {
    this.#byId.set(record.id, record);
    return Promise.resolve(record);
  }

  get(id: SpacePolicyRecordId): Promise<SpacePolicyRecord | undefined> {
    return Promise.resolve(this.#byId.get(id));
  }

  getByName(
    spaceId: SpaceId,
    name: string,
  ): Promise<SpacePolicyRecord | undefined> {
    for (const record of this.#byId.values()) {
      if (record.spaceId === spaceId && record.name === name) {
        return Promise.resolve(record);
      }
    }
    return Promise.resolve(undefined);
  }

  listBySpace(spaceId: SpaceId): Promise<readonly SpacePolicyRecord[]> {
    return Promise.resolve(
      [...this.#byId.values()].filter((record) => record.spaceId === spaceId),
    );
  }

  listBySpacePage(
    spaceId: SpaceId,
    params: PageParams,
  ): Promise<Page<SpacePolicyRecord>> {
    const records = [...this.#byId.values()]
      .filter((record) => record.spaceId === spaceId)
      .sort(compareCreatedAtAndId);
    return Promise.resolve(pageSorted(records, params));
  }

  delete(id: SpacePolicyRecordId): Promise<void> {
    this.#byId.delete(id);
    return Promise.resolve();
  }
}

/** Construct the in-memory store group for explicit test/dev injection. */
export function createInMemoryResourceShapeStores(): ResourceShapeStores {
  const resources = new InMemoryResourceShapeStore();
  const locks = new InMemoryResolutionLockStore();
  const targetPools = new InMemoryTargetPoolStore();
  const identityFences = new Map<
    ResourceShapeRecordId,
    ResourceIdentityFenceRecord
  >();
  return {
    persistence: "ephemeral",
    resources,
    locks,
    targetPools,
    spacePolicies: new InMemorySpacePolicyStore(),
    getResourceIdentityFence(resourceId) {
      return Promise.resolve(identityFences.get(resourceId));
    },
    putTargetPool(input) {
      assertTargetPoolPutInput(input);
      const currentById = targetPools.getSync(input.record.id);
      const currentByName = targetPools.getByNameSync(
        input.record.spaceId,
        input.record.name,
      );
      const current = currentByName ?? currentById;
      if (!matchesExpectedTargetPool(current, input.expected)) {
        return Promise.resolve({
          status: "conflict",
          ...(current ? { record: current } : {}),
        });
      }
      if (
        input.expected === null ||
        !targetPoolSpecsEqual(input.expected, input.record)
      ) {
        const reference = findInMemoryTargetPoolReference(
          resources,
          locks,
          input.expected ?? input.record,
        );
        if (reference) {
          return Promise.resolve({ status: "in_use", lock: reference });
        }
      }
      targetPools.replaceSync(input.record);
      return Promise.resolve({ status: "put", record: input.record });
    },
    deleteTargetPool(input) {
      assertTargetPoolDeleteInput(input);
      const current =
        targetPools.getSync(input.id) ??
        targetPools.getByNameSync(input.spaceId, input.name);
      if (!current) return Promise.resolve({ status: "absent" });
      if (!matchesExpectedTargetPool(current, input.expected)) {
        return Promise.resolve({
          status: "conflict",
          record: current,
        });
      }
      const reference = findInMemoryTargetPoolReference(
        resources,
        locks,
        current,
      );
      if (reference) {
        return Promise.resolve({ status: "in_use", lock: reference });
      }
      targetPools.deleteSync(current.id);
      return Promise.resolve({ status: "deleted" });
    },
    beginApply(input) {
      assertApplyPair(input.applyingRecord, input.plannedLock, "Applying");
      assertExpectedTargetPool(input);
      if (input.expectedTargetPool) {
        const current = targetPools.getByNameSync(
          input.expectedTargetPool.spaceId,
          input.expectedTargetPool.name,
        );
        if (!matchesTargetPool(current, input.expectedTargetPool)) {
          return Promise.resolve({
            status: "target_pool_conflict",
            ...(current ? { record: current } : {}),
          });
        }
      }
      const current = resources.getSync(input.applyingRecord.id);
      const currentIdentityFence = identityFences.get(input.applyingRecord.id);
      if (
        input.expectedIdentityFence !== undefined &&
        !matchesExpectedResourceIdentityFence(
          currentIdentityFence,
          input.expectedIdentityFence,
        )
      ) {
        return Promise.resolve({
          status: "identity_fence_conflict",
          ...(currentIdentityFence ? { fence: currentIdentityFence } : {}),
        });
      }
      if (input.expected === undefined) {
        if (current) {
          if (current.managedBy !== input.applyingRecord.managedBy) {
            return Promise.resolve({
              status: "ownership_conflict",
              record: current,
            });
          }
          return Promise.resolve({ status: "conflict", record: current });
        }
      } else {
        if (!current) return Promise.resolve({ status: "not_found" });
        if (current.managedBy !== input.applyingRecord.managedBy) {
          return Promise.resolve({
            status: "ownership_conflict",
            record: current,
          });
        }
        if (
          !matchesVersion(current, {
            ...input.expected,
            revision:
              input.expected.revision ??
              resourceRecordRevision(input.applyingRecord),
          })
        ) {
          return Promise.resolve({ status: "conflict", record: current });
        }
      }
      // Both mutations happen synchronously after every possible failure and
      // conflict has been checked, so no Promise turn can observe torn state.
      const persisted = current
        ? withNextResourceRevision(input.applyingRecord, current)
        : withResourceRevision(
            input.applyingRecord,
            resourceRecordRevision(input.applyingRecord),
          );
      const consumedIdentityFence =
        input.expectedIdentityFence === undefined
          ? undefined
          : consumeResourceIdentityFence(
              input.applyingRecord.id,
              input.applyingRecord.generation,
              input.expectedIdentityFence,
            );
      resources.replaceSync(persisted);
      locks.putSync(input.plannedLock);
      if (consumedIdentityFence) {
        identityFences.set(input.applyingRecord.id, consumedIdentityFence);
      }
      return Promise.resolve({
        status: "begun",
        record: persisted,
        lock: input.plannedLock,
      });
    },
    commitApply(input) {
      assertApplyPair(input.readyRecord, input.finalLock, "Ready");
      const current = resources.getSync(input.readyRecord.id);
      if (!current) return Promise.resolve({ status: "not_found" });
      if (!matchesVersion(current, input.expectedApplying)) {
        return Promise.resolve({ status: "conflict", record: current });
      }
      const persisted = withNextResourceRevision(input.readyRecord, current);
      resources.replaceSync(persisted);
      locks.putSync(input.finalLock);
      return Promise.resolve({
        status: "committed",
        record: persisted,
        lock: input.finalLock,
      });
    },
    claimResourceAggregate(input) {
      assertResourceAggregateClaimInput(input);
      const current = resources.getSync(input.record.id);
      const currentLock = locks.getSync(input.record.id);
      const currentIdentityFence = identityFences.get(input.record.id);
      if (!current && !currentLock) {
        return Promise.resolve({ status: "not_found" });
      }
      if (
        current &&
        currentLock &&
        matchesClaimedResource(current, input) &&
        matchesApplyLock(currentLock, input.expectedLock) &&
        matchesExpectedResourceIdentityFence(
          currentIdentityFence,
          input.expectedIdentityFence,
        )
      ) {
        return Promise.resolve({ status: "claimed", record: current });
      }
      if (
        !current ||
        !currentLock ||
        !matchesVersion(current, input.expectedResource) ||
        !matchesApplyLock(currentLock, input.expectedLock) ||
        !matchesExpectedResourceIdentityFence(
          currentIdentityFence,
          input.expectedIdentityFence,
        )
      ) {
        return Promise.resolve({
          status: "conflict",
          ...(current ? { record: current } : {}),
          ...(currentLock ? { lock: currentLock } : {}),
          ...(currentIdentityFence
            ? { identityFence: currentIdentityFence }
            : {}),
        });
      }
      const persisted = withNextResourceRevision(input.record, current);
      resources.replaceSync(persisted);
      return Promise.resolve({ status: "claimed", record: persisted });
    },
    replaceResourceAggregate(input) {
      assertResourceAggregateReplaceInput(input);
      const current = resources.getSync(input.record.id);
      const currentLock = locks.getSync(input.record.id);
      const currentIdentityFence = identityFences.get(input.record.id);
      if (!current && !currentLock) {
        return Promise.resolve({ status: "not_found" });
      }
      if (
        !current ||
        !currentLock ||
        !matchesVersion(current, input.expectedResource) ||
        !matchesApplyLock(currentLock, input.expectedLock) ||
        (input.identityFenceAdvance !== undefined &&
          !matchesExpectedResourceIdentityFence(
            currentIdentityFence,
            input.identityFenceAdvance.expected,
          ))
      ) {
        return Promise.resolve({
          status: "conflict",
          ...(current ? { record: current } : {}),
          ...(currentLock ? { lock: currentLock } : {}),
        });
      }
      const persisted = withNextResourceRevision(input.record, current);
      const consumedIdentityFence = input.identityFenceAdvance
        ? consumeResourceIdentityFence(
            input.record.id,
            input.record.generation,
            input.identityFenceAdvance.expected,
          )
        : undefined;
      resources.replaceSync(persisted);
      locks.putSync(input.lock);
      if (consumedIdentityFence) {
        identityFences.set(input.record.id, consumedIdentityFence);
      }
      return Promise.resolve({
        status: "replaced",
        record: persisted,
        lock: input.lock,
        ...(consumedIdentityFence
          ? { identityFence: consumedIdentityFence }
          : {}),
      });
    },
    abortApply(input) {
      assertAbortInput(input);
      const current = resources.getSync(input.resourceId);
      const currentLock = locks.getSync(input.resourceId);
      const currentIdentityFence = identityFences.get(input.resourceId);
      if (!current && !currentLock) {
        return Promise.resolve({ status: "not_found" });
      }
      if (
        !current ||
        !currentLock ||
        !matchesVersion(current, input.expectedApplying) ||
        !matchesApplyLock(currentLock, input.expectedPlannedLock) ||
        (input.identityFenceRollback !== undefined &&
          !matchesResourceIdentityFence(
            currentIdentityFence,
            input.identityFenceRollback.expected,
          ))
      ) {
        return Promise.resolve({
          status: "conflict",
          ...(current ? { record: current } : {}),
          ...(currentLock ? { lock: currentLock } : {}),
        });
      }
      // Like begin/commit, every possible failure is checked before these
      // synchronous mutations; there is no interleaving Promise turn.
      if (input.replacement) {
        resources.replaceSync(
          withNextResourceRevision(input.replacement.record, current),
        );
        if (input.replacement.lock) {
          locks.putSync(input.replacement.lock);
        } else {
          locks.deleteSync(input.resourceId);
        }
      } else {
        resources.deleteSync(input.resourceId);
        locks.deleteSync(input.resourceId);
      }
      if (input.identityFenceRollback) {
        if (input.identityFenceRollback.replacement) {
          identityFences.set(
            input.resourceId,
            input.identityFenceRollback.replacement,
          );
        } else {
          identityFences.delete(input.resourceId);
        }
      }
      return Promise.resolve({ status: "rolled_back" });
    },
    removeResource(input) {
      assertAtomicRemoveInput(input);
      const current = resources.getSync(input.resourceId);
      const currentLock = locks.getSync(input.resourceId);
      if (!current && !currentLock) {
        return Promise.resolve({ status: "not_found" });
      }
      if (
        !current ||
        !matchesVersion(current, input.expected) ||
        !matchesExpectedLock(currentLock, input.expectedLock)
      ) {
        return Promise.resolve({
          status: "conflict",
          ...(current ? { record: current } : {}),
          ...(currentLock ? { lock: currentLock } : {}),
        });
      }
      const currentIdentityFence = identityFences.get(input.resourceId);
      if (
        currentIdentityFence &&
        currentIdentityFence.lastGeneration !== current.generation
      ) {
        return Promise.resolve({
          status: "conflict",
          record: current,
          ...(currentLock ? { lock: currentLock } : {}),
        });
      }
      const retiredIdentityFence = retireResourceIdentityFence(
        current,
        currentIdentityFence,
      );
      // All predicates are checked before either synchronous mutation, so a
      // caller can never observe a Resource without its expected lock (or the
      // inverse) during finalization.
      locks.deleteSync(input.resourceId);
      resources.deleteSync(input.resourceId);
      identityFences.set(input.resourceId, retiredIdentityFence);
      return Promise.resolve({ status: "removed" });
    },
    pinExactFormIdentity(input) {
      assertResourceFormIdentityPinInput(input);
      const current = resources.getSync(input.resourceId);
      const currentLock = locks.getSync(input.resourceId);
      if (!current || !currentLock) {
        return Promise.resolve({ status: "not_found" });
      }
      if (
        resourceFormIdentitiesEqual(current.form, input.form) &&
        resourceFormIdentitiesEqual(currentLock.form, input.form)
      ) {
        assertNativeResourceFormIdentity(
          currentLock.nativeResources,
          input.form,
        );
        return Promise.resolve({
          status: "already_pinned",
          record: current,
          lock: currentLock,
        });
      }
      if (
        current.form !== undefined ||
        currentLock.form !== undefined ||
        current.kind !== shapeKindForPortableType(input.form.type) ||
        !matchesVersion(current, input.expectedResource) ||
        !matchesApplyLock(currentLock, input.expectedLock)
      ) {
        return Promise.resolve({
          status: "conflict",
          record: current,
          lock: currentLock,
        });
      }
      const record = {
        ...current,
        form: input.form,
        revision: nextResourceRevision(current),
      };
      const lock = {
        ...currentLock,
        form: input.form,
        nativeResources: bindNativeResourceFormIdentity(
          currentLock.nativeResources,
          input.form,
        ),
      };
      resources.replaceSync(record);
      locks.putSync(lock);
      return Promise.resolve({ status: "pinned", record, lock });
    },
  };
}

export function assertApplyPair(
  record: ResourceShapeRecord,
  lock: ResolutionLockRecord,
  phase: "Applying" | "Ready",
): void {
  if (record.phase !== phase) {
    throw new Error(`atomic Resource apply requires ${phase} record`);
  }
  if (lock.resourceId !== record.id) {
    throw new Error(
      `ResolutionLock ${lock.resourceId} does not belong to Resource ${record.id}`,
    );
  }
  assertResourceFormIdentity(record.form, record.kind);
  if (!resourceFormIdentitiesEqual(record.form, lock.form)) {
    throw new Error(
      `ResolutionLock ${lock.resourceId} does not pin the Resource form identity`,
    );
  }
  assertNativeResourceFormIdentity(lock.nativeResources, record.form);
}

export function assertResourceAggregateReplaceInput(
  input: ResourceAggregateReplaceInput,
): void {
  if (input.record.id !== input.expectedLock.resourceId) {
    throw new Error("replacement Resource does not match expected lock");
  }
  if (input.lock.resourceId !== input.record.id) {
    throw new Error("replacement ResolutionLock does not match Resource");
  }
  assertResourceFormIdentity(input.record.form, input.record.kind);
  if (!resourceFormIdentitiesEqual(input.record.form, input.lock.form)) {
    throw new Error(
      "replacement Resource and ResolutionLock Form identities differ",
    );
  }
  assertNativeResourceFormIdentity(
    input.lock.nativeResources,
    input.record.form,
  );
  if (input.record.updatedAt !== input.lock.updatedAt) {
    throw new Error(
      "replacement Resource and ResolutionLock timestamps must match",
    );
  }
  if (input.identityFenceAdvance) {
    const expected = input.identityFenceAdvance.expected;
    if (expected) {
      assertResourceIdentityFence(expected);
      if (expected.resourceId !== input.record.id) {
        throw new Error(
          "replacement identity fence does not match Resource",
        );
      }
    }
    // Validate the generation step before any durable write. The returned
    // value is recomputed by each backend inside its atomic mutation.
    consumeResourceIdentityFence(
      input.record.id,
      input.record.generation,
      expected,
    );
  }
}

export function assertResourceAggregateClaimInput(
  input: ResourceAggregateClaimInput,
): void {
  if (input.record.id !== input.expectedLock.resourceId) {
    throw new Error("claimed Resource does not match expected lock");
  }
  if (
    input.record.generation !== input.expectedResource.generation ||
    input.record.phase !== input.expectedResource.phase
  ) {
    throw new Error("Resource claim must preserve generation and phase");
  }
  assertResourceFormIdentity(input.record.form, input.record.kind);
  if (!resourceFormIdentitiesEqual(input.record.form, input.expectedLock.form)) {
    throw new Error("Resource claim and expected lock Form identities differ");
  }
  assertNativeResourceFormIdentity(
    input.expectedLock.nativeResources,
    input.record.form,
  );
  const expectedFence = input.expectedIdentityFence;
  if (expectedFence) {
    assertResourceIdentityFence(expectedFence);
    if (expectedFence.resourceId !== input.record.id) {
      throw new Error("Resource claim identity fence does not match Resource");
    }
  }
  const revision =
    input.expectedResource.revision ?? resourceRecordRevision(input.record);
  if (
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    revision === Number.MAX_SAFE_INTEGER
  ) {
    throw new Error("Resource claim requires an advanceable exact revision");
  }
}

export function matchesClaimedResource(
  current: ResourceShapeRecord,
  input: ResourceAggregateClaimInput,
): boolean {
  const expectedRevision =
    input.expectedResource.revision ?? resourceRecordRevision(input.record);
  return (
    canonicalJson(current) ===
    canonicalJson({ ...input.record, revision: expectedRevision + 1 })
  );
}

export function assertExpectedTargetPool(input: ResourceApplyBeginInput): void {
  const pool = input.expectedTargetPool;
  if (!pool) return;
  if (
    pool.spaceId !== input.applyingRecord.spaceId ||
    pool.name !== input.plannedLock.targetPool
  ) {
    throw new Error(
      `expected TargetPool ${pool.id} does not match planned ResolutionLock`,
    );
  }
}

export function assertTargetPoolPutInput(input: TargetPoolPutInput): void {
  if (
    input.expected &&
    (input.expected.id !== input.record.id ||
      input.expected.spaceId !== input.record.spaceId ||
      input.expected.name !== input.record.name ||
      input.expected.createdAt !== input.record.createdAt)
  ) {
    throw new Error("TargetPool put cannot change durable identity");
  }
}

export function assertTargetPoolDeleteInput(
  input: TargetPoolDeleteInput,
): void {
  if (
    input.expected &&
    (input.expected.id !== input.id ||
      input.expected.spaceId !== input.spaceId ||
      input.expected.name !== input.name)
  ) {
    throw new Error("TargetPool delete expected record has another identity");
  }
}

export function matchesTargetPool(
  current: TargetPoolRecord | undefined,
  expected: TargetPoolRecord,
): boolean {
  return (
    current !== undefined &&
    current.id === expected.id &&
    current.spaceId === expected.spaceId &&
    current.name === expected.name &&
    current.createdAt === expected.createdAt &&
    current.updatedAt === expected.updatedAt &&
    targetPoolSpecsEqual(current, expected)
  );
}

export function matchesExpectedTargetPool(
  current: TargetPoolRecord | undefined,
  expected: TargetPoolRecord | null,
): boolean {
  return expected === null
    ? current === undefined
    : matchesTargetPool(current, expected);
}

export function targetPoolSpecsEqual(
  left: TargetPoolRecord,
  right: TargetPoolRecord,
): boolean {
  return canonicalJson(left.spec) === canonicalJson(right.spec);
}

function findInMemoryTargetPoolReference(
  resources: InMemoryResourceShapeStore,
  locks: InMemoryResolutionLockStore,
  pool: TargetPoolRecord,
): ResolutionLockRecord | undefined {
  const targetNames = targetPoolTargetNames(pool);
  for (const resource of resources.listBySpaceSync(pool.spaceId)) {
    const lock = locks.getSync(resource.id);
    if (!lock) continue;
    if (
      lock.targetPool === pool.name ||
      (!lock.targetPool && targetNames.has(lock.target))
    ) {
      return lock;
    }
  }
  return undefined;
}

function targetPoolTargetNames(pool: TargetPoolRecord): ReadonlySet<string> {
  const targets = pool.spec.targets;
  if (!Array.isArray(targets)) return new Set();
  return new Set(
    targets.flatMap((target) => {
      if (
        target &&
        typeof target === "object" &&
        !Array.isArray(target) &&
        typeof target.name === "string"
      ) {
        return [target.name];
      }
      return [];
    }),
  );
}

export function assertResourceFormIdentityPinInput(
  input: ResourceFormIdentityPinInput,
): void {
  assertResourceFormIdentity(
    input.form,
    shapeKindForPortableType(input.form.type) as ResourceShapeKind,
  );
  if (input.expectedLock.resourceId !== input.resourceId) {
    throw new Error(
      "expected ResolutionLock does not match exact Form pin Resource",
    );
  }
}

export function matchesVersion(
  record: ResourceShapeRecord,
  expected: ResourceRecordVersion,
): boolean {
  return (
    record.generation === expected.generation &&
    record.phase === expected.phase &&
    record.updatedAt === expected.updatedAt &&
    (expected.revision === undefined ||
      resourceRecordRevision(record) === expected.revision)
  );
}

/** Normalize the compatibility absence used by rows predating revision CAS. */
export function resourceRecordRevision(record: ResourceShapeRecord): number {
  const revision = record.revision ?? 0;
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error(`invalid Resource revision ${String(revision)}`);
  }
  return revision;
}

export function nextResourceRevision(record: ResourceShapeRecord): number {
  const revision = resourceRecordRevision(record);
  if (revision === Number.MAX_SAFE_INTEGER) {
    throw new Error(`Resource ${record.id} revision overflow`);
  }
  return revision + 1;
}

export function assertResourceIdentityFence(
  fence: ResourceIdentityFenceRecord,
): void {
  if (!fence.resourceId) {
    throw new Error("Resource identity fence requires a canonical resource id");
  }
  if (!Number.isSafeInteger(fence.lastGeneration) || fence.lastGeneration < 1) {
    throw new Error(
      `invalid Resource identity fence generation ${String(fence.lastGeneration)}`,
    );
  }
  if (!Number.isSafeInteger(fence.fenceRevision) || fence.fenceRevision < 1) {
    throw new Error(
      `invalid Resource identity fence revision ${String(fence.fenceRevision)}`,
    );
  }
}

export function matchesResourceIdentityFence(
  current: ResourceIdentityFenceRecord | undefined,
  expected: ResourceIdentityFenceRecord,
): boolean {
  assertResourceIdentityFence(expected);
  return (
    current !== undefined &&
    current.resourceId === expected.resourceId &&
    current.lastGeneration === expected.lastGeneration &&
    current.fenceRevision === expected.fenceRevision
  );
}

export function matchesExpectedResourceIdentityFence(
  current: ResourceIdentityFenceRecord | undefined,
  expected: ResourceIdentityFenceRecord | null,
): boolean {
  return expected === null
    ? current === undefined
    : matchesResourceIdentityFence(current, expected);
}

/** Consume the exact read-only preview/import fence for one new generation. */
export function consumeResourceIdentityFence(
  resourceId: ResourceShapeRecordId,
  generation: number,
  expected: ResourceIdentityFenceRecord | null,
): ResourceIdentityFenceRecord {
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new Error(`invalid Resource generation ${String(generation)}`);
  }
  if (expected) {
    assertResourceIdentityFence(expected);
    if (expected.resourceId !== resourceId) {
      throw new Error(
        `Resource identity fence ${expected.resourceId} does not belong to ${resourceId}`,
      );
    }
    if (generation !== expected.lastGeneration + 1) {
      throw new Error(
        `Resource ${resourceId} generation ${generation} does not advance identity fence ${expected.lastGeneration}`,
      );
    }
    if (expected.fenceRevision === Number.MAX_SAFE_INTEGER) {
      throw new Error(
        `Resource ${resourceId} identity fence revision overflow`,
      );
    }
  }
  return {
    resourceId,
    lastGeneration: generation,
    fenceRevision: (expected?.fenceRevision ?? 0) + 1,
  };
}

/** Retire one exact live generation while preserving its canonical identity. */
export function retireResourceIdentityFence(
  record: ResourceShapeRecord,
  current: ResourceIdentityFenceRecord | undefined,
): ResourceIdentityFenceRecord {
  if (!Number.isSafeInteger(record.generation) || record.generation < 1) {
    throw new Error(
      `invalid Resource ${record.id} generation ${String(record.generation)}`,
    );
  }
  if (current) {
    assertResourceIdentityFence(current);
    if (
      current.resourceId !== record.id ||
      current.lastGeneration !== record.generation
    ) {
      throw new Error(
        `Resource ${record.id} identity fence does not match live generation`,
      );
    }
    if (current.fenceRevision === Number.MAX_SAFE_INTEGER) {
      throw new Error(`Resource ${record.id} identity fence revision overflow`);
    }
  }
  return {
    resourceId: record.id,
    lastGeneration: record.generation,
    fenceRevision: (current?.fenceRevision ?? 0) + 1,
    ...(record.owner === undefined ? {} : { retiredOwner: record.owner }),
  };
}

function withResourceRevision(
  record: ResourceShapeRecord,
  revision: number,
): ResourceShapeRecord {
  return { ...record, revision };
}

function withNextResourceRevision(
  record: ResourceShapeRecord,
  current: ResourceShapeRecord,
): ResourceShapeRecord {
  return withResourceRevision(record, nextResourceRevision(current));
}

export function matchesApplyLock(
  lock: ResolutionLockRecord,
  expected: ResolutionLockRecord,
): boolean {
  return (
    lock.resourceId === expected.resourceId &&
    lock.selectedImplementation === expected.selectedImplementation &&
    lock.targetPool === expected.targetPool &&
    lock.target === expected.target &&
    canonicalJson(lock.targetSnapshot) ===
      canonicalJson(expected.targetSnapshot) &&
    canonicalJson(lock.implementationSnapshot) ===
      canonicalJson(expected.implementationSnapshot) &&
    lock.selectedImplementationPlugin ===
      expected.selectedImplementationPlugin &&
    canonicalJson(lock.selectedImplementationOptions) ===
      canonicalJson(expected.selectedImplementationOptions) &&
    lock.implementationFingerprint === expected.implementationFingerprint &&
    lock.locked === expected.locked &&
    canonicalJson(lock.reason) === canonicalJson(expected.reason) &&
    lock.portability === expected.portability &&
    canonicalJson(lock.nativeResources) ===
      canonicalJson(expected.nativeResources) &&
    resourceFormIdentitiesEqual(lock.form, expected.form) &&
    lock.lockedAt === expected.lockedAt &&
    lock.updatedAt === expected.updatedAt
  );
}

export function matchesExpectedLock(
  current: ResolutionLockRecord | undefined,
  expected: ResolutionLockRecord | null,
): boolean {
  return expected === null
    ? current === undefined
    : current !== undefined && matchesApplyLock(current, expected);
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "undefined";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const object = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

export function assertAbortInput(input: ResourceApplyAbortInput): void {
  if (input.expectedPlannedLock.resourceId !== input.resourceId) {
    throw new Error("planned ResolutionLock does not match rollback Resource");
  }
  if (input.replacement?.record.id !== undefined) {
    if (input.replacement.record.id !== input.resourceId) {
      throw new Error("replacement Resource does not match rollback Resource");
    }
    if (
      input.replacement.lock &&
      input.replacement.lock.resourceId !== input.resourceId
    ) {
      throw new Error(
        "replacement ResolutionLock does not match rollback Resource",
      );
    }
  }
  const fenceRollback = input.identityFenceRollback;
  if (fenceRollback) {
    assertResourceIdentityFence(fenceRollback.expected);
    if (fenceRollback.expected.resourceId !== input.resourceId) {
      throw new Error(
        "expected identity fence does not match rollback Resource",
      );
    }
    if (fenceRollback.replacement) {
      assertResourceIdentityFence(fenceRollback.replacement);
      if (fenceRollback.replacement.resourceId !== input.resourceId) {
        throw new Error(
          "replacement identity fence does not match rollback Resource",
        );
      }
    }
  }
}

export function assertAtomicRemoveInput(
  input: ResourceAtomicRemoveInput,
): void {
  if (
    input.expectedLock &&
    input.expectedLock.resourceId !== input.resourceId
  ) {
    throw new Error(
      "expected ResolutionLock does not match atomically removed Resource",
    );
  }
}

function compareCreatedAtAndId(
  left: Readonly<{ createdAt: string; id: string }>,
  right: Readonly<{ createdAt: string; id: string }>,
): number {
  return (
    left.createdAt.localeCompare(right.createdAt) ||
    left.id.localeCompare(right.id)
  );
}

/** Preserve every exact Capsule-id claim so its full owner can be validated. */
export function filterCapsuleOwnerPage(
  page: Page<ResourceShapeRecord>,
  spaceId: SpaceId,
  capsuleId: string,
): Page<ResourceShapeRecord> {
  return {
    items: page.items.filter((record) => {
      const owner: unknown = record.owner;
      return (
        record.spaceId === spaceId &&
        owner !== null &&
        typeof owner === "object" &&
        !Array.isArray(owner) &&
        (owner as { readonly id?: unknown }).id === capsuleId
      );
    }),
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
  };
}
