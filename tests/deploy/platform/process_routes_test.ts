import { expect, test } from "bun:test";
import { D1AccountsStore } from "../../../accounts/service/src/mod.ts";
import {
  TAKOSUMI_PRODUCT_CAPABILITIES_PATH,
  TAKOSUMI_WELL_KNOWN_PATH,
} from "../../../contract/api-surface.ts";
import worker from "../../../deploy/platform/worker.ts";
import { SqliteFakeD1 } from "../../helpers/deploy-control/sqlite_fake_d1.ts";

const TOKEN = "process-route-token";

function platformEnv(options: { readonly token?: string } = {}) {
  const assetRequests: string[] = [];
  const token = Object.hasOwn(options, "token") ? options.token : TOKEN;
  return {
    env: {
      TAKOSUMI_CONTROL_DB: new SqliteFakeD1(),
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
    const wrong = platformEnv();
    const wrongResponse = await worker.fetch(
      new Request(`https://app.takosumi.test${path}`, {
        headers: { authorization: "Bearer wrong-token" },
      }),
      wrong.env,
    );
    expect(wrongResponse.status, path).toBe(401);
    expect(wrong.assetRequests).toEqual([]);

    const unconfigured = platformEnv({ token: undefined });
    const unconfiguredResponse = await worker.fetch(
      new Request(`https://app.takosumi.test${path}`),
      unconfigured.env,
    );
    expect(unconfiguredResponse.status, path).toBe(404);
    expect(unconfigured.assetRequests).toEqual([]);
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

test("platform delegates the canonical Accounts API v1 surface", async () => {
  const { env: baseEnv, assetRequests } = platformEnv();
  const accountsDb = new SqliteFakeD1();
  const accountsStore = new D1AccountsStore(accountsDb);
  await accountsStore.initialize();
  await accountsDb
    .prepare(
      "CREATE TABLE IF NOT EXISTS takosumi_accounts_schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)",
    )
    .run();
  await accountsDb
    .prepare(
      "INSERT INTO takosumi_accounts_schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
    )
    .bind(3, "current", Date.now())
    .run();
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
