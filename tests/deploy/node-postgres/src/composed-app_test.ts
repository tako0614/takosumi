import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  PostgresAccountsStore,
  type PostgresQueryClient,
} from "@takosjp/takosumi-accounts-service";
import type { ComposedAppInput } from "../../../../deploy/node-postgres/src/composed-app.ts";
import type { NodeAccountsServerConfig } from "../../../../deploy/node-postgres/src/handler.ts";

const globalWithRequire = globalThis as {
  require?: (specifier: string) => unknown;
};
globalWithRequire.require ??= createRequire(import.meta.url);

const TEST_DEPLOY_CONTROL_TOKEN = "test-deploy-control-token";

// The embedded service's in-memory secret store refuses to start in the default
// `local` environment without an encryption key or an explicit dev opt-in. These
// route tests never exercise the secret store, so opt into dev mode so
// `createTakosumiService` boots the in-memory adapters.
process.env.TAKOSUMI_DEV_MODE = "1";

/**
 * Regression coverage for composed-app routing. The account-plane owns
 * `/v1/installation-projections/*` for identity/billing/export projections,
 * while the embedded service owns the primary `/api/v1/*` deploy-control
 * surface. `buildComposedApp` mounts the projection route on the outer app so it
 * reaches the accounts handler while service routes stay reachable.
 */

function stubQueryClient(): PostgresQueryClient {
  return {
    // The service graph material resolver only touches the store lazily at
    // resolve time; these tests never trigger a resolve, so a throwing query
    // surfaces an accidental DB dependency rather than silently passing.
    queryObject: () => {
      throw new Error("unexpected DB query in composed-app route test");
    },
  };
}

function testConfig(): NodeAccountsServerConfig {
  return {
    bindHost: "127.0.0.1",
    port: 8787,
    issuer: "http://localhost:8787",
    databaseUrl: "postgres://unused",
    clients: undefined,
    platformAccess: { status: "closed" },
    serviceGraphMaterialResolver: undefined,
    passkeys: undefined,
    upstreamOAuth: undefined,
    stableOidc: undefined,
    exportDownload: undefined,
    subject: undefined,
  };
}

interface AccountsHandlerSpy {
  readonly handler: NonNullable<ComposedAppInput["accountsHandler"]>;
  readonly calls: { method: string; pathname: string }[];
}

function accountsHandlerSpy(): AccountsHandlerSpy {
  const calls: { method: string; pathname: string }[] = [];
  return {
    calls,
    handler: (req: Request) => {
      const url = new URL(req.url);
      calls.push({ method: req.method, pathname: url.pathname });
      // A sentinel body + header the service never emits, so a test can prove the
      // account-plane handler — not the embedded service — produced the response.
      return Promise.resolve(
        new Response(JSON.stringify({ handledBy: "accounts" }), {
          status: 299,
          headers: {
            "content-type": "application/json",
            "x-handled-by": "accounts",
          },
        }),
      );
    },
  };
}

async function buildTestApp() {
  const spy = accountsHandlerSpy();
  const { buildComposedApp } =
    await import("../../../../deploy/node-postgres/src/composed-app.ts");
  const created = await buildComposedApp({
    config: testConfig(),
    store: new PostgresAccountsStore(stubQueryClient()),
    accountsHandler: spy.handler,
    runtimeEnv: {
      TAKOSUMI_DEPLOY_CONTROL_TOKEN: TEST_DEPLOY_CONTROL_TOKEN,
    },
  });
  return { app: created.app, spy };
}

test("composed app routes POST /v1/installation-projections to the account plane, not the service", async () => {
  const { app, spy } = await buildTestApp();
  const res = await app.fetch(
    new Request("http://localhost/v1/installation-projections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ spaceId: "space_1" }),
    }),
  );
  // Account-plane sentinel proves the projection route reached the accounts
  // handler rather than the embedded service fallback.
  assert.equal(res.headers.get("x-handled-by"), "accounts");
  assert.deepEqual(spy.calls, [
    {
      method: "POST",
      pathname: "/v1/installation-projections",
    },
  ]);
});

