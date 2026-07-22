import { expect, test } from "bun:test";
import type {
  ActorContext,
  TargetImplementationDescriptor,
  TargetPoolEntry,
} from "takosumi-contract";
import {
  PluginResourceShapeAdapter,
  StubResourceShapeAdapter,
  type AdapterApplyInput,
  type AdapterDeleteInput,
  type ResourceShapePlan,
} from "../../../../core/domains/resource-shape/mod.ts";

const actor: ActorContext = {
  actorAccountId: "acct_1",
  roles: ["owner"],
  requestId: "req_1",
};

const target: TargetPoolEntry = {
  name: "cloudflare-main",
  type: "cloudflare",
  ref: "ts_acc_takosumi_cloud",
  priority: 100,
};

const plan: ResourceShapePlan = {
  shape: "ObjectBucket",
  validatedSpec: { name: "assets", interfaces: ["s3_api"] },
  templateId: "cloudflare-r2-bucket",
  moduleFiles: [
    { path: "main.tf", text: 'output "bucket_name" { value = "assets" }' },
  ],
  inputs: { bucketName: "assets", accountId: "ts_acc_takosumi_cloud" },
  publicOutputs: [
    { name: "bucket_name", type: "string" },
    { name: "s3_endpoint", type: "url" },
  ],
};

const moduleDescriptor: TargetImplementationDescriptor = {
  shape: "ObjectBucket",
  implementation: "operator.bucket.module",
  interfaces: { object_store: "native", s3_api: "native" },
  providerSource: "registry.opentofu.org/cloudflare/cloudflare",
  moduleTemplate: "cloudflare-r2-bucket",
};

const pluginDescriptor: TargetImplementationDescriptor = {
  shape: "ObjectBucket",
  implementation: "operator.bucket.plugin",
  interfaces: { object_store: "native", s3_api: "native" },
  plugin: "cloud-managed",
};

function applyInput(
  overrides: Partial<AdapterApplyInput> = {},
): AdapterApplyInput {
  return {
    resourceId: "tkrn:space_1:ObjectBucket:assets",
    resourceGeneration: 3,
    environment: "default",
    stateGeneration: 1,
    plan,
    target,
    implementation: moduleDescriptor,
    actor,
    ...overrides,
  };
}

function deleteInput(
  overrides: Partial<AdapterDeleteInput> = {},
): AdapterDeleteInput {
  return {
    resourceId: "tkrn:space_1:ObjectBucket:assets",
    resourceGeneration: 3,
    environment: "default",
    stateGeneration: 1,
    plan,
    target,
    implementation: moduleDescriptor,
    nativeResources: [{ type: "cloudflare_r2_bucket", id: "assets" }],
    actor,
    ...overrides,
  };
}

test("plugin adapter rejects invalid Resource generation before dispatch", async () => {
  let called = false;
  const adapter = new PluginResourceShapeAdapter(
    new StubResourceShapeAdapter(),
    {
      "cloud-managed": {
        fetch() {
          called = true;
          return new Response(null, { status: 204 });
        },
      },
    },
  );

  await expect(
    adapter.apply(
      applyInput({
        implementation: pluginDescriptor,
        resourceGeneration: 0,
      }),
    ),
  ).rejects.toThrow("positive safe-integer resourceGeneration");
  expect(called).toBe(false);
});

