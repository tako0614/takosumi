import assert from "node:assert/strict";
import { ConnectorRegistry } from "./connectors/mod.ts";
import {
  ArtifactKindMismatchError,
  ConnectorNotFoundError,
  LifecycleDispatcher,
} from "./lifecycle_dispatcher.ts";

Deno.test("dispatcher throws ConnectorNotFoundError for unknown shape/provider", () => {
  const dispatcher = new LifecycleDispatcher(new ConnectorRegistry());
  assert.throws(
    () =>
      dispatcher.apply({
        shape: "object-store@v1",
        provider: "ghost",
        resourceName: "x",
        spec: {},
      }),
    ConnectorNotFoundError,
  );
});

Deno.test("dispatcher rejects request whose artifact.kind is not accepted", () => {
  const reg = new ConnectorRegistry();
  reg.register({
    provider: "lambda",
    shape: "function@v1",
    acceptedArtifactKinds: ["js-bundle"],
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
        resourceName: "fn",
        spec: { artifact: { kind: "oci-image", uri: "ghcr.io/me/api:v1" } },
      }),
    (err: unknown) => {
      assert.ok(err instanceof ArtifactKindMismatchError);
      assert.equal(err.shape, "function@v1");
      assert.equal(err.provider, "lambda");
      assert.deepEqual([...err.expected], ["js-bundle"]);
      assert.equal(err.got, "oci-image");
      return true;
    },
  );
});

Deno.test("dispatcher accepts legacy spec.image as oci-image kind", async () => {
  const reg = new ConnectorRegistry();
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

Deno.test("dispatcher accepts new artifact.kind matching accepted list", async () => {
  const reg = new ConnectorRegistry();
  reg.register({
    provider: "static-host",
    shape: "web-service@v1",
    acceptedArtifactKinds: ["js-bundle"],
    apply: () => Promise.resolve({ handle: "h", outputs: {} }),
    destroy: () => Promise.resolve({ ok: true }),
    describe: () => Promise.resolve({ status: "running" as const }),
  });
  const dispatcher = new LifecycleDispatcher(reg);
  const res = await dispatcher.apply({
    shape: "web-service@v1",
    provider: "static-host",
    resourceName: "svc",
    spec: {
      artifact: { kind: "js-bundle", hash: "sha256:abc" },
      port: 8080,
      scale: { min: 1, max: 1 },
    },
  });
  assert.equal(res.handle, "h");
});

Deno.test("dispatcher passes ConnectorContext through to connector.apply", async () => {
  const reg = new ConnectorRegistry();
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
    resourceName: "x",
    spec: { name: "x" },
  }, { fetcher });
  assert.ok(seenCtx);
  assert.equal(seenCtx?.fetcher, fetcher);
});

Deno.test("dispatcher skips kind validation when spec has no artifact and no image", async () => {
  const reg = new ConnectorRegistry();
  reg.register({
    provider: "no-artifact",
    shape: "database-postgres@v1",
    acceptedArtifactKinds: [],
    apply: () => Promise.resolve({ handle: "h", outputs: {} }),
    destroy: () => Promise.resolve({ ok: true }),
    describe: () => Promise.resolve({ status: "running" as const }),
  });
  const dispatcher = new LifecycleDispatcher(reg);
  const res = await dispatcher.apply({
    shape: "database-postgres@v1",
    provider: "no-artifact",
    resourceName: "db",
    spec: { version: "16", size: "small" },
  });
  assert.equal(res.handle, "h");
});
