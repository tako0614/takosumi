import { expect, test } from "bun:test";
import {
  formActivationOfferingRequirement,
  formHostResourceNamespaceOfferingContext,
  formOfferingSubject,
  type FormActivation,
  type FormAvailability,
  type FormDefinition,
  type FormPackage,
  type InstalledFormReference,
  type Offering,
} from "takosumi-contract";
import { FormOfferingSubjectResolver } from "../../../../core/domains/offerings/form_subject_resolver.ts";

const identity: InstalledFormReference = {
  formRef: {
    apiVersion: "forms.takoform.com/v1alpha1",
    kind: "ObjectBucket",
    definitionVersion: "1.0.1",
    schemaDigest: `sha256:${"a".repeat(64)}`,
  },
  packageDigest: `sha256:${"b".repeat(64)}`,
};
const activation: FormActivation = {
  id: "object-bucket-stable",
  identity,
  scope: { type: "workspace", id: "workspace_1" },
  audience: { roles: ["developer"] },
  policy: {},
  eligibleTargetPoolClasses: ["managed.standard"],
  status: "active",
  revision: 3,
  createdAt: "2026-07-20T00:00:00.000Z",
  createdBy: "operator",
  updatedAt: "2026-07-20T00:00:00.000Z",
  updatedBy: "operator",
};
const definition: FormDefinition = {
  identity,
  operations: ["create", "read", "delete"],
  installedAt: "2026-07-20T00:00:00.000Z",
};
const formPackage: FormPackage = {
  packageDigest: identity.packageDigest,
  artifactRef: "oci://registry.example.test/form@sha256:fixture",
  verifierId: "fixture",
  status: "installed",
  definitionRefs: [identity.formRef],
  installedAt: "2026-07-20T00:00:00.000Z",
  installedBy: "operator",
  updatedAt: "2026-07-20T00:00:00.000Z",
};
const availability: FormAvailability = {
  identity,
  definitionKnown: true,
  installed: true,
  executable: true,
  activated: true,
  availableToPrincipal: true,
  operations: definition.operations,
  compatibleAdapterIds: ["managed-object-store"],
  eligibleTargetPoolClasses: ["managed.standard"],
  deprecated: false,
};
const offering: Offering = {
  id: "object-bucket",
  version: "v1",
  subject: formOfferingSubject(identity),
  requirements: [formActivationOfferingRequirement(activation)],
  profile: "standard",
  region: "global",
  maturity: "stable",
  audience: { roles: ["developer"] },
  status: "active",
};

function resolverWith(input: {
  getActivation?: () => Promise<FormActivation | undefined>;
  resolvedAvailability?: FormAvailability;
}) {
  return new FormOfferingSubjectResolver({
    forms: {
      getActivation: input.getActivation ?? (async () => activation),
      getDefinition: async () => definition,
      getPackage: async () => formPackage,
    },
    availability: {
      resolveFormOfferingAvailability: async (request) => {
        expect(request.activationId).toBe(activation.id);
        return input.resolvedAvailability ?? availability;
      },
    },
  });
}

test("Form Offering resolver pins the exact activation and canonical Resource availability", async () => {
  const result = await resolverWith({}).resolve({
    offering,
    principalId: "account_1",
    roles: ["developer"],
    workspaceId: "workspace_1",
    contexts: [formHostResourceNamespaceOfferingContext("resource_scope_1")],
  });

  expect(result.ready).toBeTrue();
  if (result.ready) {
    expect(result.resolverId).toBe("takosumi.service-form.v1");
    expect(result.resolutionFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
  }
});

test("Form Offering resolver fails closed without scope or on activation TOCTOU", async () => {
  expect(
    await resolverWith({}).resolve({
      offering,
      principalId: "account_1",
      roles: ["developer"],
      workspaceId: "workspace_1",
      contexts: [],
    }),
  ).toEqual({
    ready: false,
    reason: "resource_namespace_context_required",
  });

  let activationRead = 0;
  const changed = { ...activation, revision: activation.revision + 1 };
  expect(
    await resolverWith({
      getActivation: async () =>
        activationRead++ === 0 ? activation : changed,
    }).resolve({
      offering,
      principalId: "account_1",
      roles: ["developer"],
      workspaceId: "workspace_1",
      contexts: [formHostResourceNamespaceOfferingContext("resource_scope_1")],
    }),
  ).toEqual({ ready: false, reason: "form_evidence_changed" });
});

test("Form Offering resolver rejects implicit or additional prerequisites", async () => {
  expect(
    await resolverWith({}).resolve({
      offering: { ...offering, requirements: [] },
      roles: ["developer"],
      workspaceId: "workspace_1",
      contexts: [formHostResourceNamespaceOfferingContext("resource_scope_1")],
    }),
  ).toEqual({ ready: false, reason: "activation_requirement_invalid" });
});