test("plugin adapter routes plugin-backed operations to the injected binding", async () => {
  const calls: { readonly url: string; readonly body: unknown }[] = [];
  const adapter = new PluginResourceShapeAdapter(
    new StubResourceShapeAdapter(),
    {
      "cloud-managed": {
        async fetch(request) {
          calls.push({ url: request.url, body: await request.json() });
          if (request.url.endsWith("/delete"))
            return new Response(null, { status: 204 });
          if (request.url.endsWith("/observe")) {
            return Response.json({
              status: "current",
              summary: "in sync",
              runId: "plugin-must-not-own-run-id",
              backendOperationId: "provider-observe-42",
            });
          }
          return Response.json({
            summary: "managed",
            runId: "plugin-must-not-own-run-id",
            backendOperationId: "provider-operation-42",
            nativeResources: [
              {
                type: "cloudflare_r2_bucket",
                id: "assets",
                ownership: "operator",
              },
            ],
            outputs: { bucket_name: "assets" },
          });
        },
      },
    },
  );

  const resolvedConnections = {
    ASSETS: {
      resourceId: "tkrn:space_1:ObjectBucket:assets",
      kind: "ObjectBucket" as const,
      permissions: ["read" as const],
      projection: "runtime_binding" as const,
      target: "cloudflare-main",
      nativeResources: [{ type: "cloudflare_r2_bucket", id: "assets" }],
      outputs: { bucket_name: "assets" },
    },
  };
  const preview = await adapter.preview(
    applyInput({
      implementation: pluginDescriptor,
      resolvedConnections,
    }),
  );
  const applied = await adapter.apply(
    applyInput({
      implementation: pluginDescriptor,
      resolvedConnections,
      operationKey: "sha256:stable-apply-assets",
    }),
  );
  const imported = await adapter.importResource({
    ...applyInput({
      implementation: pluginDescriptor,
      resolvedConnections,
    }),
    nativeId: "bucket-native-123",
  });
  const observed = await adapter.observe(
    applyInput({
      implementation: pluginDescriptor,
      resolvedConnections,
    }),
  );
  const refreshed = await adapter.refresh(
    applyInput({
      implementation: pluginDescriptor,
      resolvedConnections,
    }),
  );
  await adapter.delete(
    deleteInput({
      implementation: pluginDescriptor,
      operationKey: "sha256:stable-delete-assets",
    }),
  );

  expect(preview.summary).toBe("managed");
  expect(preview.nativeResources).toEqual([
    {
      type: "cloudflare_r2_bucket",
      id: "assets",
      ownership: "operator",
    },
  ]);
  expect(applied.outputs).toEqual({ bucket_name: "assets" });
  expect(applied.nativeResources[0]?.ownership).toBe("operator");
  expect("runId" in applied).toBe(false);
  expect(applied.backendOperationId).toBe("provider-operation-42");
  expect(imported).toMatchObject({
    summary: "managed",
    outputs: { bucket_name: "assets" },
    backendOperationId: "provider-operation-42",
  });
  expect("runId" in imported).toBe(false);
  expect(observed).toEqual({
    status: "current",
    summary: "in sync",
    backendOperationId: "provider-observe-42",
  });
  expect(refreshed).toMatchObject({
    summary: "managed",
    outputs: { bucket_name: "assets" },
    backendOperationId: "provider-operation-42",
  });
  expect("runId" in refreshed).toBe(false);
  expect(calls.map((call) => call.url)).toEqual([
    "https://takosumi-resource-shape-plugin.local/cloud-managed/preview",
    "https://takosumi-resource-shape-plugin.local/cloud-managed/apply",
    "https://takosumi-resource-shape-plugin.local/cloud-managed/import",
    "https://takosumi-resource-shape-plugin.local/cloud-managed/observe",
    "https://takosumi-resource-shape-plugin.local/cloud-managed/refresh",
    "https://takosumi-resource-shape-plugin.local/cloud-managed/delete",
  ]);
  expect(calls[0]?.body).toMatchObject({
    action: "preview",
    resource: {
      kind: "ObjectBucket",
      spec: { name: "assets", interfaces: ["s3_api"] },
    },
    input: {
      resourceId: "tkrn:space_1:ObjectBucket:assets",
      resolvedConnections,
    },
  });
  expect(calls[1]?.body).toMatchObject({
    action: "apply",
    input: { operationKey: "sha256:stable-apply-assets" },
  });
  expect(calls[5]?.body).toMatchObject({
    action: "delete",
    input: { operationKey: "sha256:stable-delete-assets" },
  });
});

test("plugin adapter rejects malformed import responses", async () => {
  const adapter = new PluginResourceShapeAdapter(
    new StubResourceShapeAdapter(),
    {
      "cloud-managed": {
        fetch() {
          return Response.json({
            summary: "missing outputs",
            nativeResources: [{ type: "cloudflare_r2_bucket", id: "assets" }],
          });
        },
      },
    },
  );

  await expect(
    adapter.importResource({
      ...applyInput({ implementation: pluginDescriptor }),
      nativeId: "bucket-native-123",
    }),
  ).rejects.toThrow("import response must include outputs");
});

