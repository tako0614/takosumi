// Integration tests for ApplyService dispatch into apply_v2.
//
// Verifies that:
//   1. A manifest carrying the new shape-model `resources` array is routed
//      through `apply_v2` (observable via the fake provider apply log).
//   2. A manifest using a `template` invocation expands the template and
//      then dispatches through `apply_v2`.
//   3. Legacy `compute + resources(map) + routes` manifests continue to use
//      the existing plan-then-apply pipeline unchanged.

import assert from "node:assert/strict";
import {
  type ApplyResult,
  InMemoryObservabilitySink,
  kms,
  objectStorage,
  type ProviderPlugin,
  registerProvider,
  registerShape,
  registerTemplate,
  secretStore,
  type Shape,
  type Template,
  unregisterProvider,
  unregisterShape,
  unregisterTemplate,
} from "takosumi-contract";
import { ApplyService } from "./apply_service.ts";
import { InMemoryDeploymentStore } from "./deployment_service.ts";
import type { PublicDeployManifest } from "./types.ts";

const SHAPE = "test-dispatch-shape";
const SHAPE_VERSION = "v1";
const PROV_OK = "test-dispatch-provider";
const TEMPLATE_ID = "test-dispatch-template";
const TEMPLATE_VERSION = "v1";

interface ApplyLogEntry {
  readonly providerId: string;
  readonly resolvedSpec: unknown;
  readonly handle: string;
  readonly tenantId: string;
  readonly spaceId: string;
}

const applyLog: ApplyLogEntry[] = [];

function shape(): Shape {
  return {
    id: SHAPE,
    version: SHAPE_VERSION,
    capabilities: ["c"],
    outputFields: ["url"],
    validateSpec(value, issues) {
      if (typeof value !== "object" || value === null) {
        issues.push({ path: "$", message: "must be object" });
      }
    },
    validateOutputs(_value, _issues) {},
  };
}

function provider(): ProviderPlugin {
  return {
    id: PROV_OK,
    version: "0.0.1",
    implements: { id: SHAPE, version: SHAPE_VERSION },
    capabilities: ["c"],
    apply(spec, ctx): Promise<ApplyResult> {
      const handle = `h-${applyLog.length}`;
      applyLog.push({
        providerId: PROV_OK,
        resolvedSpec: spec,
        handle,
        tenantId: ctx.tenantId,
        spaceId: ctx.spaceId,
      });
      return Promise.resolve({
        handle,
        outputs: { url: `https://${PROV_OK}/${handle}` },
      });
    },
    destroy(_handle, _ctx) {
      return Promise.resolve();
    },
    status() {
      return Promise.resolve({
        kind: "ready" as const,
        observedAt: new Date(0).toISOString(),
      });
    },
  };
}

function template(): Template {
  return {
    id: TEMPLATE_ID,
    version: TEMPLATE_VERSION,
    description: "test dispatch template",
    validateInputs(_value, _issues) {},
    expand(_inputs) {
      return [
        {
          shape: `${SHAPE}@${SHAPE_VERSION}`,
          name: "from-template",
          provider: PROV_OK,
          spec: { kind: "expanded" },
        },
      ];
    },
  };
}

function setUp() {
  applyLog.length = 0;
  registerShape(shape());
  registerProvider(provider());
  registerTemplate(template());
}

function tearDown() {
  unregisterShape(SHAPE, SHAPE_VERSION);
  unregisterProvider(PROV_OK);
  unregisterTemplate(TEMPLATE_ID, TEMPLATE_VERSION);
}

function platformAdapters() {
  const clock = () => new Date(0);
  return {
    secrets: new secretStore.MemoryEncryptedSecretStore({
      clock,
      idGenerator: () => "test-id",
    }),
    observability: new InMemoryObservabilitySink(),
    kms: new kms.NoopTestKms({ clock }),
    objectStorage: new objectStorage.MemoryObjectStorage({ clock }),
  };
}

function legacyManifest(): PublicDeployManifest {
  return {
    name: "demo-app-legacy",
    version: "1.0.0",
    compute: {
      web: {
        type: "container",
        image:
          "registry.example.test/demo@sha256:1111111111111111111111111111111111111111111111111111111111111111",
        port: 8080,
        env: { MESSAGE: "hello" },
      },
    },
    resources: {
      db: {
        type: "postgres",
        plan: "dev",
        bindings: { web: "DATABASE_URL" },
      },
    },
    routes: {
      web: { target: "web", path: "/" },
    },
  };
}

