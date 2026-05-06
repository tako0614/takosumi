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
import { applyV2 } from "./apply_v2.ts";

const SHAPE = "test-apply-shape";
const PROV_OK = "test-apply-provider-ok";
const PROV_FAIL = "test-apply-provider-fail";
const PROV_COMPENSATE = "test-apply-provider-compensate";
const PROV_DESTROY_FAIL = "test-apply-provider-destroy-fail";
const PROV_COMPENSATE_FAIL = "test-apply-provider-compensate-fail";

interface AppliedRecord {
  readonly name: string;
  readonly handle: string;
  readonly resolvedSpec: JsonObject;
  readonly operation?: PlatformOperationContext;
}

const applyLog: AppliedRecord[] = [];
const destroyLog: string[] = [];
const compensateLog: string[] = [];

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
    apply(spec, ctx): Promise<ApplyResult> {
      if (behavior === "fail") return Promise.reject(new Error("planned-fail"));
      const handle = `h-${id}-${applyLog.length}`;
      applyLog.push({
        name: handle,
        handle,
        resolvedSpec: spec as JsonObject,
        operation: ctx.operation,
      });
      const url = `https://${id}/${handle}`;
      return Promise.resolve({
        handle,
        outputs: { url, id: handle },
      });
    },
    destroy(handle, _ctx) {
      destroyLog.push(handle);
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

function destroyFailingProvider(): ProviderPlugin {
  return {
    ...provider(PROV_DESTROY_FAIL, "ok"),
    destroy(_handle, _ctx) {
      return Promise.reject(new Error("destroy-failed"));
    },
  };
}

function compensatingProvider(): ProviderPlugin {
  return {
    ...provider(PROV_COMPENSATE, "ok"),
    compensate(handle, _ctx) {
      compensateLog.push(handle);
      return Promise.resolve({ ok: true });
    },
  };
}

function compensateFailingProvider(): ProviderPlugin {
  return {
    ...provider(PROV_COMPENSATE_FAIL, "ok"),
    compensate(_handle, _ctx) {
      return Promise.resolve({
        ok: false,
        note: "compensate-failed",
      });
    },
  };
}

function setUp(behaviour: "ok" | "fail" = "ok") {
  applyLog.length = 0;
  destroyLog.length = 0;
  compensateLog.length = 0;
  registerShape(shape());
  registerProvider(provider(PROV_OK, "ok"));
  if (behaviour === "fail") {
    registerProvider(provider(PROV_FAIL, "fail"));
  }
}

function tearDown() {
  unregisterShape(SHAPE, "v1");
  unregisterProvider(PROV_OK);
  unregisterProvider(PROV_FAIL);
  unregisterProvider(PROV_COMPENSATE);
  unregisterProvider(PROV_DESTROY_FAIL);
  unregisterProvider(PROV_COMPENSATE_FAIL);
}

const ctx = {} as PlatformContext;

Deno.test("applyV2 succeeds for independent resources", async () => {
  setUp();
  try {
    const resources: ManifestResource[] = [
      { shape: `${SHAPE}@v1`, name: "a", provider: PROV_OK, spec: { x: 1 } },
      { shape: `${SHAPE}@v1`, name: "b", provider: PROV_OK, spec: { x: 2 } },
    ];
    const result = await applyV2({ resources, context: ctx });
    assert.equal(result.status, "succeeded");
    assert.equal(result.applied.length, 2);
    assert.deepEqual(
      result.applied.map((a) => a.name).sort(),
      ["a", "b"],
    );
  } finally {
    tearDown();
  }
});

Deno.test("applyV2 threads outputs through ref expressions", async () => {
  setUp();
  try {
    const resources: ManifestResource[] = [
      { shape: `${SHAPE}@v1`, name: "db", provider: PROV_OK, spec: {} },
      {
        shape: `${SHAPE}@v1`,
        name: "web",
        provider: PROV_OK,
        spec: { dbUrl: "${ref:db.url}" },
      },
    ];
    const result = await applyV2({ resources, context: ctx });
    assert.equal(result.status, "succeeded");
    const webApplied = result.applied.find((a) => a.name === "web");
    assert.ok(webApplied);
    const matching = applyLog.find((entry) =>
      entry.handle === webApplied.handle
    );
    assert.ok(matching, "web apply was logged");
    assert.match(
      String(matching.resolvedSpec.dbUrl),
      /^https:\/\//,
    );
  } finally {
    tearDown();
  }
});

Deno.test("applyV2 fails validation when shape unregistered", async () => {
  setUp();
  try {
    const resources: ManifestResource[] = [
      {
        shape: "ghost@v1",
        name: "a",
        provider: PROV_OK,
        spec: {},
      },
    ];
    const result = await applyV2({ resources, context: ctx });
    assert.equal(result.status, "failed-validation");
  } finally {
    tearDown();
  }
});

Deno.test("applyV2 rolls back applied resources on apply failure", async () => {
  setUp("fail");
  try {
    const resources: ManifestResource[] = [
      { shape: `${SHAPE}@v1`, name: "first", provider: PROV_OK, spec: {} },
      { shape: `${SHAPE}@v1`, name: "second", provider: PROV_FAIL, spec: {} },
    ];
    const result = await applyV2({ resources, context: ctx });
    assert.equal(result.status, "failed-apply");
    assert.equal(destroyLog.length, 1, "rollback destroys first only");
    assert.equal(result.rollback?.status, "succeeded");
    assert.deepEqual(result.rollback?.failures, []);
  } finally {
    tearDown();
  }
});

Deno.test("applyV2 surfaces rollback destroy failures after apply failure", async () => {
  setUp("fail");
  registerProvider(destroyFailingProvider(), { allowOverride: true });
  try {
    const resources: ManifestResource[] = [
      {
        shape: `${SHAPE}@v1`,
        name: "first",
        provider: PROV_DESTROY_FAIL,
        spec: {},
      },
      { shape: `${SHAPE}@v1`, name: "second", provider: PROV_FAIL, spec: {} },
    ];
    const result = await applyV2({ resources, context: ctx });
    assert.equal(result.status, "failed-apply");
    assert.equal(result.rollback?.status, "partial");
    assert.deepEqual(result.rollback?.failures, [{
      name: "first",
      providerId: PROV_DESTROY_FAIL,
      handle: "h-test-apply-provider-destroy-fail-0",
      action: "destroy",
      message: "destroy-failed",
    }]);
  } finally {
    tearDown();
  }
});

Deno.test("applyV2 uses provider compensate hook during rollback when available", async () => {
  setUp("fail");
  registerProvider(compensatingProvider(), { allowOverride: true });
  try {
    const resources: ManifestResource[] = [
      {
        shape: `${SHAPE}@v1`,
        name: "first",
        provider: PROV_COMPENSATE,
        spec: {},
      },
      { shape: `${SHAPE}@v1`, name: "second", provider: PROV_FAIL, spec: {} },
    ];
    const result = await applyV2({ resources, context: ctx });
    assert.equal(result.status, "failed-apply");
    assert.equal(compensateLog.length, 1);
    assert.equal(destroyLog.length, 0);
  } finally {
    tearDown();
  }
});

Deno.test("applyV2 surfaces compensation failures after apply failure", async () => {
  setUp("fail");
  registerProvider(compensateFailingProvider(), { allowOverride: true });
  try {
    const resources: ManifestResource[] = [
      {
        shape: `${SHAPE}@v1`,
        name: "first",
        provider: PROV_COMPENSATE_FAIL,
        spec: {},
      },
      { shape: `${SHAPE}@v1`, name: "second", provider: PROV_FAIL, spec: {} },
    ];
    const result = await applyV2({ resources, context: ctx });
    assert.equal(result.status, "failed-apply");
    assert.equal(result.rollback?.status, "partial");
    assert.deepEqual(result.rollback?.failures, [{
      name: "first",
      providerId: PROV_COMPENSATE_FAIL,
      handle: "h-test-apply-provider-compensate-fail-0",
      action: "compensate",
      message: "compensate-failed",
    }]);
  } finally {
    tearDown();
  }
});

Deno.test("applyV2 fails validation on cycle", async () => {
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
    const result = await applyV2({ resources, context: ctx });
    assert.equal(result.status, "failed-validation");
  } finally {
    tearDown();
  }
});

