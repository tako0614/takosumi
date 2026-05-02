import assert from "node:assert/strict";
import {
  BundledRegistrySeedAdapter,
  bundledRegistrySeedDescriptors,
  bundledRegistrySeedResolutions,
} from "./mod.ts";

Deno.test("bundled registry seed adapter resolves built-in packages by kind and ref", async () => {
  const registry = new BundledRegistrySeedAdapter();

  const expected = [
    ["resource-contract-package", "resource.sql.postgres@v1"],
    ["resource-contract-package", "resource.object-store.s3@v1"],
    ["provider-package", "provider.noop@v1"],
    ["provider-package", "provider.local-docker@v1"],
    ["data-contract-package", "data.json@v1"],
    ["output-contract-package", "output.route@v1"],
  ] as const;

  for (const [kind, ref] of expected) {
    const resolution = await registry.resolve(kind, ref);
    assert.ok(resolution, `${kind}:${ref} should resolve`);
    assert.equal(resolution.ref, ref);
    assert.equal(resolution.kind, kind);
    assert.equal(resolution.registry, "bundled");
    assert.match(resolution.digest, /^sha256:[0-9a-f]{64}$/);

    const descriptor = await registry.getDescriptor(
      resolution.kind,
      resolution.ref,
      resolution.digest,
    );
    assert.ok(descriptor, `${kind}:${ref} descriptor should be available`);
    assert.equal(descriptor.digest, resolution.digest);
    assert.equal(descriptor.publisher, "takos");
    assert.equal(descriptor.body.schemaVersion, "takos.registry.package/v1");

    assert.ok(resolution.trustRecordId);
    const trustRecord = await registry.getTrustRecord(resolution.trustRecordId);
    assert.ok(trustRecord, `${kind}:${ref} trust record should be available`);
    assert.equal(trustRecord.packageDigest, resolution.digest);
    assert.equal(trustRecord.status, "active");
  }
});

Deno.test("bundled registry seed adapter only resolves digest-pinned built-ins", async () => {
  const registry = new BundledRegistrySeedAdapter();

  assert.equal(
    await registry.resolve("provider-package", "missing@v1"),
    undefined,
  );
  assert.equal(
    await registry.resolve("data-contract-package", "provider.noop@v1"),
    undefined,
  );

  const resolution = await registry.resolve(
    "provider-package",
    "provider.noop@v1",
  );
  assert.ok(resolution);
  assert.equal(
    await registry.getDescriptor(
      resolution.kind,
      resolution.ref,
      "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    ),
    undefined,
  );
});

Deno.test("bundled registry seed exports descriptors and resolutions with matching digests", () => {
  assert.equal(bundledRegistrySeedDescriptors.length, 6);
  assert.equal(bundledRegistrySeedResolutions.length, 6);

  for (const descriptor of bundledRegistrySeedDescriptors) {
    const resolution = bundledRegistrySeedResolutions.find((candidate) =>
      candidate.kind === descriptor.kind && candidate.ref === descriptor.ref
    );
    assert.ok(
      resolution,
      `${descriptor.kind}:${descriptor.ref} resolution missing`,
    );
    assert.equal(resolution.digest, descriptor.digest);
  }
});

Deno.test("bundled registry seed adapter reports provider support", async () => {
  const registry = new BundledRegistrySeedAdapter();

  const reports = await registry.listProviderSupport();
  assert.equal(reports.length, 2);
  assert.deepEqual(
    reports.map((report) => report.providerPackageRef).sort(),
    ["provider.local-docker@v1", "provider.noop@v1"],
  );
  for (const report of reports) {
    assert.deepEqual(report.resourceContracts, [
      "resource.sql.postgres@v1",
      "resource.object-store.s3@v1",
    ]);
    assert.deepEqual(report.capabilityProfiles, [
      "data.json@v1",
      "output.route@v1",
    ]);
  }
});
