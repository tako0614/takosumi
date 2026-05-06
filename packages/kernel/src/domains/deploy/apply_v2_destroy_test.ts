import assert from "node:assert/strict";
import {
  type ApplyResult,
  formatPlatformOperationIdempotencyKey,
  type JsonObject,
  type ManifestResource,
  type PlatformContext,
  type PlatformOperationContext,
  type ProviderPlugin,
  registerProvider,
  registerShape,
  type Shape,
  unregisterProvider,
  unregisterShape,
} from "takosumi-contract";
import { destroyV2 } from "./apply_v2.ts";
import { buildOperationPlanPreview } from "./operation_plan_preview.ts";
import { InMemoryObservabilitySink } from "../../services/observability/mod.ts";

const SHAPE = "test-destroy-shape";
const PROV_OK = "test-destroy-provider-ok";
const PROV_FAIL = "test-destroy-provider-fail";

const destroyLog: string[] = [];
const destroyOperations: Array<PlatformOperationContext | undefined> = [];

function shape(): Shape {
  return {
    id: SHAPE,
    version: "v1",
    capabilities: ["c"],
    outputFields: ["url", "id"],
    validateSpec(value, issues) {
      if (typeof value !== "object" || value === null) {
        issues.push({ path: "$", message: "must be object" });
      }
    },
    validateOutputs(_value, _issues) {},
  };
}

