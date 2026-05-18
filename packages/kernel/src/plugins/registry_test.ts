import assert from "node:assert/strict";
import type { KernelPlugin } from "takosumi-contract";
import {
  createKernelPluginRegistry,
  findPluginForKind,
  normalizeKindToUri,
} from "./registry.ts";

function buildPlugin(
  name: string,
  provides: readonly string[],
): KernelPlugin {
  return {
    name,
    version: "1.0.0",
    provides,
    apply: (ctx) =>
      Promise.resolve({
        providerResourceId: `${name}://${ctx.componentName}`,
        outputs: {},
      }),
  };
}

Deno.test("registry exposes registered plugins in registration order", () => {
  const a = buildPlugin("@example/a", ["https://example.test/kinds/v1/a"]);
  const b = buildPlugin("@example/b", ["https://example.test/kinds/v1/b"]);
  const registry = createKernelPluginRegistry([a, b]);

  assert.deepEqual(
    registry.list().map((plugin) => plugin.name),
    ["@example/a", "@example/b"],
  );
});

Deno.test("registry resolves built-in short name to canonical URI lookup", () => {
  const workerPlugin = buildPlugin(
    "@takos/workers-reference",
    ["https://takosumi.com/kinds/v1/worker"],
  );
  const registry = createKernelPluginRegistry([workerPlugin]);

  assert.equal(
    findPluginForKind(registry, "worker")?.name,
    "@takos/workers-reference",
  );
  assert.equal(
    findPluginForKind(registry, "https://takosumi.com/kinds/v1/worker")?.name,
    "@takos/workers-reference",
  );
});

Deno.test("registry resolves operator-defined kind URI without normalization", () => {
  const operatorPlugin = buildPlugin(
    "@operator/lambda",
    ["https://operator.example.com/kinds/lambda"],
  );
  const registry = createKernelPluginRegistry([operatorPlugin]);

  assert.equal(
    findPluginForKind(registry, "https://operator.example.com/kinds/lambda")
      ?.name,
    "@operator/lambda",
  );
});

Deno.test("registry rejects duplicate plugin name", () => {
  const a = buildPlugin("@example/dup", ["https://example.test/kinds/v1/a"]);
  const b = buildPlugin("@example/dup", ["https://example.test/kinds/v1/b"]);

  assert.throws(
    () => createKernelPluginRegistry([a, b]),
    /kernel plugin already registered: @example\/dup/,
  );
});

Deno.test("registry rejects conflicting kind URI providers", () => {
  const a = buildPlugin("@example/a", ["https://example.test/kinds/v1/x"]);
  const b = buildPlugin("@example/b", ["https://example.test/kinds/v1/x"]);

  assert.throws(
    () => createKernelPluginRegistry([a, b]),
    /kernel plugin @example\/b conflicts on kind https:\/\/example\.test\/kinds\/v1\/x; @example\/a already provides it/,
  );
});

Deno.test("registry refuses plugin with empty provides[]", () => {
  assert.throws(
    () =>
      createKernelPluginRegistry([
        {
          name: "@example/bad",
          version: "1.0.0",
          provides: [],
          apply: () =>
            Promise.resolve({ providerResourceId: "x", outputs: {} }),
        },
      ]),
    /must advertise at least one kind URI/,
  );
});

Deno.test("registry refuses plugin without apply()", () => {
  assert.throws(
    () =>
      createKernelPluginRegistry([
        {
          name: "@example/no-apply",
          version: "1.0.0",
          provides: ["https://example.test/kinds/v1/x"],
          // @ts-expect-error testing runtime guard
          apply: undefined,
        },
      ]),
    /must define apply\(\)/,
  );
});

Deno.test("normalizeKindToUri short names resolve to canonical URI", () => {
  assert.equal(
    normalizeKindToUri("worker"),
    "https://takosumi.com/kinds/v1/worker",
  );
  assert.equal(
    normalizeKindToUri("https://takosumi.com/kinds/v1/postgres"),
    "https://takosumi.com/kinds/v1/postgres",
  );
  assert.equal(
    normalizeKindToUri("https://operator.example.com/kinds/lambda"),
    "https://operator.example.com/kinds/lambda",
  );
});

Deno.test("findPluginForKind returns undefined when no plugin matches", () => {
  const registry = createKernelPluginRegistry([]);
  assert.equal(findPluginForKind(registry, "worker"), undefined);
  assert.equal(
    findPluginForKind(registry, "https://unknown.test/kinds/v1/x"),
    undefined,
  );
});
