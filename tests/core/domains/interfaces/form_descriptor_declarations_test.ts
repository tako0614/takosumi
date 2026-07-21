import { expect, test } from "bun:test";
import type {
  FormInterfaceDescriptor,
  InstalledFormReference,
} from "takosumi-contract";
import { formRefKey } from "takosumi-contract";
import {
  createInMemoryInterfaceStores,
  createPortableDeclarationReader,
  ensureFormDescriptorInterfaces,
  InterfaceService,
} from "../../../../core/domains/interfaces/mod.ts";

const FORM: InstalledFormReference = {
  formRef: {
    apiVersion: "forms.takoform.com/v1alpha1",
    kind: "ObjectBucket",
    definitionVersion: "1.0.0",
    schemaDigest: "sha256:" + "a".repeat(64),
  },
  packageDigest: "sha256:" + "b".repeat(64),
};

const RESOURCE_ID = "tkrn:space_1:ObjectBucket:assets";

function service(): InterfaceService {
  return new InterfaceService({
    stores: createInMemoryInterfaceStores(),
    // Every Resource-owned declaration below is materialization-only; the
    // resolution path has its own coverage.
    ownerExists: async () => true,
  });
}

function descriptor(
  overrides: Partial<FormInterfaceDescriptor> = {},
): FormInterfaceDescriptor {
  return {
    name: "mcp.server",
    version: "2025-11-25",
    ...overrides,
  };
}

async function materialize(
  interfaces: InterfaceService,
  descriptors: readonly FormInterfaceDescriptor[],
) {
  return await ensureFormDescriptorInterfaces({
    interfaces,
    workspaceId: "workspace_1",
    resourceId: RESOURCE_ID,
    resourceName: "assets",
    form: FORM,
    descriptors,
  });
}

test("a declared descriptor becomes a Resource-owned Interface with form provenance", async () => {
  const interfaces = service();
  const result = await materialize(interfaces, [
    descriptor({
      inputs: [
        { name: "endpoint", source: "output", pointer: "/mcp/endpoint" },
        { name: "protocol", source: "literal", value: "streamable-http" },
      ],
    }),
  ]);
  expect(result.skipped).toEqual([]);
  expect(result.materialized).toHaveLength(1);
  const record = result.materialized[0]!;
  // The portable identity is the declared type, not the host instance name.
  expect(record.spec.type).toBe("mcp.server");
  expect(record.spec.version).toBe("2025-11-25");
  expect(record.metadata.ownerRef).toEqual({
    kind: "Resource",
    id: RESOURCE_ID,
  });
  expect(record.metadata.materializedFrom).toEqual({
    source: "form_descriptor",
    formRefKey: formRefKey(FORM.formRef),
    formSchemaDigest: FORM.formRef.schemaDigest,
    descriptorName: "mcp.server",
    descriptorVersion: "2025-11-25",
  });
  // The portable `output` source maps onto this host's own vocabulary; a Form
  // never names a Capsule or Resource output directly.
  expect(record.spec.inputs?.endpoint).toEqual({
    source: "resource_output",
    resourceId: RESOURCE_ID,
    outputName: "mcp",
    pointer: "/endpoint",
  });
  expect(record.spec.inputs?.protocol).toEqual({
    source: "literal",
    value: "streamable-http",
  });
});

test("materialization is idempotent and never grants authorization", async () => {
  const interfaces = service();
  const first = await materialize(interfaces, [descriptor()]);
  const second = await materialize(interfaces, [descriptor()]);
  expect(second.materialized).toHaveLength(1);
  expect(second.materialized[0]!.metadata.id).toBe(
    first.materialized[0]!.metadata.id,
  );
  const bindings = await interfaces.listBindings(
    first.materialized[0]!.metadata.id,
  );
  expect(bindings).toEqual([]);
});

test("a host that does not understand a declared source declares nothing", async () => {
  const interfaces = service();
  const result = await materialize(interfaces, [
    descriptor({
      inputs: [{ name: "hint", source: "other-host.surface_hint" }],
    }),
  ]);
  // Fail closed: never a record resolved with the input silently missing.
  expect(result.materialized).toEqual([]);
  expect(result.skipped).toEqual([
    {
      name: "mcp.server",
      version: "2025-11-25",
      required: false,
      reason: "unsupported_source",
    },
  ]);
});

