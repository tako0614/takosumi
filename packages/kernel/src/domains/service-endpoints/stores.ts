import type {
  GroupId,
  IsoTimestamp,
  ServiceEndpoint,
  ServiceEndpointHealth,
  ServiceEndpointHealthStatus,
  ServiceEndpointId,
  ServiceGrant,
  ServiceGrantId,
  ServiceId,
  ServiceTrustRecord,
  ServiceTrustRecordId,
  SpaceId,
} from "./types.ts";

export interface ServiceEndpointHealthUpdate {
  readonly status: ServiceEndpointHealthStatus;
  readonly checkedAt: IsoTimestamp;
  readonly message?: string;
  readonly updatedAt?: IsoTimestamp;
}

export interface ServiceTrustRevokeInput {
  readonly revokedAt: IsoTimestamp;
  readonly revokedBy?: string;
  readonly reason?: string;
}

export interface ServiceEndpointStore {
  put(endpoint: ServiceEndpoint): Promise<ServiceEndpoint>;
  get(id: ServiceEndpointId): Promise<ServiceEndpoint | undefined>;
  listByService(serviceId: ServiceId): Promise<readonly ServiceEndpoint[]>;
  listByGroup(
    spaceId: SpaceId,
    groupId: GroupId,
  ): Promise<readonly ServiceEndpoint[]>;
  updateHealth(
    id: ServiceEndpointId,
    update: ServiceEndpointHealthUpdate,
  ): Promise<ServiceEndpoint | undefined>;
}

export interface ServiceTrustRecordStore {
  put(record: ServiceTrustRecord): Promise<ServiceTrustRecord>;
  get(id: ServiceTrustRecordId): Promise<ServiceTrustRecord | undefined>;
  listByEndpoint(
    endpointId: ServiceEndpointId,
  ): Promise<readonly ServiceTrustRecord[]>;
  listActiveByEndpoint(
    endpointId: ServiceEndpointId,
    now?: IsoTimestamp,
  ): Promise<readonly ServiceTrustRecord[]>;
  revoke(
    id: ServiceTrustRecordId,
    input: ServiceTrustRevokeInput,
  ): Promise<ServiceTrustRecord | undefined>;
}

export interface ServiceGrantStore {
  put(grant: ServiceGrant): Promise<ServiceGrant>;
  get(id: ServiceGrantId): Promise<ServiceGrant | undefined>;
  listByTrustRecord(
    trustRecordId: ServiceTrustRecordId,
  ): Promise<readonly ServiceGrant[]>;
  listBySubject(subject: string): Promise<readonly ServiceGrant[]>;
}

export class InMemoryServiceEndpointStore implements ServiceEndpointStore {
  readonly #endpoints = new Map<ServiceEndpointId, ServiceEndpoint>();

  put(endpoint: ServiceEndpoint): Promise<ServiceEndpoint> {
    const frozen = freezeClone(endpoint);
    this.#endpoints.set(frozen.id, frozen);
    return Promise.resolve(frozen);
  }

  get(id: ServiceEndpointId): Promise<ServiceEndpoint | undefined> {
    return Promise.resolve(this.#endpoints.get(id));
  }

  listByService(serviceId: ServiceId): Promise<readonly ServiceEndpoint[]> {
    return Promise.resolve(
      [...this.#endpoints.values()].filter((endpoint) =>
        endpoint.serviceId === serviceId
      ),
    );
  }

  listByGroup(
    spaceId: SpaceId,
    groupId: GroupId,
  ): Promise<readonly ServiceEndpoint[]> {
    return Promise.resolve(
      [...this.#endpoints.values()].filter((endpoint) =>
        endpoint.spaceId === spaceId && endpoint.groupId === groupId
      ),
    );
  }

  updateHealth(
    id: ServiceEndpointId,
    update: ServiceEndpointHealthUpdate,
  ): Promise<ServiceEndpoint | undefined> {
    const existing = this.#endpoints.get(id);
    if (!existing) return Promise.resolve(undefined);

    const health: ServiceEndpointHealth = {
      status: update.status,
      checkedAt: update.checkedAt,
      ...(update.message === undefined ? {} : { message: update.message }),
    };
    const updated = freezeClone({
      ...existing,
      health,
      updatedAt: update.updatedAt ?? update.checkedAt,
    });
    this.#endpoints.set(id, updated);
    return Promise.resolve(updated);
  }
}

export class InMemoryServiceTrustRecordStore
  implements ServiceTrustRecordStore {
  readonly #records = new Map<ServiceTrustRecordId, ServiceTrustRecord>();

  put(record: ServiceTrustRecord): Promise<ServiceTrustRecord> {
    const frozen = freezeClone(record);
    this.#records.set(frozen.id, frozen);
    return Promise.resolve(frozen);
  }

  get(id: ServiceTrustRecordId): Promise<ServiceTrustRecord | undefined> {
    return Promise.resolve(this.#records.get(id));
  }

  listByEndpoint(
    endpointId: ServiceEndpointId,
  ): Promise<readonly ServiceTrustRecord[]> {
    return Promise.resolve(
      [...this.#records.values()].filter((record) =>
        record.endpointId === endpointId
      ),
    );
  }

  listActiveByEndpoint(
    endpointId: ServiceEndpointId,
    now?: IsoTimestamp,
  ): Promise<readonly ServiceTrustRecord[]> {
    return Promise.resolve(
      [...this.#records.values()].filter((record) =>
        record.endpointId === endpointId && record.status === "active" &&
        (now === undefined || record.expiresAt === undefined ||
          record.expiresAt > now)
      ),
    );
  }

  revoke(
    id: ServiceTrustRecordId,
    input: ServiceTrustRevokeInput,
  ): Promise<ServiceTrustRecord | undefined> {
    const existing = this.#records.get(id);
    if (!existing) return Promise.resolve(undefined);
    if (existing.status === "revoked") return Promise.resolve(existing);

    const revoked = freezeClone({
      ...existing,
      status: "revoked" as const,
      updatedAt: input.revokedAt,
      revokedAt: input.revokedAt,
      ...(input.revokedBy === undefined ? {} : { revokedBy: input.revokedBy }),
      ...(input.reason === undefined ? {} : { revokeReason: input.reason }),
    });
    this.#records.set(id, revoked);
    return Promise.resolve(revoked);
  }
}

export class InMemoryServiceGrantStore implements ServiceGrantStore {
  readonly #grants = new Map<ServiceGrantId, ServiceGrant>();

  put(grant: ServiceGrant): Promise<ServiceGrant> {
    const frozen = freezeClone(grant);
    this.#grants.set(frozen.id, frozen);
    return Promise.resolve(frozen);
  }

  get(id: ServiceGrantId): Promise<ServiceGrant | undefined> {
    return Promise.resolve(this.#grants.get(id));
  }

  listByTrustRecord(
    trustRecordId: ServiceTrustRecordId,
  ): Promise<readonly ServiceGrant[]> {
    return Promise.resolve(
      [...this.#grants.values()].filter((grant) =>
        grant.trustRecordId === trustRecordId
      ),
    );
  }

  listBySubject(subject: string): Promise<readonly ServiceGrant[]> {
    return Promise.resolve(
      [...this.#grants.values()].filter((grant) => grant.subject === subject),
    );
  }
}

function freezeClone<T>(value: T): T {
  return deepFreeze(structuredClone(value));
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
