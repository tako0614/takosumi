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
import { destroyV2 } from "./apply_v2.ts";

const SHAPE = "test-destroy-shape";
const PROV_OK = "test-destroy-provider-ok";
const PROV_FAIL = "test-destroy-provider-fail";

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
    apply(_spec, _ctx): Promise<ApplyResult> {
      const handle = `h-${id}`;
      return Promise.resolve({
        handle,
        outputs: { url: `https://${handle}`, id: handle } as JsonObject,
      });
    },
    destroy(handle, _ctx) {
      if (behavior === "fail") {
        return Promise.reject(new Error(`destroy-failed:${handle}`));
      }
      destroyLog.push(`${id}:${handle}`);
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
