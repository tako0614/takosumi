import { expect, spyOn, test } from "bun:test";
import { D1AccountsStore } from "../../../accounts/service/src/mod.ts";
import {
  applyD1AccountsMigrationBatch,
  loadD1AccountsMigrationCatalog,
} from "../../../accounts/service/src/d1-migrations.ts";
import {
  TAKOSUMI_PRODUCT_CAPABILITIES_PATH,
  TAKOSUMI_WELL_KNOWN_PATH,
} from "../../../contract/api-surface.ts";
import worker from "../../../deploy/platform/worker.ts";
import {
  TAKOSUMI_SHARED_DASHBOARD_SESSION_CAPABILITY as dashboardSessionCapability,
  TAKOSUMI_SHARED_DASHBOARD_SESSION_PATH as dashboardSessionPath,
  TAKOSUMI_SHARED_DASHBOARD_SESSION_PROOF_HEADER as dashboardSessionProof,
} from "../../../contract/capabilities.ts";
import { SqliteFakeD1 } from "../../helpers/deploy-control/sqlite_fake_d1.ts";

const TOKEN = "process-route-token";

function platformEnv(options: { readonly token?: string } = {}) {
  const assetRequests: string[] = [];
  const token = Object.hasOwn(options, "token") ? options.token : TOKEN;
  const controlDb = new SqliteFakeD1();
  return {
    env: {
      TAKOSUMI_CONTROL_DB: controlDb,
      TAKOSUMI_DEV_MODE: "1",
      TAKOSUMI_ENVIRONMENT: "test",
      ...(token === undefined ? {} : { TAKOSUMI_DEPLOY_CONTROL_TOKEN: token }),
      ASSETS: {
        fetch: async (request: Request) => {
          assetRequests.push(new URL(request.url).pathname);
          return new Response("<html>dashboard fallback</html>", {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        },
      },
    } as never,
    assetRequests,
    controlDb,
  };
}

for (const method of ["GET", "HEAD"] as const) {
  test(`platform dispatches exact Core process routes for ${method}`, async () => {
    const { env, assetRequests } = platformEnv();
    for (const path of ["/livez", "/capabilities", "/openapi.json"]) {
      const response = await worker.fetch(
        new Request(`https://app.takosumi.test${path}`, {
          method,
          ...(path === "/capabilities" || path === "/openapi.json"
            ? { headers: { authorization: `Bearer ${TOKEN}` } }
            : {}),
        }),
        env,
      );
      expect(response.status, `${method} ${path}`).toBe(200);
      expect(response.headers.get("content-type"), `${method} ${path}`).toMatch(
        /application\/json/u,
      );
    }
    expect(assetRequests).toEqual([]);
  });
}

test("platform discovery leaves only GET and HEAD methods mounted", async () => {
  for (const path of [
    TAKOSUMI_WELL_KNOWN_PATH,
    TAKOSUMI_PRODUCT_CAPABILITIES_PATH,
  ]) {
    for (const method of ["GET", "HEAD"] as const) {
      const { env, assetRequests } = platformEnv();
      const response = await worker.fetch(
        new Request(`https://app.takosumi.test${path}`, { method }),
        env,
      );
      expect(response.status, `${method} ${path}`).toBe(200);
      expect(response.headers.get("content-type"), `${method} ${path}`).toMatch(
        /application\/json/u,
      );
      expect(assetRequests, `${method} ${path}`).toEqual([]);
    }
    for (const method of ["POST", "PUT", "OPTIONS"] as const) {
      const { env, assetRequests } = platformEnv();
      const response = await worker.fetch(
        new Request(`https://app.takosumi.test${path}`, { method }),
        env,
      );
      expect(response.status, `${method} ${path}`).toBe(405);
      expect(response.headers.get("allow"), `${method} ${path}`).toBe(
        "GET, HEAD",
      );
      expect(response.headers.get("content-type"), `${method} ${path}`).toMatch(
        /application\/json/u,
      );
      expect(await response.json(), `${method} ${path}`).toEqual({
        error: "method_not_allowed",
      });
      expect(assetRequests, `${method} ${path}`).toEqual([]);
    }
  }
});

test("platform preserves Core inventory bearer semantics", async () => {
  for (const path of ["/capabilities", "/openapi.json"]) {
    for (const method of ["GET", "HEAD"] as const) {
      const wrong = platformEnv();
      const wrongResponse = await worker.fetch(
        new Request(`https://app.takosumi.test${path}`, {
          method,
          headers: { authorization: "Bearer wrong-token" },
        }),
        wrong.env,
      );
      expect(wrongResponse.status, path).toBe(401);
      expect(wrong.assetRequests).toEqual([]);

      const unconfigured = platformEnv({ token: undefined });
      const prepare = spyOn(unconfigured.controlDb, "prepare");
      try {
        const unconfiguredResponse = await worker.fetch(
          new Request(`https://app.takosumi.test${path}`, { method }),
          unconfigured.env,
        );
        expect(unconfiguredResponse.status, path).toBe(404);
        expect(unconfiguredResponse.headers.get("content-type")).toMatch(/application\/json/u);
        if (method === "HEAD") expect(await unconfiguredResponse.text()).toBe("");
        expect(unconfigured.assetRequests).toEqual([]);
        expect(prepare).not.toHaveBeenCalled();
      } finally {
        prepare.mockRestore();
      }
    }
  }
});

test("disabled platform inventory preserves Core request-ID validation before bootstrap", async () => {
  const uuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const ulid = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const cases: readonly [HeadersInit, string | undefined][] = [
    [{ "x-request-id": uuid, "x-correlation-id": ulid }, uuid],
    [{ "x-correlation-id": ulid }, ulid],
    [{ "x-request-id": "invalid", "x-correlation-id": uuid }, undefined],
    [{ "x-request-id": "", "x-correlation-id": uuid }, undefined],
    [{ "x-request-id": "a".repeat(65) }, undefined],
  ];
  for (const path of ["/capabilities", "/openapi.json"]) {
    for (const [headers, expectedId] of cases) {
      const unconfigured = platformEnv({ token: undefined });
      const prepare = spyOn(unconfigured.controlDb, "prepare");
      try {
        const response = await worker.fetch(new Request(`https://app.takosumi.test${path}`, { headers }), unconfigured.env);
        expect(response.status).toBe(404);
        const body = await response.json() as { error: { code: string; message: string; requestId: string } };
        expect(body.error).toMatchObject({ code: "not_found", message: `${path === "/capabilities" ? "capabilities" : "openapi"} inventory disabled` });
        if (expectedId) expect(body.error.requestId).toBe(expectedId);
        else expect(body.error.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu);
        expect(prepare).not.toHaveBeenCalled();
        expect(unconfigured.assetRequests).toEqual([]);
      } finally {
        prepare.mockRestore();
      }
    }
  }
});

test("platform routes canonical Interface API to Core and retires the old path", async () => {
  const { env, assetRequests } = platformEnv();
  const canonical = await worker.fetch(
    new Request("https://app.takosumi.test/api/v1/interfaces"),
    env,
  );
  expect(canonical.status).toBe(401);
  expect(canonical.headers.get("content-type")).toMatch(/application\/json/u);

  const legacy = await worker.fetch(
    new Request("https://app.takosumi.test/v1/interfaces"),
    env,
  );
  expect(legacy.status).toBe(404);
  expect(await legacy.json()).toEqual({ error: "not found" });
  const legacyCapabilities = await worker.fetch(
    new Request("https://app.takosumi.test/v1/capabilities"),
    env,
  );
  expect(legacyCapabilities.status).toBe(404);
  expect(await legacyCapabilities.json()).toEqual({ error: "not found" });
  for (const path of [
    "/v1/hosted/subscription",
    "/v1/unknown-extension",
  ]) {
    const retired = await worker.fetch(
      new Request(`https://app.takosumi.test${path}`),
      env,
    );
    expect(retired.status, path).toBe(404);
    expect(await retired.json(), path).toEqual({ error: "not found" });
  }
  expect(assetRequests).toEqual([]);
});

test("platform reserves unknown livez descendants outside the SPA fallback", async () => {
  const { env, assetRequests } = platformEnv();
  for (const path of ["/livez/", "/livez/unknown"]) {
    const response = await worker.fetch(
      new Request(`https://app.takosumi.test${path}`),
      env,
    );
    expect(response.status, path).toBe(404);
    expect(response.headers.get("content-type"), path).toMatch(
      /application\/json/u,
    );
    expect(await response.json(), path).toEqual({ error: "not found" });
  }
  expect(assetRequests).toEqual([]);
});

test("platform reserves unknown machine-prefix paths outside the SPA fallback", async () => {
  const { env, assetRequests } = platformEnv();
  for (const path of [
    "/api",
    "/api/",
    "/api/unknown",
    "/__takosumi",
    "/__takosumi/unknown",
    "/hooks",
    "/hooks/unknown",
    "/metrics/unknown",
    "/capabilities/",
    "/capabilities/unknown",
    "/openapi.json/",
    "/openapi.json/unknown",
  ]) {
    const response = await worker.fetch(
      new Request(`https://app.takosumi.test${path}`),
      env,
    );
    expect(response.status, path).toBe(404);
    expect(response.headers.get("content-type"), path).toMatch(
      /application\/json/u,
    );
    expect(await response.json(), path).toEqual({ error: "not found" });
  }
  expect(assetRequests).toEqual([]);
});

test("only the owning shared platform advertises and mounts its cold dashboard session GET", async () => {
  const { env: baseEnv, assetRequests } = platformEnv();
  const origin = "https://app.takosumi.test";
  const send = (path: string, env = baseEnv, host = origin) => worker.fetch(new Request(host + path), env);
  const stock = await send(TAKOSUMI_PRODUCT_CAPABILITIES_PATH);
  expect((await stock.json()).extensions).not.toContain(dashboardSessionCapability);
  const unsupported = await send(dashboardSessionPath);
  expect(unsupported.status).toBe(404);
  expect(unsupported.headers.get(dashboardSessionProof)).toBeNull();
  expect(await unsupported.json()).toEqual({ error: "not found" });

  const shared = {
    ...baseEnv as object,
    TAKOSUMI_ENVIRONMENT: "staging",
    TAKOSUMI_SHARED_AUTH_PROFILE: "shared-account",
    TAKOSUMI_SHARED_AUTH_ORIGIN: origin,
    HOSTED: {
      fetchSharedAuth: () => { throw new Error("unexpected legacy health dispatch"); },
      authenticateSharedAuth: async () => ({ kind: "unauthenticated" }),
      resolveSharedAuthWorkspace: () => { throw new Error("unexpected Workspace dispatch"); },
    },
  } as never;
  const capabilities = await send(TAKOSUMI_PRODUCT_CAPABILITIES_PATH, shared);
  expect((await capabilities.json()).extensions).toContain(dashboardSessionCapability);
  const discovery = await send(TAKOSUMI_WELL_KNOWN_PATH, shared);
  expect((await discovery.json()).endpoints.extensions[dashboardSessionCapability]).toBe(origin + dashboardSessionPath);
  const alias = await send(dashboardSessionPath, shared, "https://alias.takosumi.test");
  expect(alias.status).toBe(404);
  expect(alias.headers.get(dashboardSessionProof)).toBeNull();
  const denied = await send(dashboardSessionPath, shared);
  expect(denied.status).toBe(401);
  expect(denied.headers.get(dashboardSessionProof)).toBe("1");
  expect(assetRequests).toEqual([]);
});

test("a shared-profile dashboard read cannot use an ordinary Accounts session after profile removal", async () => {
  const { env: baseEnv } = platformEnv();
  const accountsDb = new SqliteFakeD1();
  const salt = "fixture-session-salt";
  for (const migration of (await loadD1AccountsMigrationCatalog()).migrations) {
    await applyD1AccountsMigrationBatch(accountsDb, migration, 1_000 + migration.version);
  }
  const accounts = new D1AccountsStore(accountsDb, { schemaMode: "predeployed", sessionHashSalt: salt });
  const now = Date.now();
  const subject = "tsub_ordinary";
  await accounts.saveAccount({ subject, createdAt: now, updatedAt: now });
  await accounts.saveAccountSession({
    sessionId: "sess_fixture_ordinary", subject, createdAt: now, expiresAt: now + 60_000,
  });
  const env = {
    ...baseEnv as object,
    TAKOSUMI_ACCOUNTS_DB: accountsDb,
    TAKOSUMI_ACCOUNTS_D1_SCHEMA_MODE: "predeployed",
    TAKOSUMI_ACCOUNTS_ISSUER: "http://app.takosumi.test",
    TAKOSUMI_ACCOUNT_SESSION_HASH_SALT: salt,
  } as never;
  const url = "https://app.takosumi.test/api/v1/dashboard/bootstrap";
  const cookie = "takosumi_session=sess_fixture_ordinary";
  const guardedHeaders = { cookie, "x-takosumi-shared-auth-read": "1" };
  const ordinary = await worker.fetch(new Request(url, { headers: { cookie } }), env);
  expect(ordinary.status).toBe(200);
  expect(await ordinary.json()).toMatchObject({ session: { subject } });
  for (const path of [
    url,
    "https://app.takosumi.test/api/v1/apps?q=office",
    "https://app.takosumi.test/api/v1/capsules/cap_fixture/state-versions",
    "https://app.takosumi.test/api/v1/capsules/cap_fixture/activity?limit=100",
    "https://app.takosumi.test/api/v1/ui-surfaces?capsuleId=cap_fixture",
  ]) {
    const guarded = await worker.fetch(new Request(path, { headers: guardedHeaders }), env);
    expect(guarded.status).toBe(503);
    expect(guarded.headers.get("cache-control")).toBe("no-store");
  }
});

test("platform delegates the canonical Accounts API v1 surface", async () => {
  const { env: baseEnv, assetRequests } = platformEnv();
  const accountsDb = new SqliteFakeD1();
  const accountsStore = new D1AccountsStore(accountsDb);
  await accountsStore.initialize();
  const catalog = await loadD1AccountsMigrationCatalog();
  for (const migration of catalog.migrations) {
    await applyD1AccountsMigrationBatch(
      accountsDb,
      migration,
      Date.now() + migration.version,
    );
  }
  const env = {
    ...baseEnv,
    TAKOSUMI_ACCOUNTS_DB: accountsDb,
    TAKOSUMI_ACCOUNTS_D1_SCHEMA_MODE: "predeployed",
    TAKOSUMI_ACCOUNTS_ISSUER: "http://app.takosumi.test",
    TAKOSUMI_ACCOUNT_SESSION_HASH_SALT: "process-route-test-session-salt",
  } as never;
  for (const path of ["/api/v1/workspaces", "/api/v1/dashboard/bootstrap"]) {
    const response = await worker.fetch(
      new Request(`https://app.takosumi.test${path}`),
      env,
    );
    expect(response.status, path).toBe(401);
    expect(response.headers.get("content-type"), path).toMatch(
      /application\/json/u,
    );
  }
  const unknown = await worker.fetch(
    new Request("https://app.takosumi.test/api/v1/unknown"),
    env,
  );
  expect(unknown.status).toBe(401);
  expect(unknown.headers.get("content-type")).toMatch(/application\/json/u);
  expect(unknown.headers.get("www-authenticate")).toContain("Bearer");
  expect(assetRequests).toEqual([]);
});

test("platform does not broaden reserved prefixes to near-prefix paths", async () => {
  const { env, assetRequests } = platformEnv();
  for (const path of [
    "/apix",
    "/api/v1x",
    "/api/v10",
    "/__takosumix",
    "/hooksx",
    "/metricsx",
    "/livezx",
    "/capabilitiesx",
    "/openapi.jsonx",
  ]) {
    const response = await worker.fetch(
      new Request(`https://app.takosumi.test${path}`),
      env,
    );
    expect(response.status, path).toBe(200);
    expect(response.headers.get("content-type"), path).toMatch(/text\/html/u);
  }
  expect(assetRequests).toEqual([
    "/apix",
    "/api/v1x",
    "/api/v10",
    "/__takosumix",
    "/hooksx",
    "/metricsx",
    "/livezx",
    "/capabilitiesx",
    "/openapi.jsonx",
  ]);
});
