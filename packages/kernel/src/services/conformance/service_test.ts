import assert from "node:assert/strict";
import {
  BundledRegistrySeedAdapter,
  bundledRegistrySeedTrustRecords,
} from "../../adapters/registry/mod.ts";
import { PackageConformanceService } from "./mod.ts";

Deno.test("package conformance accepts trusted provider with required support", async () => {
  const service = new PackageConformanceService({
    registry: new BundledRegistrySeedAdapter(),
  });

  const result = await service.assessProvider({
    providerRef: "provider.noop@v1",
    requirements: {
      resourceContracts: ["resource.sql.postgres@v1"],
      dataContracts: ["data.json@v1"],
      publicationContracts: ["publication.route@v1"],
      minimumTier: "tested",
    },
  });

  assert.equal(result.accepted, true);
  assert.equal(result.trustStatus, "trusted");
  assert.equal(result.conformanceTier, "tested");
  assert.deepEqual(result.issues, []);
  assert.ok(result.checks.every((check) => check.passed));
});

Deno.test("package conformance blocks providers missing required features", async () => {
  const service = new PackageConformanceService({
    registry: new BundledRegistrySeedAdapter(),
  });

  const result = await service.assessProvider({
    providerRef: "provider.noop@v1",
    requirements: {
      resourceContracts: ["queue.amqp@v1"],
      minimumTier: "tested",
    },
  });

  assert.equal(result.accepted, false);
  assert.equal(result.trustStatus, "trusted");
  assert.ok(
    result.issues.some((issue) =>
      issue.code === "required-feature-missing" &&
      issue.severity === "blocked" &&
      issue.acceptanceSeverity === "blocker" &&
      issue.message.includes("queue.amqp@v1")
    ),
  );
});

Deno.test("package conformance blocks revoked trust records", async () => {
  const trustRecords = bundledRegistrySeedTrustRecords.map((record) =>
    record.packageRef === "provider.noop@v1"
      ? {
        ...record,
        status: "revoked" as const,
        revokedAt: "2026-04-27T00:30:00.000Z",
        reason: "provider signing key was revoked",
      }
      : record
  );
  const service = new PackageConformanceService({
    registry: new BundledRegistrySeedAdapter(
      undefined,
      undefined,
      trustRecords,
    ),
  });

  const result = await service.assessProvider({
    providerRef: "provider.noop@v1",
    requirements: {
      resourceContracts: ["resource.sql.postgres@v1"],
      minimumTier: "tested",
    },
  });

  assert.equal(result.accepted, false);
  assert.equal(result.trustStatus, "revoked");
  assert.ok(
    result.issues.some((issue) =>
      issue.code === "trust-record-revoked" &&
      issue.severity === "blocked" &&
      issue.acceptanceSeverity === "blocker"
    ),
  );
});
