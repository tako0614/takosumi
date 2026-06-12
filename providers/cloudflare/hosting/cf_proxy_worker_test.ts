import { afterEach, expect, test } from "bun:test";

import {
  handleCfProxyRequest,
  parseCfProxyPath,
  rewriteCfProxyApiPath,
} from "./cf_proxy_worker.ts";
import { signCfProxyScope } from "./cf_proxy_signature.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const SECRET = "test-cf-proxy-secret";
// Rotation companion: the previously-active signing secret an operator keeps
// accepting for one window after promoting a new primary.
const PREVIOUS_SECRET = "test-cf-proxy-secret-previous";
const NOW = 1_900_000_000_000;
const EXP = NOW + 60 * 60 * 1000;

const SCOPE = {
  signature: "sig",
  namespace: "takosumi-tenants",
  slug: "app",
  apiPath: "/client/v4/accounts/acct123/workers/scripts/api",
} as const;

/** A `/internal/cf-proxy/<sig>/<ns>/<slug>/client/v4<suffix>` URL with a real signature. */
async function signedProxyUrl(
  suffix: string,
  opts: { namespace?: string; slug?: string; expMs?: number } = {},
): Promise<URL> {
  const namespace = opts.namespace ?? "takosumi-tenants";
  const slug = opts.slug ?? "app";
  const sig = await signCfProxyScope(SECRET, {
    namespace,
    slug,
    expMs: opts.expMs ?? EXP,
  });
  return new URL(
    `https://app.takosumi.com/internal/cf-proxy/${sig}/${namespace}/${slug}/client/v4${suffix}`,
  );
}

/** Like {@link signedProxyUrl} but signs with an explicit (e.g. rotation) secret. */
async function signedProxyUrlWithSecret(
  secret: string,
  suffix: string,
): Promise<URL> {
  const namespace = "takosumi-tenants";
  const slug = "app";
  const sig = await signCfProxyScope(secret, { namespace, slug, expMs: EXP });
  return new URL(
    `https://app.takosumi.com/internal/cf-proxy/${sig}/${namespace}/${slug}/client/v4${suffix}`,
  );
}

test("parseCfProxyPath: extracts signature/namespace/slug/apiPath", () => {
  expect(
    parseCfProxyPath(
      "/internal/cf-proxy/123.mac/takosumi-tenants/app/client/v4/accounts/acct123/workers/scripts/api",
    ),
  ).toEqual({
    signature: "123.mac",
    namespace: "takosumi-tenants",
    slug: "app",
    apiPath: "/client/v4/accounts/acct123/workers/scripts/api",
  });
  // Not the cf-proxy prefix, or missing the signature / client/v4 marker.
  expect(parseCfProxyPath("/internal/other/x")).toBeUndefined();
  // Pre-signature 4-segment form (ns/slug/client/v4) no longer parses.
  expect(
    parseCfProxyPath("/internal/cf-proxy/takosumi-tenants/app/client/v4"),
  ).toBeUndefined();
  expect(
    parseCfProxyPath("/internal/cf-proxy/sig/ns/slug/v4/accounts"),
  ).toBeUndefined();
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

test("handleCfProxyRequest: a signed request forwards the rewritten script PUT to api.cloudflare.com with Authorization + body", async () => {
  let captured: Request | undefined;
  globalThis.fetch = (async (req: Request) => {
    captured = req;
    return new Response('{"success":true}', { status: 200 });
  }) as typeof fetch;

  const url = await signedProxyUrl("/accounts/acct123/workers/scripts/api");
  const res = await handleCfProxyRequest(
    new Request(url, {
      method: "PUT",
      headers: {
        authorization: "Bearer op-token",
        "content-type": "multipart/form-data",
      },
      body: "bundle-bytes",
    }),
    url,
    { signingSecrets: [SECRET], nowMs: NOW },
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

  const url = await signedProxyUrl(
    "/accounts/acct123/workers/scripts/api/subdomain",
  );
  const res = await handleCfProxyRequest(
    new Request(url, { method: "PUT", body: '{"enabled":true}' }),
    url,
    { signingSecrets: [SECRET], nowMs: NOW },
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

  const url = await signedProxyUrl("/accounts/acct123/d1/database");
  await handleCfProxyRequest(new Request(url, { method: "GET" }), url, {
    signingSecrets: [SECRET],
    nowMs: NOW,
  });
  expect(captured!.url).toBe(
    "https://api.cloudflare.com/client/v4/accounts/acct123/d1/database",
  );
});

test("handleCfProxyRequest: an invalid cf-proxy path is 404", async () => {
  const url = new URL("https://app.takosumi.com/internal/cf-proxy/onlyns");
  const res = await handleCfProxyRequest(new Request(url), url, {
    signingSecrets: [SECRET],
    nowMs: NOW,
  });
  expect(res.status).toBe(404);
});

// --- signature gate (the open-relay fix) -----------------------------------

test("handleCfProxyRequest: no configured secret disables the proxy (404), no upstream call", async () => {
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    return new Response("", { status: 200 });
  }) as typeof fetch;
  const url = await signedProxyUrl("/accounts/acct123/d1/database");
  const res = await handleCfProxyRequest(new Request(url, { method: "GET" }), url, {
    nowMs: NOW,
  });
  expect(res.status).toBe(404);
  expect(called).toBe(false);
});

test("handleCfProxyRequest: an unsigned / tampered signature is rejected 403 before any upstream call", async () => {
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    return new Response("", { status: 200 });
  }) as typeof fetch;
  // A made-up signature segment that was never minted by the control plane.
  const url = new URL(
    `https://app.takosumi.com/internal/cf-proxy/${EXP}.forged/takosumi-tenants/app/client/v4/accounts/acct123/d1/database`,
  );
  const res = await handleCfProxyRequest(new Request(url, { method: "GET" }), url, {
    signingSecrets: [SECRET],
    nowMs: NOW,
  });
  expect(res.status).toBe(403);
  expect(called).toBe(false);
});

