import { expect, test } from "bun:test";
import type { ActorContext, TargetPoolEntry } from "takosumi-contract";
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

function applyInput(
  overrides: Partial<AdapterApplyInput> = {},
): AdapterApplyInput {
  return {
    resourceId: "tkrn:space_1:ObjectBucket:assets",
    plan,
    target,
    actor,
    ...overrides,
  };
}

function deleteInput(
  overrides: Partial<AdapterDeleteInput> = {},
): AdapterDeleteInput {
  return {
    resourceId: "tkrn:space_1:ObjectBucket:assets",
    plan,
    target,
    nativeResources: [{ type: "cloudflare_r2_bucket", id: "assets" }],
    actor,
    ...overrides,
  };
}

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
          return Response.json({
            summary: "managed",
            nativeResources: [{ type: "cloudflare_r2_bucket", id: "assets" }],
            outputs: { bucket_name: "assets" },
          });
        },
      },
    },
  );

  const preview = await adapter.preview(
    applyInput({ implementationPlugin: "cloud-managed" }),
  );
  const applied = await adapter.apply(
    applyInput({ implementationPlugin: "cloud-managed" }),
  );
  await adapter.delete(deleteInput({ implementationPlugin: "cloud-managed" }));

  expect(preview.summary).toBe("managed");
  expect(applied.outputs).toEqual({ bucket_name: "assets" });
  expect(calls.map((call) => call.url)).toEqual([
    "https://takosumi-resource-shape-plugin.local/cloud-managed/preview",
    "https://takosumi-resource-shape-plugin.local/cloud-managed/apply",
    "https://takosumi-resource-shape-plugin.local/cloud-managed/delete",
  ]);
  expect(calls[0]?.body).toMatchObject({
    action: "preview",
    input: { resourceId: "tkrn:space_1:ObjectBucket:assets" },
  });
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
    adapter.apply(applyInput({ implementationPlugin: "missing" })),
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
    adapter.preview(applyInput({ implementationPlugin: "cloud-managed" })),
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
    adapter.apply(applyInput({ implementationPlugin: "cloud-managed" })),
  ).rejects.toThrow("apply response must include outputs");
});
