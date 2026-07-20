import { expect, test } from "bun:test";
import {
  formActivationOfferingRequirement,
  formOfferingSubject,
  type OfferingCatalog,
} from "takosumi-contract";
import {
  InMemoryOfferingCatalogReader,
  OfferingError,
  OfferingService,
  offeringSelectionProblems,
} from "../../../../core/domains/offerings/mod.ts";

const DIGEST = `sha256:${"a".repeat(64)}`;
const FINGERPRINT = `sha256:${"b".repeat(64)}`;

const catalog = {
  id: "operator-default",
  version: "v1",
  effectiveAt: "2026-07-20T00:00:00.000Z",
  offerings: [
    {
      id: "edge-worker",
      version: "v1",
      subject: {
        type: "forms.takoform.com/v1alpha1/Form",
        ref: "forms.takoform.com%2Fv1alpha1|EdgeWorker|1.0.1|sha256%3Aexact",
        version: "1.0.1",
        digest: DIGEST,
      },
      requirements: [
        {
          type: "takosumi.dev/v1alpha1/FormActivation",
          ref: "fa_edge",
          version: "7",
        },
      ],
      profile: "default",
      region: "global",
      maturity: "stable",
      audience: { roles: ["developer"] },
      status: "active",
    },
    {
      id: "ai-gateway",
      version: "v1",
      subject: {
        type: "services.example.net/v1/Endpoint",
        ref: "ai-gateway",
        version: "2026-07-20",
        digest: DIGEST,
      },
      requirements: [],
      profile: "openai-compatible",
      region: "global",
      maturity: "stable",
      audience: { public: true },
      status: "active",
    },
  ],
} as const satisfies OfferingCatalog;

