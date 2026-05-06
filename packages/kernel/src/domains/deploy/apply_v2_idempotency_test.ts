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
import {
  applyV2,
  computeSpecFingerprint,
  type PriorAppliedSnapshot,
} from "./apply_v2.ts";

const SHAPE = "test-idempotency-shape";
const PROVIDER = "test-idempotency-provider";
const FAIL_PROVIDER = "test-idempotency-provider-fail";

function shape(): Shape {
  return {
    id: SHAPE,
    version: "v1",
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

interface CountingProvider {
  readonly plugin: ProviderPlugin;
  applyCount(): number;
  destroyedHandles(): readonly string[];
  resetCount(): void;
}

function counting(id: string): CountingProvider {
  let count = 0;
  const destroyed: string[] = [];
  const plugin: ProviderPlugin = {
    id,
    version: "0.0.1",
    implements: { id: SHAPE, version: "v1" },
    capabilities: ["c"],
    apply(spec, _ctx): Promise<ApplyResult> {
      count += 1;
      const handle = `h-${id}-${count}`;
      return Promise.resolve({
        handle,
        outputs: {
          url: `https://${id}/${handle}`,
          spec: spec as JsonObject,
        } as JsonObject,
      });
    },
    destroy(handle, _ctx) {
      destroyed.push(String(handle));
      return Promise.resolve();
    },
    status() {
      return Promise.resolve({
        kind: "ready" as const,
        observedAt: new Date(0).toISOString(),
      });
    },
  };
  return {
    plugin,
    applyCount: () => count,
    destroyedHandles: () => destroyed.slice(),
    resetCount: () => {
      count = 0;
      destroyed.length = 0;
    },
  };
}

function failingProvider(): ProviderPlugin {
  return {
    id: FAIL_PROVIDER,
    version: "0.0.1",
    implements: { id: SHAPE, version: "v1" },
    capabilities: ["c"],
    apply(_spec, _ctx): Promise<ApplyResult> {
      return Promise.reject(new Error("planned-fail"));
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

function setUp(): CountingProvider {
  registerShape(shape());
  const provider = counting(PROVIDER);
  registerProvider(provider.plugin);
  return provider;
}

function tearDown(): void {
  unregisterShape(SHAPE, "v1");
  unregisterProvider(PROVIDER);
  unregisterProvider(FAIL_PROVIDER);
}

const ctx = {} as PlatformContext;

Deno.test(
  "applyV2 idempotency: matching fingerprint reuses prior handle and skips provider.apply",
  async () => {
    const provider = setUp();
    try {
      const resources: ManifestResource[] = [
        {
          shape: `${SHAPE}@v1`,
          name: "logs",
          provider: PROVIDER,
          spec: { region: "us-east-1", size: 10 },
        },
      ];

      // First apply: no prior snapshot, provider.apply should run.
      const first = await applyV2({ resources, context: ctx });
      assert.equal(first.status, "succeeded");
      assert.equal(first.applied.length, 1);
      assert.equal(provider.applyCount(), 1, "first apply must call provider");
      assert.equal(first.reused ?? 0, 0);
      const firstFingerprint = first.applied[0].specFingerprint;
      assert.ok(
        firstFingerprint && /^sha256:[0-9a-f]{64}$/.test(firstFingerprint),
        "first apply must stamp a fingerprint",
      );
      const firstHandle = first.applied[0].handle;

      // Second apply: feed the prior snapshot. provider.apply must NOT run
      // again because the fingerprint matches.
      const priorApplied = new Map<string, PriorAppliedSnapshot>([
        ["logs", {
          specFingerprint: firstFingerprint,
          handle: firstHandle,
          outputs: first.applied[0].outputs,
          providerId: PROVIDER,
        }],
      ]);
      const second = await applyV2({ resources, context: ctx, priorApplied });
      assert.equal(second.status, "succeeded");
      assert.equal(second.applied.length, 1);
      assert.equal(
        provider.applyCount(),
        1,
        "second apply with matching fingerprint must skip provider.apply",
      );
      assert.equal(second.reused, 1);
      assert.equal(
        second.applied[0].handle,
        firstHandle,
        "reused entry must surface the prior handle",
      );
    } finally {
      tearDown();
    }
  },
);

Deno.test(
  "applyV2 idempotency: edited spec triggers re-apply",
  async () => {
    const provider = setUp();
    try {
      const initialResources: ManifestResource[] = [
        {
          shape: `${SHAPE}@v1`,
          name: "logs",
          provider: PROVIDER,
          spec: { region: "us-east-1" },
        },
      ];
      const first = await applyV2({
        resources: initialResources,
        context: ctx,
      });
      assert.equal(first.status, "succeeded");
      assert.equal(provider.applyCount(), 1);

      // Same logical resource but spec edited -> different fingerprint.
      const editedResources: ManifestResource[] = [
        {
          shape: `${SHAPE}@v1`,
          name: "logs",
          provider: PROVIDER,
          spec: { region: "us-west-2" },
        },
      ];
      const priorApplied = new Map<string, PriorAppliedSnapshot>([
        ["logs", {
          specFingerprint: first.applied[0].specFingerprint,
          handle: first.applied[0].handle,
          outputs: first.applied[0].outputs,
          providerId: PROVIDER,
        }],
      ]);
      const second = await applyV2({
        resources: editedResources,
        context: ctx,
        priorApplied,
      });
      assert.equal(second.status, "succeeded");
      assert.equal(
        provider.applyCount(),
        2,
        "edited spec must call provider.apply again",
      );
      assert.equal(
        second.reused ?? 0,
        0,
        "edited spec must not be counted as reused",
      );
      assert.notEqual(
        second.applied[0].specFingerprint,
        first.applied[0].specFingerprint,
        "edited spec must produce a different fingerprint",
      );
    } finally {
      tearDown();
    }
  },
);

Deno.test(
  "applyV2 idempotency: provider id mismatch does not reuse",
  async () => {
    const provider = setUp();
    try {
      const resources: ManifestResource[] = [
        {
          shape: `${SHAPE}@v1`,
          name: "logs",
          provider: PROVIDER,
          spec: { region: "us-east-1" },
        },
      ];
      const fingerprint = computeSpecFingerprint(
        resources[0],
        PROVIDER,
        resources[0].spec as JsonObject,
      );
      // Snapshot claims it was applied by a different provider id; we
      // must not reuse it.
      const priorApplied = new Map<string, PriorAppliedSnapshot>([
        ["logs", {
          specFingerprint: fingerprint,
          handle: "stale-handle",
          outputs: {},
          providerId: "different-provider",
        }],
      ]);
      const result = await applyV2({ resources, context: ctx, priorApplied });
      assert.equal(result.status, "succeeded");
      assert.equal(
        provider.applyCount(),
        1,
        "provider id mismatch must call provider.apply",
      );
      assert.equal(result.reused ?? 0, 0);
    } finally {
      tearDown();
    }
  },
);

Deno.test(
  "applyV2 idempotency: rollback does not destroy reused prior resources",
  async () => {
    const provider = setUp();
    registerProvider(failingProvider());
    try {
      const priorResources: ManifestResource[] = [
        {
          shape: `${SHAPE}@v1`,
          name: "logs",
          provider: PROVIDER,
          spec: { region: "us-east-1" },
        },
      ];
      const first = await applyV2({ resources: priorResources, context: ctx });
      assert.equal(first.status, "succeeded");
      assert.equal(first.applied.length, 1);
      const priorApplied = new Map<string, PriorAppliedSnapshot>([
        ["logs", {
          specFingerprint: first.applied[0].specFingerprint,
          handle: first.applied[0].handle,
          outputs: first.applied[0].outputs,
          providerId: PROVIDER,
        }],
      ]);
      provider.resetCount();

      const result = await applyV2({
        resources: [
          ...priorResources,
          {
            shape: `${SHAPE}@v1`,
            name: "web",
            provider: FAIL_PROVIDER,
            spec: { upstream: "${ref:logs.url}" },
          },
        ],
        context: ctx,
        priorApplied,
      });

      assert.equal(result.status, "failed-apply");
      assert.equal(
        provider.applyCount(),
        0,
        "unchanged prior resource must still skip provider.apply",
      );
      assert.deepEqual(
        provider.destroyedHandles(),
        [],
        "rollback must not destroy resources reused from a prior apply",
      );
      assert.equal(result.rollback?.status, "succeeded");
      assert.deepEqual(result.rollback?.failures, []);
    } finally {
      tearDown();
    }
  },
);

Deno.test(
  "computeSpecFingerprint is canonical, stable, and changes when tuple changes",
  () => {
    const resource: ManifestResource = {
      shape: "test-shape@v1",
      name: "logs",
      provider: "test",
      spec: { a: 1, b: 2 },
    };
    const f1 = computeSpecFingerprint(resource, "test", {
      nested: { z: true, a: ["one", "two"] },
      a: 1,
      b: 2,
    });
    const f2 = computeSpecFingerprint(resource, "test", {
      nested: { z: true, a: ["one", "two"] },
      a: 1,
      b: 2,
    });
    assert.match(f1, /^sha256:[0-9a-f]{64}$/);
    assert.equal(f1, f2);
    const f3 = computeSpecFingerprint(resource, "test", {
      b: 2,
      nested: { a: ["one", "two"], z: true },
      a: 1,
    });
    assert.equal(f1, f3);
    const f4 = computeSpecFingerprint(resource, "test", {
      nested: { z: true, a: ["one", "two"] },
      a: 1,
      b: 3,
    });
    assert.notEqual(f1, f4);
    const f5 = computeSpecFingerprint(resource, "different", {
      nested: { z: true, a: ["one", "two"] },
      a: 1,
      b: 2,
    });
    assert.notEqual(f1, f5);
  },
);
