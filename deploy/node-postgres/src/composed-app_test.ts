import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  PostgresAccountsStore,
  type PostgresQueryClient,
} from "@takosjp/takosumi-accounts-service";
import type { ComposedAppInput } from "./composed-app.ts";
import type { NodeAccountsServerConfig } from "./handler.ts";

const globalWithRequire = globalThis as {
  require?: (specifier: string) => unknown;
};
globalWithRequire.require ??= createRequire(import.meta.url);

// The embedded service's in-memory secret store refuses to start in the default
// `local` environment without an encryption key or an explicit dev opt-in. These
// route tests never exercise the secret store, so opt into dev mode so
// `createTakosumiService` boots the in-memory adapters.
process.env.TAKOSUMI_DEV_MODE = "1";

/**
 * Regression coverage for the composed-app route-shadowing bug. The embedded
 * service (`createTakosumiService`) registers the Deploy Control API on the SAME
 * `/v1/installations/*` paths the account-plane projection owns, and Hono
 * composes matched handlers in registration order, so the service routes used to
 * permanently shadow the account-plane (account-plane mints `inst_<uuid>` ids,
 * which the service's `^ins_[0-9a-zA-Z]{16,32}$` guard rejects with 400, or 401s
 * outright without the internal deploy control bearer). `buildComposedApp` now wraps
 * the service app so account-plane installation requests reach the accounts
 * handler first while non-installation service routes stay reachable.
 */

function stubQueryClient(): PostgresQueryClient {
  return {
    // The workload platform-service resolver only touches the store lazily at
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
    managedOfferingAccess: { status: "closed" },
    workloadPlatformServices: undefined,
    stripeBilling: undefined,
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
  const { buildComposedApp } = await import("./composed-app.ts");
  const created = await buildComposedApp({
    config: testConfig(),
    store: new PostgresAccountsStore(stubQueryClient()),
    accountsHandler: spy.handler,
  });
  return { app: created.app, spy };
}

test("composed app routes POST /v1/installations to the account plane, not the service", async () => {
  const { app, spy } = await buildTestApp();
  const res = await app.fetch(
    new Request("http://localhost/v1/installations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ spaceId: "space_1" }),
    }),
  );
  // Account-plane sentinel proves the request was NOT shadowed by the service
  // deployControl route (which would 401 without the internal deploy control bearer).
  assert.equal(res.headers.get("x-handled-by"), "accounts");
  assert.deepEqual(spy.calls, [{
    method: "POST",
    pathname: "/v1/installations",
  }]);
});

test("composed app builds accounts handler with an in-process service deploy control proxy", async () => {
  const spy = accountsHandlerSpy();
  let deployControlEndpointReached = false;
  const { buildComposedApp } = await import("./composed-app.ts");
  const created = await buildComposedApp({
    config: testConfig(),
    store: new PostgresAccountsStore(stubQueryClient()),
    createAccountsHandler: async (deployControl) => {
      assert.equal(typeof deployControl.token, "string");
      const res = await deployControl.fetch!(
        new Request(`${deployControl.url}/v1/runner-profiles`, {
          method: "GET",
          headers: {
            "authorization": `Bearer ${deployControl.token}`,
          },
        }),
      );
      const body = await res.json();
      deployControlEndpointReached = res.status === 200 &&
        Array.isArray(body.runnerProfiles);
      return spy.handler;
    },
  });

  assert.equal(deployControlEndpointReached, true);
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
      "http://localhost/v1/installations/inst_abc123/deployments",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    ),
  );
  assert.equal(res.headers.get("x-handled-by"), "accounts");
  assert.deepEqual(spy.calls, [{
    method: "POST",
    pathname: "/v1/installations/inst_abc123/deployments",
  }]);
});

test("composed app routes GET /v1/installations list to the account plane", async () => {
  const { app, spy } = await buildTestApp();
  const res = await app.fetch(
    new Request("http://localhost/v1/installations?space_id=space_1"),
  );
  assert.equal(res.headers.get("x-handled-by"), "accounts");
  assert.equal(spy.calls.length, 1);
  assert.equal(spy.calls[0].pathname, "/v1/installations");
});

test("composed app still serves the embedded service /health route", async () => {
  const { app, spy } = await buildTestApp();
  const res = await app.fetch(new Request("http://localhost/health"));
  assert.equal(res.status, 200);
  // Service health, not the account-plane sentinel.
  assert.equal(res.headers.get("x-handled-by"), null);
  const body = await res.json();
  assert.equal(body.service, "takosumi");
  // The account-plane handler must NOT have seen the service health probe.
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
  const { buildComposedApp } = await import("./composed-app.ts");
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