test("a descriptor never adopts or rewrites a declaration made another way", async () => {
  const interfaces = service();
  const existing = await interfaces.create(
    {
      workspaceId: "workspace_1",
      name: "assets.mcp.server",
      ownerRef: { kind: "Resource", id: RESOURCE_ID },
      spec: {
        type: "mcp.server",
        version: "2025-11-25",
        document: { owner: "compatibility-profile" },
        access: { visibility: "workspace" },
      },
    },
    undefined,
    { compatibilityProfile: "compat.example.v1", compatibilityKey: "route" },
  );
  const result = await materialize(interfaces, [descriptor()]);
  expect(result.materialized).toHaveLength(1);
  expect(result.materialized[0]?.metadata.id).not.toBe(existing.metadata.id);
  expect(result.materialized[0]?.metadata.materializedFrom?.source).toBe(
    "form_descriptor",
  );
  expect(result.skipped).toEqual([]);
  const after = await interfaces.get(existing.metadata.id);
  expect(after.spec.document).toEqual({ owner: "compatibility-profile" });
  expect(after.metadata.materializedFrom?.source).toBe("compatibility_profile");
});

function readerFor(interfaces: InterfaceService) {
  return createPortableDeclarationReader({
    interfaces,
    listResources: async () => ({
      items: [
        {
          apiVersion: "takosumi.dev/v1alpha1",
          kind: "ObjectBucket",
          metadata: { name: "assets", space: "space_1", generation: 1 },
          spec: {},
          form: FORM,
          status: { phase: "Ready", observedGeneration: 1 },
        } as never,
      ],
      nextCursor: undefined,
    }),
    resolveWorkspace: async () => "workspace_1",
  });
}

const ACTOR = { subjectId: "user_1", requestId: "req_1" } as never;

test("the portable read reports the declared identity, never the host record", async () => {
  const interfaces = service();
  await materialize(interfaces, [descriptor()]);
  const declared = await readerFor(interfaces).listDeclaredInterfaces({
    actor: ACTOR,
    space: "space_1",
  });
  expect(declared).toEqual([
    {
      name: "mcp.server",
      version: "2025-11-25",
      resource: { kind: "ObjectBucket", name: "assets" },
      document: {},
      values: {},
      form: FORM,
    },
  ]);
  // No id, generation, revision, owner, provenance, condition, or binding: the
  // read says what exists, never who may use it or how the host tracks it.
  const projected = declared[0] as Record<string, unknown>;
  for (const leaked of [
    "id",
    "generation",
    "resolvedRevision",
    "ownerRef",
    "provenance",
    "conditions",
    "bindings",
    "permissions",
  ]) {
    expect(projected[leaked]).toBeUndefined();
  }
});

test("a private declaration stays out of the portable answer", async () => {
  const interfaces = service();
  await interfaces.create({
    workspaceId: "workspace_1",
    name: "assets.private.thing",
    ownerRef: { kind: "Resource", id: RESOURCE_ID },
    spec: {
      type: "private.thing",
      version: "1",
      document: {},
      // Visibility is discovery policy, so private is not part of the answer.
      access: { visibility: "private" },
    },
  });
  const declared = await readerFor(interfaces).listDeclaredInterfaces({
    actor: ACTOR,
    space: "space_1",
  });
  expect(declared.map((item) => item.name)).toEqual([]);
});

test("an unresolvable Space contributes nothing instead of guessing", async () => {
  const interfaces = service();
  await materialize(interfaces, [descriptor()]);
  const reader = createPortableDeclarationReader({
    interfaces,
    listResources: async () => ({
      items: [
        {
          apiVersion: "takosumi.dev/v1alpha1",
          kind: "ObjectBucket",
          metadata: { name: "assets", space: "space_1", generation: 1 },
          spec: {},
          form: FORM,
          status: { phase: "Ready", observedGeneration: 1 },
        } as never,
      ],
      nextCursor: undefined,
    }),
    // Equal-looking ids never imply ownership.
    resolveWorkspace: async () => undefined,
  });
  expect(
    await reader.listDeclaredInterfaces({ actor: ACTOR, space: "space_1" }),
  ).toEqual([]);
});