test("generic OSS Offering selection supports Form and non-Form subjects", async () => {
  const service = new OfferingService({
    catalogs: new InMemoryOfferingCatalogReader([catalog]),
    resolvers: [
      {
        subjectType: "forms.takoform.com/v1alpha1/Form",
        resolve: async ({ offering }) => ({
          ready: true,
          resolverId: "form-host",
          resolutionFingerprint: FINGERPRINT,
        }),
      },
      {
        subjectType: "services.example.net/v1/Endpoint",
        resolve: async () => ({
          ready: true,
          resolverId: "endpoint-host",
          resolutionFingerprint: FINGERPRINT,
        }),
      },
    ],
    now: () => "2026-07-20T01:00:00.000Z",
  });

  const availability = await service.listAvailability({
    catalogId: catalog.id,
    catalogVersion: catalog.version,
    roles: ["developer"],
  });
  expect(availability.map((entry) => entry.availableToPrincipal)).toEqual([
    true,
    true,
  ]);
  const selected = await service.resolve({
    reference: {
      catalogId: catalog.id,
      catalogVersion: catalog.version,
      offeringId: "edge-worker",
      offeringVersion: "v1",
    },
    roles: ["developer"],
  });
  expect(selected.subject.type).toBe("forms.takoform.com/v1alpha1/Form");
  expect(selected.requirements[0]?.type).toBe(
    "takosumi.dev/v1alpha1/FormActivation",
  );
  expect(selected.resolutionFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
  expect(selected.resolutionFingerprint).not.toBe(FINGERPRINT);
});

test("unknown subject resolvers and audience denial fail closed", async () => {
  const service = new OfferingService({
    catalogs: new InMemoryOfferingCatalogReader([catalog]),
    now: () => "2026-07-20T01:00:00.000Z",
  });
  const availability = await service.listAvailability({
    catalogId: catalog.id,
    catalogVersion: catalog.version,
  });
  expect(availability.map((entry) => entry.reason)).toEqual([
    "principal_not_allowed",
    "resolver_unavailable",
  ]);
  await expect(
    service.resolve({
      reference: {
        catalogId: catalog.id,
        catalogVersion: catalog.version,
        offeringId: "ai-gateway",
        offeringVersion: "v1",
      },
    }),
  ).rejects.toMatchObject({
    code: "offering_unavailable",
    availabilityReason: "resolver_unavailable",
  } satisfies Partial<OfferingError>);
});

test("catalog parser rejects commercial/private fields and implicit versions", async () => {
  const invalid = structuredClone(catalog) as unknown as Record<
    string,
    unknown
  >;
  const offerings = invalid.offerings as Array<Record<string, unknown>>;
  offerings[0]!.sku = "edge-worker";
  const service = new OfferingService({
    catalogs: new InMemoryOfferingCatalogReader([
      invalid as unknown as OfferingCatalog,
    ]),
    now: () => "2026-07-20T01:00:00.000Z",
  });
  await expect(
    service.listAvailability({
      catalogId: catalog.id,
      catalogVersion: catalog.version,
    }),
  ).rejects.toMatchObject({ code: "invalid_catalog" });

  await expect(
    service.listAvailability({
      catalogId: catalog.id,
      catalogVersion: "latest",
    }),
  ).rejects.toMatchObject({ code: "catalog_not_found" });
});

test("a resolver cannot claim ready without an exact fingerprint", async () => {
  const service = new OfferingService({
    catalogs: new InMemoryOfferingCatalogReader([catalog]),
    resolvers: [
      {
        subjectType: "services.example.net/v1/Endpoint",
        resolve: async () => ({
          ready: true,
          resolverId: "endpoint-host",
          resolutionFingerprint: "latest",
        }),
      },
    ],
    now: () => "2026-07-20T01:00:00.000Z",
  });
  await expect(
    service.resolve({
      reference: {
        catalogId: catalog.id,
        catalogVersion: catalog.version,
        offeringId: "ai-gateway",
        offeringVersion: "v1",
      },
    }),
  ).rejects.toMatchObject({
    code: "offering_unavailable",
    availabilityReason: "subject_unavailable",
  });
  const availability = await service.listAvailability({
    catalogId: catalog.id,
    catalogVersion: catalog.version,
  });
  expect(availability[1]).toMatchObject({
    availableToPrincipal: false,
    reason: "subject_unavailable",
  });
});

test("resolve invokes the subject authority exactly once", async () => {
  let calls = 0;
  const service = new OfferingService({
    catalogs: new InMemoryOfferingCatalogReader([catalog]),
    resolvers: [
      {
        subjectType: "services.example.net/v1/Endpoint",
        resolve: async () => {
          calls += 1;
          return {
            ready: true,
            resolverId: "endpoint-host",
            resolutionFingerprint: FINGERPRINT,
          } as const;
        },
      },
    ],
    now: () => "2026-07-20T01:00:00.000Z",
  });
  await service.resolve({
    reference: {
      catalogId: catalog.id,
      catalogVersion: catalog.version,
      offeringId: "ai-gateway",
      offeringVersion: "v1",
    },
  });
  expect(calls).toBe(1);
});

test("Core fingerprints the exact catalog row and rejects reader identity substitution", async () => {
  const resolver = {
    subjectType: "services.example.net/v1/Endpoint",
    resolve: async () => ({
      ready: true as const,
      resolverId: "endpoint-host",
      resolutionFingerprint: FINGERPRINT,
    }),
  };
  const changedCatalog = structuredClone(catalog) as OfferingCatalog;
  (changedCatalog.offerings as Array<{ profile: string }>)[1]!.profile =
    "changed-profile";
  const reference = {
    catalogId: catalog.id,
    catalogVersion: catalog.version,
    offeringId: "ai-gateway",
    offeringVersion: "v1",
  };
  const originalSelection = await new OfferingService({
    catalogs: new InMemoryOfferingCatalogReader([catalog]),
    resolvers: [resolver],
    now: () => "2026-07-20T01:00:00.000Z",
  }).resolve({ reference });
  const changedSelection = await new OfferingService({
    catalogs: new InMemoryOfferingCatalogReader([changedCatalog]),
    resolvers: [resolver],
    now: () => "2026-07-20T01:00:00.000Z",
  }).resolve({ reference });
  expect(changedSelection.resolutionFingerprint).not.toBe(
    originalSelection.resolutionFingerprint,
  );

  const immutableReader = new InMemoryOfferingCatalogReader([catalog]);
  expect(() => immutableReader.set(catalog)).toThrow("is immutable");

  const substituted = new OfferingService({
    catalogs: {
      getCatalog: async () => ({ ...catalog, id: "other-catalog" }),
    },
    resolvers: [resolver],
  });
  await expect(substituted.resolve({ reference })).rejects.toMatchObject({
    code: "invalid_catalog",
  });
});

test("Takoform is one exact generic Offering subject rather than the catalog type", () => {
  const subject = formOfferingSubject({
    formRef: {
      apiVersion: "forms.takoform.com/v1alpha1",
      kind: "KVStore",
      definitionVersion: "1.0.1",
      schemaDigest: `sha256:${"c".repeat(64)}`,
    },
    packageDigest: `sha256:${"d".repeat(64)}`,
  });
  expect(subject).toEqual({
    type: "forms.takoform.com/v1alpha1/Form",
    ref: `forms.takoform.com%2Fv1alpha1|KVStore|1.0.1|sha256%3A${"c".repeat(64)}`,
    version: "1.0.1",
    digest: `sha256:${"d".repeat(64)}`,
  });
  expect(
    formActivationOfferingRequirement({ id: "fa_kv", revision: 3 }),
  ).toEqual({
    type: "takosumi.dev/v1alpha1/FormActivation",
    ref: "fa_kv",
    version: "3",
  });
});

test("OfferingSelection validation covers every public nested field", async () => {
  const selection = await new OfferingService({
    catalogs: new InMemoryOfferingCatalogReader([catalog]),
    resolvers: [
      {
        subjectType: "services.example.net/v1/Endpoint",
        resolve: async () => ({
          ready: true,
          resolverId: "endpoint-host",
          resolutionFingerprint: FINGERPRINT,
        }),
      },
    ],
    now: () => "2026-07-20T01:00:00.000Z",
  }).resolve({
    reference: {
      catalogId: catalog.id,
      catalogVersion: catalog.version,
      offeringId: "ai-gateway",
      offeringVersion: "v1",
    },
  });
  expect(offeringSelectionProblems(selection)).toEqual([]);
  expect(
    offeringSelectionProblems({
      ...selection,
      requirements: [
        {
          type: "not-namespaced",
          ref: "customer@example.com",
          version: "v1",
        },
      ],
      maturity: "unknown",
      resolvedAt: "0",
    }),
  ).toEqual([
    "selection_maturity_invalid",
    "selection_requirements_invalid",
    "selection_resolved_at_invalid",
  ]);
});
