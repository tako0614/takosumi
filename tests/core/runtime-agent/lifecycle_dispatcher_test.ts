import { test } from "bun:test";
import assert from "node:assert/strict";
import { RuntimeHandlerRegistry } from "../../../core/runtime-agent/handlers.ts";
import {
  ArtifactKindMismatchError,
  RuntimeHandlerNotFoundError,
  LifecycleDispatcher,
} from "../../../core/runtime-agent/lifecycle_dispatcher.ts";

test("dispatcher throws RuntimeHandlerNotFoundError for unknown shape/provider", () => {
  const dispatcher = new LifecycleDispatcher(new RuntimeHandlerRegistry());
  assert.throws(
    () =>
      dispatcher.apply({
        shape: "object-store@v1",
        provider: "ghost",
        spaceId: "space_test",
        resourceName: "x",
        spec: {},
      }),
    RuntimeHandlerNotFoundError,
  );
});

test("dispatcher rejects request whose artifact.kind is not accepted", () => {
  const reg = new RuntimeHandlerRegistry();
  reg.register({
    provider: "lambda",
    shape: "function@v1",
    acceptedArtifactKinds: ["operator.example/function-bundle"],
    apply: () => Promise.resolve({ handle: "h", outputs: {} }),
    destroy: () => Promise.resolve({ ok: true }),
    describe: () => Promise.resolve({ status: "running" as const }),
  });
  const dispatcher = new LifecycleDispatcher(reg);
  assert.throws(
    () =>
      dispatcher.apply({
        shape: "function@v1",
        provider: "lambda",
        spaceId: "space_test",
        resourceName: "fn",
        spec: { artifact: { kind: "oci-image", uri: "ghcr.io/me/api:v1" } },
      }),
    (err: unknown) => {
      assert.ok(err instanceof ArtifactKindMismatchError);
      assert.equal(err.shape, "function@v1");
      assert.equal(err.provider, "lambda");
      assert.deepEqual([...err.expected], ["operator.example/function-bundle"]);
      assert.equal(err.got, "oci-image");
      return true;
    },
  );
});

test("dispatcher accepts spec.image shorthand as oci-image kind", async () => {
  const reg = new RuntimeHandlerRegistry();
  let received: unknown;
  reg.register({
    provider: "fargate-fake",
    shape: "web-service@v1",
    acceptedArtifactKinds: ["oci-image"],
    apply: (req) => {
      received = req.spec;
      return Promise.resolve({ handle: "h", outputs: {} });
    },
    destroy: () => Promise.resolve({ ok: true }),
    describe: () => Promise.resolve({ status: "running" as const }),
  });
  const dispatcher = new LifecycleDispatcher(reg);
  const res = await dispatcher.apply({
    shape: "web-service@v1",
    provider: "fargate-fake",
    spaceId: "space_test",
    resourceName: "svc",
    spec: {
      image: "ghcr.io/me/api:v1",
      port: 8080,
      scale: { min: 1, max: 1 },
    },
  });
  assert.equal(res.handle, "h");
  assert.equal(
    (received as { image: string }).image,
    "ghcr.io/me/api:v1",
  );
});

test("dispatcher accepts new artifact.kind matching accepted list", async () => {
  const reg = new RuntimeHandlerRegistry();
  reg.register({
    provider: "static-host",
    shape: "web-service@v1",
    acceptedArtifactKinds: ["operator.example/static-bundle"],
    apply: () => Promise.resolve({ handle: "h", outputs: {} }),
    destroy: () => Promise.resolve({ ok: true }),
    describe: () => Promise.resolve({ status: "running" as const }),
  });
  const dispatcher = new LifecycleDispatcher(reg);
  const res = await dispatcher.apply({
    shape: "web-service@v1",
    provider: "static-host",
    spaceId: "space_test",
    resourceName: "svc",
    spec: {
      artifact: { kind: "operator.example/static-bundle", hash: "sha256:abc" },
      port: 8080,
      scale: { min: 1, max: 1 },
    },
  });
  assert.equal(res.handle, "h");
});

