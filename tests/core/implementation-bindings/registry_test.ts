import { test } from "bun:test";
import assert from "node:assert/strict";
import type { OperatorImplementation } from "takosumi-contract/reference/implementation";
import {
  createOperatorImplementationRegistry,
  findImplementationForKind,
} from "../../../core/implementation-bindings/registry.ts";

function buildImplementation(
  name: string,
  provides: readonly string[],
): OperatorImplementation {
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

test("registry exposes registered implementations in registration order", () => {
  const a = buildImplementation("@example/a", [
    "https://example.test/kinds/v1/a",
  ]);
  const b = buildImplementation("@example/b", [
    "https://example.test/kinds/v1/b",
  ]);
  const registry = createOperatorImplementationRegistry([a, b]);

  assert.deepEqual(
    registry.list().map((implementation) => implementation.name),
    ["@example/a", "@example/b"],
  );
});

test("registry resolves exact kind URI lookup", () => {
  const workerImplementation = buildImplementation(
    "@operator/workers-reference",
    ["https://takosumi.com/kinds/v1/worker"],
  );
  const registry = createOperatorImplementationRegistry([workerImplementation]);

  assert.equal(findImplementationForKind(registry, "worker"), undefined);
  assert.equal(
    findImplementationForKind(registry, "https://takosumi.com/kinds/v1/worker")
      ?.name,
    "@operator/workers-reference",
  );
});

test("registry resolves operator-defined kind URI without normalization", () => {
  const operatorImplementation = buildImplementation("@operator/lambda", [
    "https://operator.example.com/kinds/lambda",
  ]);
  const registry = createOperatorImplementationRegistry([
    operatorImplementation,
  ]);

  assert.equal(
    findImplementationForKind(
      registry,
      "https://operator.example.com/kinds/lambda",
    )?.name,
    "@operator/lambda",
  );
});

test("registry rejects duplicate implementation name", () => {
  const a = buildImplementation("@example/dup", [
    "https://example.test/kinds/v1/a",
  ]);
  const b = buildImplementation("@example/dup", [
    "https://example.test/kinds/v1/b",
  ]);

  assert.throws(
    () => createOperatorImplementationRegistry([a, b]),
    /service implementation already registered: @example\/dup/,
  );
});

test("registry rejects conflicting kind URI providers", () => {
  const a = buildImplementation("@example/a", [
    "https://example.test/kinds/v1/x",
  ]);
  const b = buildImplementation("@example/b", [
    "https://example.test/kinds/v1/x",
  ]);

  assert.throws(
    () => createOperatorImplementationRegistry([a, b]),
    /service implementation @example\/b conflicts on kind https:\/\/example\.test\/kinds\/v1\/x; @example\/a already provides it/,
  );
});

test("registry refuses implementation with empty provides[]", () => {
  assert.throws(
    () =>
      createOperatorImplementationRegistry([
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

test("registry refuses implementation without apply()", () => {
  assert.throws(
    () =>
      createOperatorImplementationRegistry([
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

test("findByKindUri resolves kind references verbatim without normalization", () => {
  const workerImplementation = buildImplementation(
    "@operator/workers-reference",
    ["https://takosumi.com/kinds/v1/worker"],
  );
  const registry = createOperatorImplementationRegistry([workerImplementation]);

  // Bare token does not get expanded into the registered URI.
  assert.equal(registry.findByKindUri("worker"), undefined);
  // The exact URI matches.
  assert.equal(
    registry.findByKindUri("https://takosumi.com/kinds/v1/worker")?.name,
    "@operator/workers-reference",
  );
});

test("findImplementationForKind returns undefined when no implementation matches", () => {
  const registry = createOperatorImplementationRegistry([]);
  assert.equal(findImplementationForKind(registry, "worker"), undefined);
  assert.equal(
    findImplementationForKind(registry, "https://unknown.test/kinds/v1/x"),
    undefined,
  );
});
