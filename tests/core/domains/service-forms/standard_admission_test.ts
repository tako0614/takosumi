import { expect, test } from "bun:test";
import type {
  FormDefinition,
  FormPackage,
  InstalledFormReference,
  StandardFormAdmissionEvidence,
} from "takosumi-contract";
import { evaluateStandardFormAdmission } from "../../../../core/domains/service-forms/standard_admission.ts";

const IDENTITY: InstalledFormReference = {
  type: "example_store",
  version: "1.0.0",
  schemaDigest: `sha256:${"1".repeat(64)}`,
  packageDigest: `sha256:${"2".repeat(64)}`,
};

const DEFINITION: FormDefinition = {
  identity: IDENTITY,
  displayName: "Example store",
  operations: [
    "create",
    "read",
    "update",
    "delete",
    "import",
    "refresh",
    "sync",
    "drift",
  ],
  metadata: {
    takoform: {
      status: "standard",
      forceNewFields: ["/name"],
      interfaces: [],
    },
  },
  installedAt: "2026-07-17T00:00:00.000Z",
};

const PACKAGE: FormPackage = {
  packageDigest: IDENTITY.packageDigest,
  artifactRef: "r2:forms/example-store.json",
  verifierId: "takoform.form-package.v0+sigstore.test.v1",
  status: "installed",
  definitionRefs: [
    {
      type: IDENTITY.type,
      version: IDENTITY.version,
      schemaDigest: IDENTITY.schemaDigest,
    },
  ],
  installedAt: "2026-07-17T00:00:00.000Z",
  installedBy: "operator:test",
  updatedAt: "2026-07-17T00:00:00.000Z",
};

function evidence(): StandardFormAdmissionEvidence {
  const proof = (subject: string) => ({
    subject,
    runnerVersion: "1.0.0",
    identity: IDENTITY,
    status: "passed" as const,
    positiveFixtures: ["basic"],
    negativeFixtures: ["invalid-name"],
    evidenceDigest: `sha256:${"3".repeat(64)}`,
  });
  return {
    format: "takoform.standard-admission@v0",
    identity: IDENTITY,
    classification: "portable-standard",
    approvedSchemaDigest: IDENTITY.schemaDigest,
    audit: {
      lifecycle: {
        create: true,
        read: true,
        update: true,
        delete: true,
        import: true,
        refresh: true,
        sync: true,
        drift: true,
      },
      immutability: { reviewed: true, fields: ["/name"] },
      security: {
        secretFreeDesiredState: true,
        credentialBoundaryExternal: true,
        dataOnlyPackage: true,
      },
      interfaces: {
        reviewed: true,
        bindingAuthorityExternal: true,
        secretFreeDocuments: true,
      },
    },
    fixtures: {
      positive: [
        {
          name: "basic",
          config: { name: "example" },
          attributes: { state: "ready" },
          outputs: { endpoint: "https://example.test" },
        },
      ],
      negative: [
        {
          name: "invalid-name",
          stage: "config",
          input: { name: "" },
          expectedErrorCode: "invalid_argument",
        },
      ],
    },
    conformance: {
      host: proof("host:test"),
      provider: proof("provider:test"),
    },
  };
}

test("standard admission accepts exact signed-package evidence with full portable semantics", () => {
  expect(
    evaluateStandardFormAdmission({
      definition: DEFINITION,
      package: PACKAGE,
      trustedPackageVerifierId: PACKAGE.verifierId,
      evidence: evidence(),
    }),
  ).toEqual({ admitted: true, errors: [] });
});

test("retired apiVersion-envelope evidence is rejected in favor of the takoform format", () => {
  const candidate = evidence() as unknown as Record<string, unknown>;
  delete candidate.format;
  const result = evaluateStandardFormAdmission({
    definition: DEFINITION,
    package: PACKAGE,
    trustedPackageVerifierId: PACKAGE.verifierId,
    evidence: {
      ...candidate,
      apiVersion: "forms.takoform.com/standard-admission/v1alpha1",
    } as unknown as StandardFormAdmissionEvidence,
  });
  expect(result.admitted).toBe(false);
  expect(result.errors).toContain("unsupported standard-admission format");
});

