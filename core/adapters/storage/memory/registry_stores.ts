// In-memory implementations of the registry domain stores plus the
// MemoryBundledRegistry that joins them. PackageKind/ref/digest is the
// composite key shared by descriptors and resolutions.

import type {
  BundledRegistry,
  PackageDescriptorStore,
  PackageResolutionStore,
  TrustRecordStore,
} from "../../../domains/registry/stores.ts";
import type {
  PackageDescriptor,
  PackageKind,
  PackageResolution,
  ProviderSupportReport,
  TrustRecord,
} from "../../../domains/registry/types.ts";
import { filterValues, getFrom, packageKey, putValue } from "./helpers.ts";

export class MemoryPackageDescriptorStore implements PackageDescriptorStore {
  constructor(private readonly descriptors: Map<string, PackageDescriptor>) {}

  put(descriptor: PackageDescriptor): Promise<PackageDescriptor> {
    return putValue(
      this.descriptors,
      packageKey(descriptor.kind, descriptor.ref, descriptor.digest),
      descriptor,
    );
  }

  get(
    kind: PackageKind,
    ref: string,
    digest: string,
  ): Promise<PackageDescriptor | undefined> {
    return getFrom(this.descriptors, packageKey(kind, ref, digest));
  }

  listByRef(
    kind: PackageKind,
    ref: string,
  ): Promise<readonly PackageDescriptor[]> {
    return filterValues(
      this.descriptors,
      (descriptor) => descriptor.kind === kind && descriptor.ref === ref,
    );
  }
}

export class MemoryPackageResolutionStore implements PackageResolutionStore {
  constructor(private readonly resolutions: Map<string, PackageResolution>) {}

  record(resolution: PackageResolution): Promise<PackageResolution> {
    return putValue(
      this.resolutions,
      packageKey(resolution.kind, resolution.ref, resolution.digest),
      resolution,
    );
  }

  get(
    kind: PackageKind,
    ref: string,
    digest: string,
  ): Promise<PackageResolution | undefined> {
    return getFrom(this.resolutions, packageKey(kind, ref, digest));
  }

  listByRef(
    kind: PackageKind,
    ref: string,
  ): Promise<readonly PackageResolution[]> {
    return filterValues(
      this.resolutions,
      (resolution) => resolution.kind === kind && resolution.ref === ref,
    );
  }
}

export class MemoryTrustRecordStore implements TrustRecordStore {
  constructor(private readonly records: Map<string, TrustRecord>) {}

  put(record: TrustRecord): Promise<TrustRecord> {
    return putValue(this.records, record.id, record);
  }

  get(id: string): Promise<TrustRecord | undefined> {
    return getFrom(this.records, id);
  }

  findForPackage(
    kind: PackageKind,
    ref: string,
    digest: string,
  ): Promise<TrustRecord | undefined> {
    for (const record of this.records.values()) {
      if (
        record.packageKind === kind && record.packageRef === ref &&
        record.packageDigest === digest
      ) return Promise.resolve(record);
    }
    return Promise.resolve(undefined);
  }
}

export class MemoryBundledRegistry implements BundledRegistry {
  constructor(
    private readonly descriptors: PackageDescriptorStore,
    private readonly resolutions: PackageResolutionStore,
    private readonly trustRecords: TrustRecordStore,
    private readonly providerSupportReports: readonly ProviderSupportReport[],
  ) {}

  async resolve(
    kind: PackageKind,
    ref: string,
  ): Promise<PackageResolution | undefined> {
    const descriptors = await this.descriptors.listByRef(kind, ref);
    const descriptor = descriptors[descriptors.length - 1];
    if (!descriptor) return undefined;
    return await this.resolutions.get(kind, ref, descriptor.digest);
  }

  getDescriptor(
    kind: PackageKind,
    ref: string,
    digest: string,
  ): Promise<PackageDescriptor | undefined> {
    return this.descriptors.get(kind, ref, digest);
  }

  getTrustRecord(id: string): Promise<TrustRecord | undefined> {
    return this.trustRecords.get(id);
  }

  listProviderSupport(): Promise<readonly ProviderSupportReport[]> {
    return Promise.resolve(this.providerSupportReports);
  }
}
