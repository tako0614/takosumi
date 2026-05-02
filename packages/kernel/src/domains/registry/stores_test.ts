import assert from "node:assert/strict";
import {
  InMemoryBundledRegistry,
  InMemoryPackageDescriptorStore,
  InMemoryPackageResolutionStore,
  InMemoryTrustRecordStore,
  type PackageDescriptor,
  type PackageResolution,
  type TrustRecord,
} from "./mod.ts";

Deno.test("registry resolves package descriptors and exposes trust records", async () => {
  const descriptors = new InMemoryPackageDescriptorStore();
  const resolutions = new InMemoryPackageResolutionStore();
  const trustRecords = new InMemoryTrustRecordStore();

  const oldDescriptor = descriptor("sha256:old", "1.0.0");
  const newDescriptor = descriptor("sha256:new", "1.1.0");
  const resolution: PackageResolution = {
    ref: "providers/postgres",
    kind: "provider-package",
    digest: newDescriptor.digest,
    registry: "bundled",
    trustRecordId: "trust_new",
    resolvedAt: "2026-04-27T00:00:02.000Z",
  };
  const trust: TrustRecord = {
    id: "trust_new",
    packageRef: resolution.ref,
    packageKind: resolution.kind,
    packageDigest: resolution.digest,
    trustLevel: "official",
    status: "active",
    conformanceTier: "tested",
    verifiedBy: "takos",
    verifiedAt: "2026-04-27T00:00:03.000Z",
  };

  await descriptors.put(oldDescriptor);
  await descriptors.put(newDescriptor);
  await resolutions.record(resolution);
  await trustRecords.put(trust);

  const registry = new InMemoryBundledRegistry(
    descriptors,
    resolutions,
    trustRecords,
  );

  assert.equal(
    (await registry.resolve("provider-package", "providers/postgres"))?.digest,
    "sha256:new",
  );
  assert.equal(
    (await registry.getDescriptor(
      "provider-package",
      "providers/postgres",
      "sha256:new",
    ))?.version,
    "1.1.0",
  );
  assert.equal(
    (await trustRecords.findForPackage(
      "provider-package",
      "providers/postgres",
      "sha256:new",
    ))?.trustLevel,
    "official",
  );
  assert.deepEqual(await registry.getTrustRecord("trust_new"), trust);
});

Deno.test("registry resolves resource contract packages through PackageResolution", async () => {
  const descriptors = new InMemoryPackageDescriptorStore();
  const resolutions = new InMemoryPackageResolutionStore();
  const trustRecords = new InMemoryTrustRecordStore();
  const contract: PackageDescriptor = {
    ref: "resource.sql.postgres@v1",
    kind: "resource-contract-package",
    digest: "sha256:resource-sql-postgres",
    publisher: "takos",
    version: "1.0.0",
    body: {
      shortRef: "resource.sql.postgres@v1",
      contract: "https://takos.dev/contracts/resource/sql/postgres/v1",
    },
    publishedAt: "2026-04-27T00:00:00.000Z",
  };
  const resolution: PackageResolution = {
    ref: contract.ref,
    kind: contract.kind,
    digest: contract.digest,
    registry: "bundled",
    trustRecordId: "trust_resource_sql_postgres",
    resolvedAt: "2026-04-27T00:00:01.000Z",
  };
  const trust: TrustRecord = {
    id: "trust_resource_sql_postgres",
    packageRef: resolution.ref,
    packageKind: resolution.kind,
    packageDigest: resolution.digest,
    trustLevel: "official",
    status: "active",
    conformanceTier: "tested",
    verifiedBy: "takos",
    verifiedAt: "2026-04-27T00:00:02.000Z",
  };

  await descriptors.put(contract);
  await resolutions.record(resolution);
  await trustRecords.put(trust);

  const registry = new InMemoryBundledRegistry(
    descriptors,
    resolutions,
    trustRecords,
  );

  const resolved = await registry.resolve(
    "resource-contract-package",
    "resource.sql.postgres@v1",
  );
  assert.deepEqual(resolved, resolution);
  assert.deepEqual(
    await registry.getDescriptor(
      "resource-contract-package",
      "resource.sql.postgres@v1",
      "sha256:resource-sql-postgres",
    ),
    contract,
  );
  assert.deepEqual(
    resolved?.trustRecordId
      ? await registry.getTrustRecord(resolved.trustRecordId)
      : undefined,
    trust,
  );
});

function descriptor(digest: string, version: string): PackageDescriptor {
  return {
    ref: "providers/postgres",
    kind: "provider-package",
    digest,
    publisher: "takos",
    version,
    body: { version },
    publishedAt: `2026-04-27T00:00:0${version === "1.0.0" ? "0" : "1"}.000Z`,
  };
}
