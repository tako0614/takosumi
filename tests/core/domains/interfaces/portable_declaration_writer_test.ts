import { expect, test } from "bun:test";
import type {
  ActorContext,
  InstalledFormReference,
  ResourceObject,
} from "takosumi-contract";
import {
  createInMemoryInterfaceStores,
  createPortableDeclarationWriter,
  InterfaceService,
} from "../../../../core/domains/interfaces/mod.ts";

const FORM: InstalledFormReference = {
  formRef: {
    apiVersion: "forms.takoform.com/v1alpha1",
    kind: "HttpService",
    definitionVersion: "1.0.0",
    schemaDigest: `sha256:${"a".repeat(64)}`,
  },
  packageDigest: `sha256:${"b".repeat(64)}`,
};

const RESOURCE: ResourceObject = {
  apiVersion: "takosumi.dev/v1alpha1",
  kind: "HttpService",
  form: FORM,
  metadata: { name: "api", space: "space_1", generation: 1 },
  spec: {},
  status: { phase: "Ready", observedGeneration: 1 },
};

const ACTOR: ActorContext = {
  actorAccountId: "acct_owner",
  workspaceId: "workspace_1",
  roles: ["owner"],
  scopes: ["resources:*"],
  requestId: "req_iac",
};

function harness() {
  let id = 0;
  const interfaces = new InterfaceService({
    stores: createInMemoryInterfaceStores(),
    ownerExists: async () => true,
    now: () => "2026-07-29T00:00:00.000Z",
    newId: (prefix) => `${prefix}_${++id}`,
  });
  const writer = createPortableDeclarationWriter({
    interfaces,
    getResource: async (space, kind, name) =>
      space === "space_1" && kind === "HttpService" && name === "api"
        ? RESOURCE
        : undefined,
    resolveWorkspace: async () => "workspace_1",
    resolveResourceUri: async () => "https://api.example.test/",
  });
  return { interfaces, writer };
}

test("portable IaC writes opaque document content to the canonical Interface ledger", async () => {
  const { interfaces, writer } = harness();
  const created = await writer.putDeclaredInterface({
    actor: ACTOR,
    space: "space_1",
    expectedGeneration: 0,
    declaration: {
      name: "example.runtime",
      version: "1",
      resource: { kind: "HttpService", name: "api" },
      document: { arbitrary: { application: "data" } },
      documentSchema: {
        type: "object",
        additionalProperties: false,
        properties: { arbitrary: { type: "object" } },
        required: ["arbitrary"],
      },
      inputs: [
        { name: "mode", source: "literal", value: "public" },
        { name: "resource_uri", source: "resource_uri" },
      ],
      resourceUriInput: "resource_uri",
    },
  });
  expect(created).toMatchObject({
    name: "example.runtime",
    version: "1",
    resource: { kind: "HttpService", name: "api" },
    document: { arbitrary: { application: "data" } },
    values: {
      mode: "public",
      resource_uri: "https://api.example.test/",
    },
    resourceUri: "https://api.example.test/",
    resourceVersion: "1",
  });

  const records = await interfaces.list({
    workspaceId: "workspace_1",
    ownerKind: "Resource",
    includeRetired: true,
  });
  expect(records).toHaveLength(1);
  expect(records[0]!.metadata.materializedFrom).toEqual({
    source: "portable_iac",
    descriptorName: "example.runtime",
    descriptorVersion: "1",
  });
  expect(await interfaces.listBindings(records[0]!.metadata.id)).toEqual([]);
});