test("lifecycle audit must attest sync; a retired observe key never substitutes", () => {
  const candidate = evidence();
  const lifecycle = {
    ...candidate.audit.lifecycle,
  } as unknown as Record<string, boolean>;
  delete lifecycle.sync;
  lifecycle.observe = true;
  const result = evaluateStandardFormAdmission({
    definition: DEFINITION,
    package: PACKAGE,
    trustedPackageVerifierId: PACKAGE.verifierId,
    evidence: {
      ...candidate,
      audit: {
        ...candidate.audit,
        lifecycle:
          lifecycle as unknown as StandardFormAdmissionEvidence["audit"]["lifecycle"],
      },
    },
  });
  expect(result.admitted).toBe(false);
  expect(result.errors).toContain(
    "lifecycle audit must explicitly pass every portable operation",
  );
});

test("legacy compatibility status never implicitly becomes a portable standard", () => {
  const result = evaluateStandardFormAdmission({
    definition: {
      ...DEFINITION,
      metadata: { takoform: { status: "compatibility-candidate" } },
    },
    package: PACKAGE,
    trustedPackageVerifierId: PACKAGE.verifierId,
    evidence: evidence(),
  });
  expect(result.admitted).toBe(false);
  expect(result.errors).toContain("verified definition status is not standard");
});

test("standard admission rejects digest substitution, missing coverage, and private authority fields", () => {
  const candidate = evidence();
  const result = evaluateStandardFormAdmission({
    definition: DEFINITION,
    package: PACKAGE,
    trustedPackageVerifierId: PACKAGE.verifierId,
    evidence: {
      ...candidate,
      approvedSchemaDigest: `sha256:${"f".repeat(64)}`,
      fixtures: {
        ...candidate.fixtures,
        positive: [
          {
            ...candidate.fixtures.positive[0]!,
            config: { name: "example", provider: "forbidden" },
          },
        ],
      },
      conformance: {
        ...candidate.conformance,
        provider: {
          ...candidate.conformance.provider,
          negativeFixtures: [],
        },
      },
    },
  });
  expect(result.admitted).toBe(false);
  expect(result.errors).toContain(
    "approved schema digest does not match the exact FormRef",
  );
  expect(result.errors).toContain(
    "provider conformance proof lacks exact negative coverage",
  );
  expect(
    result.errors.some((error) =>
      error.includes("forbidden standard-admission field provider"),
    ),
  ).toBe(true);
});

test("negative fixtures must expect the one portable invalid_argument wire code", () => {
  const candidate = evidence();
  const result = evaluateStandardFormAdmission({
    definition: DEFINITION,
    package: PACKAGE,
    trustedPackageVerifierId: PACKAGE.verifierId,
    evidence: {
      ...candidate,
      fixtures: {
        ...candidate.fixtures,
        negative: [
          {
            ...candidate.fixtures.negative[0]!,
            expectedErrorCode: "invalid_name",
          },
        ],
      },
    },
  });
  expect(result.admitted).toBe(false);
  expect(result.errors).toContain(
    "negative fixture invalid-name must use portable wire error code invalid_argument",
  );
});

test("standard admission refuses non-Takoform or revoked package authority", () => {
  const result = evaluateStandardFormAdmission({
    definition: DEFINITION,
    package: {
      ...PACKAGE,
      verifierId: "legacy-json-loader",
      status: "revoked",
    },
    trustedPackageVerifierId: PACKAGE.verifierId,
    evidence: evidence(),
  });
  expect(result.admitted).toBe(false);
  expect(result.errors).toContain(
    "definition lacks one installed Takoform-verified package",
  );
});