test("composed app builds accounts handler with an in-process service deploy control facade", async () => {
  const spy = accountsHandlerSpy();
  let operationsWired = false;
  let controlPlaneOperationsWired = false;
  const { buildComposedApp } =
    await import("../../../../deploy/node-postgres/src/composed-app.ts");
  const created = await buildComposedApp({
    config: testConfig(),
    store: new PostgresAccountsStore(stubQueryClient()),
    createAccountsHandler: async (deployControl, controlPlaneOperations) => {
      // The account-plane deploy-control facade is in-process only: it dispatches
      // through the injected typed `operations` facade (no HTTP `fetch` seam, no
      // Bearer handshake). Assert the embedded service's facade is wired in.
      operationsWired =
        typeof deployControl.operations.createPlanRun === "function" &&
        typeof deployControl.operations.getCapsule === "function";
      // The session-authed dashboard API needs the full control-plane facade
      // (`/api/v1/spaces`, connections, run groups, etc.), not just the narrow
      // plan/apply deploy-control facade above.
      controlPlaneOperationsWired =
        typeof controlPlaneOperations.spaces.listWorkspacesByOwner ===
          "function" &&
        typeof controlPlaneOperations.connections.listProviderConnections ===
          "function";
      return spy.handler;
    },
  });

  assert.equal(operationsWired, true);
  assert.equal(controlPlaneOperationsWired, true);
  const res = await created.app.fetch(
    new Request("http://localhost/dashboard"),
  );
  assert.equal(res.headers.get("x-handled-by"), "accounts");
});

test("composed app routes per-installation deployment mutation to the account plane", async () => {
  const { app, spy } = await buildTestApp();
  // `inst_<uuid>` is the account-plane id shape; the service id guard rejects it.
  const res = await app.fetch(
    new Request(
      "http://localhost/v1/installation-projections/inst_abc123/deployments",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    ),
  );
  assert.equal(res.headers.get("x-handled-by"), "accounts");
  assert.deepEqual(spy.calls, [
    {
      method: "POST",
      pathname: "/v1/installation-projections/inst_abc123/deployments",
    },
  ]);
});

test("composed app routes GET /v1/installation-projections list to the account plane", async () => {
  const { app, spy } = await buildTestApp();
  const res = await app.fetch(
    new Request(
      "http://localhost/v1/installation-projections?space_id=space_1",
    ),
  );
  assert.equal(res.headers.get("x-handled-by"), "accounts");
  assert.equal(spy.calls.length, 1);
  assert.equal(spy.calls[0].pathname, "/v1/installation-projections");
});

test("composed app still serves an embedded service process route", async () => {
  const { app, spy } = await buildTestApp();
  // `/health` was removed in the health-dedup stage. `/capabilities` is the
  // always-mounted service process route, but it is operator-inventory gated;
  // an unauthenticated 401 proves the embedded service app saw the request and
  // the account-plane fallback did not shadow it.
  const unauthenticated = await app.fetch(
    new Request("http://localhost/capabilities"),
  );
  assert.equal(unauthenticated.status, 401);

  const res = await app.fetch(
    new Request("http://localhost/capabilities", {
      headers: { authorization: `Bearer ${TEST_DEPLOY_CONTROL_TOKEN}` },
    }),
  );
  assert.equal(res.status, 200);
  // Service-owned route, not the account-plane sentinel.
  assert.equal(res.headers.get("x-handled-by"), null);
  const body = await res.json();
  assert.equal(body.service, "takosumi");
  // The account-plane handler must NOT have seen the service process probe.
  assert.equal(spy.calls.length, 0);
});

test("composed app delegates non-installation paths to the account-plane fallback", async () => {
  const { app, spy } = await buildTestApp();
  // `/dashboard` is an account-plane surface the service never registers; it
  // reaches the accounts handler via the service app's catch-all fallback.
  const res = await app.fetch(new Request("http://localhost/dashboard"));
  assert.equal(res.headers.get("x-handled-by"), "accounts");
  assert.deepEqual(spy.calls, [{ method: "GET", pathname: "/dashboard" }]);
});

test("composed app runs preHandle ahead of installation routing", async () => {
  const spy = accountsHandlerSpy();
  const { buildComposedApp } =
    await import("../../../../deploy/node-postgres/src/composed-app.ts");
  const created = await buildComposedApp({
    config: testConfig(),
    store: new PostgresAccountsStore(stubQueryClient()),
    accountsHandler: spy.handler,
    preHandle: (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/healthz") {
        return Promise.resolve(
          new Response("ok", { status: 200, headers: { "x-pre": "1" } }),
        );
      }
      return Promise.resolve(undefined);
    },
  });
  const res = await created.app.fetch(new Request("http://localhost/healthz"));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-pre"), "1");
  assert.equal(spy.calls.length, 0);
});
