// Integration tests for ApplyService dispatch into apply_v2.
//
// Verifies that:
//   1. A manifest carrying the new shape-model `resources` array is routed
//      through `apply_v2` (observable via the fake provider apply log).
//   2. Retired top-level `template` shorthand is rejected at this boundary.
//   3. Internal `compute + resources(map) + routes` plan inputs continue to
//      use the plan-then-apply pipeline unchanged.

import assert from "node:assert/strict";
import {
  type ApplyResult,
  InMemoryObservabilitySink,
  kms,
  objectStorage,
  type ProviderPlugin,
  registerProvider,
  registerShape,
  secretStore,
  type Shape,
  unregisterProvider,
  unregisterShape,
} from "takosumi-contract";
import { ApplyService } from "./apply_service.ts";
import { InMemoryDeploymentStore } from "./deployment_service.ts";
import type { PublicDeployManifest } from "./types.ts";

const SHAPE = "test-dispatch-shape";
const SHAPE_VERSION = "v1";
const PROV_OK = "test-dispatch-provider";

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

function setUp() {
  applyLog.length = 0;
  registerShape(shape());
  registerProvider(provider());
}

function tearDown() {
  unregisterShape(SHAPE, SHAPE_VERSION);
  unregisterProvider(PROV_OK);
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

function componentMapManifest(): PublicDeployManifest {
  return {
    name: "demo-app-component-map",
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

Deno.test("ApplyService rejects retired top-level template shorthand", async () => {
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
        template: "selfhosted-single-vm@v1",
        inputs: {},
      },
    } as unknown as PublicDeployManifest;

    await assert.rejects(
      () =>
        service.applyManifest({
          spaceId: "space_template",
          manifest,
        }),
      /top-level `template` is retired/,
    );
    assert.equal(applyLog.length, 0);
  } finally {
    tearDown();
  }
});

Deno.test("ApplyService keeps component-map inputs on the plan/apply path", async () => {
  setUp();
  try {
    const store = new InMemoryDeploymentStore();
    const service = new ApplyService({
      store,
      platformAdapters: platformAdapters(),
    });
    const manifest = componentMapManifest();

    const result = await service.applyManifest({
      spaceId: "space_component_map",
      manifest,
      createdAt: "2026-05-01T00:00:00.000Z",
    });

    assert.equal(
      applyLog.length,
      0,
      "component-map flow does not call apply_v2",
    );
    assert.equal(result.v2Outcome, undefined);
    assert.equal(result.deployment.status, "applied");
    assert.equal(result.deployment.space_id, "space_component_map");
    assert.equal(result.deployment.group_id, "demo-app-component-map");
    assert.ok(result.head, "component-map flow returns a GroupHead");
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
