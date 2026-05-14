// In-memory implementations of the service-endpoint domain stores:
//   - MemoryServiceEndpointStore
//   - MemoryServiceTrustRecordStore
//   - MemoryServiceGrantStore

import type {
  ServiceEndpointHealthUpdate,
  ServiceEndpointStore,
  ServiceGrantStore,
  ServiceTrustRecordStore,
  ServiceTrustRevokeInput,
} from "../../../domains/service-endpoints/stores.ts";
import type {
  ServiceEndpoint,
  ServiceEndpointHealth,
  ServiceEndpointId,
  ServiceGrant,
  ServiceGrantId,
  ServiceId,
  ServiceTrustRecord,
  ServiceTrustRecordId,
} from "../../../domains/service-endpoints/types.ts";
import { immutable } from "./helpers.ts";

export class MemoryServiceEndpointStore implements ServiceEndpointStore {
  constructor(
    private readonly endpoints: Map<ServiceEndpointId, ServiceEndpoint>,
  ) {}

  put(endpoint: ServiceEndpoint): Promise<ServiceEndpoint> {
    const value = immutable(endpoint);
    this.endpoints.set(value.id, value);
    return Promise.resolve(value);
  }

  get(id: ServiceEndpointId): Promise<ServiceEndpoint | undefined> {
    return Promise.resolve(this.endpoints.get(id));
  }

  listByService(serviceId: ServiceId): Promise<readonly ServiceEndpoint[]> {
    return Promise.resolve(
      [...this.endpoints.values()].filter((endpoint) =>
        endpoint.serviceId === serviceId
      ),
    );
  }

  listByGroup(
    spaceId: string,
    groupId: string,
  ): Promise<readonly ServiceEndpoint[]> {
    return Promise.resolve(
      [...this.endpoints.values()].filter((endpoint) =>
        endpoint.spaceId === spaceId && endpoint.groupId === groupId
      ),
    );
  }

  updateHealth(
    id: ServiceEndpointId,
    update: ServiceEndpointHealthUpdate,
  ): Promise<ServiceEndpoint | undefined> {
    const existing = this.endpoints.get(id);
    if (!existing) return Promise.resolve(undefined);
    const health: ServiceEndpointHealth = {
      status: update.status,
      checkedAt: update.checkedAt,
      ...(update.message === undefined ? {} : { message: update.message }),
    };
    const updated = immutable({
      ...existing,
      health,
      updatedAt: update.updatedAt ?? update.checkedAt,
    });
    this.endpoints.set(id, updated);
    return Promise.resolve(updated);
  }
}

export class MemoryServiceTrustRecordStore implements ServiceTrustRecordStore {
  constructor(
    private readonly records: Map<ServiceTrustRecordId, ServiceTrustRecord>,
  ) {}

  put(record: ServiceTrustRecord): Promise<ServiceTrustRecord> {
    const value = immutable(record);
    this.records.set(value.id, value);
    return Promise.resolve(value);
  }

  get(id: ServiceTrustRecordId): Promise<ServiceTrustRecord | undefined> {
    return Promise.resolve(this.records.get(id));
  }

  listByEndpoint(
    endpointId: ServiceEndpointId,
  ): Promise<readonly ServiceTrustRecord[]> {
    return Promise.resolve(
      [...this.records.values()].filter((record) =>
        record.endpointId === endpointId
      ),
    );
  }

  listActiveByEndpoint(
    endpointId: ServiceEndpointId,
    now?: string,
  ): Promise<readonly ServiceTrustRecord[]> {
    return Promise.resolve(
      [...this.records.values()].filter((record) =>
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
    const existing = this.records.get(id);
    if (!existing) return Promise.resolve(undefined);
    if (existing.status === "revoked") return Promise.resolve(existing);

    const revoked = immutable({
      ...existing,
      status: "revoked" as const,
      updatedAt: input.revokedAt,
      revokedAt: input.revokedAt,
      ...(input.revokedBy === undefined ? {} : { revokedBy: input.revokedBy }),
      ...(input.reason === undefined ? {} : { revokeReason: input.reason }),
    });
    this.records.set(id, revoked);
    return Promise.resolve(revoked);
  }
}

export class MemoryServiceGrantStore implements ServiceGrantStore {
  constructor(private readonly grants: Map<ServiceGrantId, ServiceGrant>) {}

  put(grant: ServiceGrant): Promise<ServiceGrant> {
    const value = immutable(grant);
    this.grants.set(value.id, value);
    return Promise.resolve(value);
  }

  get(id: ServiceGrantId): Promise<ServiceGrant | undefined> {
    return Promise.resolve(this.grants.get(id));
  }

  listByTrustRecord(
    trustRecordId: ServiceTrustRecordId,
  ): Promise<readonly ServiceGrant[]> {
    return Promise.resolve(
      [...this.grants.values()].filter((grant) =>
        grant.trustRecordId === trustRecordId
      ),
    );
  }

  listBySubject(subject: string): Promise<readonly ServiceGrant[]> {
    return Promise.resolve(
      [...this.grants.values()].filter((grant) => grant.subject === subject),
    );
  }
}
