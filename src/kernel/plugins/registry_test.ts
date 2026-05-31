import { test } from "bun:test";
import assert from "node:assert/strict";
import type { KernelPlugin } from "takosumi-contract/reference/plugin";
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
        resourceHandle: `${name}://${ctx.componentName}`,
        outputs: {},
      }),
  };
}

test("registry exposes registered plugins in registration order", () => {
  const a = buildPlugin("@example/a", ["https://example.test/kinds/v1/a"]);
  const b = buildPlugin("@example/b", ["https://example.test/kinds/v1/b"]);
  const registry = createKernelPluginRegistry([a, b]);

  assert.deepEqual(
    registry.list().map((plugin) => plugin.name),
    ["@example/a", "@example/b"],
  );
});

test("registry resolves operator alias to kind URI lookup", () => {
  const workerPlugin = buildPlugin(
    "@takos/workers-reference",
    ["https://takosumi.com/kinds/v1/worker"],
  );
  const registry = createKernelPluginRegistry([workerPlugin], {
    kindAliases: {
      worker: "https://takosumi.com/kinds/v1/worker",
    },
  });

  assert.equal(
    findPluginForKind(registry, "worker")?.name,
    "@takos/workers-reference",
  );
  assert.equal(
    findPluginForKind(registry, "https://takosumi.com/kinds/v1/worker")?.name,
    "@takos/workers-reference",
  );
});

test("registry resolves operator-defined kind URI without normalization", () => {
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

test("registry rejects duplicate plugin name", () => {
  const a = buildPlugin("@example/dup", ["https://example.test/kinds/v1/a"]);
  const b = buildPlugin("@example/dup", ["https://example.test/kinds/v1/b"]);

  assert.throws(
    () => createKernelPluginRegistry([a, b]),
    /kernel plugin already registered: @example\/dup/,
  );
});

test("registry rejects conflicting kind URI providers", () => {
  const a = buildPlugin("@example/a", ["https://example.test/kinds/v1/x"]);
  const b = buildPlugin("@example/b", ["https://example.test/kinds/v1/x"]);

  assert.throws(
    () => createKernelPluginRegistry([a, b]),
    /kernel plugin @example\/b conflicts on kind https:\/\/example\.test\/kinds\/v1\/x; @example\/a already provides it/,
  );
});

test("registry refuses plugin with empty provides[]", () => {
  assert.throws(
    () =>
      createKernelPluginRegistry([
        {
          name: "@example/bad",
          version: "1.0.0",
          provides: [],
          apply: () => Promise.resolve({ resourceHandle: "x", outputs: {} }),
        },
      ]),
    /must advertise at least one kind URI/,
  );
});

test("registry refuses plugin without apply()", () => {
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

test("normalizeKindToUri resolves only operator-provided aliases", () => {
  assert.equal(
    normalizeKindToUri("worker", {
      worker: "https://takosumi.com/kinds/v1/worker",
    }),
    "https://takosumi.com/kinds/v1/worker",
  );
  assert.equal(normalizeKindToUri("worker"), "worker");
  assert.equal(
    normalizeKindToUri("https://takosumi.com/kinds/v1/postgres"),
    "https://takosumi.com/kinds/v1/postgres",
  );
  assert.equal(
    normalizeKindToUri("https://operator.example.com/kinds/lambda"),
    "https://operator.example.com/kinds/lambda",
  );
});

test("findPluginForKind returns undefined when no plugin matches", () => {
  const registry = createKernelPluginRegistry([]);
  assert.equal(findPluginForKind(registry, "worker"), undefined);
  assert.equal(
    findPluginForKind(registry, "https://unknown.test/kinds/v1/x"),
    undefined,
  );
});
