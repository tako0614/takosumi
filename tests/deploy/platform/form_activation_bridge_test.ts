import { expect, test } from "bun:test";

import type {
  FormActivation,
  FormDefinition,
  FormPackage,
  InstalledFormReference,
} from "../../../contract/index.ts";
import { resolvePlatformFormActivation } from "../../../deploy/platform/worker.ts";

const identity: InstalledFormReference = {
  formRef: {
    apiVersion: "forms.takoform.com/v1alpha1",
    kind: "ObjectBucket",
    definitionVersion: "1.0.0",
    schemaDigest: `sha256:${"1".repeat(64)}`,
  },
  packageDigest: `sha256:${"2".repeat(64)}`,
};

const activation: FormActivation = {
  id: "object-bucket-stable",
  identity,
  scope: { type: "operator" },
  audience: { public: true },
  policy: {},
  eligibleTargetPoolClasses: ["takosumi.cloud.managed.v1"],
  status: "active",
  revision: 3,
  createdAt: "2026-07-17T00:00:00.000Z",
  createdBy: "operator",
  updatedAt: "2026-07-17T00:00:00.000Z",
  updatedBy: "operator",
};

const definition: FormDefinition = {
  identity,
  operations: ["create", "read", "delete"],
  installedAt: "2026-07-17T00:00:00.000Z",
};

const formPackage: FormPackage = {
  packageDigest: identity.packageDigest,
  artifactRef: "oci://registry.example.test/forms/object-bucket@sha256:fixture",
  verifierId: "test-verifier",
  status: "installed",
  definitionRefs: [identity.formRef],
  installedAt: "2026-07-17T00:00:00.000Z",
  installedBy: "operator",
  updatedAt: "2026-07-17T00:00:00.000Z",
};

function operationsWith(overrides: {
  activation?: FormActivation;
  definition?: FormDefinition;
  formPackage?: FormPackage;
}) {
  return async () =>
    ({
      forms: {
        getActivation: async () => overrides.activation,
        getDefinition: async () => overrides.definition,
        getPackage: async () => overrides.formPackage,
      },
    }) as never;
}

test("platform FormActivation bridge requires the requested installed operation", async () => {
  const operations = operationsWith({ activation, definition, formPackage });

  expect(
    await resolvePlatformFormActivation(
      {
        activationId: activation.id,
        expectedIdentity: identity,
        requiredOperation: "create",
      },
      {},
      operations,
    ),
  ).toEqual({ status: "active", activation });

  expect(
    await resolvePlatformFormActivation(
      {
        activationId: activation.id,
        expectedIdentity: identity,
        requiredOperation: "update",
      },
      {},
      operations,
    ),
  ).toEqual({ status: "unavailable", reason: "operation_not_supported" });
});

test("platform FormActivation bridge keeps the operation gate optional", async () => {
  expect(
    await resolvePlatformFormActivation(
      { activationId: activation.id, expectedIdentity: identity },
      {},
      operationsWith({ activation, definition, formPackage }),
    ),
  ).toEqual({ status: "active", activation });
});