function provider(id: string, behavior: "ok" | "fail"): ProviderPlugin {
  return {
    id,
    version: "0.0.1",
    implements: { id: SHAPE, version: "v1" },
    capabilities: ["c"],
    apply(_spec, _ctx): Promise<ApplyResult> {
      const handle = `h-${id}`;
      return Promise.resolve({
        handle,
        outputs: { url: `https://${handle}`, id: handle } as JsonObject,
      });
    },
    destroy(handle, ctx) {
      if (behavior === "fail") {
        return Promise.reject(new Error(`destroy-failed:${handle}`));
      }
      destroyLog.push(`${id}:${handle}`);
      destroyOperations.push(ctx.operation);
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

function setUp(): void {
  destroyLog.length = 0;
  destroyOperations.length = 0;
  registerShape(shape());
  registerProvider(provider(PROV_OK, "ok"));
  registerProvider(provider(PROV_FAIL, "fail"));
}

function tearDown(): void {
  unregisterShape(SHAPE, "v1");
  unregisterProvider(PROV_OK);
  unregisterProvider(PROV_FAIL);
}

const ctx = {} as PlatformContext;

Deno.test("destroyV2 invokes provider.destroy in reverse topological order", async () => {
  setUp();
  try {
    const resources: ManifestResource[] = [
      // root → leaf chain: db ← api ← web (web depends on api, api on db)
      { shape: `${SHAPE}@v1`, name: "db", provider: PROV_OK, spec: {} },
      {
        shape: `${SHAPE}@v1`,
        name: "api",
        provider: PROV_OK,
        spec: { dbUrl: "${ref:db.url}" },
      },
      {
        shape: `${SHAPE}@v1`,
        name: "web",
        provider: PROV_OK,
        spec: { apiUrl: "${ref:api.url}" },
      },
    ];
    const outcome = await destroyV2({ resources, context: ctx });
    assert.equal(outcome.status, "succeeded");
    assert.equal(outcome.errors.length, 0);
    assert.equal(outcome.destroyed.length, 3);
    // Reverse topological order: web (leaf) → api → db (root)
    assert.deepEqual(
      outcome.destroyed.map((d) => d.name),
      ["web", "api", "db"],
    );
    assert.deepEqual(
      destroyLog,
      [`${PROV_OK}:web`, `${PROV_OK}:api`, `${PROV_OK}:db`],
    );
  } finally {
    tearDown();
  }
});

Deno.test("destroyV2 accumulates per-resource errors and returns partial", async () => {
  setUp();
  try {
    const resources: ManifestResource[] = [
      { shape: `${SHAPE}@v1`, name: "db", provider: PROV_OK, spec: {} },
      {
        shape: `${SHAPE}@v1`,
        name: "api",
        provider: PROV_FAIL,
        spec: { dbUrl: "${ref:db.url}" },
      },
      {
        shape: `${SHAPE}@v1`,
        name: "web",
        provider: PROV_OK,
        spec: { apiUrl: "${ref:api.url}" },
      },
    ];
    const outcome = await destroyV2({ resources, context: ctx });
    assert.equal(outcome.status, "partial");
    assert.equal(outcome.errors.length, 1);
    assert.equal(outcome.errors[0]?.name, "api");
    assert.match(outcome.errors[0]?.message ?? "", /destroy-failed/);
    // The other two still succeed; best-effort continues past failures.
    assert.equal(outcome.destroyed.length, 2);
    assert.deepEqual(
      outcome.destroyed.map((d) => d.name).sort(),
      ["db", "web"],
    );
  } finally {
    tearDown();
  }
});

Deno.test("destroyV2 returns failed-validation on unknown shape", async () => {
  setUp();
  try {
    const resources: ManifestResource[] = [
      { shape: "ghost@v1", name: "a", provider: PROV_OK, spec: {} },
    ];
    const outcome = await destroyV2({ resources, context: ctx });
    assert.equal(outcome.status, "failed-validation");
    assert.equal(outcome.destroyed.length, 0);
    assert.equal(outcome.errors.length, 0);
    assert.ok(outcome.issues.length > 0);
  } finally {
    tearDown();
  }
});

Deno.test("destroyV2 returns failed-validation on cycle", async () => {
  setUp();
  try {
    const resources: ManifestResource[] = [
      {
        shape: `${SHAPE}@v1`,
        name: "a",
        provider: PROV_OK,
        spec: { ref: "${ref:b.url}" },
      },
      {
        shape: `${SHAPE}@v1`,
        name: "b",
        provider: PROV_OK,
        spec: { ref: "${ref:a.url}" },
      },
    ];
    const outcome = await destroyV2({ resources, context: ctx });
    assert.equal(outcome.status, "failed-validation");
    assert.equal(outcome.destroyed.length, 0);
  } finally {
    tearDown();
  }
});

Deno.test("destroyV2 threads WAL idempotency context to provider.destroy", async () => {
  setUp();
  try {
    const resources: ManifestResource[] = [
      { shape: `${SHAPE}@v1`, name: "db", provider: PROV_OK, spec: {} },
    ];
    const operationPlanPreview = buildOperationPlanPreview({
      resources,
      planned: [{
        name: "db",
        shape: `${SHAPE}@v1`,
        providerId: PROV_OK,
        op: "delete",
      }],
      edges: [],
      spaceId: "space:fenced",
      deploymentName: "destroy-app",
    });

    const outcome = await destroyV2({
      resources,
      context: { ...ctx, spaceId: "space:fenced" },
      operationPlanPreview,
    });

    assert.equal(outcome.status, "succeeded");
    assert.equal(destroyOperations.length, 1);
    const operation = destroyOperations[0];
    assert.ok(operation);
    const plannedOperation = operationPlanPreview.operations[0];
    assert.ok(plannedOperation);
    assert.equal(operation.phase, "destroy");
    assert.equal(operation.walStage, "commit");
    assert.equal(operation.resourceName, "db");
    assert.equal(operation.providerId, PROV_OK);
    assert.equal(operation.op, "delete");
    assert.deepEqual(operation.idempotencyKey, plannedOperation.idempotencyKey);
    assert.equal(
      operation.idempotencyKeyString,
      formatPlatformOperationIdempotencyKey(plannedOperation.idempotencyKey),
    );
  } finally {
    tearDown();
  }
});

Deno.test("destroyV2 records provider destroy trace spans", async () => {
  setUp();
  try {
    const observability = new InMemoryObservabilitySink();
    const resources: ManifestResource[] = [
      { shape: `${SHAPE}@v1`, name: "db", provider: PROV_OK, spec: {} },
    ];
    const operationPlanPreview = buildOperationPlanPreview({
      resources,
      planned: [{
        name: "db",
        shape: `${SHAPE}@v1`,
        providerId: PROV_OK,
        op: "delete",
      }],
      edges: [],
      spaceId: "space:trace",
      deploymentName: "destroy-trace-app",
    });

    const outcome = await destroyV2({
      resources,
      context: {
        ...ctx,
        spaceId: "space:trace",
        observability,
        trace: {
          traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
          parentSpanId: "1111111111111111",
        },
      },
      operationPlanPreview,
    });

    assert.equal(outcome.status, "succeeded");
    const traces = await observability.listTraces();
    assert.equal(traces.length, 1);
    const span = traces[0];
    assert.ok(span);
    assert.equal(span.name, "takosumi.provider.destroy");
    assert.equal(span.traceId, "4bf92f3577b34da6a3ce929d0e0e4736");
    assert.equal(span.parentSpanId, "1111111111111111");
    assert.equal(span.spaceId, "space:trace");
    assert.equal(span.status, "ok");
    assert.equal(span.attributes?.["takosumi.operation_kind"], "destroy");
    assert.equal(span.attributes?.["takosumi.wal_stage"], "commit");
    assert.equal(span.attributes?.["takosumi.resource_name"], "db");
    assert.equal(span.attributes?.["takosumi.provider_id"], PROV_OK);
  } finally {
    tearDown();
  }
});

Deno.test("destroyV2 honors handleFor override for handle resolution", async () => {
  setUp();
  try {
    const captured: string[] = [];
    const provider2: ProviderPlugin = {
      id: "test-destroy-provider-handle",
      version: "0.0.1",
      implements: { id: SHAPE, version: "v1" },
      capabilities: ["c"],
      apply(_spec, _ctx): Promise<ApplyResult> {
        return Promise.resolve({ handle: "ignored", outputs: {} });
      },
      destroy(handle, _ctx) {
        captured.push(String(handle));
        return Promise.resolve();
      },
      status() {
        return Promise.resolve({
          kind: "ready" as const,
          observedAt: new Date(0).toISOString(),
        });
      },
    };
    registerProvider(provider2);
    try {
      const resources: ManifestResource[] = [
        {
          shape: `${SHAPE}@v1`,
          name: "logs",
          provider: provider2.id,
          spec: {},
        },
      ];
      const outcome = await destroyV2({
        resources,
        context: ctx,
        handleFor: (r) => `runtime:${r.name}`,
      });
      assert.equal(outcome.status, "succeeded");
      assert.deepEqual(captured, ["runtime:logs"]);
    } finally {
      unregisterProvider(provider2.id);
    }
  } finally {
    tearDown();
  }
});
