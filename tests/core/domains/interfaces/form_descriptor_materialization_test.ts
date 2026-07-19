import { expect, test } from "bun:test";
import type {
  FormInterfaceDescriptor,
  InstalledFormReference,
  ResourceObject,
} from "takosumi-contract";
import { formRefKey } from "takosumi-contract";
import {
  createInMemoryInterfaceStores,
  createPortableDeclarationReader,
  ensureFormDescriptorInterfaces,
  InterfaceService,
  OutputBackedInterfaceInputResolver,
  RequiredFormInterfaceError,
} from "../../../../core/domains/interfaces/mod.ts";
import {
  createInMemoryResourceShapeStores,
  formatResourceShapeId,
} from "../../../../core/domains/resource-shape/mod.ts";

const NOW = "2026-07-19T00:00:00.000Z";
const FORM: InstalledFormReference = {
  formRef: {
    apiVersion: "forms.takoform.com/v1alpha1",
    kind: "ExampleInterfaceService",
    definitionVersion: "1.0.0",
    schemaDigest: `sha256:${"1".repeat(64)}`,
  },
  packageDigest: `sha256:${"2".repeat(64)}`,
};

test("portable Form descriptors preserve pair identity, exact document, and RFC 6901 output mappings", async () => {
  const resourceStores = createInMemoryResourceShapeStores();
  const resourceId = formatResourceShapeId(
    "space_1",
    "ExampleInterfaceService",
    "api",
  );
  await resourceStores.resources.upsert({
    id: resourceId,
    spaceId: "space_1",
    kind: "ExampleInterfaceService",
    name: "api",
    managedBy: "takoform.form-host.v1",
    form: FORM,
    spec: {},
    phase: "Ready",
    generation: 1,
    observedGeneration: 1,
    outputs: {
      endpoint: "https://example.test/mcp",
      nested: { "a/b": { "~key": "escaped" } },
    },
    createdAt: NOW,
    updatedAt: NOW,
  });
  let sequence = 0;
  const interfaces = new InterfaceService({
    stores: createInMemoryInterfaceStores(),
    resolver: new OutputBackedInterfaceInputResolver({
      opentofu: {} as never,
      resources: resourceStores.resources,
      resolveResourceWorkspace: async () => "workspace_1",
    }),
    now: () => NOW,
    newId: (prefix) => `${prefix}_${++sequence}`,
  });
  const descriptors: readonly FormInterfaceDescriptor[] = [
    {
      name: "mcp.server",
      version: "2025-11-25",
      required: true,
      document: { title: "Exact portable declaration" },
      documentSchema: {
        type: "object",
        additionalProperties: false,
        properties: { title: { type: "string" } },
        required: ["title"],
      },
      inputs: [
        { name: "whole", source: "output", pointer: "" },
        {
          name: "escaped",
          source: "output",
          pointer: "/nested/a~1b/~0key",
        },
        { name: "nullable", source: "literal", value: null },
      ],
    },
    {
      name: "mcp.server",
      version: "1",
      document: {},
    },
  ];

  const first = await ensureFormDescriptorInterfaces({
    interfaces,
    workspaceId: "workspace_1",
    resourceId,
    form: FORM,
    descriptors,
  });
  expect(first.materialized).toHaveLength(2);
  expect(first.materialized.map((item) => item.spec.version).sort()).toEqual([
    "1",
    "2025-11-25",
  ]);
  const required = first.materialized.find(
    (item) => item.spec.version === "2025-11-25",
  )!;
  expect(required.status.phase).toBe("Resolved");
  expect(required.spec.document).toEqual({
    title: "Exact portable declaration",
  });
  expect(required.status.resolvedInputs).toEqual({
    whole: {
      endpoint: "https://example.test/mcp",
      nested: { "a/b": { "~key": "escaped" } },
    },
    escaped: "escaped",
    nullable: null,
  });
  expect(required.metadata.materializedFrom).toEqual({
    source: "form_descriptor",
    formRefKey: formRefKey(FORM.formRef),
    formSchemaDigest: FORM.formRef.schemaDigest,
    descriptorName: "mcp.server",
    descriptorVersion: "2025-11-25",
  });

  const replay = await ensureFormDescriptorInterfaces({
    interfaces,
    workspaceId: "workspace_1",
    resourceId,
    form: FORM,
    descriptors,
  });
  expect(replay.materialized.map((item) => item.metadata.id).sort()).toEqual(
    first.materialized.map((item) => item.metadata.id).sort(),
  );

  const controlActor = {
    actorAccountId: "acct_control",
    workspaceId: "workspace_1",
    roles: ["owner"] as const,
    requestId: "req_control",
  };
  await expect(
    interfaces.update(
      required.metadata.id,
      {
        spec: {
          ...required.spec,
          document: { title: "must not be changed by the host API" },
        },
      },
      required.metadata.generation,
      controlActor,
    ),
  ).rejects.toMatchObject({ code: "failed_precondition" });
  await expect(
    interfaces.retire(
      required.metadata.id,
      required.metadata.generation,
      controlActor,
    ),
  ).rejects.toMatchObject({ code: "failed_precondition" });

  const internallyTampered = await interfaces.update(
    required.metadata.id,
    {
      spec: {
        ...required.spec,
        document: { title: "simulated storage drift" },
      },
    },
    required.metadata.generation,
  );
  expect(internallyTampered.spec.document).toEqual({
    title: "simulated storage drift",
  });
  const repaired = await ensureFormDescriptorInterfaces({
    interfaces,
    workspaceId: "workspace_1",
    resourceId,
    form: FORM,
    descriptors,
  });
  const repairedRequired = repaired.materialized.find(
    (item) => item.spec.version === "2025-11-25",
  )!;
  expect(repairedRequired.metadata.id).not.toBe(required.metadata.id);
  expect(repairedRequired.spec.document).toEqual({
    title: "Exact portable declaration",
  });

  await expect(
    ensureFormDescriptorInterfaces({
      interfaces,
      workspaceId: "workspace_1",
      resourceId,
      form: FORM,
      descriptors: [
        {
          name: "broken.required",
          version: "1",
          required: true,
          inputs: [{ name: "missing", source: "output", pointer: "/missing" }],
        },
      ],
    }),
  ).rejects.toBeInstanceOf(RequiredFormInterfaceError);

  const upgradedForm: InstalledFormReference = {
    formRef: {
      ...FORM.formRef,
      definitionVersion: "2.0.0",
      schemaDigest: `sha256:${"3".repeat(64)}`,
    },
    packageDigest: `sha256:${"4".repeat(64)}`,
  };
  const upgraded = await ensureFormDescriptorInterfaces({
    interfaces,
    workspaceId: "workspace_1",
    resourceId,
    form: upgradedForm,
    descriptors: [],
  });
  expect(upgraded.materialized).toEqual([]);
  const upgradedHistory = await interfaces.list({
    workspaceId: "workspace_1",
    ownerKind: "Resource",
    ownerId: resourceId,
    includeRetired: true,
  });
  expect(upgradedHistory.length).toBeGreaterThanOrEqual(3);
  expect(upgradedHistory.every((item) => item.status.phase === "Retired")).toBe(
    true,
  );
});

