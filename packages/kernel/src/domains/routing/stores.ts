import type {
  RouteOwnershipRecord,
  RouteProjection,
  RouteProjectionId,
} from "./types.ts";

export interface RouteProjectionStore {
  put(projection: RouteProjection): Promise<RouteProjection>;
  get(id: RouteProjectionId): Promise<RouteProjection | undefined>;
  findByActivation(
    spaceId: string,
    groupId: string,
    activationId: string,
  ): Promise<RouteProjection | undefined>;
}

export interface RouteOwnershipStore {
  claim(record: RouteOwnershipRecord): Promise<RouteOwnershipRecord>;
  release(
    key: string,
    releasedAt?: string,
  ): Promise<RouteOwnershipRecord | undefined>;
  get(key: string): Promise<RouteOwnershipRecord | undefined>;
  listByOwner(
    spaceId: string,
    groupId: string,
  ): Promise<readonly RouteOwnershipRecord[]>;
}

export class InMemoryRouteProjectionStore implements RouteProjectionStore {
  readonly #projections = new Map<RouteProjectionId, RouteProjection>();

  put(projection: RouteProjection): Promise<RouteProjection> {
    const frozen = deepFreeze(structuredClone(projection));
    this.#projections.set(frozen.id, frozen);
    return Promise.resolve(frozen);
  }

  get(id: RouteProjectionId): Promise<RouteProjection | undefined> {
    return Promise.resolve(this.#projections.get(id));
  }

  findByActivation(
    spaceId: string,
    groupId: string,
    activationId: string,
  ): Promise<RouteProjection | undefined> {
    for (const projection of this.#projections.values()) {
      if (
        projection.spaceId === spaceId && projection.groupId === groupId &&
        projection.activationId === activationId
      ) {
        return Promise.resolve(projection);
      }
    }
    return Promise.resolve(undefined);
  }
}

export class InMemoryRouteOwnershipStore implements RouteOwnershipStore {
  readonly #records = new Map<string, RouteOwnershipRecord>();

  claim(record: RouteOwnershipRecord): Promise<RouteOwnershipRecord> {
    const existing = this.#records.get(record.key);
    const status = existing && !sameOwner(existing, record)
      ? "conflict"
      : record.status;
    const frozen = deepFreeze(structuredClone({ ...record, status }));
    this.#records.set(frozen.key, frozen);
    return Promise.resolve(frozen);
  }

  release(
    key: string,
    releasedAt?: string,
  ): Promise<RouteOwnershipRecord | undefined> {
    const existing = this.#records.get(key);
    if (!existing) return Promise.resolve(undefined);
    const released = deepFreeze(
      structuredClone({
        ...existing,
        status: "released" as const,
        updatedAt: releasedAt ?? new Date().toISOString(),
      }),
    );
    this.#records.set(key, released);
    return Promise.resolve(released);
  }

  get(key: string): Promise<RouteOwnershipRecord | undefined> {
    return Promise.resolve(this.#records.get(key));
  }

  listByOwner(
    spaceId: string,
    groupId: string,
  ): Promise<readonly RouteOwnershipRecord[]> {
    return Promise.resolve(
      [...this.#records.values()].filter((record) =>
        record.owner.spaceId === spaceId && record.owner.groupId === groupId
      ),
    );
  }
}

function sameOwner(a: RouteOwnershipRecord, b: RouteOwnershipRecord): boolean {
  return a.owner.spaceId === b.owner.spaceId &&
    a.owner.groupId === b.owner.groupId &&
    a.owner.activationId === b.owner.activationId &&
    a.owner.routeName === b.owner.routeName;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
  }
  return value;
}
