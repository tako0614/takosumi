import { expect, test } from "bun:test";

import type { OfferingCatalog } from "../../contract/index.ts";
import { createTakosumiService } from "../../core/bootstrap.ts";
import { InMemoryOfferingCatalogReader } from "../../core/domains/offerings/mod.ts";

const DIGEST = `sha256:${"a".repeat(64)}`;
const FINGERPRINT = `sha256:${"b".repeat(64)}`;

const catalog = {
  id: "operator-default",
  version: "v1",
  effectiveAt: "2020-01-01T00:00:00.000Z",
  offerings: [
    {
      id: "generic-endpoint",
      version: "v1",
      subject: {
        type: "services.example.test/v1/Endpoint",
        ref: "generic-endpoint",
        version: "2026-07-20",
        digest: DIGEST,
      },
      requirements: [],
      profile: "default",
      region: "global",
      maturity: "stable",
      audience: { public: true },
      status: "active",
    },
  ],
} as const satisfies OfferingCatalog;

test("service composition installs the generic Offering engine for non-Form subjects", async () => {
  const { operations } = await createTakosumiService({
    runtimeEnv: { TAKOSUMI_DEV_MODE: "1" },
    offeringHostComposition: {
      catalogs: new InMemoryOfferingCatalogReader([catalog]),
      resolvers: [
        {
          subjectType: catalog.offerings[0].subject.type,
          resolve: async () => ({
            ready: true,
            resolverId: "generic-endpoint-resolver",
            resolutionFingerprint: FINGERPRINT,
          }),
        },
      ],
    },
  });

  const selected = await operations.offerings.resolve({
    reference: {
      catalogId: catalog.id,
      catalogVersion: catalog.version,
      offeringId: catalog.offerings[0].id,
      offeringVersion: catalog.offerings[0].version,
    },
  });

  expect(selected.subject.type).toBe("services.example.test/v1/Endpoint");
  expect(selected.resolutionFingerprint).toBe(FINGERPRINT);
});

test("zero-offering service composition stays operational and fails exact lookup closed", async () => {
  const { operations } = await createTakosumiService({
    runtimeEnv: { TAKOSUMI_DEV_MODE: "1" },
  });

  await expect(
    operations.offerings.resolve({
      reference: {
        catalogId: "missing",
        catalogVersion: "v1",
        offeringId: "missing",
        offeringVersion: "v1",
      },
    }),
  ).rejects.toMatchObject({ code: "catalog_not_found" });
});
