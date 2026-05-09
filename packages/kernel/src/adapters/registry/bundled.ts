import type {
  BundledRegistry,
  PackageDescriptor,
  PackageKind,
  PackageResolution,
  ProviderSupportReport,
  TrustRecord,
} from "../../domains/registry/mod.ts";
import type { Digest, JsonObject } from "takosumi-contract";

const REGISTRY_NAME = "bundled";
const PUBLISHER = "takos";
const PUBLISHED_AT = "2026-04-27T00:00:00.000Z";
const RESOLVED_AT = "2026-04-27T00:00:00.000Z";
const VERIFIED_AT = "2026-04-27T00:00:00.000Z";

interface BuiltInPackageSeed {
  readonly ref: string;
  readonly kind: PackageKind;
  readonly digest: Digest;
  readonly version: string;
  readonly trustLevel: TrustRecord["trustLevel"];
  readonly conformanceTier: TrustRecord["conformanceTier"];
  readonly body: JsonObject;
}

const BUILT_IN_PACKAGE_SEEDS: readonly BuiltInPackageSeed[] = [
  {
    ref: "resource.sql.postgres@v1",
    kind: "resource-contract-package",
    digest:
      "sha256:de84b65e51c4b3ff4d1a91359f47114ccfb58378cfded8c8a6f65abed69b8a01",
    version: "1.0.0",
    trustLevel: "official",
    conformanceTier: "declared",
    body: {
      schemaVersion: "takos.registry.package/v1",
      id: "resource.sql.postgres",
      apiVersion: "v1",
      packageType: "resource-contract",
      capabilities: ["sql.database", "sql.migrations", "sql.connection-url"],
      resources: [{ kind: "postgres-database", apiVersion: "v1" }],
    },
  },
  {
    ref: "resource.object-store.s3@v1",
    kind: "resource-contract-package",
    digest:
      "sha256:75a737d7f795cf6b2f9d49e315d3d61a1f0c6c8d76b0ab94a2ebcfad64a433e4",
    version: "1.0.0",
    trustLevel: "official",
    conformanceTier: "declared",
    body: {
      schemaVersion: "takos.registry.package/v1",
      id: "resource.object-store.s3",
      apiVersion: "v1",
      packageType: "resource-contract",
      capabilities: ["object-store.bucket", "object-store.s3-compatible"],
      resources: [{ kind: "s3-bucket", apiVersion: "v1" }],
    },
  },
  {
    ref: "provider.noop@v1",
    kind: "provider-package",
    digest:
      "sha256:4f4881ad8747ad039d587479e4d1b8e11d9f8b39a5d4e6b88af9fa0f95734c56",
    version: "1.0.0",
    trustLevel: "official",
    conformanceTier: "tested",
    body: {
      schemaVersion: "takos.registry.package/v1",
      id: "provider.noop",
      apiVersion: "v1",
      packageType: "provider",
      runtime: "noop",
      supports: {
        resourceContracts: [
          "resource.sql.postgres@v1",
          "resource.object-store.s3@v1",
        ],
        interfaceContracts: [
          "interface.http@v1",
          "interface.tcp@v1",
          "interface.udp@v1",
          "interface.queue@v1",
        ],
        dataContracts: ["data.json@v1"],
        outputContracts: ["output.route@v1"],
      },
    },
  },
  {
    ref: "provider.local-docker@v1",
    kind: "provider-package",
    digest:
      "sha256:806df0fc4f7b68c60434a1c7f11b98a877af672de2b0bf73bc70b73c8fbd3f42",
    version: "1.0.0",
    trustLevel: "local",
    conformanceTier: "declared",
    body: {
      schemaVersion: "takos.registry.package/v1",
      id: "provider.local-docker",
      apiVersion: "v1",
      packageType: "provider",
      runtime: "local-docker",
      supports: {
        resourceContracts: [
          "resource.sql.postgres@v1",
          "resource.object-store.s3@v1",
        ],
        interfaceContracts: [
          "interface.http@v1",
          "interface.tcp@v1",
          "interface.udp@v1",
        ],
        dataContracts: ["data.json@v1"],
        outputContracts: ["output.route@v1"],
      },
    },
  },
  {
    ref: "data.json@v1",
    kind: "data-contract-package",
    digest:
      "sha256:369636f60f08c2aa1a745dc24700ca6a87939b782ca241f4c8cde602ac9797fe",
    version: "1.0.0",
    trustLevel: "official",
    conformanceTier: "declared",
    body: {
      schemaVersion: "takos.registry.package/v1",
      id: "data.json",
      apiVersion: "v1",
      packageType: "data-contract",
      mediaTypes: ["application/json"],
      schemaKinds: ["json-schema"],
    },
  },
  {
    ref: "output.route@v1",
    kind: "output-contract-package",
    digest:
      "sha256:34d8729672c6c7224f82f2ddb9d374cb3d015f42ef4747a486cbe95d951d130e",
    version: "1.0.0",
    trustLevel: "official",
    conformanceTier: "declared",
    body: {
      schemaVersion: "takos.registry.package/v1",
      id: "output.route",
      apiVersion: "v1",
      packageType: "output-contract",
      outputKinds: ["http-route"],
      protocols: ["http", "https"],
    },
  },
];

export const bundledRegistrySeedDescriptors: readonly PackageDescriptor[] =
  BUILT_IN_PACKAGE_SEEDS.map((seed) => ({
    ref: seed.ref,
    kind: seed.kind,
    digest: seed.digest,
    publisher: PUBLISHER,
    version: seed.version,
    body: seed.body,
    publishedAt: PUBLISHED_AT,
  }));

