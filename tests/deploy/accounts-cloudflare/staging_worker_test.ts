import { expect, test } from "bun:test";
import { createAuthStagingWorker } from "../../../deploy/accounts-cloudflare/src/staging-worker.ts";
import { AUTH_STAGING_CLIENTS, AUTH_STAGING_COMPATIBILITY_DATE, AUTH_STAGING_ISSUER, AUTH_STAGING_WORKER } from "../../../deploy/accounts-cloudflare/src/staging-target.ts";
import { Miniflare } from "miniflare";
import { resolve } from "node:path";

type Env = Parameters<ReturnType<typeof createAuthStagingWorker>["fetch"]>[1];
const env = {
  TAKOSUMI_ENVIRONMENT: "staging", TAKOSUMI_AUTH_WORKER_NAME: AUTH_STAGING_WORKER, TAKOSUMI_ACCOUNTS_ISSUER: AUTH_STAGING_ISSUER,
  TAKOSUMI_ACCOUNTS_D1_SCHEMA_MODE: "predeployed", TAKOSUMI_CONTROL_D1_SCHEMA_MODE: "predeployed", TAKOSUMI_ACCOUNTS_HOSTED_SESSION_POLICY: "true",
  TAKOSUMI_ACCOUNTS_CLIENTS: JSON.stringify(AUTH_STAGING_CLIENTS.map((client) => ({ ...client, allowedScopes: ["openid", "email", "offline_access"], tokenEndpointAuthMethod: "client_secret_basic", enabled: true, profile: "shared-account" }))),
  TAKOSUMI_ACCOUNTS_UPSTREAM_PROVIDERS: JSON.stringify([
    { providerId: "google", protocol: "oidc", verificationProfile: "google-oidc", clientSecretEnv: "TAKOSUMI_ACCOUNTS_UPSTREAM_GOOGLE_CLIENT_SECRET", redirectUri: `${AUTH_STAGING_ISSUER}/oauth/upstream/callback` },
    { providerId: "github", protocol: "oauth2", verificationProfile: "github-oauth", clientSecretEnv: "TAKOSUMI_ACCOUNTS_UPSTREAM_GITHUB_CLIENT_SECRET", redirectUri: `${AUTH_STAGING_ISSUER}/oauth/upstream/callback` },
  ]),
  TAKOSUMI_VERSION_METADATA: { id: "fixture-version" },
  ...Object.fromEntries(["TAKOSUMI_ACCOUNTS_DB", "TAKOSUMI_CONTROL_DB", "R2_ARTIFACTS", "R2_SOURCE", "R2_STATE", "R2_BACKUPS", "COORDINATION", "RUN_OWNER", "RUNNER"].map((name) => [name, {}])),
  ...Object.fromEntries(["TAKOSUMI_ACCOUNTS_ES256_PRIVATE_JWK", "TAKOSUMI_ACCOUNTS_OIDC_PAIRWISE_SUBJECT_SECRET", "TAKOSUMI_ACCOUNT_SESSION_HASH_SALT", "TAKOSUMI_ACCOUNTS_HOSTED_STAGE_CLIENT_SECRET", "TAKOSUMI_ACCOUNTS_SERVER_STAGE_CLIENT_SECRET", "TAKOSUMI_ACCOUNTS_SUBJECT_SECRET", "TAKOSUMI_ACCOUNTS_UPSTREAM_GOOGLE_CLIENT_SECRET", "TAKOSUMI_ACCOUNTS_UPSTREAM_GITHUB_CLIENT_SECRET"].map((name) => [name, "fixture-secret"])),
} as Env;

function request(path: string, init?: RequestInit) { return new Request(`${AUTH_STAGING_ISSUER}${path}`, init); }

test("wrong origin/host and production configuration never reach Accounts or schema", async () => {
  let calls = 0;
  const worker = createAuthStagingWorker({ accounts: { async fetch() { calls++; return Response.json({ ok: true }); } }, verifySchema: async () => { calls++; } });
  expect((await worker.fetch(new Request("https://auth.takos.jp/oauth/token"), env)).status).toBe(404);
  expect((await worker.fetch(request("/oauth/token", { headers: { host: "auth.takos.jp" } }), env)).status).toBe(404);
  expect((await worker.fetch(request("/oauth/token"), { ...env, TAKOSUMI_ENVIRONMENT: "production" })).status).toBe(503);
  expect(calls).toBe(0);
});

test("Core, internal, assets and unrelated discovery are never mounted", async () => {
  let calls = 0;
  const worker = createAuthStagingWorker({ accounts: { async fetch() { calls++; return Response.json({ ok: true }); } }, verifySchema: async () => { calls++; } });
  for (const path of ["/api/v1/workspaces", "/api/v1/capsules", "/internal/v1/workspaces", "/assets/main.js", "/.well-known/takosumi", "/dashboard", "/api/v1/accounting"]) expect((await worker.fetch(request(path), env)).status).toBe(404);
  expect(calls).toBe(0);
});

