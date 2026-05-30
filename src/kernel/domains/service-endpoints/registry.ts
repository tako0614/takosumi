import type {
  IsoTimestamp,
  ServiceEndpoint,
  ServiceEndpointId,
  ServiceGrant,
  ServiceTrustRecord,
  ServiceTrustRecordId,
} from "./types.ts";
import type {
  ServiceEndpointHealthUpdate,
  ServiceEndpointStore,
  ServiceGrantStore,
  ServiceTrustRecordStore,
  ServiceTrustRevokeInput,
} from "./stores.ts";

export interface ServiceEndpointRegistryStores {
  readonly endpoints: ServiceEndpointStore;
  readonly trustRecords: ServiceTrustRecordStore;
  readonly grants: ServiceGrantStore;
}

export class ServiceEndpointRegistry {
  readonly #stores: ServiceEndpointRegistryStores;

  constructor(stores: ServiceEndpointRegistryStores) {
    this.#stores = stores;
  }

  registerEndpoint(endpoint: ServiceEndpoint): Promise<ServiceEndpoint> {
    return this.#stores.endpoints.put(endpoint);
  }

  getEndpoint(
    id: ServiceEndpointId,
  ): Promise<ServiceEndpoint | undefined> {
    return this.#stores.endpoints.get(id);
  }

  updateHealth(
    id: ServiceEndpointId,
    update: ServiceEndpointHealthUpdate,
  ): Promise<ServiceEndpoint | undefined> {
    return this.#stores.endpoints.updateHealth(id, update);
  }

  recordTrust(record: ServiceTrustRecord): Promise<ServiceTrustRecord> {
    return this.#stores.trustRecords.put(record);
  }

  revokeTrust(
    id: ServiceTrustRecordId,
    input: ServiceTrustRevokeInput,
  ): Promise<ServiceTrustRecord | undefined> {
    return this.#stores.trustRecords.revoke(id, input);
  }

  grantAccess(grant: ServiceGrant): Promise<ServiceGrant> {
    return this.#stores.grants.put(grant);
  }

  async listEffectiveGrantsForEndpoint(
    endpointId: ServiceEndpointId,
    now?: IsoTimestamp,
  ): Promise<readonly ServiceGrant[]> {
    const activeTrustRecords = await this.#stores.trustRecords
      .listActiveByEndpoint(endpointId, now);
    const grants = await Promise.all(
      activeTrustRecords.map((record) =>
        this.#stores.grants.listByTrustRecord(record.id)
      ),
    );
    return grants.flat().filter((grant) =>
      now === undefined || grant.expiresAt === undefined ||
      grant.expiresAt > now
    );
  }
}