test("portable declaration reads paginate every Resource and enforce the explicit Workspace bridge", async () => {
  const stores = createInMemoryInterfaceStores();
  const interfaces = new InterfaceService({
    stores,
    now: () => NOW,
    newId: () => "if_last",
  });
  const resources: ResourceObject[] = Array.from(
    { length: 201 },
    (_, index) => ({
      apiVersion: "takosumi.dev/v1alpha1",
      kind: "ExampleInterfaceService",
      form: FORM,
      metadata: {
        name: `service-${String(index).padStart(3, "0")}`,
        space: "space_1",
        generation: 1,
      },
      spec: {},
      status: { phase: "Ready", observedGeneration: 1 },
    }),
  );
  const last = resources.at(-1)!;
  const lastId = formatResourceShapeId(
    last.metadata.space,
    last.kind,
    last.metadata.name,
  );
  await ensureFormDescriptorInterfaces({
    interfaces,
    workspaceId: "workspace_1",
    resourceId: lastId,
    form: FORM,
    descriptors: [
      {
        name: "mcp.server",
        version: "1",
        document: { title: "last page" },
        inputs: [{ name: "protocol", source: "literal", value: "http" }],
      },
    ],
  });
  const cursors: Array<string | undefined> = [];
  let repairCalls = 0;
  let resolverCalls = 0;
  const reader = createPortableDeclarationReader({
    interfaces,
    resolveWorkspace: async () => {
      resolverCalls += 1;
      return "workspace_1";
    },
    ensureResourceDeclarations: async () => {
      repairCalls += 1;
    },
    listResources: (_space, page) => {
      cursors.push(page.cursor);
      const offset = page.cursor ? Number(page.cursor) : 0;
      const items = resources.slice(offset, offset + page.limit);
      const next = offset + items.length;
      return Promise.resolve({
        items,
        ...(next < resources.length ? { nextCursor: String(next) } : {}),
      });
    },
  });

  const visible = await reader.listDeclaredInterfaces({
    actor: {
      actorAccountId: "acct_1",
      workspaceId: "workspace_1",
      roles: ["owner"],
      requestId: "req_1",
    },
    space: "space_1",
    name: "mcp.server",
  });
  expect(cursors).toEqual([undefined, "100", "200"]);
  expect(visible).toEqual([
    {
      name: "mcp.server",
      version: "1",
      resource: {
        kind: "ExampleInterfaceService",
        name: "service-200",
      },
      document: { title: "last page" },
      values: { protocol: "http" },
      form: FORM,
    },
  ]);
  expect(repairCalls).toBe(0);
  expect(resolverCalls).toBe(1);

  expect(
    await reader.listDeclaredInterfaces({
      actor: {
        actorAccountId: "acct_1",
        workspaceId: "workspace_1",
        roles: ["owner"],
        requestId: "req_exact",
      },
      space: "space_1",
      resourceKind: last.kind,
      resourceName: last.metadata.name,
    }),
  ).toHaveLength(1);
  expect(repairCalls).toBe(1);
  expect(resolverCalls).toBe(2);

  resources[resources.length - 1] = {
    ...last,
    status: {
      ...last.status,
      phase: "Degraded",
    },
  };
  expect(
    await reader.listDeclaredInterfaces({
      actor: {
        actorAccountId: "acct_1",
        workspaceId: "workspace_1",
        roles: ["owner"],
        requestId: "req_degraded",
      },
      space: "space_1",
      resourceKind: last.kind,
      resourceName: last.metadata.name,
    }),
  ).toEqual([]);
  expect(repairCalls).toBe(1);
  expect(resolverCalls).toBe(2);

  expect(
    await reader.listDeclaredInterfaces({
      actor: {
        actorAccountId: "acct_2",
        workspaceId: "workspace_2",
        roles: ["owner"],
        requestId: "req_2",
      },
      space: "space_1",
      name: "mcp.server",
    }),
  ).toEqual([]);
  expect(repairCalls).toBe(1);
  expect(resolverCalls).toBe(3);
});
