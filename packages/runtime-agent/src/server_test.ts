import assert from "node:assert/strict";
import {
  LIFECYCLE_APPLY_PATH,
  LIFECYCLE_DESTROY_PATH,
  LIFECYCLE_HEALTH_PATH,
  type LifecycleApplyRequest,
  type LifecycleDestroyRequest,
} from "takosumi-contract";
import { ConnectorRegistry } from "./connectors/mod.ts";
import { createRuntimeAgentApp } from "./server.ts";

function authHeaders(token: string) {
  return {
    "content-type": "application/json",
    "authorization": `Bearer ${token}`,
  };
}

Deno.test("health returns ok with connector count", async () => {
  const registry = new ConnectorRegistry();
  const app = createRuntimeAgentApp({ registry, token: "tok" });
  const res = await app.request(LIFECYCLE_HEALTH_PATH);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, "ok");
  assert.equal(body.connectors, 0);
});

Deno.test("lifecycle endpoints reject missing auth header", async () => {
  const registry = new ConnectorRegistry();
  const app = createRuntimeAgentApp({ registry, token: "tok" });
  const res = await app.request(LIFECYCLE_APPLY_PATH, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 401);
});

Deno.test("lifecycle endpoints reject wrong token", async () => {
  const registry = new ConnectorRegistry();
  const app = createRuntimeAgentApp({ registry, token: "tok" });
  const res = await app.request(LIFECYCLE_APPLY_PATH, {
    method: "POST",
    headers: authHeaders("wrong"),
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 401);
});

Deno.test("apply returns 400 on missing fields", async () => {
  const registry = new ConnectorRegistry();
  const app = createRuntimeAgentApp({ registry, token: "tok" });
  const res = await app.request(LIFECYCLE_APPLY_PATH, {
    method: "POST",
    headers: authHeaders("tok"),
    body: JSON.stringify({ shape: "x" }),
  });
  assert.equal(res.status, 400);
});

Deno.test("apply returns 404 for unknown connector", async () => {
  const registry = new ConnectorRegistry();
  const app = createRuntimeAgentApp({ registry, token: "tok" });
  const req: LifecycleApplyRequest = {
    shape: "object-store@v1",
    provider: "ghost",
    resourceName: "x",
    spec: {},
  };
  const res = await app.request(LIFECYCLE_APPLY_PATH, {
    method: "POST",
    headers: authHeaders("tok"),
    body: JSON.stringify(req),
  });
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.code, "connector_not_found");
});

Deno.test("apply dispatches to registered connector", async () => {
  const registry = new ConnectorRegistry();
  registry.register({
    provider: "memory",
    shape: "object-store@v1",
    acceptedArtifactKinds: [],
    apply: () =>
      Promise.resolve({ handle: "memory://x", outputs: { bucket: "x" } }),
    destroy: () => Promise.resolve({ ok: true }),
    describe: () => Promise.resolve({ status: "running" as const }),
  });
  const app = createRuntimeAgentApp({ registry, token: "tok" });
  const req: LifecycleApplyRequest = {
    shape: "object-store@v1",
    provider: "memory",
    resourceName: "x",
    spec: { name: "x" },
  };
  const res = await app.request(LIFECYCLE_APPLY_PATH, {
    method: "POST",
    headers: authHeaders("tok"),
    body: JSON.stringify(req),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.handle, "memory://x");
  assert.deepEqual(body.outputs, { bucket: "x" });
});

Deno.test("GET /v1/connectors lists registered connectors with auth", async () => {
  const registry = new ConnectorRegistry();
  registry.register({
    provider: "memory",
    shape: "object-store@v1",
    acceptedArtifactKinds: [],
    apply: () => Promise.resolve({ handle: "h", outputs: {} }),
    destroy: () => Promise.resolve({ ok: true }),
    describe: () => Promise.resolve({ status: "running" as const }),
  });
  registry.register({
    provider: "alt",
    shape: "web-service@v1",
    acceptedArtifactKinds: ["oci-image"],
    apply: () => Promise.resolve({ handle: "h", outputs: {} }),
    destroy: () => Promise.resolve({ ok: true }),
    describe: () => Promise.resolve({ status: "running" as const }),
  });
  const app = createRuntimeAgentApp({ registry, token: "tok" });

  const unauthorized = await app.request("/v1/connectors");
  assert.equal(unauthorized.status, 401);

  const ok = await app.request("/v1/connectors", {
    headers: { authorization: "Bearer tok" },
  });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.connectors.length, 2);
  assert.deepEqual(
    body.connectors.map((c: { shape: string; provider: string }) =>
      `${c.shape}/${c.provider}`
    ).sort(),
    ["object-store@v1/memory", "web-service@v1/alt"],
  );
});

