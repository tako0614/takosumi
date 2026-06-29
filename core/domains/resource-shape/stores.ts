// Resource Shape store interfaces + in-memory implementations.
//
// The interfaces are the contract the service layer depends on. Durable
// implementations (Cloudflare D1 + Postgres) mirror these and are wired on the
// deploy-control persistence plane; the in-memory stores here keep the service
// runnable in tests and self-host defaults without a database.

import type { ResourceShapeKind } from "takosumi-contract";
import type { SpaceId } from "../../shared/ids.ts";
import type {
  ResolutionLockRecord,
  ResourceShapeRecord,
  ResourceShapeRecordId,
  SpacePolicyRecord,
  SpacePolicyRecordId,
  TargetPoolRecord,
  TargetPoolRecordId,
} from "./records.ts";

export interface ResourceShapeStore {
  upsert(record: ResourceShapeRecord): Promise<ResourceShapeRecord>;
  get(id: ResourceShapeRecordId): Promise<ResourceShapeRecord | undefined>;
  getByName(
    spaceId: SpaceId,
    kind: ResourceShapeKind,
    name: string,
  ): Promise<ResourceShapeRecord | undefined>;
  listBySpace(spaceId: SpaceId): Promise<readonly ResourceShapeRecord[]>;
  delete(id: ResourceShapeRecordId): Promise<void>;
}

export interface ResolutionLockStore {
  put(lock: ResolutionLockRecord): Promise<ResolutionLockRecord>;
  get(
    resourceId: ResourceShapeRecordId,
  ): Promise<ResolutionLockRecord | undefined>;
  delete(resourceId: ResourceShapeRecordId): Promise<void>;
}

export interface TargetPoolStore {
  upsert(record: TargetPoolRecord): Promise<TargetPoolRecord>;
  get(id: TargetPoolRecordId): Promise<TargetPoolRecord | undefined>;
  getByName(
    spaceId: SpaceId,
    name: string,
  ): Promise<TargetPoolRecord | undefined>;
  listBySpace(spaceId: SpaceId): Promise<readonly TargetPoolRecord[]>;
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
  delete(id: SpacePolicyRecordId): Promise<void>;
}

/** The four Resource Shape stores, grouped for transaction wiring. */
export interface ResourceShapeStores {
  readonly resources: ResourceShapeStore;
  readonly locks: ResolutionLockStore;
  readonly targetPools: TargetPoolStore;
  readonly spacePolicies: SpacePolicyStore;
}

// --- In-memory implementations -----------------------------------------------

export class InMemoryResourceShapeStore implements ResourceShapeStore {
  readonly #byId = new Map<ResourceShapeRecordId, ResourceShapeRecord>();

  upsert(record: ResourceShapeRecord): Promise<ResourceShapeRecord> {
    this.#byId.set(record.id, record);
    return Promise.resolve(record);
  }

  get(id: ResourceShapeRecordId): Promise<ResourceShapeRecord | undefined> {
    return Promise.resolve(this.#byId.get(id));
  }

  getByName(
    spaceId: SpaceId,
    kind: ResourceShapeKind,
    name: string,
  ): Promise<ResourceShapeRecord | undefined> {
    for (const record of this.#byId.values()) {
      if (
        record.spaceId === spaceId && record.kind === kind &&
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

  delete(id: ResourceShapeRecordId): Promise<void> {
    this.#byId.delete(id);
    return Promise.resolve();
  }
}

export class InMemoryResolutionLockStore implements ResolutionLockStore {
  readonly #byResource = new Map<ResourceShapeRecordId, ResolutionLockRecord>();

  put(lock: ResolutionLockRecord): Promise<ResolutionLockRecord> {
    this.#byResource.set(lock.resourceId, lock);
    return Promise.resolve(lock);
  }

  get(
    resourceId: ResourceShapeRecordId,
  ): Promise<ResolutionLockRecord | undefined> {
    return Promise.resolve(this.#byResource.get(resourceId));
  }

  delete(resourceId: ResourceShapeRecordId): Promise<void> {
    this.#byResource.delete(resourceId);
    return Promise.resolve();
  }
}

export class InMemoryTargetPoolStore implements TargetPoolStore {
  readonly #byId = new Map<TargetPoolRecordId, TargetPoolRecord>();

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

  delete(id: SpacePolicyRecordId): Promise<void> {
    this.#byId.delete(id);
    return Promise.resolve();
  }
}

/** Construct the in-memory store group (used by tests + self-host default). */
export function createInMemoryResourceShapeStores(): ResourceShapeStores {
  return {
    resources: new InMemoryResourceShapeStore(),
    locks: new InMemoryResolutionLockStore(),
    targetPools: new InMemoryTargetPoolStore(),
    spacePolicies: new InMemorySpacePolicyStore(),
  };
}