test("handleCfProxyRequest: an expired signature is rejected 403", async () => {
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    return new Response("", { status: 200 });
  }) as typeof fetch;
  const url = await signedProxyUrl("/accounts/acct123/d1/database", {
    expMs: NOW - 1,
  });
  const res = await handleCfProxyRequest(new Request(url, { method: "GET" }), url, {
    signingSecrets: [SECRET],
    nowMs: NOW,
  });
  expect(res.status).toBe(403);
  expect(called).toBe(false);
});

test("handleCfProxyRequest: a signature minted for a DIFFERENT namespace/slug is rejected 403", async () => {
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    return new Response("", { status: 200 });
  }) as typeof fetch;
  // Sign for namespace "other", but address "takosumi-tenants" in the path.
  const sig = await signCfProxyScope(SECRET, {
    namespace: "other",
    slug: "app",
    expMs: EXP,
  });
  const url = new URL(
    `https://app.takosumi.com/internal/cf-proxy/${sig}/takosumi-tenants/app/client/v4/accounts/acct123/d1/database`,
  );
  const res = await handleCfProxyRequest(new Request(url, { method: "GET" }), url, {
    signingSecrets: [SECRET],
    nowMs: NOW,
  });
  expect(res.status).toBe(403);
  expect(called).toBe(false);
});

// --- dual-key rotation (the dedicated-secret + rotation companion) ----------

test("handleCfProxyRequest: a signature minted by the PRIMARY secret verifies against the accepted set", async () => {
  let captured: Request | undefined;
  globalThis.fetch = (async (req: Request) => {
    captured = req;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  // Accepted set = [primary, previous]; signed with the primary.
  const url = await signedProxyUrlWithSecret(SECRET, "/accounts/acct123/d1/database");
  const res = await handleCfProxyRequest(new Request(url, { method: "GET" }), url, {
    signingSecrets: [SECRET, PREVIOUS_SECRET],
    nowMs: NOW,
  });
  expect(res.status).toBe(200);
  expect(captured).toBeDefined();
});

test("handleCfProxyRequest: a signature minted by the PREVIOUS (rotation) secret still verifies", async () => {
  let captured: Request | undefined;
  globalThis.fetch = (async (req: Request) => {
    captured = req;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  // A run dispatched before rotation signed with the now-previous secret; the
  // proxy admits it because it is still in the accepted set (no hard break).
  const url = await signedProxyUrlWithSecret(
    PREVIOUS_SECRET,
    "/accounts/acct123/d1/database",
  );
  const res = await handleCfProxyRequest(new Request(url, { method: "GET" }), url, {
    signingSecrets: [SECRET, PREVIOUS_SECRET],
    nowMs: NOW,
  });
  expect(res.status).toBe(200);
  expect(captured).toBeDefined();
});

test("handleCfProxyRequest: a signature minted by a secret NOT in the accepted set is rejected 403", async () => {
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    return new Response("", { status: 200 });
  }) as typeof fetch;
  // Signed with an unknown key; the accepted set is [primary, previous].
  const url = await signedProxyUrlWithSecret(
    "rotated-out-secret",
    "/accounts/acct123/d1/database",
  );
  const res = await handleCfProxyRequest(new Request(url, { method: "GET" }), url, {
    signingSecrets: [SECRET, PREVIOUS_SECRET],
    nowMs: NOW,
  });
  expect(res.status).toBe(403);
  expect(called).toBe(false);
});

test("handleCfProxyRequest: an empty accepted set disables the proxy (404), no upstream call", async () => {
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    return new Response("", { status: 200 });
  }) as typeof fetch;
  const url = await signedProxyUrl("/accounts/acct123/d1/database");
  const res = await handleCfProxyRequest(new Request(url, { method: "GET" }), url, {
    signingSecrets: [],
    nowMs: NOW,
  });
  expect(res.status).toBe(404);
  expect(called).toBe(false);
});

test("handleCfProxyRequest: blank entries in the accepted set are ignored (fail closed when all blank)", async () => {
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    return new Response("", { status: 200 });
  }) as typeof fetch;
  const url = await signedProxyUrl("/accounts/acct123/d1/database");
  const res = await handleCfProxyRequest(new Request(url, { method: "GET" }), url, {
    signingSecrets: ["", ""],
    nowMs: NOW,
  });
  expect(res.status).toBe(404);
  expect(called).toBe(false);
});