test("plugin adapter falls back when no implementation plugin is selected", async () => {
  const adapter = new PluginResourceShapeAdapter(
    new StubResourceShapeAdapter(),
    {},
  );
  const result = await adapter.apply(applyInput());
  expect(result.outputs.bucket_name).toBe(
    "stub://cloudflare-main/tkrn:space_1:ObjectBucket:assets/bucket_name",
  );
});

test("plugin adapter fails closed when a selected plugin is not installed", async () => {
  const adapter = new PluginResourceShapeAdapter(
    new StubResourceShapeAdapter(),
    {},
  );
  await expect(
    adapter.apply(
      applyInput({
        implementation: { ...pluginDescriptor, plugin: "missing" },
      }),
    ),
  ).rejects.toThrow('Resource Shape adapter plugin "missing" is not installed');
});

test("plugin adapter rejects malformed preview responses", async () => {
  const adapter = new PluginResourceShapeAdapter(
    new StubResourceShapeAdapter(),
    {
      "cloud-managed": {
        fetch() {
          return Response.json({ summary: "missing native resources" });
        },
      },
    },
  );

  await expect(
    adapter.preview(applyInput({ implementation: pluginDescriptor })),
  ).rejects.toThrow("preview response must include nativeResources");
});

test("plugin adapter rejects malformed apply responses", async () => {
  const adapter = new PluginResourceShapeAdapter(
    new StubResourceShapeAdapter(),
    {
      "cloud-managed": {
        fetch() {
          return Response.json({
            nativeResources: [{ type: "cloudflare_r2_bucket", id: "assets" }],
          });
        },
      },
    },
  );

  await expect(
    adapter.apply(applyInput({ implementation: pluginDescriptor })),
  ).rejects.toThrow("apply response must include outputs");
});

test("plugin adapter rejects fake OpenTofu execution authority", async () => {
  const adapter = new PluginResourceShapeAdapter(
    new StubResourceShapeAdapter(),
    {
      "cloud-managed": {
        fetch() {
          return Response.json({
            summary: "attempted state claim",
            nativeResources: [
              {
                type: "cloudflare_r2_bucket",
                id: "assets",
                ownership: "operator",
              },
            ],
            outputs: { bucket_name: "assets" },
            execution: {
              runId: "plugin-run",
              stateRef: "plugin://fake-state",
              stateGeneration: 999,
            },
          });
        },
      },
    },
  );

  await expect(
    adapter.apply(applyInput({ implementation: pluginDescriptor })),
  ).rejects.toThrow("cannot claim an OpenTofu execution/state pointer");
});

test("plugin adapter rejects invalid or unresolved native ownership evidence", async () => {
  for (const ownership of ["tenant", "planned"] as const) {
    const adapter = new PluginResourceShapeAdapter(
      new StubResourceShapeAdapter(),
      {
        "cloud-managed": {
          fetch() {
            return Response.json({
              nativeResources: [
                { type: "cloudflare_r2_bucket", id: "assets", ownership },
              ],
              outputs: { bucket_name: "assets" },
            });
          },
        },
      },
    );

    await expect(
      adapter.apply(applyInput({ implementation: pluginDescriptor })),
    ).rejects.toThrow(
      ownership === "planned"
        ? "cannot remain planned"
        : "ownership is invalid",
    );
  }
});

test("plugin adapter rejects malformed observe responses", async () => {
  const adapter = new PluginResourceShapeAdapter(
    new StubResourceShapeAdapter(),
    {
      "cloud-managed": {
        fetch() {
          return Response.json({ status: "maybe", summary: "unknown" });
        },
      },
    },
  );

  await expect(
    adapter.observe(applyInput({ implementation: pluginDescriptor })),
  ).rejects.toThrow(
    "observe response status must be current, drifted, or missing",
  );
});

test("plugin adapter rejects malformed refresh responses", async () => {
  const adapter = new PluginResourceShapeAdapter(
    new StubResourceShapeAdapter(),
    {
      "cloud-managed": {
        fetch() {
          return Response.json({
            summary: "missing outputs",
            nativeResources: [{ type: "cloudflare_r2_bucket", id: "assets" }],
          });
        },
      },
    },
  );

  await expect(
    adapter.refresh(applyInput({ implementation: pluginDescriptor })),
  ).rejects.toThrow("refresh response must include outputs");
});
