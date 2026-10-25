import { afterEach, expect, jest, spyOn, test } from "bun:test";
import {
  accountsExternalLoginConfigured,
  createCloudflareWorker,
  parseConfiguredOidcClients,
  parseLoginEmailAllowlist,
  type CloudflareWorkerEnv,
} from "../../../../deploy/accounts-cloudflare/src/handler.ts";
import { REQUIRED_PLATFORM_BINDINGS } from "../../../../deploy/accounts-cloudflare/src/bindings-check.ts";
import {
  D1AccountsStore,
  type D1Database,
  type D1ExecResult,
  type D1PreparedStatement,
  type D1Result,
  issueInterfaceOAuthAccessToken,
  registerSessionHashSaltConfig,
  resolveSessionHashSalt,
} from "../../../../accounts/service/src/mod.ts";
import { __resetSessionHashSaltConfigForTesting } from "../../../../accounts/service/src/session-hash-salt.ts";
import { oidcClientActivationDigest } from "../../../../accounts/service/src/oidc-activation.ts";
import {
  applyD1AccountsMigrationBatch,
  loadD1AccountsMigrationCatalog,
} from "../../../../accounts/service/src/d1-migrations.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";
import type {
  D1Database as ControlD1Database,
  D1PreparedStatement as ControlD1PreparedStatement,
  D1Result as ControlD1Result,
} from "../../../../worker/src/bindings.ts";
import platformWorker from "../../../../deploy/platform/worker.ts";
import { cachedDeployControlService } from "../../../../worker/src/deploy_control_seam.ts";
import {
  CloudflareD1OpenTofuControlStore,
  ensureD1OpenTofuLedgerSchema,
} from "../../../../worker/src/d1_opentofu_store.ts";
import {
  acquireControlD1MaintenanceFence,
  releaseControlD1MaintenanceFence,
} from "../../../../worker/src/d1_schema_maintenance.ts";
import { seedCapsuleModel } from "../../../helpers/deploy-control/model_fixture.ts";
import type { PlanRun } from "@takosumi/internal/deploy-control-api";

function env(values: Record<string, unknown> = {}): CloudflareWorkerEnv {
  return values as CloudflareWorkerEnv;
}

async function accountsDbAtHead(headVersion: 3 | 4): Promise<AccountsSqliteD1> {
  const db = new AccountsSqliteD1();
  const catalog = await loadD1AccountsMigrationCatalog();
  for (const migration of catalog.migrations) {
    if (migration.version > headVersion) break;
    await applyD1AccountsMigrationBatch(db, migration, 1_000 + migration.version);
  }
  return db;
}

async function versionedAccountsDb(): Promise<AccountsSqliteD1> {
  return accountsDbAtHead(4);
}

// The shared SQLite fake implements Control's optional-success D1 contract.
// Validate its actual results at this Accounts boundary; never invent success.
function accountsD1Result<T>(result: ControlD1Result<T>): D1Result<T> {
  if (typeof result.success !== "boolean") {
    throw new TypeError("SQLite Accounts fixture requires an explicit success result");
  }
  return {
    ...result,
    success: result.success,
    results: result.results === undefined ? undefined : [...result.results],
  };
}

async function sqliteRawRows(statement: ControlD1PreparedStatement): Promise<unknown[][]> {
  if (!("raw" in statement) || typeof statement.raw !== "function") {
    throw new TypeError("SQLite fixture statement does not support raw rows");
  }
  const rows: unknown = await statement.raw();
  if (!Array.isArray(rows)) throw new TypeError("SQLite raw rows must be an array");
  return rows.map((row: unknown) => {
    if (!Array.isArray(row)) throw new TypeError("SQLite raw row must be an array");
    const values: unknown[] = [...row];
    return values;
  });
}

class AccountsSqliteD1 implements D1Database {
  private readonly delegate = new SqliteFakeD1();
  private readonly statements = new WeakMap<D1PreparedStatement, ControlD1PreparedStatement>();

  prepare(query: string): D1PreparedStatement {
    return this.wrap(this.delegate.prepare(query));
  }

  private wrap(bound: ControlD1PreparedStatement): D1PreparedStatement {
    const statement: D1PreparedStatement = {
      bind: (...values) => this.wrap(bound.bind(...values)),
      run: async () => accountsD1Result(await bound.run()),
      first: <T>(column?: string) => {
        if (column !== undefined) throw new TypeError("SQLite fixture first(column) is unsupported");
        return bound.first<T>();
      },
      all: async <T>() => accountsD1Result(await bound.all<T>()),
      raw: () => sqliteRawRows(bound),
    };
    this.statements.set(statement, bound);
    return statement;
  }

  async batch<T = unknown>(statements: readonly D1PreparedStatement[]): Promise<readonly D1Result<T>[]> {
    const originals = statements.map((statement) => {
      const original = this.statements.get(statement);
      if (!original) throw new TypeError("SQLite Accounts batch requires its own prepared statements");
      return original;
    });
    // Preserve the real fake's transaction and SELECT dispatch, including rollback.
    return (await this.delegate.batch<T>(originals)).map(accountsD1Result);
  }

  exec(query: string): Promise<D1ExecResult> {
    return this.delegate.exec(query);
  }
}

async function jwksFixtureKeys(response: Response): Promise<Array<{ kid: string; d: unknown }>> {
  const document: unknown = await response.json();
  if (typeof document !== "object" || document === null || !("keys" in document) ||
      !Array.isArray(document.keys)) throw new TypeError("Expected a JWKS keys array");
  return document.keys.map((key: unknown) => {
    if (typeof key !== "object" || key === null || !("kid" in key) ||
        typeof key.kid !== "string") throw new TypeError("Expected an explicit fixture key ID");
    return { kid: key.kid, d: "d" in key ? key.d : undefined };
  });
}

afterEach(() => {
  __resetSessionHashSaltConfigForTesting();
});

test("Accounts SQLite fixture validates success without changing results or metadata", () => {
  const meta = { changes: 1, rows_read: 2 };
  const rows: readonly { id: number }[] = [{ id: 7 }];
  const result = accountsD1Result({ success: false, results: rows, meta });
  expect(result.success).toBe(false);
  expect(result.meta).toBe(meta);
  expect(result.results).toEqual([...rows]);
  expect(result.results).not.toBe(rows);
  expect(() => accountsD1Result({ results: rows, meta })).toThrow("explicit success");
});

test("Accounts SQLite fixture preserves read batches and real transaction rollback", async () => {
  const db = new AccountsSqliteD1();
  await db.exec("CREATE TABLE fixture_rows (id INTEGER PRIMARY KEY)");
  const results = await db.batch<{ id: number }>([
    db.prepare("INSERT INTO fixture_rows (id) VALUES (?)").bind(1),
    db.prepare("SELECT id FROM fixture_rows ORDER BY id"),
  ]);
  expect(results[0]?.meta?.changes).toBe(1);
  expect(results[1]?.results).toEqual([{ id: 1 }]);
  await expect(db.batch([
    db.prepare("INSERT INTO fixture_rows (id) VALUES (?)").bind(2),
    db.prepare("INSERT INTO fixture_rows (id) VALUES (?)").bind(1),
  ])).rejects.toThrow();
  expect(await db.prepare("SELECT id FROM fixture_rows ORDER BY id").all()).toEqual({
    success: true, results: [{ id: 1 }],
  });
  expect(await db.prepare("SELECT id FROM fixture_rows ORDER BY id").raw?.()).toEqual([[1]]);
  const foreign = new AccountsSqliteD1();
  await expect(db.batch([foreign.prepare("SELECT 1")])).rejects.toThrow("own prepared statements");
});

test("Accounts SQLite fixture composes counting wrappers with atomic read/write batches", async () => {
  for (const wrap of [
    (db: D1Database) => new CountingAccountsD1(db),
    (db: D1Database) => new PendingAccountsSchemaReadD1(db),
  ]) {
    const db = wrap(new AccountsSqliteD1());
    await db.exec("CREATE TABLE wrapped_rows (id INTEGER PRIMARY KEY)");
    const results = await db.batch<{ id: number }>([
      db.prepare("INSERT INTO wrapped_rows (id) VALUES (?)").bind(1),
      db.prepare("SELECT id FROM wrapped_rows ORDER BY id"),
    ]);
    expect(results[0]?.meta?.changes).toBe(1);
    expect(results[1]?.results).toEqual([{ id: 1 }]);
    // Count the exec and batch calls; batch's real statements stay atomic.
    expect(db.writeCount).toBe(2);
    await expect(db.batch([
      db.prepare("INSERT INTO wrapped_rows (id) VALUES (?)").bind(2),
      db.prepare("INSERT INTO wrapped_rows (id) VALUES (?)").bind(1),
    ])).rejects.toThrow();
    expect(db.writeCount).toBe(3);
    expect((await db.prepare("SELECT id FROM wrapped_rows ORDER BY id").all()).results).toEqual([{ id: 1 }]);
    await db.prepare("INSERT INTO wrapped_rows (id) VALUES (?)").bind(3).run();
    expect(db.writeCount).toBe(4);
    const foreign = wrap(new AccountsSqliteD1());
    await expect(db.batch([foreign.prepare("SELECT 1")])).rejects.toThrow("own prepared statements");
    expect(db.writeCount).toBe(5);
  }
});

test("Cloudflare Accounts worker keeps health local", async () => {
  const response = await createCloudflareWorker().fetch(
    new Request("https://app.example.test/healthz"),
    env(),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    ok: true,
    service: "takosumi-accounts",
  });
});

test("full Cloudflare handler keeps request-time salt out of legacy global registration", async () => {
  const legacySalt = "legacy-global-session-salt-sentinel";
  registerSessionHashSaltConfig({ salt: legacySalt });
  const response = await createCloudflareWorker().fetch(
    new Request("https://app.example.test/api/v1/workspaces"),
    env({
      TAKOSUMI_ACCOUNTS_DB: await versionedAccountsDb(),
      TAKOSUMI_ACCOUNTS_D1_SCHEMA_MODE: "predeployed",
      TAKOSUMI_ACCOUNTS_ISSUER: "http://app.example.test",
      TAKOSUMI_ACCOUNT_SESSION_HASH_SALT:
        "full-handler-explicit-session-salt",
    }),
  );

  expect(response.status).toBe(401);
  expect(resolveSessionHashSalt("TAKOSUMI_ACCOUNT_SESSION_HASH_SALT")).toBe(
    legacySalt,
  );
});

test("Cloudflare readiness checks canonical platform bindings only", async () => {
  const missing = await createCloudflareWorker().fetch(
    new Request("https://app.example.test/readyz"),
    env(),
  );
  expect(missing.status).toBe(503);
  expect((await missing.json()).missing).not.toContain(
    "TAKOSUMI_ACCOUNTS_EXPORTS",
  );

  const complete: Record<string, unknown> = {};
  for (const name of [
    ...REQUIRED_PLATFORM_BINDINGS.d1,
    ...REQUIRED_PLATFORM_BINDINGS.r2,
    ...REQUIRED_PLATFORM_BINDINGS.durableObjects,
    ...REQUIRED_PLATFORM_BINDINGS.assets,
  ]) {
    complete[name] = {};
  }
  const ready = await createCloudflareWorker().fetch(
    new Request("https://app.example.test/readyz"),
    env(complete),
  );
  expect(ready.status).toBe(200);
  // Readiness NAMES the runtime-binding lane. Absence of the derivation key is
  // a legitimate mode; a lane that switches itself without saying so is what
  // this line exists to stop.
  expect(await ready.json()).toEqual({
    ok: true,
    runtimeBindingDerivation: "sealed",
  });

  const derived = await createCloudflareWorker().fetch(
    new Request("https://app.example.test/readyz"),
    env({
      ...complete,
      TAKOSUMI_RUNTIME_BINDING_DERIVATION_KEY: "k".repeat(48),
    }),
  );
  expect(await derived.json()).toEqual({
    ok: true,
    runtimeBindingDerivation: "host-derivation",
  });

  // A key that is present but unusable refuses readiness rather than silently
  // sealing while the private RPC lane throws mid-apply on the same value.
  const unusable = await createCloudflareWorker().fetch(
    new Request("https://app.example.test/readyz"),
    env({ ...complete, TAKOSUMI_RUNTIME_BINDING_DERIVATION_KEY: "short" }),
  );
  expect(unusable.status).toBe(503);
  expect((await unusable.json()).invalid).toEqual([
    "TAKOSUMI_RUNTIME_BINDING_DERIVATION_KEY: must be at least 32 bytes, found 5",
  ]);
});

test("Cloudflare readiness keeps the same JSON response for a trailing slash", async () => {
  const complete: Record<string, unknown> = {};
  for (const name of [
    ...REQUIRED_PLATFORM_BINDINGS.d1,
    ...REQUIRED_PLATFORM_BINDINGS.r2,
    ...REQUIRED_PLATFORM_BINDINGS.durableObjects,
    ...REQUIRED_PLATFORM_BINDINGS.assets,
  ]) {
    complete[name] = {};
  }
  const worker = createCloudflareWorker();
  const canonical = await worker.fetch(
    new Request("https://app.example.test/readyz"),
    env(complete),
  );
  const trailingSlash = await worker.fetch(
    new Request("https://app.example.test/readyz/"),
    env(complete),
  );

  expect(trailingSlash.status).toBe(canonical.status);
  expect(await trailingSlash.json()).toEqual(await canonical.json());
  expect(trailingSlash.headers.get("content-type")).toBe(
    canonical.headers.get("content-type"),
  );
  expect(trailingSlash.headers.get("x-takosumi-version-id")).toBe(
    canonical.headers.get("x-takosumi-version-id"),
  );
});

test("dashboard documents keep inline scripts blocked while allowing the configured Cloudflare beacon", async () => {
  const response = await createCloudflareWorker().fetch(
    new Request("https://app.example.test/new"),
    env({
      ASSETS: {
        fetch: () =>
          Promise.resolve(
            new Response("<!doctype html><html><body></body></html>", {
              headers: { "content-type": "text/html; charset=utf-8" },
            }),
          ),
      },
    }),
  );

  expect(response.status).toBe(200);
  const csp = response.headers.get("content-security-policy") ?? "";
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(csp).toContain(
    "script-src 'self' https://static.cloudflareinsights.com",
  );
  expect(csp.match(/script-src[^;]*/u)?.[0]).not.toContain("'unsafe-inline'");
});

test("hosted docs allow exactly their own inline scripts by hash, never unsafe-inline", async () => {
  const appearance = `(()=>{const e=localStorage.getItem("vitepress-theme-appearance")})();`;
  const hashMap = `window.__VP_HASH_MAP__=JSON.parse("{}")`;
  const html =
    `<!doctype html><html><head>` +
    `<script>${appearance}</script>` +
    `<script>${hashMap}</script>` +
    `<script src="/docs/assets/app.js"></script>` +
    `</head><body></body></html>`;
  const response = await createCloudflareWorker().fetch(
    new Request("https://app.example.test/docs/"),
    env({
      ASSETS: {
        fetch: () =>
          Promise.resolve(
            new Response(html, {
              headers: { "content-type": "text/html; charset=utf-8" },
            }),
          ),
      },
    }),
  );

  expect(response.status).toBe(200);
  expect(await response.text()).toBe(html);
  const scriptSrc =
    response.headers
      .get("content-security-policy")
      ?.match(/script-src[^;]*/u)?.[0] ?? "";
  // Every inline script the document actually ships is allowed by its exact
  // digest, so the docs boot; nothing else is.
  for (const source of [appearance, hashMap]) {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(source),
    );
    let binary = "";
    for (const byte of new Uint8Array(digest))
      binary += String.fromCharCode(byte);
    expect(scriptSrc).toContain(`'sha256-${btoa(binary)}'`);
  }
  expect(scriptSrc).not.toContain("'unsafe-inline'");
  expect(scriptSrc).toContain("'self'");
  expect(scriptSrc).toContain("https://static.cloudflareinsights.com");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
});

