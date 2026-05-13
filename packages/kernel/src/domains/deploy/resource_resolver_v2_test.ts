import assert from "node:assert/strict";
import {
  type ManifestResource,
  type ProviderPlugin,
  registerProvider,
  registerShape,
  type Shape,
  type ShapeValidationIssue,
  unregisterProvider,
  unregisterShape,
} from "takosumi-contract";
import { resolveResourcesV2 } from "./resource_resolver_v2.ts";

function fakeShape(id: string, version = "v1"): Shape {
  return {
    id,
    version,
    capabilities: ["c1", "c2"],
    outputFields: ["url"],
    validateSpec(value, issues) {
      if (typeof value !== "object" || value === null) {
        issues.push({ path: "$", message: "spec must be object" });
      } else if ("bad" in (value as Record<string, unknown>)) {
        issues.push({ path: "$.bad", message: "bad field present" });
      }
    },
    validateOutputs(_value, _issues) {},
  };
}

function fakeProvider(
  id: string,
  shape: { id: string; version: string },
  capabilities: readonly string[] = ["c1", "c2"],
): ProviderPlugin {
  return {
    id,
    version: "0.0.1",
    implements: shape,
    capabilities,
    apply: () => Promise.resolve({ handle: `${id}-h`, outputs: { url: "x" } }),
    destroy: () => Promise.resolve(),
    status: () =>
      Promise.resolve({
        kind: "ready" as const,
        observedAt: new Date(0).toISOString(),
      }),
  };
}

const SHAPE_ID = "test-rr-shape";
const PROVIDER_ID = "test-rr-provider";

function setUp() {
  registerShape(fakeShape(SHAPE_ID));
  registerProvider(
    fakeProvider(PROVIDER_ID, { id: SHAPE_ID, version: "v1" }),
  );
}

function tearDown() {
  unregisterShape(SHAPE_ID, "v1");
  unregisterProvider(PROVIDER_ID);
}

Deno.test("resolveResourcesV2 returns resolved when shape and provider match", () => {
  setUp();
  try {
    const resources: ManifestResource[] = [{
      shape: `${SHAPE_ID}@v1`,
      name: "ok",
      provider: PROVIDER_ID,
      spec: { foo: "bar" },
    }];
    const result = resolveResourcesV2(resources);
    assert.equal(result.issues.length, 0);
    assert.equal(result.resolved.length, 1);
    assert.equal(result.resolved[0].resource.name, "ok");
  } finally {
    tearDown();
  }
});

Deno.test("resolveResourcesV2 selects a single registered provider when omitted", () => {
  setUp();
  try {
    const resources: ManifestResource[] = [{
      shape: `${SHAPE_ID}@v1`,
      name: "ok",
      spec: { foo: "bar" },
    }];
    const result = resolveResourcesV2(resources);
    assert.equal(result.issues.length, 0);
    assert.equal(result.resolved.length, 1);
    assert.equal(result.resolved[0].provider.id, PROVIDER_ID);
  } finally {
    tearDown();
  }
});

Deno.test("resolveResourcesV2 reports ambiguous provider selection", () => {
  setUp();
  const otherProviderId = "test-rr-provider-other";
  registerProvider(
    fakeProvider(otherProviderId, { id: SHAPE_ID, version: "v1" }),
  );
  try {
    const result = resolveResourcesV2([{
      shape: `${SHAPE_ID}@v1`,
      name: "x",
      spec: { foo: "bar" },
    }]);
    assert.equal(result.resolved.length, 0);
    assert.ok(
      result.issues.some((i) =>
        i.path === "$.resources[0].provider" &&
        i.message.includes("ambiguous")
      ),
    );
  } finally {
    unregisterProvider(otherProviderId);
    tearDown();
  }
});