test("dispatcher passes RuntimeHandlerContext through to handler.apply", async () => {
  const reg = new RuntimeHandlerRegistry();
  let seenCtx: { fetcher?: unknown } | undefined;
  reg.register({
    provider: "ctx-test",
    shape: "object-store@v1",
    acceptedArtifactKinds: [],
    apply: (_req, ctx) => {
      seenCtx = ctx;
      return Promise.resolve({ handle: "h", outputs: {} });
    },
    destroy: () => Promise.resolve({ ok: true }),
    describe: () => Promise.resolve({ status: "running" as const }),
  });
  const dispatcher = new LifecycleDispatcher(reg);
  const fetcher = {
    fetch: () => Promise.reject(new Error("not used")),
    head: () => Promise.resolve(undefined),
  };
  await dispatcher.apply({
    shape: "object-store@v1",
    provider: "ctx-test",
    spaceId: "space_test",
    resourceName: "x",
    spec: { name: "x" },
  }, { fetcher });
  assert.ok(seenCtx);
  assert.equal(seenCtx?.fetcher, fetcher);
});

test("dispatcher skips kind validation when spec has no artifact and no image", async () => {
  const reg = new RuntimeHandlerRegistry();
  reg.register({
    provider: "no-artifact",
    shape: "postgres@v1",
    acceptedArtifactKinds: [],
    apply: () => Promise.resolve({ handle: "h", outputs: {} }),
    destroy: () => Promise.resolve({ ok: true }),
    describe: () => Promise.resolve({ status: "running" as const }),
  });
  const dispatcher = new LifecycleDispatcher(reg);
  const res = await dispatcher.apply({
    shape: "postgres@v1",
    provider: "no-artifact",
    spaceId: "space_test",
    resourceName: "db",
    spec: { version: "16", size: "small" },
  });
  assert.equal(res.handle, "h");
});

test("dispatcher routes compensate to handler hook when present", async () => {
  const reg = new RuntimeHandlerRegistry();
  let seenHandle = "";
  reg.register({
    provider: "compensating",
    shape: "object-store@v1",
    acceptedArtifactKinds: [],
    apply: () => Promise.resolve({ handle: "h", outputs: {} }),
    destroy: () => Promise.resolve({ ok: true }),
    compensate: (req) => {
      seenHandle = req.handle;
      return Promise.resolve({ ok: true, note: "compensated" });
    },
    describe: () => Promise.resolve({ status: "running" as const }),
  });
  const dispatcher = new LifecycleDispatcher(reg);
  const res = await dispatcher.compensate({
    shape: "object-store@v1",
    provider: "compensating",
    spaceId: "space_test",
    handle: "bucket-one",
  });
  assert.equal(seenHandle, "bucket-one");
  assert.deepEqual(res, { ok: true, note: "compensated" });
});

test("dispatcher falls back to destroy when compensate hook is absent", async () => {
  const reg = new RuntimeHandlerRegistry();
  let destroyed = "";
  reg.register({
    provider: "destroy-fallback",
    shape: "object-store@v1",
    acceptedArtifactKinds: [],
    apply: () => Promise.resolve({ handle: "h", outputs: {} }),
    destroy: (req) => {
      destroyed = req.handle;
      return Promise.resolve({ ok: true, note: "destroyed" });
    },
    describe: () => Promise.resolve({ status: "running" as const }),
  });
  const dispatcher = new LifecycleDispatcher(reg);
  const res = await dispatcher.compensate({
    shape: "object-store@v1",
    provider: "destroy-fallback",
    spaceId: "space_test",
    handle: "bucket-two",
  });
  assert.equal(destroyed, "bucket-two");
  assert.deepEqual(res, { ok: true, note: "destroyed" });
});