test("OAuth callback documents never expose code or state in referrers", async () => {
  const response = await createCloudflareWorker().fetch(
    new Request(
      "https://app.example.test/sign-in/callback?code=oauth-code&state=oauth-state",
    ),
    env({
      ASSETS: {
        fetch: () =>
          Promise.resolve(
            new Response("<!doctype html><html><body>callback</body></html>", {
              headers: { "content-type": "text/html; charset=utf-8" },
            }),
          ),
      },
    }),
  );

  expect(response.status).toBe(200);
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
});

test("a docs document with no inline script keeps the unmodified dashboard policy", async () => {
  const response = await createCloudflareWorker().fetch(
    new Request("https://app.example.test/docs/endpoints.html"),
    env({
      ASSETS: {
        fetch: () =>
          Promise.resolve(
            new Response("<!doctype html><html><body>docs</body></html>", {
              headers: { "content-type": "text/html; charset=utf-8" },
            }),
          ),
      },
    }),
  );

  const scriptSrc =
    response.headers
      .get("content-security-policy")
      ?.match(/script-src[^;]*/u)?.[0] ?? "";
  expect(scriptSrc).toBe(
    "script-src 'self' https://static.cloudflareinsights.com",
  );
});

test("login allowlist and upstream discovery stay provider-neutral", () => {
  expect(
    parseLoginEmailAllowlist(
      env({ TAKOSUMI_ACCOUNTS_LOGIN_EMAIL_ALLOWLIST: "a@example.test" }),
      "https://app.example.test",
    ),
  ).toEqual({ emails: ["a@example.test"], requireVerifiedEmail: true });
  expect(accountsExternalLoginConfigured(env())).toBe(false);
  expect(
    accountsExternalLoginConfigured(
      env({
        TAKOSUMI_ACCOUNTS_SUBJECT_SECRET: "subject-secret",
        TAKOSUMI_ACCOUNTS_UPSTREAM_PROVIDERS: JSON.stringify([
          {
            providerId: "primary-oidc",
            issuer: "https://id.example.test",
            authorizationEndpoint: "https://id.example.test/authorize",
            tokenEndpoint: "https://id.example.test/token",
            userInfoEndpoint: "https://id.example.test/userinfo",
            clientId: "accounts-client",
            redirectUri: "https://app.example.test/sign-in/callback",
          },
        ]),
      }),
    ),
  ).toBe(true);
});

test("Cloudflare auth discovery exposes the current Google, OIDC, and passkey contract", async () => {
  const response = await createCloudflareWorker().fetch(
    new Request("https://app.example.test/api/v1/auth/providers"),
    env({
      TAKOSUMI_ACCOUNTS_SUBJECT_SECRET: "subject-secret",
      TAKOSUMI_ACCOUNTS_UPSTREAM_PROVIDERS: JSON.stringify([
        {
          providerId: "google",
          label: "Google",
          protocol: "oidc",
          issuer: "https://accounts.google.example.test",
          authorizationEndpoint:
            "https://accounts.google.example.test/authorize",
          tokenEndpoint: "https://accounts.google.example.test/token",
          userInfoEndpoint: "https://accounts.google.example.test/userinfo",
          clientId: "google-client-id",
          clientSecretEnv: "GOOGLE_CLIENT_SECRET",
          redirectUri: "https://app.example.test/sign-in/callback",
        },
        {
          providerId: "company-oidc",
          label: "Company SSO",
          protocol: "OIDC",
          issuer: "https://id.example.test",
          authorizationEndpoint: "https://id.example.test/authorize",
          tokenEndpoint: "https://id.example.test/token",
          userInfoEndpoint: "https://id.example.test/userinfo",
          clientId: "company-client-id",
          redirectUri: "https://app.example.test/sign-in/callback",
        },
      ]),
      GOOGLE_CLIENT_SECRET: "google-client-secret",
      TAKOSUMI_ACCOUNTS_PASSKEY_RP_ID: "app.example.test",
      TAKOSUMI_ACCOUNTS_PASSKEY_RP_NAME: "Takosumi",
      TAKOSUMI_ACCOUNTS_PASSKEY_ORIGIN: "https://app.example.test",
    }),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const text = await response.text();
  expect(JSON.parse(text)).toEqual({
    providers: [
      {
        id: "google",
        enabled: true,
        label: "Google",
        protocol: "oidc",
      },
      {
        id: "company-oidc",
        enabled: true,
        label: "Company SSO",
        protocol: "oidc",
      },
      {
        id: "passkey",
        enabled: true,
        label: "Passkey",
        protocol: "webauthn",
      },
    ],
  });
  expect(text).not.toContain("google-client-id");
  expect(text).not.toContain("google-client-secret");
  expect(text).not.toContain("accounts.google.example.test");
  expect(text).not.toContain("sign-in/callback");
});

test("retired Accounts /v1 paths bypass Cloudflare SPA assets and return JSON 404", async () => {
  const response = await createCloudflareWorker().fetch(
    new Request("http://app.example.test/v1/account/session/me"),
    env({
      ASSETS: {
        fetch: () =>
          Promise.resolve(
            new Response("<!doctype html><html>spa</html>", {
              headers: { "content-type": "text/html; charset=utf-8" },
            }),
          ),
      },
      TAKOSUMI_ACCOUNTS_DB: await versionedAccountsDb(),
      TAKOSUMI_ACCOUNTS_D1_SCHEMA_MODE: "predeployed",
      TAKOSUMI_ACCOUNTS_ISSUER: "http://app.example.test",
      TAKOSUMI_ACCOUNT_SESSION_HASH_SALT: "retired-v1-route-test-salt",
    }),
  );
  expect(response.status).toBe(404);
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(await response.json()).toMatchObject({
    error: { code: "not_found" },
  });
});

test("Cloudflare auth discovery rejects malformed config without leaking it", async () => {
  const response = await createCloudflareWorker().fetch(
    new Request("https://app.example.test/api/v1/auth/providers"),
    env({
      TAKOSUMI_ACCOUNTS_SUBJECT_SECRET: "subject-secret",
      TAKOSUMI_ACCOUNTS_UPSTREAM_PROVIDERS: JSON.stringify([
        {
          providerId: "google",
          label: "Google",
          protocol: "oidc/private-provider-detail",
          issuer: "https://private-idp.example.test",
          authorizationEndpoint: "https://private-idp.example.test/authorize",
          tokenEndpoint: "https://private-idp.example.test/token",
          userInfoEndpoint: "https://private-idp.example.test/userinfo",
          clientId: "private-client-id",
          clientSecret: "must-never-be-returned",
          redirectUri: "https://app.example.test/sign-in/callback",
        },
      ]),
    }),
  );
  expect(response.status).toBe(503);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const text = await response.text();
  expect(JSON.parse(text)).toEqual({
    error: "auth_provider_configuration_invalid",
    error_description: "Sign-in provider configuration is invalid.",
  });
  expect(text).not.toContain("private-idp");
  expect(text).not.toContain("private-client-id");
  expect(text).not.toContain("must-never-be-returned");
});

test("Cloudflare Accounts authenticates before resolving the cold Control plane", async () => {
  const db = await versionedAccountsDb();
  const sessionSalt = "cloudflare-handler-timing-test-session-salt";
  registerSessionHashSaltConfig({ salt: sessionSalt });
  const store = new D1AccountsStore(db, { schemaMode: "predeployed" });
  const sessionId = "sess_control_initialization_timing";
  await store.saveAccount({
    subject: "tsub_control_initialization_timing",
    createdAt: 1_000,
    updatedAt: 1_000,
  });
  await store.saveAccountSession({
    sessionId,
    subject: "tsub_control_initialization_timing",
    createdAt: 1_000,
    expiresAt: Date.now() + 60_000,
  });
  let releaseControlInitialization!: () => void;
  const controlInitialization = new Promise<void>((resolve) => {
    releaseControlInitialization = resolve;
  });
  let signalControlInitializationStarted!: () => void;
  const controlInitializationStarted = new Promise<void>((resolve) => {
    signalControlInitializationStarted = resolve;
  });
  let controlInitializationCalls = 0;
  const worker = createCloudflareWorker({
    controlPlaneOperations: async () => {
      controlInitializationCalls += 1;
      signalControlInitializationStarted();
      await controlInitialization;
      return {
        workspaces: {
          listWorkspacesForAccountPage: async () => ({ items: [] }),
        },
      } as never;
    },
  });
  const workerEnv = env({
    TAKOSUMI_ACCOUNTS_DB: db,
    TAKOSUMI_ACCOUNTS_D1_SCHEMA_MODE: "predeployed",
    TAKOSUMI_ACCOUNTS_ISSUER: "http://app.example.test",
    TAKOSUMI_ACCOUNT_SESSION_HASH_SALT: sessionSalt,
  });
  const request = (authenticated = false) =>
    new Request("https://app.example.test/api/v1/workspaces", {
      ...(authenticated
        ? { headers: { "x-takosumi-account-session": sessionId } }
        : {}),
    });

  const anonymousResponse = await worker.fetch(request(), workerEnv);
  expect(anonymousResponse.status).toBe(401);
  expect(controlInitializationCalls).toBe(0);
  const anonymousTiming = anonymousResponse.headers.get("server-timing") ?? "";
  expect(anonymousTiming).toContain("tk_control_auth");
  expect(anonymousTiming).not.toContain("tk_control_init");

  const coldRequest = worker.fetch(request(true), workerEnv);
  await controlInitializationStarted;
  const concurrentRequest = worker.fetch(request(true), workerEnv);
  releaseControlInitialization();

  const [coldResponse, concurrentResponse] = await Promise.all([
    coldRequest,
    concurrentRequest,
  ]);
  for (const response of [coldResponse, concurrentResponse]) {
    expect(response.status).toBe(200);
    const timing = response.headers.get("server-timing") ?? "";
    expect(timing).toContain("tk_control_auth");
    expect(timing).toMatch(/tk_control_init;dur=\d+(?:\.\d+)?/u);
  }
  expect(controlInitializationCalls).toBe(1);

  const warmResponse = await worker.fetch(request(true), workerEnv);
  expect(warmResponse.status).toBe(200);
  const warmTiming = warmResponse.headers.get("server-timing") ?? "";
  expect(warmTiming).toContain("tk_control_auth");
  expect(warmTiming).not.toContain("tk_accounts_init");
  expect(warmTiming).toMatch(/tk_control_init;dur=\d+(?:\.\d+)?/u);
});

test("Cloudflare PAT self authority uses only the dedicated membership reader", async () => {
  const db = await versionedAccountsDb();
  const store = new D1AccountsStore(db, { schemaMode: "predeployed" });
  const now = Date.now();
  const rawToken = "takpat_cloudflare_workspace_authority";
  await store.savePersonalAccessToken(rawToken, {
    tokenId: "pat_cloudflare_workspace_authority",
    tokenPrefix: "takpat_cloudflar",
    subject: "tsub_cloudflare_workspace_authority",
    name: "Cloudflare authority",
    scopes: ["write", "read"],
    workspaceId: "ws_cloudflare_workspace_authority",
    createdAt: now,
    expiresAt: now + 60_000,
  });
  let membershipReads = 0;
  let controlInitializations = 0;
  const worker = createCloudflareWorker({
    patWorkspaceMembershipReader: () => ({
      getMember: async (workspaceId, subject) => {
        membershipReads += 1;
        expect([workspaceId, subject]).toEqual([
          "ws_cloudflare_workspace_authority",
          "tsub_cloudflare_workspace_authority",
        ]);
        return {
          workspaceId,
          accountId: subject,
          status: "active",
          roles: ["owner"],
        };
      },
    }),
    controlPlaneOperations: async () => {
      controlInitializations += 1;
      throw new Error("the full Control plane must not initialize");
    },
  });

  const response = await worker.fetch(
    new Request("http://app.example.test/api/v1/account/tokens/current", {
      headers: { authorization: `Bearer ${rawToken}` },
    }),
    env({
      TAKOSUMI_ACCOUNTS_DB: db,
      TAKOSUMI_ACCOUNTS_D1_SCHEMA_MODE: "predeployed",
      TAKOSUMI_ACCOUNTS_ISSUER: "http://app.example.test",
      TAKOSUMI_ACCOUNT_SESSION_HASH_SALT:
        "cloudflare-pat-authority-session-salt",
    }),
  );

  const responseBody = await response.json();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("pragma")).toBe("no-cache");
  expect(responseBody).toEqual({
    kind: "takosumi.account-pat-authority@v1",
    token_id: "pat_cloudflare_workspace_authority",
    subject: "tsub_cloudflare_workspace_authority",
    scopes: ["read", "write"],
    workspace_id: "ws_cloudflare_workspace_authority",
    expires_at: new Date(now + 60_000).toISOString(),
    workspace_role: "owner",
  });
  expect(membershipReads).toBe(1);
  expect(controlInitializations).toBe(0);
});

test("Cloudflare authorize revalidates a Capsule OIDC client with canonical Control", async () => {
  const db = await versionedAccountsDb();
  const sessionSalt = "cloudflare-capsule-oidc-live-grant-session-salt";
  registerSessionHashSaltConfig({ salt: sessionSalt });
  const store = new D1AccountsStore(db, { schemaMode: "predeployed" });
  const now = Date.now();
  const subject = "tsub_capsule_oidc_live_grant";
  const sessionId = "sess_capsule_oidc_live_grant";
  const capsuleId = "cap_capsule_oidc_live_grant";
  const workspaceId = "ws_capsule_oidc_live_grant";
  const clientId = "toc_capsule_oidc_live_grant";
  const redirectUri = "https://capsule.example.test/auth/oidc/callback";
  const installConfig = {
    id: "icfg_capsule_oidc_live_grant",
    variableMapping: { oidc_client_id: clientId },
    installExperience: {
      projections: [
        {
          kind: "oidc_client",
          variables: { clientId: "oidc_client_id" },
          callbackPath: "/auth/oidc/callback",
          scopes: ["openid", "profile"],
        },
      ],
    },
    updatedAt: new Date(now).toISOString(),
  };
  await store.saveAccount({
    subject,
    createdAt: now,
    updatedAt: now,
  });
  await store.saveAccountSession({
    sessionId,
    subject,
    createdAt: now,
    expiresAt: now + 60_000,
  });
  await store.saveOidcClient({
    clientId,
    capsuleId,
    namespacePath: "identity.oidc",
    issuerUrl: "http://app.example.test",
    redirectUris: [redirectUri],
    allowedScopes: ["openid", "profile"],
    subjectMode: "pairwise",
    tokenEndpointAuthMethod: "none",
    activationDigest: await oidcClientActivationDigest({
      workspaceId,
      capsuleId,
      executionAuthorityEpoch: 1,
      installConfig: installConfig as never,
    }),
    createdAt: now,
    updatedAt: now,
  });
  let controlInitializationCalls = 0;
  const worker = createCloudflareWorker({
    controlPlaneOperations: async () => {
      controlInitializationCalls += 1;
      return {
        capsules: {
          getCapsule: async () => ({
            id: capsuleId,
            workspaceId,
            installConfigId: installConfig.id,
            name: "capsule-live-grant",
            status: "active",
          }),
          getInstallConfig: async () => installConfig,
          getCapsuleExecutionAuthorityEpoch: async () => 1,
        },
        workspaces: {
          getWorkspace: async () => ({
            id: workspaceId,
            ownerUserId: subject,
          }),
        },
        members: { listMembers: async () => [] },
      } as never;
    },
  });
  const authorize = new URL("http://app.example.test/oauth/authorize");
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: "openid profile",
    code_challenge: "capsule-live-grant-challenge",
    code_challenge_method: "S256",
    state: "capsule-live-grant-state",
  }).toString();

  const response = await worker.fetch(
    new Request(authorize, {
      headers: { "x-takosumi-account-session": sessionId },
    }),
    env({
      TAKOSUMI_ACCOUNTS_DB: db,
      TAKOSUMI_ACCOUNTS_D1_SCHEMA_MODE: "predeployed",
      TAKOSUMI_ACCOUNTS_ISSUER: "http://app.example.test",
      TAKOSUMI_ACCOUNT_SESSION_HASH_SALT: sessionSalt,
    }),
  );

  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toStartWith(
    `${redirectUri}?code=`,
  );
  expect(controlInitializationCalls).toBe(1);
});

