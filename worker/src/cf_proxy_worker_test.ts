import { afterEach, expect, test } from "bun:test";

import {
  handleCfProxyRequest,
  parseCfProxyPath,
  rewriteCfProxyApiPath,
} from "./cf_proxy_worker.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const SCOPE = {
  namespace: "takosumi-tenants",
  slug: "app",
  apiPath: "/client/v4/accounts/acct123/workers/scripts/api",
} as const;

test("parseCfProxyPath: extracts namespace/slug/apiPath", () => {
  expect(
    parseCfProxyPath(
      "/internal/cf-proxy/takosumi-tenants/app/client/v4/accounts/acct123/workers/scripts/api",
    ),
  ).toEqual({
    namespace: "takosumi-tenants",
    slug: "app",
    apiPath: "/client/v4/accounts/acct123/workers/scripts/api",
  });
  // Not the cf-proxy prefix, or missing the client/v4 marker.
  expect(parseCfProxyPath("/internal/other/x")).toBeUndefined();
  expect(parseCfProxyPath("/internal/cf-proxy/ns/slug/v4/accounts")).toBeUndefined();
});

test("rewriteCfProxyApiPath: worker script -> dispatch namespace with slug prefix", () => {
  expect(rewriteCfProxyApiPath(SCOPE)).toEqual({
    path: "/client/v4/accounts/acct123/workers/dispatch/namespaces/takosumi-tenants/scripts/app-api",
  });
  // A sub-resource (settings) keeps its suffix under the namespace script.
  expect(
    rewriteCfProxyApiPath({
      ...SCOPE,
      apiPath: "/client/v4/accounts/acct123/workers/scripts/api/settings",
    }),
  ).toEqual({
    path: "/client/v4/accounts/acct123/workers/dispatch/namespaces/takosumi-tenants/scripts/app-api/settings",
  });
});

test("rewriteCfProxyApiPath: subdomain is a no-op; KV/D1/R2 pass through", () => {
  expect(
    rewriteCfProxyApiPath({
      ...SCOPE,
      apiPath: "/client/v4/accounts/acct123/workers/scripts/api/subdomain",
    }),
  ).toEqual({ noop: true });
  // Non-worker-script paths pass through verbatim.
  const kv = "/client/v4/accounts/acct123/storage/kv/namespaces";
  expect(rewriteCfProxyApiPath({ ...SCOPE, apiPath: kv })).toEqual({ path: kv });
});

test("rewriteCfProxyApiPath: an invalid derived script name is rejected", () => {
  const r = rewriteCfProxyApiPath({
    ...SCOPE,
    slug: "BAD_SLUG",
    apiPath: "/client/v4/accounts/acct123/workers/scripts/api",
  });
  expect("error" in r).toBe(true);
});

test("handleCfProxyRequest: forwards the rewritten script PUT to api.cloudflare.com with Authorization + body", async () => {
  let captured: Request | undefined;
  globalThis.fetch = (async (req: Request) => {
    captured = req;
    return new Response('{"success":true}', { status: 200 });
  }) as typeof fetch;

  const url = new URL(
    "https://app.takosumi.com/internal/cf-proxy/takosumi-tenants/app/client/v4/accounts/acct123/workers/scripts/api",
  );
  const res = await handleCfProxyRequest(
    new Request(url, {
      method: "PUT",
      headers: { authorization: "Bearer op-token", "content-type": "multipart/form-data" },
      body: "bundle-bytes",
    }),
    url,
  );
  expect(res.status).toBe(200);
  expect(captured).toBeDefined();
  expect(captured!.url).toBe(
    "https://api.cloudflare.com/client/v4/accounts/acct123/workers/dispatch/namespaces/takosumi-tenants/scripts/app-api",
  );
  expect(captured!.method).toBe("PUT");
  expect(captured!.headers.get("authorization")).toBe("Bearer op-token");
});

test("handleCfProxyRequest: subdomain no-op returns success without an upstream call", async () => {
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    return new Response("", { status: 500 });
  }) as typeof fetch;

  const url = new URL(
    "https://app.takosumi.com/internal/cf-proxy/takosumi-tenants/app/client/v4/accounts/acct123/workers/scripts/api/subdomain",
  );
  const res = await handleCfProxyRequest(
    new Request(url, { method: "PUT", body: '{"enabled":true}' }),
    url,
  );
  expect(called).toBe(false);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { success: boolean };
  expect(body.success).toBe(true);
});

test("handleCfProxyRequest: passthrough for KV/D1/R2 hits api.cloudflare.com unchanged", async () => {
  let captured: Request | undefined;
  globalThis.fetch = (async (req: Request) => {
    captured = req;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  const url = new URL(
    "https://app.takosumi.com/internal/cf-proxy/takosumi-tenants/app/client/v4/accounts/acct123/d1/database",
  );
  await handleCfProxyRequest(new Request(url, { method: "GET" }), url);
  expect(captured!.url).toBe(
    "https://api.cloudflare.com/client/v4/accounts/acct123/d1/database",
  );
});

test("handleCfProxyRequest: an invalid cf-proxy path is 404", async () => {
  const url = new URL("https://app.takosumi.com/internal/cf-proxy/onlyns");
  const res = await handleCfProxyRequest(new Request(url), url);
  expect(res.status).toBe(404);
});
