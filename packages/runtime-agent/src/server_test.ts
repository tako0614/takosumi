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

Deno.test("destroy dispatches to registered connector", async () => {
  const registry = new ConnectorRegistry();
  let destroyed: string | undefined;
  registry.register({
    provider: "memory",
    shape: "object-store@v1",
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