test("Cloudflare config preserves a host-specific public mobile OIDC client", () => {
  const mobileClient = {
    clientId: "takos-mobile-host-example",
    redirectUris: ["takos://oauth/callback"],
    tokenEndpointAuthMethod: "none",
    allowedScopes: ["openid", "profile", "offline_access", "spaces:read"],
  } as const;

  expect(
    parseConfiguredOidcClients(
      env({ TAKOSUMI_ACCOUNTS_CLIENTS: JSON.stringify([mobileClient]) }),
    ),
  ).toEqual([mobileClient]);
});

test("Cloudflare multi-client config injects one confidential secret by exact client id", () => {
  const publicClient = {
    clientId: "takos-mobile-host-example",
    redirectUris: ["takos://oauth/callback"],
    tokenEndpointAuthMethod: "none",
  } as const;
  const introspectionClient = {
    clientId: "takosumi-cloud-extensions",
    redirectUris: ["https://app.example.test/__takosumi/callback"],
    tokenEndpointAuthMethod: "client_secret_post",
  } as const;

  expect(
    parseConfiguredOidcClients(
      env({
        TAKOSUMI_ACCOUNTS_CLIENTS: JSON.stringify([
          publicClient,
          introspectionClient,
        ]),
        TAKOSUMI_ACCOUNTS_CLIENT_ID: introspectionClient.clientId,
        TAKOSUMI_ACCOUNTS_CLIENT_SECRET: "operator-secret",
      }),
    ),
  ).toEqual([
    publicClient,
    { ...introspectionClient, clientSecret: "operator-secret" },
  ]);

  expect(() =>
    parseConfiguredOidcClients(
      env({
        TAKOSUMI_ACCOUNTS_CLIENTS: JSON.stringify([publicClient]),
        TAKOSUMI_ACCOUNTS_CLIENT_ID: introspectionClient.clientId,
        TAKOSUMI_ACCOUNTS_CLIENT_SECRET: "operator-secret",
      }),
    ),
  ).toThrow("must name an exact TAKOSUMI_ACCOUNTS_CLIENTS entry");
});

test("Cloudflare identity handler lazily revalidates Interface OAuth against Core", async () => {
  const db = await versionedAccountsDb();
  const store = new D1AccountsStore(db, { schemaMode: "predeployed" });
  const issued = await issueInterfaceOAuthAccessToken({
    store,
    subject: "principal_cloudflare",
    workspaceId: "workspace_cloudflare",
    capsuleId: "capsule_cloudflare",
    audience: "https://resource.example.test/mcp",
    permission: "mcp.invoke",
    interfaceId: "if_cloudflare",
    bindingId: "ifb_cloudflare",
    interfaceRevision: 3,
  });
  let validations = 0;
  const worker = createCloudflareWorker({
    controlPlaneOperations: () =>
      Promise.resolve({
        interfaces: {
          validatePrincipalOAuth2TokenEvidence: (evidence: {
            readonly interfaceId: string;
          }) => {
            validations += 1;
            return Promise.resolve(evidence.interfaceId === "if_cloudflare");
          },
        },
      } as never),
  });
  const oidcKeyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const workerEnv = env({
    TAKOSUMI_ACCOUNTS_DB: db,
    TAKOSUMI_ACCOUNTS_ISSUER: "https://app.example.test",
    TAKOSUMI_ACCOUNT_SESSION_HASH_SALT:
      "cloudflare-interface-oauth-test-session-salt",
    TAKOSUMI_ACCOUNTS_ES256_PRIVATE_JWK: JSON.stringify(
      await crypto.subtle.exportKey("jwk", oidcKeyPair.privateKey),
    ),
    TAKOSUMI_ACCOUNTS_ES256_KEY_ID: "cloudflare-interface-test-key",
    TAKOSUMI_ACCOUNTS_OIDC_PAIRWISE_SUBJECT_SECRET:
      "cloudflare-interface-test-pairwise-secret",
  });
  const response = await worker.fetch(
    new Request("https://app.example.test/oauth/userinfo", {
      headers: { authorization: `Bearer ${issued.accessToken}` },
    }),
    workerEnv,
  );
  const responseBody = await response.text();
  expect(response.status).toBe(200);
  expect(validations).toBe(1);
  expect(JSON.parse(responseBody)).toMatchObject({
    token_use: "interface_oauth",
    aud: "https://resource.example.test/mcp",
    takosumi: { interface_id: "if_cloudflare" },
  });
});

test("Cloudflare OIDC signing rotation publishes bounded overlap then removes the previous key", async () => {
  const db = await versionedAccountsDb();
  const store = new D1AccountsStore(db, { schemaMode: "predeployed" });
  const oldKeyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const newKeyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const oldPrivateJwk = await crypto.subtle.exportKey(
    "jwk",
    oldKeyPair.privateKey,
  );
  const newPrivateJwk = await crypto.subtle.exportKey(
    "jwk",
    newKeyPair.privateKey,
  );
  const oldPublicJwk = {
    ...(await crypto.subtle.exportKey("jwk", oldKeyPair.publicKey)),
    kid: "oidc-key-before-rotation",
    use: "sig",
    alg: "ES256",
  };
  const worker = createCloudflareWorker();
  const baseEnv = {
    TAKOSUMI_ACCOUNTS_DB: db,
    TAKOSUMI_ACCOUNTS_ISSUER: "https://app.example.test",
    TAKOSUMI_ACCOUNT_SESSION_HASH_SALT: "cloudflare-rotation-test-session-salt",
    TAKOSUMI_ACCOUNTS_OIDC_PAIRWISE_SUBJECT_SECRET:
      "cloudflare-rotation-test-pairwise-secret",
  };

  const before = await worker.fetch(
    new Request("https://app.example.test/oauth/jwks"),
    env({
      ...baseEnv,
      TAKOSUMI_ACCOUNTS_ES256_PRIVATE_JWK: JSON.stringify(oldPrivateJwk),
      TAKOSUMI_ACCOUNTS_ES256_KEY_ID: "oidc-key-before-rotation",
    }),
  );
  expect(before.status).toBe(200);
  expect((await jwksFixtureKeys(before)).map((key) => key.kid)).toEqual([
    "oidc-key-before-rotation",
  ]);

  const overlap = await worker.fetch(
    new Request("https://app.example.test/oauth/jwks"),
    env({
      ...baseEnv,
      TAKOSUMI_ACCOUNTS_ES256_PRIVATE_JWK: JSON.stringify(newPrivateJwk),
      TAKOSUMI_ACCOUNTS_ES256_KEY_ID: "oidc-key-after-rotation",
      TAKOSUMI_ACCOUNTS_ES256_PREVIOUS_PUBLIC_JWKS: JSON.stringify({
        keys: [oldPublicJwk],
      }),
    }),
  );
  expect(overlap.status).toBe(200);
  const overlapKeys = await jwksFixtureKeys(overlap);
  expect(overlapKeys.map((key) => key.kid)).toEqual([
    "oidc-key-after-rotation",
    "oidc-key-before-rotation",
  ]);
  expect(overlapKeys.every((key) => key.d === undefined)).toBe(true);

  const after = await worker.fetch(
    new Request("https://app.example.test/oauth/jwks"),
    env({
      ...baseEnv,
      TAKOSUMI_ACCOUNTS_ES256_PRIVATE_JWK: JSON.stringify(newPrivateJwk),
      TAKOSUMI_ACCOUNTS_ES256_KEY_ID: "oidc-key-after-rotation",
    }),
  );
  expect(after.status).toBe(200);
  expect((await jwksFixtureKeys(after)).map((key) => key.kid)).toEqual([
    "oidc-key-after-rotation",
  ]);
});

test("predeployed accounts routes perform multiple document operations with zero request-time DDL", async () => {
  const db = await versionedAccountsDb();
  const store = new D1AccountsStore(db, { schemaMode: "predeployed" });
  const sessionSalt = "predeployed-accounts-test-session-salt";
  const sessionId = "sess_predeployed_route";
  registerSessionHashSaltConfig({ salt: sessionSalt });
  await store.saveAccount({
    subject: "tsub_predeployed_route",
    createdAt: 1_000,
    updatedAt: 1_000,
  });
  await store.saveAccountSession({
    sessionId,
    subject: "tsub_predeployed_route",
    createdAt: 1_000,
    expiresAt: Date.now() + 60_000,
  });

  const predeployedDb = new NoDdlD1Database(db);
  const worker = createCloudflareWorker();
  const workerEnv = env({
    TAKOSUMI_ACCOUNTS_DB: predeployedDb,
    TAKOSUMI_ACCOUNTS_D1_SCHEMA_MODE: "predeployed",
    TAKOSUMI_ACCOUNTS_ISSUER: "http://localhost:8787",
    TAKOSUMI_ACCOUNT_SESSION_HASH_SALT: sessionSalt,
  });
  const sessionRequest = (method = "GET") =>
    new Request("http://localhost:8787/api/v1/account/session/me", {
      method,
      headers: {
        origin: "http://localhost:8787",
        "x-takosumi-account-session": sessionId,
      },
    });

  const getResponse = await worker.fetch(sessionRequest(), workerEnv);
  expect(getResponse.status).toBe(200);
  expect(await getResponse.json()).toMatchObject({
    subject: "tsub_predeployed_route",
  });

  const deleteResponse = await worker.fetch(
    sessionRequest("DELETE"),
    workerEnv,
  );
  expect(deleteResponse.status).toBe(204);

  const afterDelete = await worker.fetch(sessionRequest(), workerEnv);
  expect(afterDelete.status).toBe(200);
  expect(await afterDelete.json()).toEqual({ session: null });
  expect(predeployedDb.execCount).toBe(0);
});

test("predeployed accounts schema mode fails closed when schema is absent", async () => {
  const db = new AccountsSqliteD1();
  const predeployedDb = new NoDdlD1Database(db);
  const response = await createCloudflareWorker().fetch(
    new Request("https://app.example.test/api/v1/account/session/me"),
    env({
      TAKOSUMI_ACCOUNTS_DB: predeployedDb,
      TAKOSUMI_ACCOUNTS_D1_SCHEMA_MODE: "predeployed",
      TAKOSUMI_ACCOUNTS_ISSUER: "https://app.example.test",
      TAKOSUMI_ACCOUNT_SESSION_HASH_SALT:
        "predeployed-accounts-absent-test-session-salt",
    }),
  );

  expect(response.status).toBe(500);
  expect(predeployedDb.execCount).toBe(0);
});

test("predeployed Accounts Worker rejects exact legacy v3 after v4 tightening", async () => {
  const predeployedDb = new NoDdlD1Database(await accountsDbAtHead(3));
  const diagnostics: string[] = [];
  const errorSpy = spyOn(console, "error").mockImplementation((value) => {
    if (typeof value === "string") diagnostics.push(value);
  });

  let response: Response;
  try {
    response = await createCloudflareWorker().fetch(
      new Request("https://app.example.test/api/v1/account/session/me"),
      env({
        TAKOSUMI_ACCOUNTS_DB: predeployedDb,
        TAKOSUMI_ACCOUNTS_D1_SCHEMA_MODE: "predeployed",
        TAKOSUMI_ACCOUNTS_ISSUER: "https://app.example.test",
        TAKOSUMI_ACCOUNT_SESSION_HASH_SALT:
          "predeployed-accounts-v3-test-session-salt",
      }),
    );
  } finally {
    errorSpy.mockRestore();
  }

  expect(response.status).toBe(500);
  expect(
    diagnostics.some(
      (diagnostic) =>
        diagnostic.includes('"event":"accounts_d1_schema_incompatible"') &&
        diagnostic.includes('"worker_catalog_head_not_accepted"'),
    ),
  ).toBe(true);
  expect(predeployedDb.execCount).toBe(0);
});

test("Accounts handler initialization bounds each request while retaining the shared attempt", async () => {
  const delegate = await versionedAccountsDb();
  const delayedDb = new PendingAccountsSchemaReadD1(delegate);
  const worker = createCloudflareWorker();
  const workerEnv = env({
    TAKOSUMI_ACCOUNTS_DB: delayedDb,
    TAKOSUMI_ACCOUNTS_D1_SCHEMA_MODE: "predeployed",
    TAKOSUMI_ACCOUNTS_ISSUER: "http://app.example.test",
    TAKOSUMI_ACCOUNT_SESSION_HASH_SALT:
      "accounts-initialization-deadline-test-salt",
  });
  const request = () =>
    new Request("http://app.example.test/api/v1/account/session/logout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "must-not-be-dispatched",
    });

  const warnings: string[] = [];
  const warnSpy = spyOn(console, "warn").mockImplementation((value) => {
    if (typeof value === "string") warnings.push(value);
  });
  jest.useFakeTimers();
  try {
    const firstRequest = request();
    const firstResponsePromise = worker.fetch(firstRequest, workerEnv);
    await flushMicrotasks();
    expect(delayedDb.schemaReadCount).toBe(1);

    jest.advanceTimersByTime(1_000);
    const secondRequest = request();
    const secondResponsePromise = worker.fetch(secondRequest, workerEnv);
    await flushMicrotasks();
    jest.advanceTimersByTime(4_000);
    await flushMicrotasks();
    const firstResponse = await Promise.race([
      firstResponsePromise,
      Promise.resolve(undefined),
    ]);
    expect(firstResponse?.status).toBe(503);
    if (!firstResponse) throw new Error("first request did not settle");
    expect(await firstResponse.json()).toEqual({
      error: "accounts_handler_initialization_unavailable",
      error_description: "Accounts is temporarily unavailable.",
    });
    expect(firstResponse.headers.get("cache-control")).toBe("no-store");
    expect(firstResponse.headers.get("retry-after")).toBe("1");
    expect(firstResponse.headers.get("server-timing")).toMatch(
      /tk_accounts_init;dur=/u,
    );
    expect(firstRequest.bodyUsed).toBe(false);
    expect(secondRequest.bodyUsed).toBe(false);
    expect(delayedDb.writeCount).toBe(0);
    expect(
      await Promise.race([
        secondResponsePromise.then(() => "settled"),
        Promise.resolve("pending"),
      ]),
    ).toBe("pending");

    jest.advanceTimersByTime(1_000);
    await flushMicrotasks();
    const secondResponse = await Promise.race([
      secondResponsePromise,
      Promise.resolve(undefined),
    ]);
    expect(secondResponse?.status).toBe(503);
    if (!secondResponse) throw new Error("second request did not settle");
    expect(await secondResponse.json()).toEqual({
      error: "accounts_handler_initialization_unavailable",
      error_description: "Accounts is temporarily unavailable.",
    });
    expect(delayedDb.schemaReadCount).toBe(1);

    const waitingResponse = worker.fetch(
      new Request("http://app.example.test/api/v1/workspaces"),
      workerEnv,
    );
    await flushMicrotasks();
    delayedDb.releaseSchemaRead();
    await flushMicrotasks();
    expect((await waitingResponse).status).toBe(401);
    jest.advanceTimersByTime(5_000);
    await flushMicrotasks();
    const laterResponse = await worker.fetch(
      new Request("http://app.example.test/api/v1/workspaces"),
      workerEnv,
    );
    expect(laterResponse.status).toBe(401);
    expect(delayedDb.schemaReadCount).toBe(1);
    expect(
      warnings.some((warning) =>
        warning.includes('"event":"accounts_handler_initialization_unavailable"') &&
        warning.includes('"stage":"await_handler"') &&
        warning.includes('"timeoutMs":5000') &&
        warning.includes('"elapsedMs":5000') &&
        warning.includes('"errorName":"TimeoutError"'),
      ),
    ).toBe(true);
    expect(
      warnings
        .filter((warning) =>
          warning.includes('"event":"accounts_handler_initialization_unavailable"'),
        )
        .map((warning) => JSON.parse(warning).activeWaiters),
    ).toEqual([1, 0]);
  } finally {
    jest.useRealTimers();
    warnSpy.mockRestore();
  }
});

