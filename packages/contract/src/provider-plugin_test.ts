import assert from "node:assert/strict";
import {
  capabilitySubsetIssues,
  getProvider,
  isProviderRegistered,
  listProviders,
  listProvidersForShape,
  type PlatformContext,
  type ProviderPlugin,
  registerProvider,
  unregisterProvider,
} from "./provider-plugin.ts";

function fakeProvider(
  id: string,
  shape: { id: string; version: string },
  capabilities: readonly string[] = [],
): ProviderPlugin {
  return {
    id,
    version: "0.0.1",
    implements: shape,
    capabilities,
    apply() {
      return Promise.resolve({
        handle: `${id}-handle`,
        outputs: {},
      });
    },
    destroy() {
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

Deno.test("registerProvider stores and getProvider retrieves", () => {
  const provider = fakeProvider("test-provider-basic", {
    id: "object-store",
    version: "v1",
  });
  try {
    assert.equal(registerProvider(provider), undefined);
    assert.equal(isProviderRegistered("test-provider-basic"), true);
    assert.equal(getProvider("test-provider-basic"), provider);
    assert.ok(listProviders().includes(provider));
  } finally {
    unregisterProvider("test-provider-basic");
  }
});

Deno.test("registerProvider returns previous on replace", () => {
  const first = fakeProvider("test-provider-replace", {
    id: "x",
    version: "v1",
  });
  const second = fakeProvider("test-provider-replace", {
    id: "x",
    version: "v1",
  });
  try {
    registerProvider(first);
    assert.equal(registerProvider(second), first);
    assert.equal(getProvider("test-provider-replace"), second);
  } finally {
    unregisterProvider("test-provider-replace");
  }
});

Deno.test("listProvidersForShape filters by shape ref", () => {
  const a = fakeProvider("test-provider-shape-a", {
    id: "object-store",
    version: "v1",
  });
  const b = fakeProvider("test-provider-shape-b", {
    id: "object-store",
    version: "v1",
  });
  const c = fakeProvider("test-provider-shape-c", {
    id: "web-service",
    version: "v1",
  });
  try {
    registerProvider(a);
    registerProvider(b);
    registerProvider(c);
    const matches = listProvidersForShape("object-store", "v1");
    assert.equal(matches.length, 2);
    assert.ok(matches.includes(a));
    assert.ok(matches.includes(b));
    assert.ok(!matches.includes(c));
  } finally {
    unregisterProvider("test-provider-shape-a");
    unregisterProvider("test-provider-shape-b");
    unregisterProvider("test-provider-shape-c");
  }
});

Deno.test("listProvidersForShape returns empty for unknown shape", () => {
  assert.deepEqual(listProvidersForShape("nonexistent-shape", "v1"), []);
});

Deno.test("capabilitySubsetIssues returns empty when satisfied", () => {
  const issues = capabilitySubsetIssues(
    ["always-on", "websocket"],
    ["always-on", "websocket", "long-request"],
    "$.requires",
  );
  assert.equal(issues.length, 0);
});

Deno.test("capabilitySubsetIssues lists each missing capability", () => {
  const issues = capabilitySubsetIssues(
    ["always-on", "websocket", "encryption"],
    ["always-on"],
    "$.requires",
  );
  assert.equal(issues.length, 2);
  assert.ok(issues.some((i) => i.message.includes("websocket")));
  assert.ok(issues.some((i) => i.message.includes("encryption")));
  assert.equal(issues[0].path, "$.requires");
});

Deno.test("ProviderPlugin apply returns ApplyResult shape", async () => {
  const provider = fakeProvider("test-provider-apply", {
    id: "object-store",
    version: "v1",
  });
  const ctx = {} as PlatformContext;
  const result = await provider.apply({}, ctx);
  assert.equal(result.handle, "test-provider-apply-handle");
  assert.deepEqual(result.outputs, {});
});