Deno.test("resolveResourcesV2 reports unknown shape", () => {
  setUp();
  try {
    const result = resolveResourcesV2([{
      shape: "nonexistent@v1",
      name: "x",
      provider: PROVIDER_ID,
      spec: {},
    }]);
    assert.ok(result.issues.some((i) => i.path === "$.resources[0].shape"));
  } finally {
    tearDown();
  }
});

Deno.test("resolveResourcesV2 reports unknown provider", () => {
  setUp();
  try {
    const result = resolveResourcesV2([{
      shape: `${SHAPE_ID}@v1`,
      name: "x",
      provider: "nonexistent-provider",
      spec: {},
    }]);
    assert.ok(result.issues.some((i) => i.path === "$.resources[0].provider"));
  } finally {
    tearDown();
  }
});

Deno.test("resolveResourcesV2 reports provider/shape mismatch", () => {
  setUp();
  try {
    registerShape(fakeShape("other-shape"));
    const otherProviderId = "other-provider";
    registerProvider(
      fakeProvider(otherProviderId, { id: "other-shape", version: "v1" }),
    );
    try {
      const result = resolveResourcesV2([{
        shape: `${SHAPE_ID}@v1`,
        name: "x",
        provider: otherProviderId,
        spec: {},
      }]);
      assert.ok(
        result.issues.some((i) => i.message.includes("not")),
      );
    } finally {
      unregisterShape("other-shape", "v1");
      unregisterProvider(otherProviderId);
    }
  } finally {
    tearDown();
  }
});

Deno.test("resolveResourcesV2 reports spec validation issues", () => {
  setUp();
  try {
    const result = resolveResourcesV2([{
      shape: `${SHAPE_ID}@v1`,
      name: "x",
      provider: PROVIDER_ID,
      spec: { bad: true },
    }]);
    assert.ok(result.issues.some((i) => i.path.endsWith(".spec.bad")));
    assert.equal(result.resolved.length, 0);
  } finally {
    tearDown();
  }
});

Deno.test("resolveResourcesV2 reports missing capability", () => {
  setUp();
  try {
    const result = resolveResourcesV2([{
      shape: `${SHAPE_ID}@v1`,
      name: "x",
      provider: PROVIDER_ID,
      spec: { foo: 1 },
      requires: ["c1", "c3"],
    }]);
    assert.ok(result.issues.some((i) => i.message.includes("c3")));
  } finally {
    tearDown();
  }
});

Deno.test("resolveResourcesV2 detects duplicate resource names", () => {
  setUp();
  try {
    const result = resolveResourcesV2([
      {
        shape: `${SHAPE_ID}@v1`,
        name: "dup",
        provider: PROVIDER_ID,
        spec: { x: 1 },
      },
      {
        shape: `${SHAPE_ID}@v1`,
        name: "dup",
        provider: PROVIDER_ID,
        spec: { x: 2 },
      },
    ]);
    assert.ok(result.issues.some((i) => i.message.includes("duplicate")));
  } finally {
    tearDown();
  }
});

Deno.test(
  "resolveResourcesV2 rejects bare provider id with a namespaced suggestion",
  () => {
    registerShape(fakeShape("object-store"));
    registerProvider(
      fakeProvider(
        "@takos/aws-s3",
        { id: "object-store", version: "v1" },
        ["c1", "c2"],
      ),
    );
    try {
      const result = resolveResourcesV2([{
        shape: "object-store@v1",
        name: "bucket",
        provider: "aws-s3",
        spec: { foo: "bar" },
      }]);
      assert.equal(result.resolved.length, 0);
      assert.equal(result.issues.length, 1);
      const issue = result.issues[0];
      assert.equal(issue.path, "$.resources[0].provider");
      assert.ok(
        issue.message.includes("aws-s3") &&
          issue.message.includes("@takos/aws-s3"),
        `expected rejection message naming both the bare id and the ` +
          `namespaced replacement, got: ${issue.message}`,
      );
    } finally {
      unregisterShape("object-store", "v1");
      unregisterProvider("@takos/aws-s3");
    }
  },
);

void ({} as ShapeValidationIssue);