test("Accounts initialization releases timed-out waiters and observes late rejection", async () => {
  const delayedDb = new PendingAccountsSchemaReadD1(await versionedAccountsDb());
  const worker = createCloudflareWorker();
  const workerEnv = env({
    TAKOSUMI_ACCOUNTS_DB: delayedDb,
    TAKOSUMI_ACCOUNTS_D1_SCHEMA_MODE: "predeployed",
    TAKOSUMI_ACCOUNTS_ISSUER: "http://app.example.test",
    TAKOSUMI_ACCOUNT_SESSION_HASH_SALT:
      "accounts-initialization-late-rejection-test-salt",
  });
  const warnings: string[] = [];
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => unhandled.push(error);
  const warnSpy = spyOn(console, "warn").mockImplementation((value) => {
    if (typeof value === "string") warnings.push(value);
  });
  process.on("unhandledRejection", onUnhandled);
  jest.useFakeTimers();
  try {
    for (let index = 0; index < 5; index += 1) {
      const responsePromise = worker.fetch(
        new Request("http://app.example.test/api/v1/workspaces"),
        workerEnv,
      );
      await flushMicrotasks();
      jest.advanceTimersByTime(5_000);
      await flushMicrotasks();
      const response = await Promise.race([
        responsePromise,
        Promise.resolve(undefined),
      ]);
      expect(response?.status).toBe(503);
    }
    expect(delayedDb.schemaReadCount).toBe(1);
    expect(
      warnings
        .filter((warning) =>
          warning.includes('"event":"accounts_handler_initialization_unavailable"'),
        )
        .map((warning) => JSON.parse(warning).activeWaiters),
    ).toEqual(Array(5).fill(0));

    const waitingResponse = worker.fetch(
      new Request("http://app.example.test/api/v1/workspaces"),
      workerEnv,
    );
    await flushMicrotasks();
    delayedDb.rejectSchemaRead(new Error("delayed schema failure"));
    await flushMicrotasks();
    expect((await waitingResponse).status).toBe(500);
    jest.advanceTimersByTime(999);
    await flushMicrotasks();
    const laterResponse = await worker.fetch(
      new Request("http://app.example.test/api/v1/workspaces"),
      workerEnv,
    );
    expect(laterResponse.status).toBe(500);
    expect((await laterResponse.json()).error).toBe("worker_configuration_error");
    expect(delayedDb.schemaReadCount).toBe(1);
    jest.advanceTimersByTime(4_001);
    await flushMicrotasks();
    expect(delayedDb.schemaReadCount).toBe(1);
    expect(
      warnings.filter((warning) =>
        warning.includes('"event":"accounts_handler_initialization_unavailable"'),
      ),
    ).toHaveLength(5);
    await flushMicrotasks();
    expect(unhandled).toEqual([]);
  } finally {
    jest.useRealTimers();
    warnSpy.mockRestore();
    process.off("unhandledRejection", onUnhandled);
  }
});

test.each(["identity", "control"] as const)(
  "Accounts %s capacity wait caps callers and recovers on current settlement",
  async (mode) => {
    const delayedDb = new PendingAccountsSchemaReadD1(await versionedAccountsDb());
    const worker = createCloudflareWorker();
    const workerEnv = env({
      TAKOSUMI_ACCOUNTS_DB: delayedDb,
      TAKOSUMI_ACCOUNTS_D1_SCHEMA_MODE: "predeployed",
      TAKOSUMI_ACCOUNTS_ISSUER: "http://app.example.test",
      TAKOSUMI_ACCOUNT_SESSION_HASH_SALT: "capacity-wait-secret-sentinel",
    });
    const request = () => new Request(mode === "identity"
      ? "http://app.example.test/.well-known/openid-configuration"
      : "http://app.example.test/api/v1/workspaces");
    const warnings: string[] = [];
    const warnSpy = spyOn(console, "warn").mockImplementation((value) => {
      if (typeof value === "string") warnings.push(value);
    });
    jest.useFakeTimers();
    let virtualNowMs = 0;
    const nowSpy = spyOn(performance, "now").mockImplementation(() => virtualNowMs);
    const advanceTime = (ms: number) => {
      virtualNowMs += ms;
      jest.advanceTimersByTime(ms);
    };
    try {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const response = worker.fetch(request(), workerEnv);
        await flushMicrotasks();
        advanceTime(5_000);
        await flushMicrotasks();
        expect((await response).status).toBe(503);
        advanceTime(30_000);
      }
      const waiting = Array.from({ length: 32 }, () => worker.fetch(request(), workerEnv));
      const overflow = await worker.fetch(request(), workerEnv);
      expect(overflow.status).toBe(503);
      expect(overflow.headers.get("retry-after")).toBe("1");
      expect(overflow.headers.get("cache-control")).toBe("no-store");
      expect(overflow.headers.get("server-timing")).toBe("tk_accounts_init;dur=0.0");
      advanceTime(4_999);
      await flushMicrotasks();
      expect(await Promise.race([
        waiting[0]!.then(() => "settled"), Promise.resolve("pending"),
      ])).toBe("pending");
      expect(delayedDb.schemaReadCount).toBe(4);
      delayedDb.releaseSchemaRead(3);
      expect((await Promise.all(waiting)).map((response) => response.status))
        .toEqual(Array(32).fill(mode === "identity" ? 200 : 401));
      // Success clears every waiter deadline, and the cached handler stays usable.
      advanceTime(1);
      await flushMicrotasks();
      expect((await worker.fetch(request(), workerEnv)).status).toBe(mode === "identity" ? 200 : 401);
      const capacity = warnings.map((warning) => JSON.parse(warning))
        .filter((warning) => warning.stage === "abandonment_capacity");
      expect(capacity.filter((warning) => warning.outcome === "waiting")).toHaveLength(32);
      expect(capacity.filter((warning) => warning.outcome === "waiter_capacity")).toHaveLength(1);
      expect(capacity.filter((warning) => warning.outcome === "fulfilled")).toHaveLength(32);
      expect(capacity.filter((warning) => warning.outcome === "timeout")).toEqual([]);
      expect(capacity.every((warning) => warning.mode === mode && warning.count === 1)).toBe(true);
      expect(JSON.stringify(capacity)).not.toContain("capacity-wait-secret-sentinel");
      expect(JSON.stringify(capacity)).not.toContain("app.example.test");
      expect(delayedDb.writeCount).toBe(0);
      jest.useRealTimers();
      for (let attempt = 0; attempt < 3; attempt += 1) delayedDb.releaseSchemaRead(attempt);
      for (let attempt = 0; attempt < 100 && warnings.filter((warning) =>
        warning.includes('"event":"accounts_handler_abandoned_initialization_settled"'),
      ).length < 3; attempt += 1) {
        await flushMicrotasks();
        await Bun.sleep(1);
      }
      expect(warnings.filter((warning) =>
        warning.includes('"event":"accounts_handler_abandoned_initialization_settled"'),
      )).toHaveLength(3);
    } finally {
      jest.useRealTimers();
      nowSpy.mockRestore();
      warnSpy.mockRestore();
    }
  },
);

test("Accounts initialization caps abandoned attempts and recovers after obsolete outcomes", async () => {
  for (const lateOutcome of ["fulfilled", "rejected"] as const) {
    const delayedDb = new PendingAccountsSchemaReadD1(
      await versionedAccountsDb(),
    );
    const worker = createCloudflareWorker();
    const workerEnv = env({
      TAKOSUMI_ACCOUNTS_DB: delayedDb,
      TAKOSUMI_ACCOUNTS_D1_SCHEMA_MODE: "predeployed",
      TAKOSUMI_ACCOUNTS_ISSUER: "http://app.example.test",
      TAKOSUMI_ACCOUNT_SESSION_HASH_SALT: "accounts-abandoned-cap-test-salt",
    });
    const request = () =>
      new Request("http://app.example.test/api/v1/workspaces");
    const warnings: string[] = [];
    const flushUntil = async (predicate: () => boolean): Promise<void> => {
      for (let attempt = 0; attempt < 100 && !predicate(); attempt += 1) {
        await flushMicrotasks();
        await Bun.sleep(1);
      }
    };
    const warnSpy = spyOn(console, "warn").mockImplementation((value) => {
      if (typeof value === "string") warnings.push(value);
    });
    jest.useFakeTimers();
    let virtualNowMs = 0;
    const performanceNowSpy = spyOn(performance, "now").mockImplementation(
      () => virtualNowMs,
    );
    const advanceTime = (durationMs: number): void => {
      virtualNowMs += durationMs;
      jest.advanceTimersByTime(durationMs);
    };
    try {
      const first = worker.fetch(request(), workerEnv);
      await flushMicrotasks();
      advanceTime(5_000);
      await flushMicrotasks();
      expect((await first).status).toBe(503);

      // Three expired attempts are displaced over successive 30s windows.
      // The fourth remains the current initializer while the cap is full.
      for (let replacement = 1; replacement <= 3; replacement += 1) {
        advanceTime(30_000);
        const concurrentPromise = Promise.all(
          Array.from({ length: 12 }, () => worker.fetch(request(), workerEnv)),
        );
        advanceTime(5_000);
        await flushMicrotasks();
        const concurrent = await concurrentPromise;
        expect(concurrent.map((response) => response.status)).toEqual(
          Array(12).fill(503),
        );
        expect(delayedDb.schemaReadCount).toBe(replacement + 1);
      }

      const capacityWaitUntilPromises: Promise<unknown>[] = [];
      const capacityContext = {
        waitUntil(promise: Promise<unknown>): void {
          expect(this).toBe(capacityContext);
          capacityWaitUntilPromises.push(promise);
        },
      };
      advanceTime(30_000);
      const saturatedPromise = Promise.all(
        Array.from({ length: 12 }, () =>
          worker.fetch(request(), workerEnv, capacityContext),
        ),
      );
      advanceTime(4_999);
      await flushMicrotasks();
      expect(await Promise.race([
        saturatedPromise.then(() => "settled"),
        Promise.resolve("pending"),
      ])).toBe("pending");
      advanceTime(1);
      await flushMicrotasks();
      const saturated = await saturatedPromise;
      expect(saturated.map((response) => response.status)).toEqual(
        Array(12).fill(503),
      );
      expect(await saturated[0]?.json()).toEqual({
        error: "accounts_handler_initialization_unavailable",
        error_description: "Accounts is temporarily unavailable.",
      });
      expect(saturated[0]?.headers.get("cache-control")).toBe("no-store");
      expect(saturated[0]?.headers.get("retry-after")).toBe("1");
      expect(saturated[0]?.headers.get("server-timing")).toBe(
        "tk_accounts_init;dur=5000.0",
      );
      expect(capacityWaitUntilPromises).toHaveLength(12);
      expect(capacityWaitUntilPromises.every((promise) =>
        promise === capacityWaitUntilPromises[0],
      )).toBe(true);
      expect(
        warnings.filter((warning) =>
          warning.includes('"stage":"abandonment_capacity"'),
        ),
      ).toHaveLength(24);
      expect(warnings.filter((warning) =>
        warning.includes('"stage":"abandonment_capacity"') &&
        warning.includes('"outcome":"timeout"'),
      )).toHaveLength(12);
      expect(delayedDb.schemaReadCount).toBe(4);
      expect(
        warnings
          .filter((warning) =>
            warning.includes('"event":"accounts_handler_initialization_abandoned"'),
          )
          .map((warning) => JSON.parse(warning).abandonedInits),
      ).toEqual([1, 2, 3]);
      expect(
        warnings
          .filter((warning) =>
            warning.includes('"event":"accounts_handler_initialization_abandoned"'),
          )
          .map((warning) => JSON.parse(warning).abandonedInitsTotal),
      ).toEqual([1, 2, 3]);
      expect(
        warnings.some((warning) =>
          warning.includes('"event":"accounts_handler_initialization_unavailable"') &&
          warning.includes('"stage":"abandonment_capacity"') &&
          warning.includes('"abandonedInits":3'),
        ),
      ).toBe(true);
      jest.useRealTimers();
      // Settling any obsolete attempt returns a slot, regardless of outcome.
      if (lateOutcome === "fulfilled") delayedDb.releaseSchemaRead(0);
      else delayedDb.rejectSchemaRead(new Error("obsolete schema failure"), 0);
      await flushUntil(() =>
        warnings.some((warning) =>
          warning.includes('"event":"accounts_handler_abandoned_initialization_settled"'),
        ),
      );
      expect(
        warnings
          .filter((warning) =>
            warning.includes('"event":"accounts_handler_abandoned_initialization_settled"'),
          )
          .map((warning) => JSON.parse(warning).abandonedInits),
      ).toEqual([2]);

      // The slot freed by the obsolete settlement permits exactly one new
      // single-flight initializer while other expired work remains pending.
      const recoveryWaitUntilPromises: Promise<unknown>[] = [];
      const recoveryContext = {
        waitUntil(promise: Promise<unknown>): void {
          recoveryWaitUntilPromises.push(promise);
        },
      };
      const recoveryPromises = Array.from({ length: 12 }, () =>
        worker.fetch(request(), workerEnv, recoveryContext),
      );
      await flushUntil(() => delayedDb.schemaReadCount === 5);
      expect(delayedDb.schemaReadCount).toBe(5);
      expect(recoveryWaitUntilPromises).toHaveLength(12);
      expect(recoveryWaitUntilPromises.every((promise) =>
        promise === recoveryWaitUntilPromises[0],
      )).toBe(true);

      // Another obsolete settlement must not resolve callers on the current
      // flight or publish its handler into the cache.
      if (lateOutcome === "fulfilled") delayedDb.releaseSchemaRead(1);
      else delayedDb.rejectSchemaRead(new Error("another obsolete failure"), 1);
      await flushUntil(() =>
        warnings.filter((warning) =>
          warning.includes('"event":"accounts_handler_abandoned_initialization_settled"'),
        ).length >= 2,
      );
      expect(
        await Promise.race([
          recoveryPromises[0].then(() => "settled"),
          Promise.resolve("pending"),
        ]),
      ).toBe("pending");
      delayedDb.releaseSchemaRead(4);
      expect((await Promise.all(recoveryPromises)).map((response) => response.status)).toEqual(
        Array(12).fill(401),
      );
      expect((await worker.fetch(request(), workerEnv)).status).toBe(401);
      delayedDb.releaseSchemaRead(2);
      delayedDb.releaseSchemaRead(3);
      await flushUntil(() =>
        warnings.filter((warning) =>
          warning.includes('"event":"accounts_handler_abandoned_initialization_settled"'),
        ).length >= 4,
      );
      expect(
        warnings
          .filter((warning) =>
            warning.includes('"event":"accounts_handler_abandoned_initialization_settled"'),
          )
          .map((warning) => JSON.parse(warning).abandonedInits),
      ).toEqual([2, 2, 1, 0]);
      expect(
        warnings
          .filter((warning) =>
            warning.includes('"event":"accounts_handler_abandoned_initialization_settled"'),
          )
          .map((warning) => JSON.parse(warning).abandonedInitsTotal),
      ).toEqual([3, 4, 4, 4]);
      expect(
        warnings.every((warning) =>
          !warning.includes("accounts-abandoned-cap-test-salt") &&
          !warning.includes("app.example.test") &&
          !warning.includes("obsolete schema failure"),
        ),
      ).toBe(true);
    } finally {
      jest.useRealTimers();
      performanceNowSpy.mockRestore();
      warnSpy.mockRestore();
    }
  }
});

