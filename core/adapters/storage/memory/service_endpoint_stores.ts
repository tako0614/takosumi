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
import { filterValues, getFrom, immutable, putValue } from "./helpers.ts";

export class MemoryServiceEndpointStore implements ServiceEndpointStore {
  constructor(
    private readonly endpoints: Map<ServiceEndpointId, ServiceEndpoint>,
  ) {}

  put(endpoint: ServiceEndpoint): Promise<ServiceEndpoint> {
    return putValue(this.endpoints, endpoint.id, endpoint);
  }

  get(id: ServiceEndpointId): Promise<ServiceEndpoint | undefined> {
    return getFrom(this.endpoints, id);
  }

  listByService(serviceId: ServiceId): Promise<readonly ServiceEndpoint[]> {
    return filterValues(
      this.endpoints,
      (endpoint) => endpoint.serviceId === serviceId,
    );
  }

  listByGroup(
    spaceId: string,
    groupId: string,
  ): Promise<readonly ServiceEndpoint[]> {
    return filterValues(
      this.endpoints,
      (endpoint) => endpoint.spaceId === spaceId && endpoint.groupId === groupId,
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
    return putValue(this.records, record.id, record);
  }

  get(id: ServiceTrustRecordId): Promise<ServiceTrustRecord | undefined> {
    return getFrom(this.records, id);
  }

  listByEndpoint(
    endpointId: ServiceEndpointId,
  ): Promise<readonly ServiceTrustRecord[]> {
    return filterValues(
      this.records,
      (record) => record.endpointId === endpointId,
    );
  }

  listActiveByEndpoint(
    endpointId: ServiceEndpointId,
    now?: string,
  ): Promise<readonly ServiceTrustRecord[]> {
    return filterValues(
      this.records,
      (record) =>
        record.endpointId === endpointId && record.status === "active" &&
        (now === undefined || record.expiresAt === undefined ||
          record.expiresAt > now),
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
    return putValue(this.grants, grant.id, grant);
  }

  get(id: ServiceGrantId): Promise<ServiceGrant | undefined> {
    return getFrom(this.grants, id);
  }

  listByTrustRecord(
    trustRecordId: ServiceTrustRecordId,
  ): Promise<readonly ServiceGrant[]> {
    return filterValues(
      this.grants,
      (grant) => grant.trustRecordId === trustRecordId,
    );
  }

  listBySubject(subject: string): Promise<readonly ServiceGrant[]> {
    return filterValues(this.grants, (grant) => grant.subject === subject);
  }
}