Deno.test("/v1/lifecycle/verify rejects missing auth", async () => {
  const registry = new ConnectorRegistry();
  const app = createRuntimeAgentApp({ registry, token: "tok" });
  const res = await app.request("/v1/lifecycle/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(res.status, 401);
});

Deno.test(
  "/v1/lifecycle/verify reports `no verify hook` for connectors without verify",
  async () => {
    const registry = new ConnectorRegistry();
    registry.register({
      provider: "memory",
      shape: "object-store@v1",
      acceptedArtifactKinds: [],
      apply: () => Promise.resolve({ handle: "h", outputs: {} }),
      destroy: () => Promise.resolve({ ok: true }),
      describe: () => Promise.resolve({ status: "running" as const }),
    });
    const app = createRuntimeAgentApp({ registry, token: "tok" });
    const res = await app.request("/v1/lifecycle/verify", {
      method: "POST",
      headers: authHeaders("tok"),
      body: "{}",
    });
    assert.equal(res.status, 200);
    const body = await res.json() as {
      results: Array<
        { shape: string; provider: string; ok: boolean; note?: string }
      >;
    };
    assert.equal(body.results.length, 1);
    assert.equal(body.results[0].ok, true);
    assert.equal(body.results[0].note, "no verify hook");
  },
);

Deno.test("/v1/lifecycle/verify aggregates ok + fail connectors", async () => {
  const registry = new ConnectorRegistry();
  registry.register({
    provider: "good",
    shape: "object-store@v1",
    acceptedArtifactKinds: [],
    apply: () => Promise.resolve({ handle: "h", outputs: {} }),
    destroy: () => Promise.resolve({ ok: true }),
    describe: () => Promise.resolve({ status: "running" as const }),
    verify: () => Promise.resolve({ ok: true, note: "credentials valid" }),
  });
  registry.register({
    provider: "bad",
    shape: "web-service@v1",
    acceptedArtifactKinds: ["oci-image"],
    apply: () => Promise.resolve({ handle: "h", outputs: {} }),
    destroy: () => Promise.resolve({ ok: true }),
    describe: () => Promise.resolve({ status: "running" as const }),
    verify: () =>
      Promise.resolve({
        ok: false,
        code: "auth_failed",
        note: "401 Unauthorized",
      }),
  });
  const app = createRuntimeAgentApp({ registry, token: "tok" });
  const res = await app.request("/v1/lifecycle/verify", {
    method: "POST",
    headers: authHeaders("tok"),
    body: "{}",
  });
  assert.equal(res.status, 200);
  const body = await res.json() as {
    results: Array<{
      shape: string;
      provider: string;
      ok: boolean;
      note?: string;
      code?: string;
    }>;
  };
  assert.equal(body.results.length, 2);
  const byProvider = Object.fromEntries(
    body.results.map((r) => [r.provider, r]),
  );
  assert.equal(byProvider.good.ok, true);
  assert.equal(byProvider.good.note, "credentials valid");
  assert.equal(byProvider.bad.ok, false);
  assert.equal(byProvider.bad.code, "auth_failed");
});

Deno.test(
  "/v1/lifecycle/verify catches thrown errors as network_error",
  async () => {
    const registry = new ConnectorRegistry();
    registry.register({
      provider: "throws",
      shape: "object-store@v1",
      acceptedArtifactKinds: [],
      apply: () => Promise.resolve({ handle: "h", outputs: {} }),
      destroy: () => Promise.resolve({ ok: true }),
      describe: () => Promise.resolve({ status: "running" as const }),
      verify: () => Promise.reject(new Error("connection refused")),
    });
    const app = createRuntimeAgentApp({ registry, token: "tok" });
    const res = await app.request("/v1/lifecycle/verify", {
      method: "POST",
      headers: authHeaders("tok"),
      body: "{}",
    });
    assert.equal(res.status, 200);
    const body = await res.json() as {
      results: Array<
        { ok: boolean; code?: string; note?: string }
      >;
    };
    assert.equal(body.results[0].ok, false);
    assert.equal(body.results[0].code, "network_error");
    assert.match(`${body.results[0].note}`, /connection refused/);
  },
);

Deno.test(
  "/v1/lifecycle/verify filters by shape + provider when supplied",
  async () => {
    const registry = new ConnectorRegistry();
    registry.register({
      provider: "memory",
      shape: "object-store@v1",
      acceptedArtifactKinds: [],
      apply: () => Promise.resolve({ handle: "h", outputs: {} }),
      destroy: () => Promise.resolve({ ok: true }),
      describe: () => Promise.resolve({ status: "running" as const }),
      verify: () => Promise.resolve({ ok: true }),
    });
    registry.register({
      provider: "alt",
      shape: "web-service@v1",
      acceptedArtifactKinds: ["oci-image"],
      apply: () => Promise.resolve({ handle: "h", outputs: {} }),
      destroy: () => Promise.resolve({ ok: true }),
      describe: () => Promise.resolve({ status: "running" as const }),
      verify: () => Promise.resolve({ ok: true }),
    });
    const app = createRuntimeAgentApp({ registry, token: "tok" });
    const res = await app.request("/v1/lifecycle/verify", {
      method: "POST",
      headers: authHeaders("tok"),
      body: JSON.stringify({ provider: "alt" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as {
      results: Array<{ provider: string }>;
    };
    assert.equal(body.results.length, 1);
    assert.equal(body.results[0].provider, "alt");
  },
);

Deno.test("destroy dispatches to registered connector", async () => {
  const registry = new ConnectorRegistry();
  let destroyed: string | undefined;
  registry.register({
    provider: "memory",
    shape: "object-store@v1",
    acceptedArtifactKinds: [],
    apply: () => Promise.resolve({ handle: "h", outputs: {} }),
    destroy: (req) => {
      destroyed = req.handle;
      return Promise.resolve({ ok: true });
    },
    describe: () => Promise.resolve({ status: "running" as const }),
  });
  const app = createRuntimeAgentApp({ registry, token: "tok" });
  const req: LifecycleDestroyRequest = {
    shape: "object-store@v1",
    provider: "memory",
    handle: "memory://x",
  };
  const res = await app.request(LIFECYCLE_DESTROY_PATH, {
    method: "POST",
    headers: authHeaders("tok"),
    body: JSON.stringify(req),
  });
  assert.equal(res.status, 200);
  assert.equal(destroyed, "memory://x");
});
