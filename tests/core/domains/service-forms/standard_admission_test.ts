import { expect, test } from "bun:test";
import type {
  FormDefinition,
  FormPackage,
  InstalledFormReference,
  StandardFormAdmissionEvidence,
} from "takosumi-contract";
import { evaluateStandardFormAdmission } from "../../../../core/domains/service-forms/standard_admission.ts";

const IDENTITY: InstalledFormReference = {
  formRef: {
    apiVersion: "forms.takoform.com/v1alpha1",
    kind: "ExampleStore",
    definitionVersion: "1.0.0",
    schemaDigest: `sha256:${"1".repeat(64)}`,
  },
  packageDigest: `sha256:${"2".repeat(64)}`,
};

const DEFINITION: FormDefinition = {
  identity: IDENTITY,
  displayName: "Example store",
  operations: ["create", "read", "update", "delete", "import", "refresh"],
  metadata: {
    takoform: {
      status: "standard",
      immutableFields: ["/name"],
      interfaces: [],
    },
  },
  installedAt: "2026-07-17T00:00:00.000Z",
};

const PACKAGE: FormPackage = {
  packageDigest: IDENTITY.packageDigest,
  artifactRef: "r2:forms/example-store.json",
  verifierId: "takoform.form-package.v1alpha1+sigstore.test.v1",
  status: "installed",
  definitionRefs: [IDENTITY.formRef],
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
    apiVersion: "forms.takoform.com/standard-admission/v1alpha1",
    identity: IDENTITY,
    classification: "portable-standard",
    approvedSchemaDigest: IDENTITY.formRef.schemaDigest,
    audit: {
      lifecycle: {
        create: true,
        read: true,
        update: true,
        delete: true,
        import: true,
        observe: true,
        refresh: true,
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
          desired: { name: "example" },
          observed: { state: "ready" },
          output: { endpoint: "https://example.test" },
        },
      ],
      negative: [
        {
          name: "invalid-name",
          stage: "desired",
          input: { name: "" },
          expectedErrorCode: "invalid_name",
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
            desired: { name: "example", provider: "forbidden" },
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