Deno.test("applyV2 dry-run includes deterministic OperationPlan preview", async () => {
  setUp();
  try {
    const resources: ManifestResource[] = [
      { shape: `${SHAPE}@v1`, name: "db", provider: PROV_OK, spec: {} },
      {
        shape: `${SHAPE}@v1`,
        name: "web",
        provider: PROV_OK,
        spec: { dbUrl: "${ref:db.url}" },
      },
    ];
    const first = await applyV2({
      resources,
      context: { ...ctx, spaceId: "space:preview" },
      dryRun: true,
      deploymentName: "preview-app",
    });
    const second = await applyV2({
      resources,
      context: { ...ctx, spaceId: "space:preview" },
      dryRun: true,
      deploymentName: "preview-app",
    });

    assert.equal(first.status, "succeeded");
    assert.ok(first.operationPlanPreview);
    assert.deepEqual(first.operationPlanPreview, second.operationPlanPreview);
    assert.equal(first.operationPlanPreview!.spaceId, "space:preview");
    assert.equal(first.operationPlanPreview!.deploymentName, "preview-app");
    assert.match(
      first.operationPlanPreview!.desiredSnapshotDigest,
      /^sha256:[0-9a-f]{64}$/,
    );
    assert.match(
      first.operationPlanPreview!.operationPlanDigest,
      /^sha256:[0-9a-f]{64}$/,
    );
    assert.deepEqual(
      first.operationPlanPreview!.operations.map((operation) =>
        operation.resourceName
      ),
      ["db", "web"],
    );
    assert.deepEqual(
      first.operationPlanPreview!.operations[1].dependsOn,
      ["db"],
    );
    assert.deepEqual(first.operationPlanPreview!.operations[0].idempotencyKey, {
      spaceId: "space:preview",
      operationPlanDigest: first.operationPlanPreview!.operationPlanDigest,
      journalEntryId: first.operationPlanPreview!.operations[0].operationId,
    });
  } finally {
    tearDown();
  }
});

