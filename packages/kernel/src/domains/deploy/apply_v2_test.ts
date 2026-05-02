import assert from "node:assert/strict";
import {
  type ApplyResult,
  type JsonObject,
  type ManifestResource,
  type PlatformContext,
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

interface AppliedRecord {
  readonly name: string;
  readonly handle: string;
  readonly resolvedSpec: JsonObject;
}

const applyLog: AppliedRecord[] = [];
const destroyLog: string[] = [];

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
    apply(spec, _ctx): Promise<ApplyResult> {
      if (behavior === "fail") return Promise.reject(new Error("planned-fail"));
      const handle = `h-${id}-${applyLog.length}`;
      applyLog.push({
        name: handle,
        handle,
        resolvedSpec: spec as JsonObject,
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

function setUp(behaviour: "ok" | "fail" = "ok") {
  applyLog.length = 0;
  destroyLog.length = 0;
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
