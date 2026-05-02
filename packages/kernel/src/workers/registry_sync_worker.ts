import type {
  BundledRegistry,
  PackageDescriptorStore,
  PackageKind,
  PackageResolutionStore,
  TrustRecordStore,
} from "../domains/registry/mod.ts";
import {
  createDomainEvent,
  type DomainEvent,
  type OutboxStore,
} from "../shared/events.ts";

export interface RegistryPackageRef {
  readonly kind: PackageKind;
  readonly ref: string;
}

export interface RegistrySyncWorkerOptions {
  readonly registry: BundledRegistry;
  readonly descriptors?: PackageDescriptorStore;
  readonly resolutions?: PackageResolutionStore;
  readonly trustRecords?: TrustRecordStore;
  readonly outboxStore?: OutboxStore;
}

export interface RegistrySyncResult {
  readonly synced: number;
  readonly missing: number;
  readonly events: readonly DomainEvent[];
}

export class RegistrySyncWorker {
  readonly #registry: BundledRegistry;
  readonly #descriptors?: PackageDescriptorStore;
  readonly #resolutions?: PackageResolutionStore;
  readonly #trustRecords?: TrustRecordStore;
  readonly #outboxStore?: OutboxStore;

  constructor(options: RegistrySyncWorkerOptions) {
    this.#registry = options.registry;
    this.#descriptors = options.descriptors;
    this.#resolutions = options.resolutions;
    this.#trustRecords = options.trustRecords;
    this.#outboxStore = options.outboxStore;
  }

  async syncPackages(
    refs: readonly RegistryPackageRef[],
  ): Promise<RegistrySyncResult> {
    let synced = 0;
    let missing = 0;
    const events: DomainEvent[] = [];
    for (const packageRef of refs) {
      const resolution = await this.#registry.resolve(
        packageRef.kind,
        packageRef.ref,
      );
      if (!resolution) {
        missing += 1;
        continue;
      }
      await this.#resolutions?.record(resolution);
      const descriptor = await this.#registry.getDescriptor(
        resolution.kind,
        resolution.ref,
        resolution.digest,
      );
      if (descriptor) await this.#descriptors?.put(descriptor);
      if (resolution.trustRecordId) {
        const trustRecord = await this.#registry.getTrustRecord(
          resolution.trustRecordId,
        );
        if (trustRecord) await this.#trustRecords?.put(trustRecord);
      }
      const event = createDomainEvent({
        type: "registry.package.synced",
        aggregateType: "registry.package",
        aggregateId:
          `${resolution.kind}:${resolution.ref}:${resolution.digest}`,
        payload: {
          kind: resolution.kind,
          ref: resolution.ref,
          digest: resolution.digest,
          registry: resolution.registry,
          descriptorFound: descriptor !== undefined,
        },
      });
      await this.#outboxStore?.append(event);
      events.push(event);
      synced += 1;
    }
    return { synced, missing, events };
  }

  async syncProviderSupport(): Promise<number> {
    const reports = await this.#registry.listProviderSupport();
    return reports.length;
  }
}