test("portable IaC update and delete are generation-fenced and replay-safe", async () => {
  const { interfaces, writer } = harness();
  const first = await writer.putDeclaredInterface({
    actor: ACTOR,
    space: "space_1",
    expectedGeneration: 0,
    declaration: {
      name: "example.runtime",
      version: "1",
      resource: { kind: "HttpService", name: "api" },
      document: { revision: 1 },
    },
  });
  const replay = await writer.putDeclaredInterface({
    actor: ACTOR,
    space: "space_1",
    expectedGeneration: 0,
    declaration: {
      name: "example.runtime",
      version: "1",
      resource: { kind: "HttpService", name: "api" },
      document: { revision: 1 },
    },
  });
  expect(replay.resourceVersion).toBe(first.resourceVersion);

  const updated = await writer.putDeclaredInterface({
    actor: ACTOR,
    space: "space_1",
    expectedGeneration: 1,
    declaration: {
      name: "example.runtime",
      version: "1",
      resource: { kind: "HttpService", name: "api" },
      document: { revision: 2 },
      resourceVersion: "1",
    },
  });
  expect(updated.document).toEqual({ revision: 2 });
  expect(updated.resourceVersion).toBe("2");

  await expect(
    writer.deleteDeclaredInterface({
      actor: ACTOR,
      space: "space_1",
      name: "example.runtime",
      version: "1",
      resourceKind: "HttpService",
      resourceName: "api",
      expectedGeneration: 1,
    }),
  ).rejects.toMatchObject({ code: "conflict" });

  await writer.deleteDeclaredInterface({
    actor: ACTOR,
    space: "space_1",
    name: "example.runtime",
    version: "1",
    resourceKind: "HttpService",
    resourceName: "api",
    expectedGeneration: 2,
  });
  await writer.deleteDeclaredInterface({
    actor: ACTOR,
    space: "space_1",
    name: "example.runtime",
    version: "1",
    resourceKind: "HttpService",
    resourceName: "api",
    expectedGeneration: 2,
  });
  expect(
    (
      await interfaces.list({
        workspaceId: "workspace_1",
        ownerKind: "Resource",
        includeRetired: true,
      })
    )[0]!.status.phase,
  ).toBe("Retired");
});

test("portable IaC rejects malformed mappings and invalid document schemas before persistence", async () => {
  const { interfaces, writer } = harness();
  await expect(
    writer.putDeclaredInterface({
      actor: ACTOR,
      space: "space_1",
      expectedGeneration: 0,
      declaration: {
        name: "example.runtime",
        version: "1",
        resource: { kind: "HttpService", name: "api" },
        document: {},
        inputs: [
          { name: "endpoint", source: "output", pointer: "/url" },
          { name: "endpoint", source: "literal", value: "duplicate" },
        ],
      },
    }),
  ).rejects.toMatchObject({ code: "invalid_argument" });

  await expect(
    writer.putDeclaredInterface({
      actor: ACTOR,
      space: "space_1",
      expectedGeneration: 0,
      declaration: {
        name: "example.runtime",
        version: "1",
        resource: { kind: "HttpService", name: "api" },
        document: { enabled: true },
        documentSchema: {
          type: "object",
          properties: { enabled: { type: "string" } },
        },
      },
    }),
  ).rejects.toMatchObject({ code: "invalid_argument" });

  expect(
    await interfaces.list({
      workspaceId: "workspace_1",
      ownerKind: "Resource",
      includeRetired: true,
    }),
  ).toEqual([]);
});

test("portable IaC direct writes cannot bypass the Form portable-data policy", async () => {
  const { interfaces, writer } = harness();
  await expect(
    writer.putDeclaredInterface({
      actor: ACTOR,
      space: "space_1",
      expectedGeneration: 0,
      declaration: {
        name: "example.runtime",
        version: "1",
        resource: { kind: "HttpService", name: "api" },
        document: { apiKey: "must-not-enter-the-ledger" },
      },
    }),
  ).rejects.toMatchObject({
    code: "invalid_argument",
    message: expect.stringContaining("forbidden field apiKey"),
  });
  expect(
    await interfaces.list({
      workspaceId: "workspace_1",
      ownerKind: "Resource",
      includeRetired: true,
    }),
  ).toEqual([]);
});