Deno.test("ApplyService dispatches shape-model resources to apply_v2", async () => {
  setUp();
  try {
    const store = new InMemoryDeploymentStore();
    const service = new ApplyService({
      store,
      platformAdapters: platformAdapters(),
    });
    const manifest = {
      name: "shape-model-app",
      resources: [
        {
          shape: `${SHAPE}@${SHAPE_VERSION}`,
          name: "first",
          provider: PROV_OK,
          spec: { kind: "raw" },
        },
        {
          shape: `${SHAPE}@${SHAPE_VERSION}`,
          name: "second",
          provider: PROV_OK,
          spec: { upstream: "${ref:first.url}" },
        },
      ],
    } as unknown as PublicDeployManifest;

    const result = await service.applyManifest({
      spaceId: "space_dispatch",
      manifest,
      createdAt: "2026-05-01T00:00:00.000Z",
    });

    // applyV2 ran -> the fake provider was invoked twice via the v2 path.
    assert.equal(applyLog.length, 2, "v2 provider apply called per resource");
    assert.equal(applyLog[0].tenantId, "space_dispatch");
    assert.equal(applyLog[0].spaceId, "space_dispatch");
    // ref expansion happened inside apply_v2 before the second apply.
    const second = applyLog.find((e) => e.handle === "h-1");
    assert.ok(second);
    const upstream = (second!.resolvedSpec as { upstream?: unknown }).upstream;
    assert.match(String(upstream), /^https:\/\//);

    // The synthesized Deployment record is persisted with status `applied`.
    assert.equal(result.deployment.status, "applied");
    assert.equal(result.deployment.space_id, "space_dispatch");
    assert.equal(result.deployment.group_id, "shape-model-app");
    assert.equal(result.deployment.applied_at, "2026-05-01T00:00:00.000Z");
    assert.ok(result.v2Outcome, "v2Outcome should be returned");
    assert.equal(result.v2Outcome!.status, "succeeded");
    assert.equal(result.v2Outcome!.applied.length, 2);

    // The store keeps the synthesized record.
    const stored = await store.getDeployment(result.deployment.id);
    assert.ok(stored);
    assert.equal(stored!.status, "applied");
  } finally {
    tearDown();
  }
});

Deno.test("ApplyService expands manifest.template and dispatches to apply_v2", async () => {
  setUp();
  try {
    const store = new InMemoryDeploymentStore();
    const service = new ApplyService({
      store,
      platformAdapters: platformAdapters(),
    });
    const manifest = {
      name: "template-app",
      template: {
        template: `${TEMPLATE_ID}@${TEMPLATE_VERSION}`,
        inputs: {},
      },
    } as unknown as PublicDeployManifest;

    const result = await service.applyManifest({
      spaceId: "space_template",
      manifest,
    });

    assert.equal(applyLog.length, 1, "template expanded into one resource");
    assert.equal(result.v2Outcome?.status, "succeeded");
    assert.equal(result.v2Outcome?.applied.length, 1);
    assert.equal(result.v2Outcome?.applied[0].name, "from-template");
    assert.equal(result.deployment.group_id, "template-app");
  } finally {
    tearDown();
  }
});

Deno.test("ApplyService preserves legacy target+services flow (no v2 dispatch)", async () => {
  setUp();
  try {
    const store = new InMemoryDeploymentStore();
    const service = new ApplyService({
      store,
      platformAdapters: platformAdapters(),
    });
    const manifest = legacyManifest();

    const result = await service.applyManifest({
      spaceId: "space_legacy",
      manifest,
      createdAt: "2026-05-01T00:00:00.000Z",
    });

    // The legacy flow does NOT touch the v2 provider apply log.
    assert.equal(applyLog.length, 0, "legacy flow does not call apply_v2");
    assert.equal(result.v2Outcome, undefined);
    // Legacy flow returns an `applied` Deployment from DeploymentService.
    assert.equal(result.deployment.status, "applied");
    assert.equal(result.deployment.space_id, "space_legacy");
    assert.equal(result.deployment.group_id, "demo-app-legacy");
    // The legacy flow advances the GroupHead.
    assert.ok(result.head, "legacy flow returns a GroupHead");
    assert.equal(result.head!.current_deployment_id, result.deployment.id);
  } finally {
    tearDown();
  }
});

Deno.test("ApplyService surfaces a clear error when shape-model is used without platformAdapters", async () => {
  setUp();
  try {
    const store = new InMemoryDeploymentStore();
    const service = new ApplyService({ store }); // no platformAdapters
    const manifest = {
      name: "no-adapters",
      resources: [
        {
          shape: `${SHAPE}@${SHAPE_VERSION}`,
          name: "x",
          provider: PROV_OK,
          spec: {},
        },
      ],
    } as unknown as PublicDeployManifest;

    await assert.rejects(
      service.applyManifest({ spaceId: "s", manifest }),
      /platformAdapters/,
    );
  } finally {
    tearDown();
  }
});
