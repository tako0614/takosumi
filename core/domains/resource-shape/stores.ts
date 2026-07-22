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
import {
  pageSorted,
  type Page,
  type PageParams,
} from "takosumi-contract/pagination";
import type { SpaceId } from "../../shared/ids.ts";
import type {
  ResolutionLockRecord,
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
}

export interface ResourceApplyingVersion {
  readonly generation: number;
  readonly phase: "Applying";
  readonly updatedAt: string;
}

export interface ResourceApplyBeginInput {
  readonly applyingRecord: ResourceShapeRecord;
  readonly plannedLock: ResolutionLockRecord;
  /** Omit only for a create-only claim. Present means CAS-only. */
  readonly expected?: ResourceRecordVersion;
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
      readonly status: "ownership_conflict";
      readonly record: ResourceShapeRecord;
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
  delete(resourceId: ResourceShapeRecordId): Promise<void>;
}

export type TargetPoolCreateResult =
  | { readonly status: "created"; readonly record: TargetPoolRecord }
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
  /**
   * Atomically claims an apply by publishing the Applying Resource together
   * with the planned ResolutionLock. `expected` selects CAS-only behavior;
   * omitting it selects create-only behavior.
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
    this.#byId.set(record.id, record);
    return { status: "created", record };
  }

  upsert(record: ResourceShapeRecord): Promise<ResourceShapeRecord> {
    this.#byId.set(record.id, record);
    return Promise.resolve(record);
  }

  get(id: ResourceShapeRecordId): Promise<ResourceShapeRecord | undefined> {
    return Promise.resolve(this.#byId.get(id));
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
    return Promise.resolve(
      [...this.#byId.values()].filter((record) => record.spaceId === spaceId),
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
  ): Promise<Page<ResourceShapeRecord>> {
    const records = [...this.#byId.values()]
      .filter(
        (record) =>
          record.kind === kind &&
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
    if (
      current.generation !== expected.generation ||
      current.phase !== expected.phase ||
      current.updatedAt !== expected.updatedAt
    ) {
      return Promise.resolve({ status: "conflict", record: current });
    }
    this.#byId.set(record.id, record);
    return Promise.resolve({ status: "updated", record });
  }

  deleteIfVersion(
    id: ResourceShapeRecordId,
    expected: ResourceRecordVersion,
  ): Promise<boolean> {
    const current = this.#byId.get(id);
    if (
      !current ||
      current.generation !== expected.generation ||
      current.phase !== expected.phase ||
      current.updatedAt !== expected.updatedAt
    ) {
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
    this.#byId.set(record.id, record);
    return Promise.resolve({ status: "claimed", record });
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
    this.#byId.set(record.id, record);
    return Promise.resolve(record);
  }

  get(id: TargetPoolRecordId): Promise<TargetPoolRecord | undefined> {
    return Promise.resolve(this.#byId.get(id));
  }

  getByName(
    spaceId: SpaceId,
    name: string,
  ): Promise<TargetPoolRecord | undefined> {
    for (const record of this.#byId.values()) {
      if (record.spaceId === spaceId && record.name === name) {
        return Promise.resolve(record);
      }
    }
    return Promise.resolve(undefined);
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
    this.#byId.delete(id);
    return Promise.resolve();
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
  return {
    persistence: "ephemeral",
    resources,
    locks,
    targetPools: new InMemoryTargetPoolStore(),
    spacePolicies: new InMemorySpacePolicyStore(),
    beginApply(input) {
      assertApplyPair(input.applyingRecord, input.plannedLock, "Applying");
      const current = resources.getSync(input.applyingRecord.id);
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
        if (!matchesVersion(current, input.expected)) {
          return Promise.resolve({ status: "conflict", record: current });
        }
      }
      // Both mutations happen synchronously after every possible failure and
      // conflict has been checked, so no Promise turn can observe torn state.
      resources.replaceSync(input.applyingRecord);
      locks.putSync(input.plannedLock);
      return Promise.resolve({
        status: "begun",
        record: input.applyingRecord,
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
      resources.replaceSync(input.readyRecord);
      locks.putSync(input.finalLock);
      return Promise.resolve({
        status: "committed",
        record: input.readyRecord,
        lock: input.finalLock,
      });
    },
    abortApply(input) {
      assertAbortInput(input);
      const current = resources.getSync(input.resourceId);
      const currentLock = locks.getSync(input.resourceId);
      if (!current && !currentLock) {
        return Promise.resolve({ status: "not_found" });
      }
      if (
        !current ||
        !currentLock ||
        !matchesVersion(current, input.expectedApplying) ||
        !matchesApplyLock(currentLock, input.expectedPlannedLock)
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
        resources.replaceSync(input.replacement.record);
        if (input.replacement.lock) {
          locks.putSync(input.replacement.lock);
        } else {
          locks.deleteSync(input.resourceId);
        }
      } else {
        resources.deleteSync(input.resourceId);
        locks.deleteSync(input.resourceId);
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
      // All predicates are checked before either synchronous mutation, so a
      // caller can never observe a Resource without its expected lock (or the
      // inverse) during finalization.
      locks.deleteSync(input.resourceId);
      resources.deleteSync(input.resourceId);
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
        current.kind !== input.form.formRef.kind ||
        !matchesVersion(current, input.expectedResource) ||
        !matchesApplyLock(currentLock, input.expectedLock)
      ) {
        return Promise.resolve({
          status: "conflict",
          record: current,
          lock: currentLock,
        });
      }
      const record = { ...current, form: input.form };
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

export function assertResourceFormIdentityPinInput(
  input: ResourceFormIdentityPinInput,
): void {
  assertResourceFormIdentity(
    input.form,
    input.form.formRef.kind as ResourceShapeKind,
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
    record.updatedAt === expected.updatedAt
  );
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
