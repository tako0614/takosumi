import { expect, test } from "bun:test";
import { Hono } from "hono";
import type {
  ActorContext,
  TakoformDeclaredInterface,
} from "takosumi-contract";
import {
  registerPortableFormHostRoutes,
  type PortableInterfaceDeclarationReader,
} from "../../../core/api/form_host_routes.ts";
import type { ResourceShapeService } from "../../../core/domains/resource-shape/mod.ts";

const ACTOR: ActorContext = {
  actorAccountId: "acct_reader",
  workspaceId: "workspace_1",
  roles: ["owner"],
  scopes: ["forms:read"],
  requestId: "req_interface_read",
};

const DECLARATIONS: readonly TakoformDeclaredInterface[] = [
  {
    name: "storage.object",
    version: "v1",
    resource: { kind: "ObjectBucket", name: "assets" },
    document: { protocol: "https" },
  },
  {
    name: "storage.object",
    version: "v1",
    resource: { kind: "ObjectBucket", name: "archives" },
    document: { protocol: "https" },
  },
  {
    name: "storage.object",
    version: "v2",
    resource: { kind: "ObjectBucket", name: "assets" },
    document: { protocol: "https", revision: 2 },
  },
];

function appFor(options: { readonly allowRead?: boolean } = {}) {
  const app = new Hono();
  const reader: PortableInterfaceDeclarationReader = {
    listDeclaredInterfaces: async (input) =>
      DECLARATIONS.filter(
        (entry) =>
          (input.name === undefined || entry.name === input.name) &&
          (input.version === undefined || entry.version === input.version) &&
          (input.resourceKind === undefined ||
            entry.resource.kind === input.resourceKind) &&
          (input.resourceName === undefined ||
            entry.resource.name === input.resourceName),
      ),
  };
  registerPortableFormHostRoutes(app, {
    service: {} as ResourceShapeService,
    availability: {
      listFormAvailability: async () => ({ items: [] }),
    },
    authorize: async () => ({ ok: true, actor: ACTOR }),
    canReadForms: () => options.allowRead !== false,
    interfaceDeclarations: reader,
  });
  return app;
}

test("portable Interface read distinguishes version and instance ambiguity", async () => {
  const app = appFor();
  const identity = await app.request(
    "/apis/forms.takoform.com/v1alpha1/interfaces/storage.object?space=space_1",
  );
  expect(identity.status).toBe(409);
  expect(await identity.json()).toMatchObject({
    error: { code: "interface_identity_ambiguous" },
  });

  const instance = await app.request(
    "/apis/forms.takoform.com/v1alpha1/interfaces/storage.object?space=space_1&version=v1",
  );
  expect(instance.status).toBe(409);
  expect(await instance.json()).toMatchObject({
    error: { code: "interface_instance_ambiguous" },
  });
});

test("portable Interface exact Resource selector returns one declaration", async () => {
  const response = await appFor().request(
    "/apis/forms.takoform.com/v1alpha1/interfaces/storage.object?space=space_1&version=v1&resourceKind=ObjectBucket&resourceName=assets",
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(DECLARATIONS[0]);
});

test("portable Interface selectors and read scope fail closed", async () => {
  const app = appFor();
  const partialSelector = await app.request(
    "/apis/forms.takoform.com/v1alpha1/interfaces?space=space_1&resourceKind=ObjectBucket",
  );
  expect(partialSelector.status).toBe(400);
  expect(await partialSelector.json()).toMatchObject({
    error: { code: "invalid_argument" },
  });

  const denied = await appFor({ allowRead: false }).request(
    "/apis/forms.takoform.com/v1alpha1/interfaces?space=space_1",
  );
  expect(denied.status).toBe(403);
  expect(await denied.json()).toMatchObject({
    error: { code: "permission_denied" },
  });
});
