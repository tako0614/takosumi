import assert from "node:assert/strict";
import {
  type ApplyResult,
  type JsonObject,
  type PlatformContext,
  type ProviderPlugin,
  registerProvider,
  registerShape,
  type Shape,
  TAKOS_DISTRIBUTION_MANIFEST_API_VERSION,
  TAKOS_DISTRIBUTION_MANIFEST_KIND,
  type TakosDistributionManifest,
  unregisterProvider,
  unregisterShape,
  validateTakosDistributionManifest,
} from "takosumi-contract";
import { applyV2 } from "./apply_v2.ts";

const WEB = "e2e-web";
const STORE = "e2e-store";
const WEB_PROV = "e2e-web-prov";
const STORE_PROV = "e2e-store-prov";

function webShape(): Shape {
  return {
    id: WEB,
    version: "v1",
    capabilities: ["always-on"],
    outputFields: ["url"],
    validateSpec(value, issues) {
      if (typeof value !== "object" || value === null) {
        issues.push({ path: "$", message: "must be object" });
      }
    },
    validateOutputs(_v, _i) {},
  };
}

function storeShape(): Shape {
  return {
    id: STORE,
    version: "v1",
    capabilities: ["public-access"],
    outputFields: ["bucket", "endpoint"],
    validateSpec(value, issues) {
      if (typeof value !== "object" || value === null) {
        issues.push({ path: "$", message: "must be object" });
      }
    },
    validateOutputs(_v, _i) {},
  };
}

function webProvider(): ProviderPlugin {
  return {
    id: WEB_PROV,
    version: "0.0.1",
    implements: { id: WEB, version: "v1" },
    capabilities: ["always-on"],
    apply(spec, _ctx): Promise<ApplyResult> {
      const handle = `web-${crypto.randomUUID().slice(0, 4)}`;
      const bindings =
        (spec as { bindings?: Record<string, unknown> }).bindings ?? {};
      const bucketBinding = typeof bindings.BUCKET === "string"
        ? bindings.BUCKET
        : "missing";
      return Promise.resolve({
        handle,
        outputs: {
          url: `https://${handle}/`,
          observedBucketBinding: bucketBinding,
        },
      });
    },
    destroy: () => Promise.resolve(),
    status: () =>
      Promise.resolve({
        kind: "ready" as const,
        observedAt: new Date(0).toISOString(),
      }),
  };
}

function storeProvider(): ProviderPlugin {
  return {
    id: STORE_PROV,
    version: "0.0.1",
    implements: { id: STORE, version: "v1" },
    capabilities: ["public-access"],
    apply(_spec, _ctx): Promise<ApplyResult> {
      const handle = `store-${crypto.randomUUID().slice(0, 4)}`;
      return Promise.resolve({
        handle,
        outputs: {
          bucket: handle,
          endpoint: `https://${handle}.example.com`,
        },
      });
    },
    destroy: () => Promise.resolve(),
    status: () =>
      Promise.resolve({
        kind: "ready" as const,
        observedAt: new Date(0).toISOString(),
      }),
  };
}

function setUp() {
  registerShape(webShape());
  registerShape(storeShape());
  registerProvider(webProvider());
  registerProvider(storeProvider());
}

function tearDown() {
  unregisterShape(WEB, "v1");
  unregisterShape(STORE, "v1");
  unregisterProvider(WEB_PROV);
  unregisterProvider(STORE_PROV);
}

const ctx = {} as PlatformContext;

Deno.test("e2e: TakosDistributionManifest validation + applyV2 succeeds for shape-model resources", async () => {
  setUp();
  try {
    const manifest: TakosDistributionManifest = {
      apiVersion: TAKOS_DISTRIBUTION_MANIFEST_API_VERSION,
      kind: TAKOS_DISTRIBUTION_MANIFEST_KIND,
      resources: [
        {
          shape: `${STORE}@v1`,
          name: "assets",
          provider: STORE_PROV,
          spec: { name: "my-assets" },
        },
        {
          shape: `${WEB}@v1`,
          name: "api",
          provider: WEB_PROV,
          spec: { bindings: { BUCKET: "${ref:assets.bucket}" } },
        },
      ],
    };
    const issues = validateTakosDistributionManifest(manifest, {
      requireAllServices: false,
    });
    assert.deepEqual([...issues], [], "manifest should validate");

    const outcome = await applyV2({
      resources: manifest.resources!,
      context: ctx,
    });
    assert.equal(outcome.status, "succeeded");
    assert.equal(outcome.applied.length, 2);
    const apiApplied = outcome.applied.find((a) => a.name === "api")!;
    const observedBinding =
      (apiApplied.outputs as JsonObject).observedBucketBinding;
    assert.match(String(observedBinding), /^store-/);
  } finally {
    tearDown();
  }
});

Deno.test("e2e: validation rejects unknown shape before applyV2 runs", async () => {
  setUp();
  try {
    const manifest = {
      apiVersion: TAKOS_DISTRIBUTION_MANIFEST_API_VERSION,
      kind: TAKOS_DISTRIBUTION_MANIFEST_KIND,
      resources: [
        {
          shape: "unknown@v1",
          name: "x",
          provider: WEB_PROV,
          spec: {},
        },
      ],
    };
    const issues = validateTakosDistributionManifest(manifest, {
      requireAllServices: false,
    });
    assert.deepEqual(
      [...issues],
      [],
      "envelope-level validation passes (shape lookup is resolver-side)",
    );

    const outcome = await applyV2({
      resources: manifest.resources,
      context: ctx,
    });
    assert.equal(outcome.status, "failed-validation");
  } finally {
    tearDown();
  }
});