test("current Accounts initialization recovers while abandoned-attempt capacity is full", async () => {
  const delayedDb = new PendingAccountsSchemaReadD1(
    await versionedAccountsDb(),
  );
  const worker = createCloudflareWorker();
  const workerEnv = env({
    TAKOSUMI_ACCOUNTS_DB: delayedDb,
    TAKOSUMI_ACCOUNTS_D1_SCHEMA_MODE: "predeployed",
    TAKOSUMI_ACCOUNTS_ISSUER: "http://app.example.test",
    TAKOSUMI_ACCOUNT_SESSION_HASH_SALT: "accounts-current-cap-test-salt",
  });
  const request = () =>
    new Request("http://app.example.test/api/v1/workspaces");
  const warnings: string[] = [];
  const warnSpy = spyOn(console, "warn").mockImplementation((value) => {
    if (typeof value === "string") warnings.push(value);
  });
  jest.useFakeTimers();
  let virtualNowMs = 0;
  const performanceNowSpy = spyOn(performance, "now").mockImplementation(
    () => virtualNowMs,
  );
  const advanceTime = (durationMs: number): void => {
    virtualNowMs += durationMs;
    jest.advanceTimersByTime(durationMs);
  };
  try {
    const first = worker.fetch(request(), workerEnv);
    await flushMicrotasks();
    advanceTime(5_000);
    expect((await first).status).toBe(503);
    for (let replacement = 1; replacement <= 3; replacement += 1) {
      advanceTime(30_000);
      const pending = worker.fetch(request(), workerEnv);
      advanceTime(5_000);
      expect((await pending).status).toBe(503);
      expect(delayedDb.schemaReadCount).toBe(replacement + 1);
    }

    advanceTime(30_000);
    const saturationTasks: Promise<unknown>[] = [];
    const context = {
      waitUntil(promise: Promise<unknown>): void {
        saturationTasks.push(promise);
      },
    };
    const refusedPromise = worker.fetch(request(), workerEnv, context);
    advanceTime(5_000);
    const refused = await refusedPromise;
    expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual({
      error: "accounts_handler_initialization_unavailable",
      error_description: "Accounts is temporarily unavailable.",
    });
    expect(refused.headers.get("server-timing")).toBe(
      "tk_accounts_init;dur=5000.0",
    );
    expect(saturationTasks).toHaveLength(1);
    expect(delayedDb.schemaReadCount).toBe(4);
    expect(
      warnings.some((warning) =>
        warning.includes('"stage":"abandonment_capacity"') &&
        warning.includes('"abandonedInits":3') &&
        warning.includes('"abandonedInitsTotal":3'),
      ),
    ).toBe(true);

    jest.useRealTimers();
    delayedDb.releaseSchemaRead(3);
    await saturationTasks[0];
    expect((await worker.fetch(request(), workerEnv)).status).toBe(401);
    expect(delayedDb.schemaReadCount).toBe(4);

    delayedDb.releaseSchemaRead(0);
    delayedDb.releaseSchemaRead(1);
    delayedDb.releaseSchemaRead(2);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await flushMicrotasks();
      if (
        warnings.filter((warning) =>
          warning.includes('"event":"accounts_handler_abandoned_initialization_settled"'),
        ).length === 3
      ) {
        break;
      }
      await Bun.sleep(1);
    }
    expect(
      warnings
        .filter((warning) =>
          warning.includes('"event":"accounts_handler_abandoned_initialization_settled"'),
        )
        .map((warning) => JSON.parse(warning).abandonedInits),
    ).toEqual([2, 1, 0]);
  } finally {
    jest.useRealTimers();
    performanceNowSpy.mockRestore();
    warnSpy.mockRestore();
  }
});

for (const mode of ["identity", "control"] as const) {
  const pathname =
    mode === "identity"
      ? "/.well-known/openid-configuration"
      : "/api/v1/workspaces";
  const readyStatus = mode === "identity" ? 200 : 401;
  for (const lateOutcome of ["fulfilled", "rejected"] as const) {
    test(`Accounts ${mode} initialization replaces an expired attempt once and ignores late ${lateOutcome}`, async () => {
      const delayedDb = new PendingAccountsSchemaReadD1(
        await versionedAccountsDb(),
      );
      const worker = createCloudflareWorker();
      const workerEnv = env({
        TAKOSUMI_ACCOUNTS_DB: delayedDb,
        TAKOSUMI_ACCOUNTS_D1_SCHEMA_MODE: "predeployed",
        TAKOSUMI_ACCOUNTS_ISSUER: "http://app.example.test",
        TAKOSUMI_ACCOUNT_SESSION_HASH_SALT: "accounts-expired-attempt-test-salt",
      });
      const request = () => new Request(`http://app.example.test${pathname}`);
      const warnings: string[] = [];
      const warnSpy = spyOn(console, "warn").mockImplementation((value) => {
        if (typeof value === "string") warnings.push(value);
      });
      const unhandled: unknown[] = [];
      const onUnhandled = (error: unknown) => unhandled.push(error);
      process.on("unhandledRejection", onUnhandled);
      jest.useFakeTimers();
      try {
        const first = worker.fetch(request(), workerEnv);
        await flushMicrotasks();
        jest.advanceTimersByTime(5_000);
        await flushMicrotasks();
        expect((await first).status).toBe(503);
        jest.advanceTimersByTime(24_999);
        const oldWaiter = worker.fetch(request(), workerEnv);
        await flushMicrotasks();
        expect(delayedDb.schemaReadCount).toBe(1);

        jest.advanceTimersByTime(1);
        const retries = Array.from({ length: 12 }, () =>
          worker.fetch(request(), workerEnv),
        );
        await flushMicrotasks();
        expect(delayedDb.schemaReadCount).toBe(2);

        if (lateOutcome === "fulfilled") delayedDb.releaseSchemaRead();
        else delayedDb.rejectSchemaRead(new Error("obsolete schema failure"));
        await flushMicrotasks();
        // An obsolete initializer cannot dispatch its waiter or settle the new flight.
        for (const response of [oldWaiter, ...retries]) {
          expect(
            await Promise.race([
              response.then(() => "settled"),
              Promise.resolve("pending"),
            ]),
          ).toBe("pending");
        }

        delayedDb.releaseSchemaRead(1);
        await flushMicrotasks();
        expect(
          (await Promise.all(retries)).map((response) => response.status),
        ).toEqual(Array(12).fill(readyStatus));
        jest.advanceTimersByTime(4_999);
        await flushMicrotasks();
        expect((await oldWaiter).status).toBe(503);
        jest.advanceTimersByTime(30_000);
        await flushMicrotasks();
        expect((await worker.fetch(request(), workerEnv)).status).toBe(
          readyStatus,
        );
        expect(delayedDb.schemaReadCount).toBe(2);
        expect(delayedDb.writeCount).toBe(0);
        expect(
          warnings.filter((warning) =>
            warning.includes('"event":"accounts_handler_initialization_unavailable"'),
          ),
        ).toHaveLength(2);
        expect(unhandled).toEqual([]);
      } finally {
        jest.useRealTimers();
        warnSpy.mockRestore();
        process.off("unhandledRejection", onUnhandled);
      }
    });
  }

  test(`Accounts ${mode} initialization retries a rejection after backoff with one shared attempt`, async () => {
    const delayedDb = new PendingAccountsSchemaReadD1(
      await versionedAccountsDb(),
    );
    const worker = createCloudflareWorker();
    const workerEnv = env({
      TAKOSUMI_ACCOUNTS_DB: delayedDb,
      TAKOSUMI_ACCOUNTS_D1_SCHEMA_MODE: "predeployed",
      TAKOSUMI_ACCOUNTS_ISSUER: "http://app.example.test",
      TAKOSUMI_ACCOUNT_SESSION_HASH_SALT: "accounts-rejected-attempt-test-salt",
    });
    const request = () => new Request(`http://app.example.test${pathname}`);
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    jest.useFakeTimers();
    try {
      const first = worker.fetch(request(), workerEnv);
      await flushMicrotasks();
      delayedDb.rejectSchemaRead(new Error("temporary schema failure"));
      await flushMicrotasks();
      expect((await first).status).toBe(500);
      jest.advanceTimersByTime(999);
      const duringBackoff = await Promise.all(
        Array.from({ length: 12 }, () => worker.fetch(request(), workerEnv)),
      );
      expect(duringBackoff.map((response) => response.status)).toEqual(
        Array(12).fill(500),
      );
      expect(delayedDb.schemaReadCount).toBe(1);

      jest.advanceTimersByTime(1);
      const retries = Array.from({ length: 12 }, () =>
        worker.fetch(request(), workerEnv),
      );
      await flushMicrotasks();
      expect(delayedDb.schemaReadCount).toBe(2);
      delayedDb.releaseSchemaRead(1);
      await flushMicrotasks();
      expect(
        (await Promise.all(retries)).map((response) => response.status),
      ).toEqual(Array(12).fill(readyStatus));
      jest.advanceTimersByTime(30_000);
      await flushMicrotasks();
      expect((await worker.fetch(request(), workerEnv)).status).toBe(readyStatus);
      expect(delayedDb.schemaReadCount).toBe(2);
      expect(delayedDb.writeCount).toBe(0);
    } finally {
      jest.useRealTimers();
      warnSpy.mockRestore();
    }
  });
}