test("wrong schema fails before account/OIDC routes while local health stays explicit", async () => {
  let accountCalls = 0;
  const worker = createAuthStagingWorker({ accounts: { async fetch() { accountCalls++; return Response.json({ ok: true }); } }, verifySchema: async () => { throw new Error("fixture-head4"); } });
  expect((await worker.fetch(request("/healthz"), env)).status).toBe(200);
  expect((await worker.fetch(request("/readyz"), env)).status).toBe(503);
  expect((await worker.fetch(request("/.well-known/openid-configuration"), env)).status).toBe(503);
  expect(accountCalls).toBe(0);
});

test("identity and shared Workspace facade use the supplied Accounts handler with version/no-store", async () => {
  const paths: string[] = [];
  const worker = createAuthStagingWorker({ accounts: { async fetch(request) { paths.push(new URL(request.url).pathname); return Response.json({ ok: true }); } }, verifySchema: async () => {} });
  for (const path of ["/.well-known/openid-configuration", "/oauth/authorize", "/api/v1/account/shared-workspaces", "/api/v1/account/identity-merges", "/api/v1/auth/providers"]) {
    const response = await worker.fetch(request(path), env);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-takosumi-worker-version")).toBe("fixture-version");
  }
  expect(paths).toHaveLength(5);
});

test("simultaneous readiness callers share one pending verification and retry only after settlement", async () => {
  let settle: (() => void) | undefined;
  let attempts = 0;
  const worker = createAuthStagingWorker({ verifySchema: () => { attempts++; return new Promise<void>((resolve) => { settle = resolve; }); } });
  const pending = Array.from({ length: 12 }, () => worker.fetch(request("/readyz"), env));
  await Promise.resolve();
  await Promise.resolve();
  expect(attempts).toBe(1);
  settle?.();
  const responses = await Promise.all(pending);
  expect(responses.every((response) => response.status === 200)).toBe(true);
  const next = worker.fetch(request("/readyz"), env);
  await Promise.resolve();
  await Promise.resolve();
  expect(attempts).toBe(2);
  settle?.();
  await next;
});

test("completed readiness never caches maintenance-inactive across future requests", async () => {
  let fenced = false;
  const worker = createAuthStagingWorker({ verifySchema: async () => { if (fenced) throw new Error("fixture-maintenance-fence"); } });
  expect((await worker.fetch(request("/readyz"), env)).status).toBe(200);
  fenced = true;
  expect((await worker.fetch(request("/readyz"), env)).status).toBe(503);
});

test("timed-out readiness callers reuse one rejection until native work settles", async () => {
  let attempts = 0;
  let settle: (() => void) | undefined;
  const worker = createAuthStagingWorker({ verifySchema: () => { attempts++; return new Promise<void>((resolve) => { settle = resolve; }); } });
  const started = Date.now();
  const results = await Promise.all(Array.from({ length: 12 }, () => worker.fetch(request("/readyz"), env)));
  expect(results.every((response) => response.status === 503)).toBe(true);
  expect(attempts).toBe(1);
  expect(Date.now() - started).toBeGreaterThanOrEqual(4_500);
  const nextStarted = Date.now();
  expect((await worker.fetch(request("/readyz"), env)).status).toBe(503);
  expect(Date.now() - nextStarted).toBeLessThan(500);
  expect(attempts).toBe(1);
  settle?.();
}, 10_000);

test("actual workerd entry refuses production origin and missing protected schema", async () => {
  const build = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../../../deploy/accounts-cloudflare/src/entry-worker.ts")], target: "browser", format: "esm", external: ["cloudflare:workers"] });
  expect(build.success).toBe(true);
  const bindings: Record<string, string | object> = {};
  for (const [name, value] of Object.entries(env)) {
    if (["TAKOSUMI_ACCOUNTS_DB", "TAKOSUMI_CONTROL_DB"].includes(name)) continue;
    if (typeof value === "string" || typeof value === "object") bindings[name] = value;
  }
  const runtime = new Miniflare({ script: await build.outputs[0]!.text(), modules: true, compatibilityDate: AUTH_STAGING_COMPATIBILITY_DATE, compatibilityFlags: ["nodejs_compat"], bindings, d1Databases: ["TAKOSUMI_ACCOUNTS_DB", "TAKOSUMI_CONTROL_DB"] });
  try {
    // Miniflare's Node dispatcher normally installs this original-URL header.
    // Bun's Undici bridge does not apply that dispatcher, so supply the same
    // loopback ingress metadata explicitly without weakening the Worker guard.
    const ingress = (url: string) => runtime.dispatchFetch(url, { headers: { host: new URL(url).host, "MF-Original-URL": url } });
    expect((await ingress("https://auth.takos.jp/oauth/token")).status).toBe(404);
    expect((await ingress(`${AUTH_STAGING_ISSUER}/readyz`)).status).toBe(503);
    expect((await ingress(`${AUTH_STAGING_ISSUER}/.well-known/openid-configuration`)).status).toBe(503);
  } finally { await runtime.dispose(); }
}, 20_000);
