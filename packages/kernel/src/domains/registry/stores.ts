import type { Digest } from "takosumi-contract";
import type {
  PackageDescriptor,
  PackageKind,
  PackageResolution,
  ProviderSupportReport,
  TrustRecord,
} from "./types.ts";

export interface PackageDescriptorStore {
  put(descriptor: PackageDescriptor): Promise<PackageDescriptor>;
  get(
    kind: PackageKind,
    ref: string,
    digest: Digest,
  ): Promise<PackageDescriptor | undefined>;
  listByRef(
    kind: PackageKind,
    ref: string,
  ): Promise<readonly PackageDescriptor[]>;
}

export interface PackageResolutionStore {
  record(resolution: PackageResolution): Promise<PackageResolution>;
  get(
    kind: PackageKind,
    ref: string,
    digest: Digest,
  ): Promise<PackageResolution | undefined>;
  listByRef(
    kind: PackageKind,
    ref: string,
  ): Promise<readonly PackageResolution[]>;
}

export interface TrustRecordStore {
  put(record: TrustRecord): Promise<TrustRecord>;
  get(id: string): Promise<TrustRecord | undefined>;
  findForPackage(
    kind: PackageKind,
    ref: string,
    digest: Digest,
  ): Promise<TrustRecord | undefined>;
}

export interface BundledRegistry {
  resolve(
    kind: PackageKind,
    ref: string,
  ): Promise<PackageResolution | undefined>;
  getDescriptor(
    kind: PackageKind,
    ref: string,
    digest: Digest,
  ): Promise<PackageDescriptor | undefined>;
  getTrustRecord(id: string): Promise<TrustRecord | undefined>;
  listProviderSupport(): Promise<readonly ProviderSupportReport[]>;
}

export class InMemoryPackageDescriptorStore implements PackageDescriptorStore {
  readonly #descriptors = new Map<string, PackageDescriptor>();

  put(descriptor: PackageDescriptor): Promise<PackageDescriptor> {
    this.#descriptors.set(descriptorKey(descriptor), descriptor);
    return Promise.resolve(descriptor);
  }

  get(
    kind: PackageKind,
    ref: string,
    digest: Digest,
  ): Promise<PackageDescriptor | undefined> {
    return Promise.resolve(this.#descriptors.get(keyFor(kind, ref, digest)));
  }

  listByRef(
    kind: PackageKind,
    ref: string,
  ): Promise<readonly PackageDescriptor[]> {
    return Promise.resolve(
      [...this.#descriptors.values()].filter((descriptor) =>
        descriptor.kind === kind && descriptor.ref === ref
      ),
    );
  }
}

export class InMemoryPackageResolutionStore implements PackageResolutionStore {
  readonly #resolutions = new Map<string, PackageResolution>();

  record(resolution: PackageResolution): Promise<PackageResolution> {
    this.#resolutions.set(resolutionKey(resolution), resolution);
    return Promise.resolve(resolution);
  }

  get(
    kind: PackageKind,
    ref: string,
    digest: Digest,
  ): Promise<PackageResolution | undefined> {
    return Promise.resolve(this.#resolutions.get(keyFor(kind, ref, digest)));
  }

  listByRef(
    kind: PackageKind,
    ref: string,
  ): Promise<readonly PackageResolution[]> {
    return Promise.resolve(
      [...this.#resolutions.values()].filter((resolution) =>
        resolution.kind === kind && resolution.ref === ref
      ),
    );
  }
}

export class InMemoryTrustRecordStore implements TrustRecordStore {
  readonly #records = new Map<string, TrustRecord>();

  put(record: TrustRecord): Promise<TrustRecord> {
    this.#records.set(record.id, record);
    return Promise.resolve(record);
  }

  get(id: string): Promise<TrustRecord | undefined> {
    return Promise.resolve(this.#records.get(id));
  }

  findForPackage(
    kind: PackageKind,
    ref: string,
    digest: Digest,
  ): Promise<TrustRecord | undefined> {
    for (const record of this.#records.values()) {
      if (
        record.packageKind === kind && record.packageRef === ref &&
        record.packageDigest === digest
      ) return Promise.resolve(record);
    }
    return Promise.resolve(undefined);
  }
}

export class InMemoryBundledRegistry implements BundledRegistry {
  constructor(
    readonly descriptors: PackageDescriptorStore,
    readonly resolutions: PackageResolutionStore,
    readonly trustRecords: TrustRecordStore,
    readonly providerSupportReports: readonly ProviderSupportReport[] = [],
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
    digest: Digest,
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

function keyFor(kind: PackageKind, ref: string, digest: Digest): string {
  return `${kind}:${ref}:${digest}`;
}

function descriptorKey(descriptor: PackageDescriptor): string {
  return keyFor(descriptor.kind, descriptor.ref, descriptor.digest);
}

function resolutionKey(resolution: PackageResolution): string {
  return keyFor(resolution.kind, resolution.ref, resolution.digest);
}
