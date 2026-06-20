import { freezeClone } from "../../shared/freeze.ts";
import type {
  ServiceBinding,
  ServiceExport,
  ServiceGrant,
  ServiceGraphCapability,
  ServiceGrantStatus,
} from "takosumi-contract/service-graph";
import {
  assertValidServiceBinding,
  assertValidServiceExport,
  assertValidServiceGrant,
} from "takosumi-contract/service-graph";

export interface ServiceExportStore {
  put(record: ServiceExport): Promise<ServiceExport>;
  get(id: string): Promise<ServiceExport | undefined>;
  listByWorkspace(workspaceId: string): Promise<readonly ServiceExport[]>;
  listByProducerCapsule(
    producerCapsuleId: string,
  ): Promise<readonly ServiceExport[]>;
  listByCapability(
    workspaceId: string,
    capability: ServiceGraphCapability,
  ): Promise<readonly ServiceExport[]>;
}

export interface ServiceBindingStore {
  put(record: ServiceBinding): Promise<ServiceBinding>;
  get(id: string): Promise<ServiceBinding | undefined>;
  listByWorkspace(workspaceId: string): Promise<readonly ServiceBinding[]>;
  listByConsumerCapsule(
    consumerCapsuleId: string,
  ): Promise<readonly ServiceBinding[]>;
  listBySelectedExport(
    serviceExportId: string,
  ): Promise<readonly ServiceBinding[]>;
}

export interface ServiceGraphGrantStore {
  put(record: ServiceGrant): Promise<ServiceGrant>;
  get(id: string): Promise<ServiceGrant | undefined>;
  listByBinding(bindingId: string): Promise<readonly ServiceGrant[]>;
  listByServiceExport(
    serviceExportId: string,
  ): Promise<readonly ServiceGrant[]>;
  listByConsumerCapsule(
    consumerCapsuleId: string,
  ): Promise<readonly ServiceGrant[]>;
  listActiveByConsumerCapsule(
    consumerCapsuleId: string,
    now?: string,
  ): Promise<readonly ServiceGrant[]>;
}

export class InMemoryServiceExportStore implements ServiceExportStore {
  constructor(private readonly records = new Map<string, ServiceExport>()) {}

  put(record: ServiceExport): Promise<ServiceExport> {
    assertValidServiceExport(record);
    const frozen = freezeClone(record);
    this.records.set(frozen.id, frozen);
    return Promise.resolve(frozen);
  }

  get(id: string): Promise<ServiceExport | undefined> {
    return Promise.resolve(this.records.get(id));
  }

  listByWorkspace(workspaceId: string): Promise<readonly ServiceExport[]> {
    return Promise.resolve(
      [...this.records.values()].filter(
        (record) => record.workspaceId === workspaceId,
      ),
    );
  }

  listByProducerCapsule(
    producerCapsuleId: string,
  ): Promise<readonly ServiceExport[]> {
    return Promise.resolve(
      [...this.records.values()].filter(
        (record) => record.producerCapsuleId === producerCapsuleId,
      ),
    );
  }

  listByCapability(
    workspaceId: string,
    capability: ServiceGraphCapability,
  ): Promise<readonly ServiceExport[]> {
    return Promise.resolve(
      [...this.records.values()].filter(
        (record) =>
          record.workspaceId === workspaceId &&
          record.revokedAt === undefined &&
          record.capabilities.includes(capability),
      ),
    );
  }
}

export class InMemoryServiceBindingStore implements ServiceBindingStore {
  constructor(private readonly records = new Map<string, ServiceBinding>()) {}

  put(record: ServiceBinding): Promise<ServiceBinding> {
    assertValidServiceBinding(record);
    const frozen = freezeClone(record);
    this.records.set(frozen.id, frozen);
    return Promise.resolve(frozen);
  }

  get(id: string): Promise<ServiceBinding | undefined> {
    return Promise.resolve(this.records.get(id));
  }

  listByWorkspace(workspaceId: string): Promise<readonly ServiceBinding[]> {
    return Promise.resolve(
      [...this.records.values()].filter(
        (record) => record.workspaceId === workspaceId,
      ),
    );
  }

  listByConsumerCapsule(
    consumerCapsuleId: string,
  ): Promise<readonly ServiceBinding[]> {
    return Promise.resolve(
      [...this.records.values()].filter(
        (record) => record.consumerCapsuleId === consumerCapsuleId,
      ),
    );
  }

  listBySelectedExport(
    serviceExportId: string,
  ): Promise<readonly ServiceBinding[]> {
    return Promise.resolve(
      [...this.records.values()].filter(
        (record) => record.selectedServiceExportId === serviceExportId,
      ),
    );
  }
}

export class InMemoryServiceGraphGrantStore implements ServiceGraphGrantStore {
  constructor(private readonly records = new Map<string, ServiceGrant>()) {}

  put(record: ServiceGrant): Promise<ServiceGrant> {
    assertValidServiceGrant(record);
    const frozen = freezeClone(record);
    this.records.set(frozen.id, frozen);
    return Promise.resolve(frozen);
  }

  get(id: string): Promise<ServiceGrant | undefined> {
    return Promise.resolve(this.records.get(id));
  }

  listByBinding(bindingId: string): Promise<readonly ServiceGrant[]> {
    return Promise.resolve(
      [...this.records.values()].filter(
        (record) => record.bindingId === bindingId,
      ),
    );
  }

  listByServiceExport(
    serviceExportId: string,
  ): Promise<readonly ServiceGrant[]> {
    return Promise.resolve(
      [...this.records.values()].filter(
        (record) => record.serviceExportId === serviceExportId,
      ),
    );
  }

  listByConsumerCapsule(
    consumerCapsuleId: string,
  ): Promise<readonly ServiceGrant[]> {
    return Promise.resolve(
      [...this.records.values()].filter(
        (record) => record.consumerCapsuleId === consumerCapsuleId,
      ),
    );
  }

  listActiveByConsumerCapsule(
    consumerCapsuleId: string,
    now?: string,
  ): Promise<readonly ServiceGrant[]> {
    return Promise.resolve(
      [...this.records.values()].filter(
        (record) =>
          record.consumerCapsuleId === consumerCapsuleId &&
          isActive(record.status, record.expiresAt, now),
      ),
    );
  }
}

function isActive(
  status: ServiceGrantStatus,
  expiresAt: string | undefined,
  now: string | undefined,
): boolean {
  return (
    status === "active" &&
    (now === undefined || expiresAt === undefined || expiresAt > now)
  );
}
