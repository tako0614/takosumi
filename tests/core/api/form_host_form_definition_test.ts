import { expect, test } from "bun:test";
import { Hono } from "hono";
import type {
  ActorContext,
  FormDefinition,
  FormAvailability,
  InstalledFormReference,
} from "takosumi-contract";
import { registerPortableFormHostRoutes } from "../../../core/api/form_host_routes.ts";
import type { ResourceShapeService } from "../../../core/domains/resource-shape/mod.ts";

const ACTOR: ActorContext = {
  actorAccountId: "acct_reader",
  workspaceId: "workspace_1",
  roles: ["owner"],
  scopes: ["forms:read"],
  requestId: "req_definition_read",
};

const IDENTITY: InstalledFormReference = {
  type: "object_bucket",
  version: "1.0.0",
  schemaDigest: `sha256:${"a".repeat(64)}`,
  packageDigest: `sha256:${"b".repeat(64)}`,
};

const DEFINITION: FormDefinition = {
  identity: IDENTITY,
  displayName: "Object storage",
  description: "A portable object bucket",
  operations: ["create", "read", "update", "delete"],
  desiredSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"],
  },
  metadata: {
    operatorOnly: "must not cross the host boundary",
    takoform: { status: "standard" },
  },
  installedAt: "2026-08-01T00:00:00.000Z",
};

function query(identity: InstalledFormReference = IDENTITY): string {
  const params = new URLSearchParams({
    space: "space_1",
    apiVersion: "forms.takoform.com/v1alpha1",
    kind: "ObjectBucket",
    definitionVersion: identity.version,
    schemaDigest: identity.schemaDigest,
    packageDigest: identity.packageDigest,
  });
  return params.toString();
}

function appFor(options: { readonly allowed?: boolean } = {}) {
  const app = new Hono();
  const availability: FormAvailability = {
    form: IDENTITY,
    definitionKnown: true,
    installed: true,
    executable: true,
    activated: true,
    availableToPrincipal: options.allowed !== false,
    operations: DEFINITION.operations,
    compatibleAdapterIds: ["test"],
    eligibleTargetPoolClasses: ["test"],
    deprecated: false,
  };
  registerPortableFormHostRoutes(app, {
    service: {} as ResourceShapeService,
    availability: {
      listFormAvailability: async () => ({ items: [availability] }),
      getReadableFormDefinition: async (input) =>
        options.allowed !== false &&
        JSON.stringify(input.identity) === JSON.stringify(IDENTITY)
          ? DEFINITION
          : undefined,
    },
    authorize: async () => ({ ok: true, actor: ACTOR }),
    canReadForms: () => true,
  });
  return app;
}

test("exact Form Definition read returns only the principal-safe projection", async () => {
  const response = await appFor().request(
    `/apis/forms.takoform.com/v1alpha1/form-definitions/ObjectBucket?${query()}`,
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    identity: {
      formRef: {
        apiVersion: "forms.takoform.com/v1alpha1",
        kind: "ObjectBucket",
        definitionVersion: "1.0.0",
        schemaDigest: IDENTITY.schemaDigest,
      },
      packageDigest: IDENTITY.packageDigest,
    },
    displayName: DEFINITION.displayName,
    description: DEFINITION.description,
    desiredSchema: DEFINITION.desiredSchema,
  });
});

test("exact Form Definition read fails closed for incomplete, mismatched, or unavailable identity", async () => {
  const app = appFor();
  const partial = await app.request(
    "/apis/forms.takoform.com/v1alpha1/form-definitions/ObjectBucket?space=space_1&kind=ObjectBucket",
  );
  expect(partial.status).toBe(400);

  const wrongPath = await app.request(
    `/apis/forms.takoform.com/v1alpha1/form-definitions/KVStore?${query()}`,
  );
  expect(wrongPath.status).toBe(404);

  const wrongPackage = await app.request(
    `/apis/forms.takoform.com/v1alpha1/form-definitions/ObjectBucket?${query({
      ...IDENTITY,
      packageDigest: `sha256:${"c".repeat(64)}`,
    })}`,
  );
  expect(wrongPackage.status).toBe(404);

  const denied = await appFor({ allowed: false }).request(
    `/apis/forms.takoform.com/v1alpha1/form-definitions/ObjectBucket?${query()}`,
  );
  expect(denied.status).toBe(404);
});

test("Form Definition read still requires the existing forms read scope", async () => {
  const app = new Hono();
  registerPortableFormHostRoutes(app, {
    service: {} as ResourceShapeService,
    availability: {
      listFormAvailability: async () => ({ items: [] }),
      getReadableFormDefinition: async () => DEFINITION,
    },
    authorize: async () => ({ ok: true, actor: ACTOR }),
    canReadForms: () => false,
  });
  const response = await app.request(
    `/apis/forms.takoform.com/v1alpha1/form-definitions/ObjectBucket?${query()}`,
  );
  expect(response.status).toBe(403);
});