for (const route of ["identity", "extension-session"] as const) {
  test(`platform ${route} keeps the shared Accounts initializer in waitUntil after request deadlines`, async () => {
    const delayedDb = new PendingAccountsSchemaReadD1(await versionedAccountsDb());
    const unexpectedBindingIo = (): never => {
      throw new Error("Accounts init fixture must not access R2 or coordination transport");
    };
    const workerEnv = {
      R2_ARTIFACTS: {
        get: unexpectedBindingIo, put: unexpectedBindingIo, head: unexpectedBindingIo,
        list: unexpectedBindingIo, delete: unexpectedBindingIo,
      },
      R2_BACKUPS: {
        get: unexpectedBindingIo, put: unexpectedBindingIo, head: unexpectedBindingIo,
        list: unexpectedBindingIo, delete: unexpectedBindingIo,
      },
      COORDINATION: {
        idFromName: (name: string) => name,
        get: () => ({ fetch: unexpectedBindingIo }),
      },
      TAKOSUMI_ACCOUNTS_DB: delayedDb,
      TAKOSUMI_CONTROL_DB: new SqliteFakeD1(),
      TAKOSUMI_ACCOUNTS_D1_SCHEMA_MODE: "predeployed",
      TAKOSUMI_ACCOUNTS_ISSUER: "http://app.example.test",
      TAKOSUMI_ACCOUNT_SESSION_HASH_SALT: "accounts-background-init-test-salt",
      TAKOSUMI_PLATFORM_EXTENSIONS: JSON.stringify([{
        basePath: "/extensions/init-retry",
        handlerKey: "INIT_RETRY_EXTENSION",
      }]),
      INIT_RETRY_EXTENSION: {
        fetch(): Response {
          throw new Error("an unauthenticated request must not dispatch");
        },
      },
    } satisfies Parameters<typeof platformWorker.fetch>[1];
    const isIdentity = route === "identity";
    const request = () =>
      new Request(
        isIdentity
          ? "http://app.example.test/.well-known/openid-configuration"
          : "http://app.example.test/extensions/init-retry",
        isIdentity ? undefined : {
          headers: { "x-takosumi-account-session": "missing-test-session" },
        },
      );
    const tasks: Promise<unknown>[] = [];
    const context = {
      waitUntil(promise: Promise<unknown>): void {
        expect(this).toBe(context);
        tasks.push(promise);
      },
    };
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    jest.useFakeTimers();
    try {
      const first = platformWorker.fetch(request(), workerEnv, context);
      const second = platformWorker.fetch(request(), workerEnv, context);
      await flushMicrotasks();
      expect(tasks).toHaveLength(2);
      expect(tasks[0]).toBe(tasks[1]);
      expect(delayedDb.schemaReadCount).toBe(1);
      jest.advanceTimersByTime(5_000);
      await flushMicrotasks();
      expect((await first).status).toBe(isIdentity ? 503 : 401);
      expect((await second).status).toBe(isIdentity ? 503 : 401);
      expect(
        await Promise.race([
          tasks[0].then(() => "settled"),
          Promise.resolve("pending"),
        ]),
      ).toBe("pending");

      delayedDb.releaseSchemaRead();
      await tasks[0];
      jest.advanceTimersByTime(5_000);
      expect(
        (await platformWorker.fetch(request(), workerEnv, context)).status,
      ).toBe(isIdentity ? 200 : 401);
      expect(tasks).toHaveLength(2);
      expect(delayedDb.schemaReadCount).toBe(1);
      expect(delayedDb.writeCount).toBe(0);
    } finally {
      jest.useRealTimers();
      warnSpy.mockRestore();
    }
  });
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

class NoDdlD1Database implements D1Database {
  execCount = 0;

  constructor(private readonly delegate: D1Database) {}

  prepare(query: string): D1PreparedStatement {
    return this.delegate.prepare(query);
  }

  batch<T = unknown>(
    statements: readonly D1PreparedStatement[],
  ): Promise<readonly D1Result<T>[]> {
    return this.delegate.batch<T>(statements);
  }

  exec(_query: string): Promise<D1ExecResult> {
    this.execCount += 1;
    return Promise.reject(new Error("request-time schema DDL is forbidden"));
  }
}

class PendingAccountsSchemaReadD1 implements D1Database {
  schemaReadCount = 0;
  writeCount = 0;
  private readonly statements = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  private readonly schemaReads: Array<{
    promise: Promise<void>;
    release: () => void;
    reject: (error: Error) => void;
  }> = [];

  constructor(private readonly delegate: D1Database) {}

  releaseSchemaRead(index = 0): void {
    this.schemaReads[index]?.release();
  }

  rejectSchemaRead(error: Error, index = 0): void {
    this.schemaReads[index]?.reject(error);
  }

  prepare(query: string): D1PreparedStatement {
    return this.wrapStatement(
      this.delegate.prepare(query),
      query.includes("FROM sqlite_master"),
    );
  }

  private wrapStatement(
    bound: D1PreparedStatement,
    waitForSchema = false,
  ): D1PreparedStatement {
    const statement: D1PreparedStatement = {
      bind: (...values) =>
        this.wrapStatement(bound.bind(...values), waitForSchema),
      run: () => {
        this.writeCount += 1;
        return bound.run();
      },
      first: <T>(column?: string) => bound.first<T>(column),
      all: async <T>() => {
        if (waitForSchema) {
          this.schemaReadCount += 1;
          let release!: () => void;
          let reject!: (error: Error) => void;
          const promise = new Promise<void>((resolve, rejectRead) => {
            release = resolve;
            reject = rejectRead;
          });
          this.schemaReads.push({ promise, release, reject });
          await promise;
        }
        return await bound.all<T>();
      },
      raw: () => bound.raw?.() ?? Promise.resolve([]),
    };
    this.statements.set(statement, bound);
    return statement;
  }

  async batch<T = unknown>(statements: readonly D1PreparedStatement[]): Promise<readonly D1Result<T>[]> {
    this.writeCount += 1;
    const originals = statements.map((statement) => {
      const original = this.statements.get(statement);
      if (!original) throw new TypeError("Accounts counting batch requires its own prepared statements");
      return original;
    });
    return await this.delegate.batch<T>(originals);
  }

  exec(query: string): Promise<D1ExecResult> {
    this.writeCount += 1;
    return this.delegate.exec(query);
  }
}


const PLAN_RUN_SELECT = /\bfrom\s+(?:(?:"[^"]+"|[A-Za-z_][\w]*)\s*\.\s*)?(?:"runs"|runs)(?=\s|$)/iu;
const WORKSPACE_SELECT = /\bfrom\s+(?:(?:"[^"]+"|[A-Za-z_][\w]*)\s*\.\s*)?(?:"workspaces"|workspaces)(?=\s|$)/iu;
const WORKSPACE_MEMBER_SELECT = /\bfrom\s+(?:(?:"[^"]+"|[A-Za-z_][\w]*)\s*\.\s*)?(?:"workspace_members"|workspace_members)(?=\s|$)/iu;
type PendingControlReadKind = "planRun" | "workspace" | "member";
interface PendingControlReadGate {
  readonly started: Promise<void>;
  readonly completed: Promise<void>;
  readonly waiting: Promise<void>;
  readonly signalStarted: () => void;
  readonly signalCompleted: () => void;
  readonly markConsumed: () => void;
  readonly release: () => void;
  readonly reject: (error: unknown) => void;
}
interface PausedControlRead {
  readonly started: Promise<void>;
  readonly completed: Promise<void>;
  readonly release: () => void;
  readonly reject: (error: unknown) => void;
}

class CountingAccountsD1 implements D1Database {
  writeCount = 0;
  pausedReadSql: string | undefined;
  pausedReadBucket: unknown;
  private readonly statements = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  private nextReadResult: (PausedControlRead & {
    readsBeforeGate: number;
    readonly waiting: Promise<void>;
    readonly signalStarted: () => void;
    readonly signalCompleted: () => void;
  }) | undefined;

  constructor(private readonly delegate: D1Database) {}

  pauseNextReadResult(readsBeforeGate = 0): PausedControlRead {
    if (this.nextReadResult) throw new Error("Accounts read result gate is already armed");
    if (!Number.isSafeInteger(readsBeforeGate) || readsBeforeGate < 0) throw new Error("invalid Accounts read offset");
    let signalStarted!: () => void;
    let signalCompleted!: () => void;
    let release!: () => void;
    let reject!: (error: unknown) => void;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const completed = new Promise<void>((resolve) => { signalCompleted = resolve; });
    const waiting = new Promise<void>((resolve, rejectRead) => {
      release = resolve;
      reject = rejectRead;
    });
    const gate = { started, completed, waiting, signalStarted, signalCompleted, release, reject, readsBeforeGate };
    this.nextReadResult = gate;
    return gate;
  }

  prepare(query: string): D1PreparedStatement {
    return this.wrap(this.delegate.prepare(query), query);
  }

  private wrap(bound: D1PreparedStatement, query: string, values: readonly unknown[] = []): D1PreparedStatement {
    const statement: D1PreparedStatement = {
      bind: (...values) => this.wrap(bound.bind(...values), query, values),
      run: () => {
        this.writeCount += 1;
        return bound.run();
      },
      first: <T>(column?: string) => this.readResult(query, values, () => bound.first<T>(column)),
      all: <T>() => this.readResult(query, values, () => bound.all<T>()),
      raw: () => bound.raw?.() ?? Promise.resolve([]),
    };
    this.statements.set(statement, bound);
    return statement;
  }

  private async readResult<T>(query: string, values: readonly unknown[], read: () => Promise<T>): Promise<T> {
    let gate = this.nextReadResult;
    if (gate && gate.readsBeforeGate > 0) {
      gate.readsBeforeGate -= 1;
      gate = undefined;
    } else {
      this.nextReadResult = undefined;
    }
    try {
      // Execute the real SELECT first; hold only its transport result.
      // The write counters and underlying SQLite effects remain unchanged.
      const result = await read();
      if (gate) {
        this.pausedReadSql = query;
        this.pausedReadBucket = values[0];
        gate.signalStarted();
        await gate.waiting;
      }
      return result;
    } finally {
      gate?.signalCompleted();
    }
  }

  async batch<T = unknown>(statements: readonly D1PreparedStatement[]): Promise<readonly D1Result<T>[]> {
    this.writeCount += 1;
    const originals = statements.map((statement) => {
      const original = this.statements.get(statement);
      if (!original) throw new TypeError("Accounts counting batch requires its own prepared statements");
      return original;
    });
    return await this.delegate.batch<T>(originals);
  }

  exec(query: string): Promise<D1ExecResult> {
    this.writeCount += 1;
    return this.delegate.exec(query);
  }
}


class PendingPlanRunReadD1 implements ControlD1Database {
  planRunReadCount = 0;
  workspaceReadCount = 0;
  memberReadCount = 0;
  writeCount = 0;
  private readonly nextGates = new Map<PendingControlReadKind, PendingControlReadGate>();

  constructor(private readonly delegate: SqliteFakeD1) {}

  pauseNextPlanRunRead(): PausedControlRead {
    return this.pauseNextRead("planRun");
  }

  pauseNextWorkspaceRead(): PausedControlRead {
    return this.pauseNextRead("workspace");
  }

  pauseNextMemberRead(): PausedControlRead {
    return this.pauseNextRead("member");
  }

  private pauseNextRead(kind: PendingControlReadKind): PausedControlRead {
    let signalStarted!: () => void;
    let signalCompleted!: () => void;
    let release!: () => void;
    let reject!: (error: unknown) => void;
    let consumed = false;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const completed = new Promise<void>((resolve) => { signalCompleted = resolve; });
    const waiting = new Promise<void>((resolve, rejectPromise) => {
      release = () => {
        resolve();
        if (!consumed) {
          if (this.nextGates.get(kind)?.completed === completed) {
            this.nextGates.delete(kind);
          }
          signalCompleted();
        }
      };
      reject = (error) => {
        rejectPromise(error);
        if (!consumed) {
          if (this.nextGates.get(kind)?.completed === completed) {
            this.nextGates.delete(kind);
          }
          signalCompleted();
        }
      };
    });
    const markConsumed = () => { consumed = true; };
    this.nextGates.set(kind, {
      started, completed, signalStarted, signalCompleted, markConsumed, waiting, release, reject,
    });
    return { started, completed, release, reject };
  }

  prepare(query: string): ControlD1PreparedStatement & { raw(): Promise<unknown[][]> } {
    const kind: PendingControlReadKind | undefined = PLAN_RUN_SELECT.test(query)
      ? "planRun"
      : WORKSPACE_MEMBER_SELECT.test(query)
        ? "member"
        : WORKSPACE_SELECT.test(query)
          ? "workspace"
          : undefined;
    return this.wrap(this.delegate.prepare(query), kind);
  }

  private wrap(bound: ControlD1PreparedStatement, kind: PendingControlReadKind | undefined): ControlD1PreparedStatement & { raw(): Promise<unknown[][]> } {
    const beforeRead = async (): Promise<(() => void) | undefined> => {
      if (!kind) return undefined;
      if (kind === "planRun") this.planRunReadCount += 1;
      if (kind === "workspace") this.workspaceReadCount += 1;
      if (kind === "member") this.memberReadCount += 1;
      const gate = this.nextGates.get(kind);
      if (!gate) return undefined;
      this.nextGates.delete(kind);
      gate.markConsumed();
      gate.signalStarted();
      try {
        await gate.waiting;
        return gate.signalCompleted;
      } catch (error) {
        gate.signalCompleted();
        throw error;
      }
    };
    return {
      bind: (...values) => this.wrap(bound.bind(...values), kind),
      run: <T>() => {
        this.writeCount += 1;
        return bound.run<T>();
      },
      first: async <T>() => {
        const completeGate = await beforeRead();
        try {
          return await bound.first<T>();
        } finally {
          completeGate?.();
        }
      },
      all: async <T>() => {
        const completeGate = await beforeRead();
        try {
          return await bound.all<T>();
        } finally {
          completeGate?.();
        }
      },
      raw: async () => {
        const completeGate = await beforeRead();
        try {
          return await sqliteRawRows(bound);
        } finally {
          completeGate?.();
        }
      },
    };
  }

  batch<T = unknown>(statements: readonly ControlD1PreparedStatement[]): Promise<readonly ControlD1Result<T>[]> {
    this.writeCount += 1;
    return this.delegate.batch<T>(statements);
  }

  exec(query: string): Promise<D1ExecResult> {
    this.writeCount += 1;
    return this.delegate.exec(query);
  }
}

test("staging request phase diagnostics locate pending Accounts initialization without changing its deadline", async () => {
  const delayedDb = new PendingAccountsSchemaReadD1(
    await versionedAccountsDb(),
  );
  const worker = createCloudflareWorker();
  const workerEnv = env({
    TAKOSUMI_ACCOUNTS_DB: delayedDb,
    TAKOSUMI_ACCOUNTS_D1_SCHEMA_MODE: "predeployed",
    TAKOSUMI_ACCOUNTS_ISSUER: "http://app.example.test",
    TAKOSUMI_ACCOUNT_SESSION_HASH_SALT: "request-phase-diagnostic-test-salt",
    TAKOSUMI_ENVIRONMENT: "staging",
    TAKOSUMI_REQUEST_PHASE_DIAGNOSTICS: "true",
  });
  const logs: string[] = [];
  const infoSpy = spyOn(console, "info").mockImplementation((value) => {
    if (typeof value === "string") logs.push(value);
  });
  const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  jest.useFakeTimers();
  try {
    const pending = worker.fetch(
      new Request(
        "http://app.example.test/api/v1/workspaces?private-query-marker=1",
        {
          headers: {
            authorization: "Bearer secret-credential-marker",
            cookie: "private-cookie-marker",
            "cf-ray": "0123456789abcdef-NRT",
            "x-takosumi-request-probe-id": "0123456789abcdef",
          },
        },
      ),
      workerEnv,
    );
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await flushMicrotasks();
    jest.advanceTimersByTime(2000);
    await flushMicrotasks();
    const rows = logs.map((line) => JSON.parse(line));
    expect(rows).toContainEqual(
      expect.objectContaining({
        event: "request_phase",
        phase: "accounts_init",
        outcome: "pending",
        route: "/api/v1/workspaces",
        cfRay: "0123456789abcdef-NRT",
        probeId: "0123456789abcdef",
      }),
    );
    expect(settled).toBe(false);
    jest.advanceTimersByTime(3000);
    await flushMicrotasks();
    expect((await pending).status).toBe(503);
    expect(logs.map((line) => JSON.parse(line))).toContainEqual(
      expect.objectContaining({ phase: "accounts_init", outcome: "rejected" }),
    );
    const count = logs.length;
    jest.advanceTimersByTime(10000);
    await flushMicrotasks();
    expect(logs).toHaveLength(count);
    const serialized = logs.join("\n");
    for (const marker of [
      "secret-credential-marker",
      "private-cookie-marker",
      "private-query-marker",
      "app.example.test",
    ]) {
      expect(serialized).not.toContain(marker);
    }
  } finally {
    delayedDb.releaseSchemaRead();
    await flushMicrotasks();
    jest.useRealTimers();
    infoSpy.mockRestore();
    warnSpy.mockRestore();
  }
});

test("platform GET Run separates an Accounts init gate from a post-init Plan read stall", async () => {
  const subject = "tsub_issue444_platform_run";
  const sessionId = "sess_issue444_platform_run";
  const sessionSalt = "issue444-platform-run-session-salt";
  const runId = "plan_issue444_platform_run";
  const now = Date.now();
  const rawAccountsDb = await versionedAccountsDb();
  const accountWriter = new D1AccountsStore(rawAccountsDb, {
    sessionHashSalt: sessionSalt,
    schemaMode: "predeployed",
  });
  await accountWriter.saveAccount({ subject, createdAt: now, updatedAt: now });
  await accountWriter.saveAccountSession({
    sessionId,
    subject,
    createdAt: now,
    expiresAt: now + 60_000,
  });
  const pat = "takpat_issue444_auth_deadline";
  const expiredSession = "sess_issue444_expired_auth_deadline";
  const hostedSession = "sess_issue444_hosted_auth_deadline";
  const disallowedSession = "sess_issue444_disallowed_auth_deadline";
  const inactiveToken = "oauth_issue444_inactive_auth_deadline";
  await accountWriter.savePersonalAccessToken(pat, {
    tokenId: "pat_issue444_auth_deadline", tokenPrefix: "takpat_issue444",
    subject, name: "local deadline fixture", scopes: ["read"],
    createdAt: now, expiresAt: now + 60_000,
  });
  await accountWriter.saveAccountSession({
    sessionId: expiredSession, subject, createdAt: now - 60_000, expiresAt: now - 1,
  });
  await accountWriter.saveAccountSession({
    sessionId: hostedSession, subject, policy: "hosted", identityGeneration: 0,
    issuerSessionId: `sha256:${"a".repeat(43)}`, authTime: Math.floor(now / 1_000),
    createdAt: now, expiresAt: now + 60_000, absoluteExpiresAt: now + 120_000,
  });
  await accountWriter.saveAccountSession({
    sessionId: disallowedSession, subject, createdAt: now, expiresAt: now + 60_000,
  });
  await accountWriter.saveAccessToken(inactiveToken, {
    clientId: "issue444-fixture-client", subject, takosumiSubject: subject,
    scope: "read", expiresAt: now - 1,
  });

  const rawControlDb = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(rawControlDb);
  // Predeployed request reads co-read the operator-maintenance singleton.
  // Seed its valid released state using the same canonical APIs as store tests.
  const maintenanceFence = await acquireControlD1MaintenanceFence(rawControlDb, {
    sourceCommit: "a".repeat(40),
    manifestDigest: `sha256:${"b".repeat(64)}`,
    environment: "test",
    databaseRole: "in_place",
    releasePolicy: "in_place",
  }, "2026-10-17T00:00:00.000Z");
  await releaseControlD1MaintenanceFence(
    rawControlDb, maintenanceFence, "2026-10-17T00:00:01.000Z",
  );
  const controlStore = new CloudflareD1OpenTofuControlStore(rawControlDb);
  const seeded = await seedCapsuleModel(controlStore, {
    workspaceId: "ws_issue444_platform_run",
    capsuleId: "cap_issue444_platform_run",
  });
  await controlStore.putWorkspaceMember({
    id: "member_issue444_platform_run",
    workspaceId: seeded.workspace.id,
    accountId: subject,
    status: "active",
    roles: ["owner"],
    createdAt: seeded.workspace.createdAt,
    updatedAt: seeded.workspace.updatedAt,
  });
  const completedPlan: PlanRun = {
    id: runId,
    workspaceId: seeded.workspace.id,
    capsuleId: seeded.capsule.id,
    source: {
      kind: "git",
      url: seeded.source.url,
      ref: seeded.source.defaultRef,
      modulePath: seeded.snapshot.path,
    },
    sourceDigest: seeded.snapshot.archiveDigest,
    operation: "update",
    runnerProfileId: "fixture-runner",
    variablesDigest: "fixture-variables-digest",
    requiredProviders: [],
    status: "succeeded",
    policy: { status: "passed", reasons: [], checkedAt: now },
    policyDecisionDigest: "fixture-policy-decision",
    auditEvents: [],
    createdAt: now,
    updatedAt: now,
    startedAt: now - 1,
    finishedAt: now,
    sourceSnapshotId: seeded.snapshot.id,
  };
  await controlStore.putPlanRun(completedPlan);

  const accountDb = new CountingAccountsD1(rawAccountsDb);
  const controlDb = new PendingPlanRunReadD1(rawControlDb);
  // Match the existing HTTPS worker fixtures: one synthetic signing key is
  // shared by both local envs; the production HTTPS signing guard stays active.
  const oidcKeyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const oidcPrivateJwk = await crypto.subtle.exportKey("jwk", oidcKeyPair.privateKey);
  let bindingIoCount = 0;
  const unexpectedBindingIo = (): never => {
    bindingIoCount += 1;
    throw new Error("completed Run reads must not access R2 or coordination transport");
  };
  const baseBindings = {
    TAKOSUMI_ACCOUNTS_DB: accountDb,
    R2_ARTIFACTS: {
      get: unexpectedBindingIo, put: unexpectedBindingIo, head: unexpectedBindingIo,
      list: unexpectedBindingIo, delete: unexpectedBindingIo,
    },
    R2_BACKUPS: {
      get: unexpectedBindingIo, put: unexpectedBindingIo, head: unexpectedBindingIo,
      list: unexpectedBindingIo, delete: unexpectedBindingIo,
    },
    COORDINATION: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: unexpectedBindingIo }),
    },
    TAKOSUMI_CONTROL_DB: controlDb,
    TAKOSUMI_CONTROL_D1_SCHEMA_MODE: "predeployed",
    TAKOSUMI_ACCOUNTS_D1_SCHEMA_MODE: "predeployed",
    TAKOSUMI_ACCOUNTS_ISSUER: "https://app.example.test",
    TAKOSUMI_ACCOUNT_SESSION_HASH_SALT: sessionSalt,
    TAKOSUMI_ACCOUNTS_ES256_PRIVATE_JWK: JSON.stringify(oidcPrivateJwk),
    TAKOSUMI_ACCOUNTS_ES256_KEY_ID: "issue444-platform-run-test-key",
    TAKOSUMI_ACCOUNTS_OIDC_PAIRWISE_SUBJECT_SECRET:
      "issue444-platform-run-test-pairwise-secret",
    TAKOSUMI_SECRET_STORE_KEY: "issue444-platform-run-test-storage-encryption-key",
    TAKOSUMI_DEPLOY_CONTROL_TOKEN: "issue444-platform-run-test-operator-token",
    TAKOSUMI_ENVIRONMENT: "staging",
    TAKOSUMI_REQUEST_PHASE_DIAGNOSTICS: "true",
  } satisfies Parameters<typeof platformWorker.fetch>[1];
  const request = (probeId: string) => new Request(
    `https://app.example.test/api/v1/runs/${runId}`,
    {
      method: "GET",
      headers: {
        origin: "https://app.example.test",
        "x-takosumi-account-session": sessionId,
        "x-takosumi-request-probe-id": probeId,
      },
    },
  );
  const phaseRows: Record<string, unknown>[] = [];
  const infoSpy = spyOn(console, "info").mockImplementation((value) => {
    if (typeof value !== "string") return;
    try {
      const row = JSON.parse(value) as Record<string, unknown>;
      if (row.event === "request_phase") phaseRows.push(row);
    } catch {
      // Retain only the fixed-vocabulary phase records in memory.
    }
  });
  const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  const rowsFor = (probeId: string) => phaseRows
    .filter((row) => row.probeId === probeId);
  const outcomesFor = (probeId: string, phase: string) => rowsFor(probeId)
    .filter((row) => row.phase === phase)
    .map((row) => row.outcome);
  const releaseReads: Array<() => void> = [];
  const pendingReadCompletions: Array<Promise<void>> = [];
  const pendingRouteResponses: Array<Promise<Response>> = [];
  let downstreamResponsePromise: Promise<Response> | undefined;
  let downstreamSettlementObserver: Promise<void> | undefined;
  const realSetTimeout = setTimeout;
  const realClearTimeout = clearTimeout;
  const readinessCleanups: Array<() => void> = [];
  const prepareGateWait = (started: Promise<void>) => {
    // Arm while real timers are active: capturing setTimeout alone does not
    // bypass Bun's fake timer heap. This real timer also yields to native I/O.
    let realExpired = false;
    let expire: ((reached: boolean) => void) | undefined;
    const readinessExpired = new Promise<boolean>((resolve) => { expire = resolve; });
    const timer = realSetTimeout(() => {
      realExpired = true;
      expire?.(false);
    }, 1_000);
    const cleanup = (): void => {
      realClearTimeout(timer);
      expire?.(false);
    };
    readinessCleanups.push(cleanup);
    return async (pending: Promise<Response>): Promise<void> => {
      const fakeNow = Date.now();
      try {
        // Observe rejections immediately. A response before the exact storage
        // gate or a real readiness timeout is failure, never successful entry.
        const reached = await Promise.race([
          started.then(() => !realExpired),
          pending.then(() => false),
          readinessExpired,
        ]);
        expect(reached).toBe(true);
        expect(Date.now()).toBe(fakeNow);
      } finally {
        cleanup();
      }
    };
  };
  const drainLateRouteContinuation = async (gate: PausedControlRead): Promise<void> => {
    // `completed` is signaled only after the actual bound first/all/raw promise
    // settles (or after its intentional rejection). Switch to real timers for
    // one macrotask checkpoint so queued store/operation/route reactions drain;
    // the fixed fake-time deadline has already won and its timer is cleared.
    await gate.completed;
    jest.useRealTimers();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    // Leave real timers active so the next gate can arm its real readiness
    // timeout before re-enabling that request's separate fake deadline.
  };
  const realSetImmediate = setImmediate;
  const realClearImmediate = clearImmediate;
  const flushRouteResponse = async (): Promise<void> => {
    const fakeNow = Date.now();
    let immediate: ReturnType<typeof setImmediate> | undefined;
    try {
      await new Promise<void>((resolve) => { immediate = realSetImmediate(resolve); });
    } finally {
      if (immediate !== undefined) realClearImmediate(immediate);
    }
    expect(Date.now()).toBe(fakeNow);
  };
  const expectDeadlineResponse = async (
    pending: Promise<Response>,
  ): Promise<Response> => {
    let settled = false;
    const observer = pending.then(
      () => { settled = true; },
      () => { settled = true; },
    );
    jest.advanceTimersByTime(4_999);
    await flushRouteResponse();
    expect(settled).toBe(false);
    jest.advanceTimersByTime(1);
    await flushRouteResponse();
    expect(settled).toBe(true);
    const response = await pending;
    await observer;
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(expect.objectContaining({
      error: expect.objectContaining({ code: "feature_unavailable" }),
    }));
    return response;
  };
  try {
    const pendingAccountsDb = new PendingAccountsSchemaReadD1(rawAccountsDb);
    const initEnv = { ...baseBindings, TAKOSUMI_ACCOUNTS_DB: pendingAccountsDb };
    const initTasks: Promise<unknown>[] = [];
    const initContext = {
      waitUntil(promise: Promise<unknown>): void { initTasks.push(promise); },
    };
    let initResponsePromise: Promise<Response> | undefined;
    jest.useFakeTimers();
    try {
      const initProbe = "a444000000000001";
      initResponsePromise = platformWorker.fetch(request(initProbe), initEnv, initContext);
      await flushMicrotasks();
      expect(pendingAccountsDb.schemaReadCount).toBe(1);
      expect(initTasks).toHaveLength(1);
      jest.advanceTimersByTime(5_000);
      await flushMicrotasks();
      const initResponse = await initResponsePromise;
      expect(initResponse.status).toBe(503);
      expect(controlDb.planRunReadCount).toBe(0);
      expect(pendingAccountsDb.writeCount).toBe(0);
      expect(rowsFor(initProbe)).toContainEqual(expect.objectContaining({
        phase: "accounts_init", outcome: "pending", route: "/api/v1/runs/{runId}",
      }));
      expect(rowsFor(initProbe)).toContainEqual(expect.objectContaining({
        phase: "accounts_init", outcome: "rejected", route: "/api/v1/runs/{runId}",
      }));
      expect(rowsFor(initProbe)).not.toContainEqual(expect.objectContaining({
        phase: "control_dispatch", outcome: "started",
      }));
      pendingAccountsDb.releaseSchemaRead();
      await initTasks[0];
    } finally {
      pendingAccountsDb.releaseSchemaRead();
      await initResponsePromise?.catch(() => undefined);
      await Promise.all(initTasks.map((task) => task.catch(() => undefined)));
      jest.useRealTimers();
    }

    const routeEnv = { ...baseBindings, TAKOSUMI_ACCOUNTS_DB: accountDb };
    // The actual same-env service seeds its default runner profile at boot.
    // Await that canonical initialization; never reset or filter the counter.
    const initializedService = await cachedDeployControlService(routeEnv);
    const initializedProfiles = await initializedService.operations.listRunnerProfiles();
    expect(await cachedDeployControlService(routeEnv)).toBe(initializedService);
    expect(initializedProfiles.runnerProfiles).toHaveLength(1);
    const controlWritesAtPostInitStart = controlDb.writeCount;
    expect(controlWritesAtPostInitStart).toBe(1);
    expect(accountDb.writeCount).toBe(0);
    expect(bindingIoCount).toBe(0);

    const baselineProbe = "a444000000000002";
    const baselineResponse = await platformWorker.fetch(request(baselineProbe), routeEnv);
    const baselineBody = await baselineResponse.text();
    expect(baselineResponse.status, baselineBody).toBe(200);
    const baselinePlanReads = controlDb.planRunReadCount;
    const baselineAccountWrites = accountDb.writeCount;
    const baselineControlWrites = controlDb.writeCount - controlWritesAtPostInitStart;
    expect(baselinePlanReads).toBeGreaterThan(0);
    expect(baselineAccountWrites).toBe(0);
    expect(baselineControlWrites).toBe(0);
    expect(outcomesFor(baselineProbe, "run_get_read")).toContain("fulfilled");
    expect(outcomesFor(baselineProbe, "run_get_access")).toContain("fulfilled");
    expect(JSON.stringify(rowsFor(baselineProbe))).not.toContain(runId);

    // Authentication precedes Run dispatch. A held bearer lookup must use the
    // same request-local read deadline and must not resume authority work late.
    const authGate = accountDb.pauseNextReadResult();
    releaseReads.push(authGate.release);
    pendingReadCompletions.push(authGate.completed);
    const authProbe = "a444000000000008";
    const waitForAuthGate = prepareGateWait(authGate.started);
    jest.useFakeTimers();
    expect(jest.getTimerCount()).toBe(0);
    const authResponse = platformWorker.fetch(request(authProbe), routeEnv);
    pendingRouteResponses.push(authResponse);
    await waitForAuthGate(authResponse);
    expect(accountDb.pausedReadSql).toContain("presented_session as");
    expect(accountDb.pausedReadSql).toContain("select 'pat' as kind");
    const readsBeforeAuthRelease = {
      plan: controlDb.planRunReadCount,
      workspace: controlDb.workspaceReadCount,
      member: controlDb.memberReadCount,
    };
    await expectDeadlineResponse(authResponse);
    expect(rowsFor(authProbe)).toContainEqual(expect.objectContaining({
      phase: "control_auth", outcome: "pending", route: "/api/v1/runs/{runId}",
    }));
    expect(rowsFor(authProbe)).not.toContainEqual(expect.objectContaining({
      phase: "control_init", outcome: "started",
    }));
    expect(rowsFor(authProbe)).not.toContainEqual(expect.objectContaining({
      phase: "control_dispatch", outcome: "started",
    }));
    authGate.release();
    await drainLateRouteContinuation(authGate);
    expect(controlDb.planRunReadCount).toBe(readsBeforeAuthRelease.plan);
    expect(controlDb.workspaceReadCount).toBe(readsBeforeAuthRelease.workspace);
    expect(controlDb.memberReadCount).toBe(readsBeforeAuthRelease.member);
    expect(accountDb.writeCount).toBe(baselineAccountWrites);
    expect(controlDb.writeCount - controlWritesAtPostInitStart).toBe(baselineControlWrites);

    // Authentication consumes three seconds; entering Run dispatch must use
    // the remaining two seconds, never start a fresh five-second timer.
    const sharedAuthGate = accountDb.pauseNextReadResult();
    const sharedPlanGate = controlDb.pauseNextPlanRunRead();
    releaseReads.push(sharedAuthGate.release, sharedPlanGate.release);
    pendingReadCompletions.push(sharedAuthGate.completed, sharedPlanGate.completed);
    const waitForSharedAuth = prepareGateWait(sharedAuthGate.started);
    const waitForSharedPlan = prepareGateWait(sharedPlanGate.started);
    jest.useFakeTimers();
    expect(jest.getTimerCount()).toBe(0);
    const sharedStartedAt = Date.now();
    const sharedResponse = platformWorker.fetch(request("a444000000000012"), routeEnv);
    pendingRouteResponses.push(sharedResponse);
    let sharedSettled = false;
    const sharedObserver = sharedResponse.then(() => { sharedSettled = true; }, () => { sharedSettled = true; });
    await waitForSharedAuth(sharedResponse);
    jest.advanceTimersByTime(3_000);
    sharedAuthGate.release();
    await waitForSharedPlan(sharedResponse);
    expect(Date.now()).toBe(sharedStartedAt + 3_000);
    jest.advanceTimersByTime(1_999);
    await flushRouteResponse();
    expect(sharedSettled).toBe(false);
    jest.advanceTimersByTime(1);
    await flushRouteResponse();
    expect(Date.now()).toBe(sharedStartedAt + 5_000);
    expect(sharedSettled).toBe(true);
    const sharedResult = await sharedResponse;
    await sharedObserver;
    expect(sharedResult.status).toBe(503);
    expect(sharedResult.headers.get("cache-control")).toBe("no-store");
    expect(await sharedResult.json()).toEqual(expect.objectContaining({ error: expect.objectContaining({ code: "feature_unavailable" }) }));
    expect(rowsFor("a444000000000012")).toContainEqual(expect.objectContaining({ phase: "control_dispatch", outcome: "fulfilled" }));
    const memberReadsBeforeSharedRelease = controlDb.memberReadCount;
    const workspaceReadsBeforeSharedRelease = controlDb.workspaceReadCount;
    sharedPlanGate.release();
    await drainLateRouteContinuation(sharedPlanGate);
    expect(controlDb.memberReadCount).toBe(memberReadsBeforeSharedRelease);
    expect(controlDb.workspaceReadCount).toBe(workspaceReadsBeforeSharedRelease);
    expect(accountDb.writeCount).toBe(baselineAccountWrites);
    expect(controlDb.writeCount - controlWritesAtPostInitStart).toBe(baselineControlWrites);

    const downstreamProbe = "a444000000000003";
    const gate = controlDb.pauseNextPlanRunRead();
    releaseReads.push(gate.release);
    pendingReadCompletions.push(gate.completed);
    let downstreamSettled = false;
    const waitForDownstreamGate = prepareGateWait(gate.started);
    jest.useFakeTimers();
    expect(jest.getTimerCount()).toBe(0);
    downstreamResponsePromise = platformWorker.fetch(request(downstreamProbe), routeEnv);
    pendingRouteResponses.push(downstreamResponsePromise);
    downstreamSettlementObserver = downstreamResponsePromise.then(
      () => { downstreamSettled = true; },
      () => { downstreamSettled = true; },
    );
    await waitForDownstreamGate(downstreamResponsePromise);
    expect(controlDb.planRunReadCount).toBeGreaterThan(baselinePlanReads);

    // A held request owns only its local deadline. A second exact GET still
    // returns the baseline response while the first SELECT remains gated.
    const parallelProbe = "a444000000000004";
    const parallelResponse = await platformWorker.fetch(request(parallelProbe), routeEnv);
    expect(parallelResponse.status).toBe(200);
    expect(await parallelResponse.text()).toBe(baselineBody);
    expect(controlDb.writeCount - controlWritesAtPostInitStart).toBe(baselineControlWrites);
    expect(accountDb.writeCount).toBe(baselineAccountWrites);

    const workspaceReadsBeforeLateRun = controlDb.workspaceReadCount;
    const memberReadsBeforeLateRun = controlDb.memberReadCount;
    const downstreamResponse = await expectDeadlineResponse(downstreamResponsePromise);
    await downstreamSettlementObserver;
    expect(downstreamSettled).toBe(true);
    expect(rowsFor(downstreamProbe)).toContainEqual(expect.objectContaining({
      phase: "accounts_init", outcome: "fulfilled", route: "/api/v1/runs/{runId}",
    }));
    expect(rowsFor(downstreamProbe)).toContainEqual(expect.objectContaining({
      phase: "control_dispatch", outcome: "started", route: "/api/v1/runs/{runId}",
    }));
    expect(rowsFor(downstreamProbe)).toContainEqual(expect.objectContaining({
      phase: "control_dispatch", outcome: "pending", route: "/api/v1/runs/{runId}",
    }));
    expect(rowsFor(downstreamProbe)).toContainEqual(expect.objectContaining({
      phase: "control_dispatch", outcome: "fulfilled", route: "/api/v1/runs/{runId}",
    }));
    expect(outcomesFor(downstreamProbe, "run_get_read")).toEqual(["started", "pending"]);
    expect(outcomesFor(downstreamProbe, "run_get_access")).toEqual([]);
    expect(outcomesFor(downstreamProbe, "run_get_workspace")).toEqual([]);
    expect(outcomesFor(downstreamProbe, "run_get_member")).toEqual([]);
    expect(downstreamResponse.status).toBe(503);

    // Release the underlying read only after the response has settled. The
    // expired route must not start its Workspace/member checks afterward.
    gate.release();
    await drainLateRouteContinuation(gate);
    expect(outcomesFor(downstreamProbe, "run_get_read")).toContain("fulfilled");
    expect(controlDb.workspaceReadCount).toBe(workspaceReadsBeforeLateRun);
    expect(controlDb.memberReadCount).toBe(memberReadsBeforeLateRun);
    downstreamResponsePromise = undefined;
    downstreamSettlementObserver = undefined;

    const lateRejectGate = controlDb.pauseNextPlanRunRead();
    releaseReads.push(lateRejectGate.release);
    pendingReadCompletions.push(lateRejectGate.completed);
    const lateRejectProbe = "a444000000000005";
    const waitForLateRejectGate = prepareGateWait(lateRejectGate.started);
    jest.useFakeTimers();
    expect(jest.getTimerCount()).toBe(0);
    const lateRejectResponse = platformWorker.fetch(request(lateRejectProbe), routeEnv);
    pendingRouteResponses.push(lateRejectResponse);
    await waitForLateRejectGate(lateRejectResponse);
    const workspaceReadsBeforeLateReject = controlDb.workspaceReadCount;
    const memberReadsBeforeLateReject = controlDb.memberReadCount;
    await expectDeadlineResponse(lateRejectResponse);
    lateRejectGate.reject(new Error("fixture late rejection"));
    await drainLateRouteContinuation(lateRejectGate);
    expect(controlDb.workspaceReadCount).toBe(workspaceReadsBeforeLateReject);
    expect(controlDb.memberReadCount).toBe(memberReadsBeforeLateReject);

    // If Workspace loading itself finishes after the same deadline, the guard
    // after that await prevents a new member read from starting.
    const workspaceGate = controlDb.pauseNextWorkspaceRead();
    releaseReads.push(workspaceGate.release);
    pendingReadCompletions.push(workspaceGate.completed);
    const workspaceProbe = "a444000000000006";
    const waitForWorkspaceGate = prepareGateWait(workspaceGate.started);
    jest.useFakeTimers();
    expect(jest.getTimerCount()).toBe(0);
    const workspaceResponse = platformWorker.fetch(request(workspaceProbe), routeEnv);
    pendingRouteResponses.push(workspaceResponse);
    await waitForWorkspaceGate(workspaceResponse);
    const memberReadsBeforeWorkspaceRelease = controlDb.memberReadCount;
    await expectDeadlineResponse(workspaceResponse);
    expect(outcomesFor(workspaceProbe, "run_get_read")).toContain("fulfilled");
    expect(outcomesFor(workspaceProbe, "run_get_access")).toEqual(["started", "pending"]);
    expect(outcomesFor(workspaceProbe, "run_get_workspace")).toEqual(["started", "pending"]);
    expect(outcomesFor(workspaceProbe, "run_get_member")).toEqual([]);
    workspaceGate.release();
    await drainLateRouteContinuation(workspaceGate);
    expect(outcomesFor(workspaceProbe, "run_get_workspace")).toContain("fulfilled");
    expect(outcomesFor(workspaceProbe, "run_get_member")).toEqual([]);
    expect(controlDb.memberReadCount).toBe(memberReadsBeforeWorkspaceRelease);

    // If membership loading is already in flight, its late result must not
    // start further authorization reads/writes after the already returned 503.
    const memberGate = controlDb.pauseNextMemberRead();
    releaseReads.push(memberGate.release);
    pendingReadCompletions.push(memberGate.completed);
    const memberProbe = "a444000000000007";
    const waitForMemberGate = prepareGateWait(memberGate.started);
    jest.useFakeTimers();
    expect(jest.getTimerCount()).toBe(0);
    const memberResponse = platformWorker.fetch(request(memberProbe), routeEnv);
    pendingRouteResponses.push(memberResponse);
    await waitForMemberGate(memberResponse);
    const readsBeforeMemberRelease = {
      plan: controlDb.planRunReadCount,
      workspace: controlDb.workspaceReadCount,
      member: controlDb.memberReadCount,
    };
    await expectDeadlineResponse(memberResponse);
    expect(outcomesFor(memberProbe, "run_get_read")).toContain("fulfilled");
    expect(outcomesFor(memberProbe, "run_get_access")).toEqual(["started", "pending"]);
    expect(outcomesFor(memberProbe, "run_get_workspace")).toEqual(["started", "fulfilled"]);
    expect(outcomesFor(memberProbe, "run_get_member")).toEqual(["started", "pending"]);
    memberGate.release();
    await drainLateRouteContinuation(memberGate);
    expect(outcomesFor(memberProbe, "run_get_member")).toContain("fulfilled");
    expect(controlDb.planRunReadCount).toBe(readsBeforeMemberRelease.plan);
    expect(controlDb.workspaceReadCount).toBe(readsBeforeMemberRelease.workspace);
    expect(controlDb.memberReadCount).toBe(readsBeforeMemberRelease.member);
    expect(accountDb.writeCount).toBe(baselineAccountWrites);
    expect(controlDb.writeCount - controlWritesAtPostInitStart).toBe(baselineControlWrites);
    expect(bindingIoCount).toBe(0);

    // Positive native requests must retain their real PAT usage and Hosted
    // session-touch effects before testing that late auth cannot start them.
    const credentialRequest = (probeId: string, credential: string): Request => {
      const value = request(probeId);
      value.headers.delete("x-takosumi-account-session");
      value.headers.set("authorization", `Bearer ${credential}`);
      return value;
    };
    const positivePat = await platformWorker.fetch(credentialRequest("a444000000000009", pat), routeEnv);
    expect(positivePat.status).toBe(200);
    const usedPat = await accountWriter.findPersonalAccessToken(pat);
    expect(usedPat?.lastUsedAt).toBeNumber();
    const positiveHosted = await platformWorker.fetch(credentialRequest("a44400000000000a", hostedSession), routeEnv);
    expect(positiveHosted.status).toBe(200);
    const currentHosted = await accountWriter.findAccountSession(hostedSession);
    expect(currentHosted?.expiresAt).toBeGreaterThan(now + 60_000);
    expect(accountDb.writeCount).toBeGreaterThan(baselineAccountWrites);

    const totalChanges = async (): Promise<number> => {
      const row = await rawAccountsDb.prepare("SELECT total_changes() AS changes").first<{ changes: unknown }>();
      if (typeof row?.changes !== "number" || !Number.isSafeInteger(row.changes) || row.changes < 0) {
        throw new Error("missing SQLite total_changes oracle");
      }
      return row.changes;
    };
    const assertLateAuthFenced = async (input: {
      readonly probe: string;
      readonly credential: string;
      readonly readsBeforeGate?: number;
      readonly sql: string;
      readonly bucket?: string;
      readonly environment?: typeof routeEnv;
    }): Promise<void> => {
      const writesBefore = accountDb.writeCount;
      const changesBefore = await totalChanges();
      const controlBefore = {
        plan: controlDb.planRunReadCount,
        workspace: controlDb.workspaceReadCount,
        member: controlDb.memberReadCount,
        writes: controlDb.writeCount,
      };
      const held = accountDb.pauseNextReadResult(input.readsBeforeGate);
      releaseReads.push(held.release);
      pendingReadCompletions.push(held.completed);
      const waitForHeld = prepareGateWait(held.started);
      jest.useFakeTimers();
      expect(jest.getTimerCount()).toBe(0);
      const pending = platformWorker.fetch(credentialRequest(input.probe, input.credential), input.environment ?? routeEnv);
      pendingRouteResponses.push(pending);
      await waitForHeld(pending);
      expect(accountDb.pausedReadSql).toContain(input.sql);
      if (input.bucket) expect(accountDb.pausedReadBucket).toBe(input.bucket);
      await expectDeadlineResponse(pending);
      expect(jest.getTimerCount()).toBe(0);
      held.release();
      await drainLateRouteContinuation(held);
      expect(accountDb.writeCount).toBe(writesBefore);
      expect(await totalChanges()).toBe(changesBefore);
      expect(controlDb.planRunReadCount).toBe(controlBefore.plan);
      expect(controlDb.workspaceReadCount).toBe(controlBefore.workspace);
      expect(controlDb.memberReadCount).toBe(controlBefore.member);
      expect(controlDb.writeCount).toBe(controlBefore.writes);
      expect(rowsFor(input.probe)).not.toContainEqual(expect.objectContaining({ phase: "control_dispatch", outcome: "started" }));
    };
    await assertLateAuthFenced({ probe: "a44400000000000b", credential: pat, sql: "presented_session as" });
    expect(await accountWriter.findPersonalAccessToken(pat)).toEqual(usedPat);
    await assertLateAuthFenced({ probe: "a44400000000000c", credential: expiredSession, sql: "presented_session as" });
    expect(await accountWriter.findAccountSession(expiredSession)).toBeDefined();
    await assertLateAuthFenced({ probe: "a44400000000000d", credential: inactiveToken, sql: "presented_session as" });
    expect(await accountWriter.findAccessToken(inactiveToken)).toBeDefined();
    // Skip the coalesced bearer SELECT, then hold the actual nested Hosted
    // generation read. Its late result must not start touch or cleanup writes.
    await assertLateAuthFenced({ probe: "a44400000000000e", credential: hostedSession, readsBeforeGate: 1, sql: "SELECT document FROM takosumi_accounts_documents WHERE bucket = ? AND key = ?", bucket: "authentication_generations" });
    expect(await accountWriter.findAccountSession(hostedSession)).toEqual(currentHosted);

    const allowlistEnv = { ...routeEnv, TAKOSUMI_ACCOUNTS_LOGIN_EMAIL_ALLOWLIST: "only-allowed@example.test" };
    const anonymousRequest = request("a44400000000000f");
    anonymousRequest.headers.delete("x-takosumi-account-session");
    expect((await platformWorker.fetch(anonymousRequest, allowlistEnv)).status).toBe(401);
    await assertLateAuthFenced({ probe: "a444000000000010", credential: disallowedSession, sql: "presented_session as", environment: allowlistEnv });
    expect(await accountWriter.findAccountSession(disallowedSession)).toBeDefined();
    // Without a deadline stall the same policy still revokes the disallowed
    // session; the late-write fence must never disable ordinary enforcement.
    expect((await platformWorker.fetch(credentialRequest("a444000000000011", disallowedSession), allowlistEnv)).status).toBe(403);
    expect(await accountWriter.findAccountSession(disallowedSession)).toBeUndefined();
    expect(bindingIoCount).toBe(0);
  } finally {
    for (const cleanup of readinessCleanups) cleanup();
    for (const release of releaseReads) release();
    await downstreamResponsePromise?.catch(() => undefined);
    await Promise.all(pendingReadCompletions);
    await Promise.all(pendingRouteResponses.map((pending) => pending.catch(() => undefined)));
    await downstreamSettlementObserver;
    jest.useRealTimers();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await flushMicrotasks();
    infoSpy.mockRestore();
    warnSpy.mockRestore();
  }
});

for (const config of [
  { environment: "production", enabled: "true" },
  { environment: "staging", enabled: undefined },
  { environment: "staging", enabled: "false" },
]) {
  test(`request phase diagnostics emit nothing for ${config.environment}/${config.enabled ?? "unset"}`, async () => {
    const delayedDb = new PendingAccountsSchemaReadD1(
      await versionedAccountsDb(),
    );
    const worker = createCloudflareWorker();
    const workerEnv = env({
      TAKOSUMI_ACCOUNTS_DB: delayedDb,
      TAKOSUMI_ACCOUNTS_D1_SCHEMA_MODE: "predeployed",
      TAKOSUMI_ACCOUNTS_ISSUER: "http://app.example.test",
      TAKOSUMI_ACCOUNT_SESSION_HASH_SALT:
        "request-phase-diagnostic-disabled-test-salt",
      TAKOSUMI_ENVIRONMENT: config.environment,
      TAKOSUMI_REQUEST_PHASE_DIAGNOSTICS: config.enabled,
    });
    const logs: string[] = [];
    const infoSpy = spyOn(console, "info").mockImplementation((value) => {
      if (typeof value === "string") logs.push(value);
    });
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    jest.useFakeTimers();
    try {
      const pending = worker.fetch(
        new Request("http://app.example.test/api/v1/workspaces"),
        workerEnv,
      );
      await flushMicrotasks();
      jest.advanceTimersByTime(5000);
      await flushMicrotasks();
      expect((await pending).status).toBe(503);
      expect(
        logs.filter((line) => line.includes('"event":"request_phase"')),
      ).toHaveLength(0);
    } finally {
      delayedDb.releaseSchemaRead();
      await flushMicrotasks();
      jest.useRealTimers();
      infoSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
}