Deno.test("applyV2 threads WAL idempotency context to provider.apply", async () => {
  setUp();
  try {
    const resources: ManifestResource[] = [
      { shape: `${SHAPE}@v1`, name: "db", provider: PROV_OK, spec: {} },
      {
        shape: `${SHAPE}@v1`,
        name: "web",
        provider: PROV_OK,
        spec: { dbUrl: "${ref:db.url}" },
      },
    ];
    const planned = await applyV2({
      resources,
      context: { ...ctx, spaceId: "space:fenced" },
      dryRun: true,
      deploymentName: "fenced-app",
    });
    assert.ok(planned.operationPlanPreview);

    const result = await applyV2({
      resources,
      context: { ...ctx, spaceId: "space:fenced" },
      deploymentName: "fenced-app",
      operationPlanPreview: planned.operationPlanPreview,
    });

    assert.equal(result.status, "succeeded");
    assert.equal(applyLog.length, 2);
    const firstOperation = planned.operationPlanPreview.operations[0];
    assert.ok(firstOperation);
    const firstApply = applyLog[0];
    assert.ok(firstApply);
    assert.deepEqual(
      firstApply.operation?.idempotencyKey,
      firstOperation.idempotencyKey,
    );
    assert.equal(firstApply.operation?.phase, "apply");
    assert.equal(firstApply.operation?.walStage, "commit");
    assert.equal(firstApply.operation?.resourceName, "db");
    assert.equal(firstApply.operation?.providerId, PROV_OK);
    assert.equal(firstApply.operation?.op, "create");
    assert.equal(
      firstApply.operation?.idempotencyKeyString,
      formatPlatformOperationIdempotencyKey(firstOperation.idempotencyKey),
    );
  } finally {
    tearDown();
  }
});
