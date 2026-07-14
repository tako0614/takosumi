import { expect, test } from "bun:test";
import {
  createPlatformReadinessContributionRegistry,
  isPlatformReadinessContribution,
  platformReadinessEvidenceSchemaErrors,
} from "../../contract/platform-readiness.ts";

const contribution = {
  kind: "takosumi.platform-readiness-contribution@v1",
  id: "example-operator-readiness",
  version: "1.2.0",
  capability: "example.operator-readiness.v1",
  domains: [
    {
      id: "external-operation",
      requiredEvidenceTypes: ["external-operation-proof"],
    },
  ],
  evidenceSchemas: {
    "external-operation-proof": {
      fields: ["proofId", "startedAt", "completedAt"],
      patterns: { proofId: "^proof_[a-z0-9]{6,}$" },
      after: { completedAt: "startedAt" },
    },
  },
  collectionClassHints: {
    "operation-drill": ["external-operation-proof"],
  },
} as const;

test("readiness contributions are versioned and registry selected", () => {
  expect(isPlatformReadinessContribution(contribution)).toBe(true);
  const registry = createPlatformReadinessContributionRegistry([contribution]);
  expect(registry.get(contribution.id)).toBe(contribution);
  expect(registry.get(contribution.id, contribution.version)).toBe(
    contribution,
  );
  expect(registry.get(contribution.id, "1.3.0")).toBeUndefined();
  expect(registry.hasCapability(contribution.capability)).toBe(true);
  expect(
    isPlatformReadinessContribution({ ...contribution, version: "latest" }),
  ).toBe(false);
  expect(
    isPlatformReadinessContribution({ ...contribution, version: "01.2.0" }),
  ).toBe(false);
  expect(
    isPlatformReadinessContribution({
      ...contribution,
      evidenceSchemas: { "external-operation-proof": [] },
    }),
  ).toBe(false);
  expect(
    isPlatformReadinessContribution({
      ...contribution,
      evidenceSchemas: {
        "external-operation-proof": {
          fields: ["proofId"],
          formats: { undeclaredField: "sha256" },
        },
      },
    }),
  ).toBe(false);
  expect(
    isPlatformReadinessContribution({
      ...contribution,
      collectionClassHints: {
        "unknown-collector": ["external-operation-proof"],
      },
    }),
  ).toBe(false);
  expect(
    isPlatformReadinessContribution({
      ...contribution,
      collectionClassHints: {
        "operation-drill": ["not-owned-by-this-contribution"],
      },
    }),
  ).toBe(false);
  expect(
    isPlatformReadinessContribution({
      ...contribution,
      evidenceSchemas: {
        "external-operation-proof": {
          fields: ["proofId"],
          after: { completedAt: "startedAt" },
        },
      },
    }),
  ).toBe(false);
  expect(() =>
    createPlatformReadinessContributionRegistry([
      contribution,
      { ...contribution, version: "1.3.0" },
    ]),
  ).toThrow("contribution id is duplicated");
});

test("contribution evidence schemas validate without extension code", () => {
  const schema = contribution.evidenceSchemas["external-operation-proof"];
  expect(
    platformReadinessEvidenceSchemaErrors(schema, {
      proofId: "proof_abcdef",
      startedAt: "2026-07-13T10:00:00Z",
      completedAt: "2026-07-13T10:05:00Z",
    }),
  ).toEqual([]);
  expect(
    platformReadinessEvidenceSchemaErrors(schema, {
      proofId: "wrong",
      startedAt: "2026-07-13T10:05:00Z",
      completedAt: "2026-07-13T10:00:00Z",
    }),
  ).toEqual([
    "evidence.proofId does not match its required pattern",
    "evidence.completedAt must be after startedAt",
  ]);
});

test("evidence semantics come from schema data, never field or type names", () => {
  const schema = {
    fields: ["ordinaryDigest", "amount", "classes", "left", "right"],
    formats: { ordinaryDigest: "sha256" },
    numericBounds: { amount: { minimum: 0, exclusiveMinimum: true } },
    requiredItems: { classes: ["alpha", "beta"] },
    distinctFields: [["left", "right"]],
  } as const;
  expect(
    platformReadinessEvidenceSchemaErrors(schema, {
      ordinaryDigest: `sha256:${"a".repeat(64)}`,
      amount: 1,
      classes: ["alpha", "beta"],
      left: "one",
      right: "two",
    }),
  ).toEqual([]);
  expect(
    platformReadinessEvidenceSchemaErrors(schema, {
      ordinaryDigest: "not-a-digest",
      amount: 0,
      classes: ["alpha"],
      left: "same",
      right: "same",
    }),
  ).toEqual([
    "evidence.ordinaryDigest is not a valid sha256",
    "evidence.amount must be greater than 0",
    "evidence.classes must include alpha, beta",
    "evidence.left,right must be pairwise distinct",
  ]);

  expect(
    platformReadinessEvidenceSchemaErrors(
      { fields: ["ordinaryDigest"] },
      { ordinaryDigest: "ordinary-value" },
    ),
  ).toEqual([]);
});