export const bundledRegistrySeedResolutions: readonly PackageResolution[] =
  BUILT_IN_PACKAGE_SEEDS.map((seed) => ({
    ref: seed.ref,
    kind: seed.kind,
    digest: seed.digest,
    registry: REGISTRY_NAME,
    trustRecordId: trustRecordIdFor(seed.kind, seed.ref, seed.digest),
    resolvedAt: RESOLVED_AT,
  }));

export const bundledRegistrySeedTrustRecords: readonly TrustRecord[] =
  BUILT_IN_PACKAGE_SEEDS.map((seed) => ({
    id: trustRecordIdFor(seed.kind, seed.ref, seed.digest),
    packageRef: seed.ref,
    packageDigest: seed.digest,
    packageKind: seed.kind,
    trustLevel: seed.trustLevel,
    status: "active",
    conformanceTier: seed.conformanceTier,
    verifiedBy: PUBLISHER,
    verifiedAt: VERIFIED_AT,
  }));

export const bundledRegistrySeedProviderSupportReports:
  readonly ProviderSupportReport[] = [
    providerSupportReport("provider.noop@v1", "tested"),
    providerSupportReport("provider.local-docker@v1", "declared", [
      "Intended for local development and smoke tests.",
    ]),
  ];

export class BundledRegistrySeedAdapter implements BundledRegistry {
  readonly #descriptorsByKey: ReadonlyMap<string, PackageDescriptor>;
  readonly #resolutionsByRef: ReadonlyMap<string, PackageResolution>;
  readonly #trustRecordsById: ReadonlyMap<string, TrustRecord>;

  constructor(
    descriptors: readonly PackageDescriptor[] = bundledRegistrySeedDescriptors,
    resolutions: readonly PackageResolution[] = bundledRegistrySeedResolutions,
    trustRecords: readonly TrustRecord[] = bundledRegistrySeedTrustRecords,
  ) {
    this.#descriptorsByKey = new Map(
      descriptors.map((descriptor) => [descriptorKey(descriptor), descriptor]),
    );
    this.#resolutionsByRef = new Map(
      resolutions.map((
        resolution,
      ) => [refKey(resolution.kind, resolution.ref), resolution]),
    );
    this.#trustRecordsById = new Map(
      trustRecords.map((record) => [record.id, record]),
    );
  }

  resolve(
    kind: PackageKind,
    ref: string,
  ): Promise<PackageResolution | undefined> {
    return Promise.resolve(
      clonePackageResolution(this.#resolutionsByRef.get(refKey(kind, ref))),
    );
  }

  getDescriptor(
    kind: PackageKind,
    ref: string,
    digest: Digest,
  ): Promise<PackageDescriptor | undefined> {
    return Promise.resolve(
      clonePackageDescriptor(
        this.#descriptorsByKey.get(keyFor(kind, ref, digest)),
      ),
    );
  }

  getTrustRecord(id: string): Promise<TrustRecord | undefined> {
    return Promise.resolve(cloneTrustRecord(this.#trustRecordsById.get(id)));
  }

  listProviderSupport(): Promise<readonly ProviderSupportReport[]> {
    return Promise.resolve(
      bundledRegistrySeedProviderSupportReports.map((report) => ({
        ...report,
        resourceContracts: [...report.resourceContracts],
        capabilityProfiles: [...report.capabilityProfiles],
        limitations: report.limitations ? [...report.limitations] : undefined,
      })),
    );
  }
}

function providerSupportReport(
  providerRef: string,
  conformanceTier: ProviderSupportReport["conformanceTier"],
  limitations?: readonly string[],
): ProviderSupportReport {
  const resolution = bundledRegistrySeedResolutions.find((candidate) =>
    candidate.kind === "provider-package" && candidate.ref === providerRef
  );
  if (!resolution) throw new Error(`Missing bundled provider ${providerRef}`);
  const interfaceContracts = providerRef === "provider.local-docker@v1"
    ? ["interface.http@v1", "interface.tcp@v1", "interface.udp@v1"]
    : [
      "interface.http@v1",
      "interface.tcp@v1",
      "interface.udp@v1",
      "interface.queue@v1",
    ];
  const routeProtocols = providerRef === "provider.local-docker@v1"
    ? ["http", "tcp", "udp"]
    : ["http", "tcp", "udp", "queue"];
  return {
    providerPackageRef: resolution.ref,
    providerPackageDigest: resolution.digest,
    resourceContracts: [
      "resource.sql.postgres@v1",
      "resource.object-store.s3@v1",
    ],
    interfaceContracts,
    routeProtocols,
    capabilityProfiles: ["data.json@v1", "output.route@v1"],
    conformanceTier,
    limitations,
  };
}

function refKey(kind: PackageKind, ref: string): string {
  return `${kind}:${ref}`;
}

function keyFor(kind: PackageKind, ref: string, digest: Digest): string {
  return `${kind}:${ref}:${digest}`;
}

function descriptorKey(descriptor: PackageDescriptor): string {
  return keyFor(descriptor.kind, descriptor.ref, descriptor.digest);
}

function trustRecordIdFor(
  kind: PackageKind,
  ref: string,
  digest: Digest,
): string {
  return `bundled:${kind}:${ref}:${digest}`;
}

function clonePackageResolution(
  resolution: PackageResolution | undefined,
): PackageResolution | undefined {
  return resolution ? { ...resolution } : undefined;
}

function clonePackageDescriptor(
  descriptor: PackageDescriptor | undefined,
): PackageDescriptor | undefined {
  return descriptor
    ? { ...descriptor, body: structuredClone(descriptor.body) }
    : undefined;
}

function cloneTrustRecord(
  record: TrustRecord | undefined,
): TrustRecord | undefined {
  return record ? { ...record } : undefined;
}
