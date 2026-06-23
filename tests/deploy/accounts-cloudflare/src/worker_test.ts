import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  type CloudflareWorkerEnv,
  createCloudflareWorker,
  createR2InstallationExportWorker,
  parseLoginEmailAllowlist,
  type R2Bucket,
  type R2ObjectBody,
  type R2PutOptions,
} from "../../../../deploy/accounts-cloudflare/src/handler.ts";
import {
  buildInstallationExportBundle,
  type ControlPlaneOperations,
  D1AccountsStore,
  registerSessionHashSaltConfig,
  type D1Result,
  type D1Value,
  type InstallationRecord,
} from "@takosjp/takosumi-accounts-service";
import type {
  D1Database,
  D1ExecResult,
  D1PreparedStatement,
} from "@takosjp/takosumi-accounts-service";

test("Cloudflare Accounts Worker keeps edge health local", async () => {
  const d1 = new InitOnlyD1Database();
  const worker = createCloudflareWorker();
  const response = await worker.fetch(
    new Request("https://accounts.example/healthz"),
    createEnv(d1),
  );

  assert.equal(response.status, 200);
  assert.equal(d1.execCount, 0);
  assert.deepEqual(await response.json(), {
    ok: true,
    provider: "cloudflare",
    service: "takosumi-accounts",
    persistence: "d1+r2",
  });
});

test("the dashboard SPA owns /install (external install link is client-handled)", async () => {
  // The external install link has NO server-side handling: `/install?git=…`
  // is served as a plain SPA path by ASSETS (no 302, no param parsing here).
  // The dashboard client reads the query and pre-fills `/new` — pre-fill
  // only, with an explicit confirmation before anything installs.
  const worker = createCloudflareWorker();
  const response = await worker.fetch(
    new Request(
      "https://accounts.example/install?git=https://github.com/acme/repo.git",
    ),
    createEnv(new InitOnlyD1Database(), {
      ASSETS: {
        fetch: async (request) =>
          new Response(`asset:${new URL(request.url).pathname}`, {
            status: 200,
          }),
      },
    }),
  );
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "asset:/install");
  assert.equal(response.headers.get("location"), null);
});

test("Cloudflare Accounts Worker handles account-plane routes directly", async () => {
  const d1 = new InitOnlyD1Database();
  const worker = createCloudflareWorker();
  const env = createEnv(d1);

  const discovery = await worker.fetch(
    new Request("https://accounts.example/.well-known/openid-configuration"),
    env,
  );
  assert.equal(discovery.status, 200);
  // Two exec() calls on first build: D1_ACCOUNTS_STORE_INIT_SQL +
  // CREATE TABLE IF NOT EXISTS takosumi_accounts_schema_migrations. The
  // latter is the schema version bookkeeping table that
  // ensureD1SchemaVersion reads (same table the migrate-d1 runner writes).
  assert.equal(d1.execCount, 2);
  assert.equal((await discovery.json()).issuer, "https://accounts.example");

  const unknown = await worker.fetch(
    new Request("https://accounts.example/unknown"),
    env,
  );
  assert.equal(unknown.status, 404);
  assert.equal(d1.execCount, 2);
});

test("Cloudflare Accounts Worker parses env clients without a sidecar container", async () => {
  const d1 = new InitOnlyD1Database();
  const worker = createCloudflareWorker();
  const response = await worker.fetch(
    new Request("https://accounts.example/.well-known/openid-configuration"),
    createEnv(d1, {
      TAKOSUMI_ACCOUNTS_ISSUER: "https://issuer.example",
      TAKOSUMI_ACCOUNTS_CLIENTS: JSON.stringify([
        {
          clientId: "takos",
          redirectUris: ["https://takos.example/auth/callback"],
          tokenEndpointAuthMethod: "none",
        },
      ]),
    }),
  );

  assert.equal(response.status, 200);
  assert.equal((await response.json()).issuer, "https://issuer.example");
});

test("Cloudflare Accounts Worker enforces the pre-GA login allowlist for official Cloud", () => {
  const expected = {
    emails: ["shoutatomiyama0614@gmail.com"],
    requireVerifiedEmail: true,
  };

  assert.deepEqual(
    parseLoginEmailAllowlist(
      createEnv(new InitOnlyD1Database(), {
        TAKOSUMI_ACCOUNTS_ISSUER: "https://app.takosumi.com",
      }),
      "https://app.takosumi.com",
    ),
    expected,
  );
  assert.deepEqual(
    parseLoginEmailAllowlist(
      createEnv(new InitOnlyD1Database(), {
        TAKOSUMI_ACCOUNTS_ISSUER: "https://app-staging.takosumi.com",
      }),
      "https://app-staging.takosumi.com",
    ),
    expected,
  );
  assert.deepEqual(
    parseLoginEmailAllowlist(
      createEnv(new InitOnlyD1Database(), {
        TAKOSUMI_ACCOUNTS_ISSUER: "https://app.takosumi.com",
        TAKOSUMI_ACCOUNTS_LOGIN_EMAIL_ALLOWLIST: "*",
      }),
      "https://app.takosumi.com",
    ),
    expected,
  );
  assert.deepEqual(
    parseLoginEmailAllowlist(
      createEnv(new InitOnlyD1Database(), {
        TAKOSUMI_ACCOUNTS_ISSUER: "https://app.takosumi.com",
        TAKOSUMI_ACCOUNTS_LOGIN_EMAIL_ALLOWLIST:
          "someone-else@example.test,shoutatomiyama0614@gmail.com",
        TAKOSUMI_ACCOUNTS_LOGIN_EMAIL_ALLOWLIST_REQUIRE_VERIFIED: "false",
      }),
      "https://app.takosumi.com",
    ),
    expected,
  );
  assert.equal(
    parseLoginEmailAllowlist(
      createEnv(new InitOnlyD1Database(), {
        TAKOSUMI_ACCOUNTS_ISSUER: "https://app.takosumi.test",
      }),
      "https://app.takosumi.test",
    ),
    undefined,
  );
  assert.equal(
    parseLoginEmailAllowlist(
      createEnv(new InitOnlyD1Database(), {
        TAKOSUMI_ACCOUNTS_ISSUER: "https://accounts.example.test",
        TAKOSUMI_ACCOUNTS_LOGIN_EMAIL_ALLOWLIST: "*",
      }),
      "https://accounts.example.test",
    ),
    undefined,
  );
});

test("Cloudflare Accounts Worker can use a stable OIDC signing key", async () => {
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const previousKeyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const privateJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);
  const previousPublicJwk = await crypto.subtle.exportKey(
    "jwk",
    previousKeyPair.publicKey,
  );
  const worker = createCloudflareWorker();
  const response = await worker.fetch(
    new Request("https://accounts.example/oauth/jwks"),
    createEnv(new InitOnlyD1Database(), {
      TAKOSUMI_ACCOUNTS_ES256_PRIVATE_JWK: JSON.stringify(privateJwk),
      TAKOSUMI_ACCOUNTS_ES256_KEY_ID: "stable-key-1",
      TAKOSUMI_ACCOUNTS_ES256_PREVIOUS_PUBLIC_JWKS: JSON.stringify({
        keys: [{ ...previousPublicJwk, kid: "stable-key-previous" }],
      }),
      TAKOSUMI_ACCOUNTS_OIDC_PAIRWISE_SUBJECT_SECRET: "pairwise-secret",
      TAKOSUMI_ACCOUNTS_LAUNCH_TOKEN_PAIRWISE_SECRET: "launch-secret",
    }),
  );

  assert.equal(response.status, 200);
  const jwks = (await response.json()) as {
    keys?: readonly { readonly kid?: string; readonly d?: string }[];
  };
  assert.equal(jwks.keys?.[0]?.kid, "stable-key-1");
  assert.equal(jwks.keys?.[0]?.d, undefined);
  assert.equal(jwks.keys?.[1]?.kid, "stable-key-previous");
  assert.equal(jwks.keys?.[1]?.d, undefined);
});

test("Cloudflare Accounts Worker rejects private previous OIDC JWKS", async () => {
  const worker = createCloudflareWorker();
  const response = await worker.fetch(
    new Request("https://accounts.example/oauth/jwks"),
    createEnv(new InitOnlyD1Database(), {
      TAKOSUMI_ACCOUNTS_ES256_PREVIOUS_PUBLIC_JWKS: JSON.stringify({
        keys: [
          {
            kty: "EC",
            crv: "P-256",
            kid: "previous-private",
            x: "x",
            y: "y",
            d: "must-not-be-present",
          },
        ],
      }),
    }),
  );
  assert.equal(response.status, 500);
});

test("Cloudflare Accounts Worker treats subject secret without upstream providers as disabled sign-in", async () => {
  const worker = createCloudflareWorker();
  const response = await worker.fetch(
    new Request("https://accounts.example/v1/auth/providers"),
    createEnv(new InitOnlyD1Database(), {
      TAKOSUMI_ACCOUNTS_SUBJECT_SECRET: "upstream-subject-secret",
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    providers: [
      { id: "google", enabled: false },
      { id: "passkey", enabled: false },
    ],
  });
});

test("Cloudflare Accounts Worker ignores retired custom OIDC GitHub provider id", async () => {
  const worker = createCloudflareWorker();
  const response = await worker.fetch(
    new Request("https://accounts.example/v1/auth/providers"),
    createEnv(new InitOnlyD1Database(), {
      TAKOSUMI_ACCOUNTS_SUBJECT_SECRET: "upstream-subject-secret",
      TAKOSUMI_ACCOUNTS_UPSTREAM_OIDC_PROVIDER_ID: "github",
      TAKOSUMI_ACCOUNTS_UPSTREAM_OIDC_ISSUER: "https://github.com/login/oauth",
      TAKOSUMI_ACCOUNTS_UPSTREAM_OIDC_AUTHORIZATION_ENDPOINT:
        "https://github.com/login/oauth/authorize",
      TAKOSUMI_ACCOUNTS_UPSTREAM_OIDC_TOKEN_ENDPOINT:
        "https://github.com/login/oauth/access_token",
      TAKOSUMI_ACCOUNTS_UPSTREAM_OIDC_USERINFO_ENDPOINT:
        "https://api.github.com/user",
      TAKOSUMI_ACCOUNTS_UPSTREAM_OIDC_CLIENT_ID: "github-client",
      TAKOSUMI_ACCOUNTS_UPSTREAM_OIDC_CLIENT_SECRET: "github-secret",
      TAKOSUMI_ACCOUNTS_UPSTREAM_OIDC_REDIRECT_URI:
        "https://accounts.example/v1/auth/upstream/callback",
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    providers: [
      { id: "google", enabled: false },
      { id: "passkey", enabled: false },
    ],
  });
});

test("Cloudflare Accounts Worker rejects retired custom OIDC GitHub provider id on authorize", async () => {
  const worker = createCloudflareWorker();
  const response = await worker.fetch(
    new Request(
      "https://accounts.example/v1/auth/upstream/authorize?provider=github&state=state-1",
    ),
    createEnv(new InitOnlyD1Database(), {
      TAKOSUMI_ACCOUNTS_SUBJECT_SECRET: "upstream-subject-secret",
      TAKOSUMI_ACCOUNTS_UPSTREAM_OIDC_PROVIDER_ID: "github",
      TAKOSUMI_ACCOUNTS_UPSTREAM_OIDC_ISSUER: "https://github.com/login/oauth",
      TAKOSUMI_ACCOUNTS_UPSTREAM_OIDC_AUTHORIZATION_ENDPOINT:
        "https://github.com/login/oauth/authorize",
      TAKOSUMI_ACCOUNTS_UPSTREAM_OIDC_TOKEN_ENDPOINT:
        "https://github.com/login/oauth/access_token",
      TAKOSUMI_ACCOUNTS_UPSTREAM_OIDC_USERINFO_ENDPOINT:
        "https://api.github.com/user",
      TAKOSUMI_ACCOUNTS_UPSTREAM_OIDC_CLIENT_ID: "github-client",
      TAKOSUMI_ACCOUNTS_UPSTREAM_OIDC_CLIENT_SECRET: "github-secret",
      TAKOSUMI_ACCOUNTS_UPSTREAM_OIDC_REDIRECT_URI:
        "https://accounts.example/v1/auth/upstream/callback",
    }),
  );

  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, "feature_unavailable");
});

test("Cloudflare Accounts Worker ignores retired partial GitHub OAuth config on provider discovery", async () => {
  const worker = createCloudflareWorker();
  const response = await worker.fetch(
    new Request("https://accounts.example/v1/auth/providers"),
    createEnv(new InitOnlyD1Database(), {
      TAKOSUMI_ACCOUNTS_SUBJECT_SECRET: "upstream-subject-secret",
      TAKOSUMI_ACCOUNTS_UPSTREAM_GITHUB_CLIENT_ID: "github-client",
      TAKOSUMI_ACCOUNTS_UPSTREAM_GITHUB_REDIRECT_URI:
        "https://accounts.example/sign-in/callback",
    }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    providers: [
      { id: "google", enabled: false },
      { id: "passkey", enabled: false },
    ],
  });
});

test("Cloudflare Accounts Worker rejects retired GitHub OAuth on authorize", async () => {
  const worker = createCloudflareWorker();
  const response = await worker.fetch(
    new Request(
      "https://accounts.example/v1/auth/upstream/authorize?provider=github&state=state-1",
    ),
    createEnv(new InitOnlyD1Database(), {
      TAKOSUMI_ACCOUNTS_SUBJECT_SECRET: "upstream-subject-secret",
      TAKOSUMI_ACCOUNTS_UPSTREAM_GITHUB_CLIENT_ID: "github-client",
      TAKOSUMI_ACCOUNTS_UPSTREAM_GITHUB_REDIRECT_URI:
        "https://accounts.example/sign-in/callback",
    }),
  );
  assert.equal(response.status, 503);
  const body = (await response.json()) as {
    readonly error?: string;
    readonly error_description?: string;
  };
  assert.equal(body.error, "feature_unavailable");
  assert.equal(body.error_description, "Sign-in is temporarily unavailable.");
});

test("Cloudflare Accounts Worker keeps OIDC discovery alive with partial upstream provider", async () => {
  const worker = createCloudflareWorker();
  const response = await worker.fetch(
    new Request("https://accounts.example/.well-known/openid-configuration"),
    createEnv(new InitOnlyD1Database(), {
      TAKOSUMI_ACCOUNTS_SUBJECT_SECRET: "upstream-subject-secret",
      TAKOSUMI_ACCOUNTS_UPSTREAM_GITHUB_CLIENT_ID: "github-client",
      TAKOSUMI_ACCOUNTS_UPSTREAM_GITHUB_REDIRECT_URI:
        "https://accounts.example/sign-in/callback",
    }),
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as { readonly issuer?: string };
  assert.equal(body.issuer, "https://accounts.example");
});

test("Cloudflare Accounts Worker requires a session hash salt outside local substrate", async () => {
  const worker = createCloudflareWorker();
  const response = await worker.fetch(
    new Request("https://accounts.example/v1/account/session/me"),
    createEnv(new InitOnlyD1Database(), {
      TAKOSUMI_ACCOUNT_SESSION_HASH_SALT: undefined,
    }),
  );

  assert.equal(response.status, 500);
  const body = (await response.json()) as {
    readonly error?: string;
    readonly error_description?: string;
  };
  assert.equal(body.error, "worker_configuration_error");
  assert.match(body.error_description, /TAKOSUMI_ACCOUNT_SESSION_HASH_SALT/);
});

test("Cloudflare Accounts Worker writes metadata exports to R2 with signed downloads", async () => {
  const bucket = new MemoryR2Bucket();
  const exportWorker = createR2InstallationExportWorker({
    bucket,
    downloadBaseUrl: "https://accounts.example",
    downloadSecret: "download-secret",
    ttlMs: 60_000,
    now: () => new Date("2999-05-17T00:00:00.000Z"),
  });
  const installation = sampleInstallation();
  const bundle = buildInstallationExportBundle({ installation });

  const result = await exportWorker({
    installation,
    operationId: "op_export_1",
    request: {
      includeData: false,
      format: "bundle",
      encryption: { method: "none", recipients: [] },
      scope: {},
    },
    bundle,
  });

  assert.equal(
    bucket.puts[0]?.key,
    "installation-exports/inst_export/op_export_1/takos-export.json",
  );
  assert.equal(
    bucket.puts[0]?.options?.httpMetadata?.contentType,
    "application/json; charset=utf-8",
  );
  assert.match(
    result.downloadUrl,
    /^https:\/\/accounts\.example\/__takosumi\/exports\//,
  );
  assert.equal(result.downloadExpiresAt, "2999-05-17T00:01:00.000Z");

  const worker = createCloudflareWorker();
  const response = await worker.fetch(
    new Request(result.downloadUrl),
    createEnv(new InitOnlyD1Database(), {
      TAKOSUMI_ACCOUNTS_EXPORTS: bucket,
      TAKOSUMI_ACCOUNTS_EXPORT_DOWNLOAD_SECRET: "download-secret",
    }),
  );
  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("content-type"),
    "application/json; charset=utf-8",
  );
  const body = (await response.json()) as {
    kind?: string;
    operationId?: string;
    bundle?: { installation?: { installationId?: string } };
  };
  assert.equal(
    body.kind,
    "takosumi.accounts.cloudflare-r2-installation-export@v1",
  );
  assert.equal(body.operationId, "op_export_1");
  assert.equal(body.bundle?.installation?.installationId, "inst_export");

  const downloadEnv = createEnv(new InitOnlyD1Database(), {
    TAKOSUMI_ACCOUNTS_EXPORTS: bucket,
    TAKOSUMI_ACCOUNTS_EXPORT_DOWNLOAD_SECRET: "download-secret",
  });
  const headResponse = await worker.fetch(
    new Request(result.downloadUrl, { method: "HEAD" }),
    downloadEnv,
  );
  assert.equal(headResponse.status, 200);
  assert.equal(
    headResponse.headers.get("content-type"),
    "application/json; charset=utf-8",
  );
  assert.equal(await headResponse.text(), "");

  const methodResponse = await worker.fetch(
    new Request(result.downloadUrl, { method: "POST" }),
    downloadEnv,
  );
  assert.equal(methodResponse.status, 405);
  assert.equal(methodResponse.headers.get("allow"), "GET, HEAD");

  const badSignatureUrl = new URL(result.downloadUrl);
  badSignatureUrl.searchParams.set("sig", "bad");
  const badSignatureResponse = await worker.fetch(
    new Request(badSignatureUrl),
    downloadEnv,
  );
  assert.equal(badSignatureResponse.status, 403);
  assert.equal(
    (await badSignatureResponse.json()).error,
    "invalid_export_download_signature",
  );

  const missingObjectResponse = await worker.fetch(
    new Request(result.downloadUrl),
    createEnv(new InitOnlyD1Database(), {
      TAKOSUMI_ACCOUNTS_EXPORTS: new MemoryR2Bucket(),
      TAKOSUMI_ACCOUNTS_EXPORT_DOWNLOAD_SECRET: "download-secret",
    }),
  );
  assert.equal(missingObjectResponse.status, 404);
  assert.equal(
    (await missingObjectResponse.json()).error,
    "export_artifact_not_found",
  );

  const missingConfigResponse = await worker.fetch(
    new Request(result.downloadUrl),
    createEnv(new InitOnlyD1Database()),
  );
  assert.equal(missingConfigResponse.status, 500);
  assert.equal(
    (await missingConfigResponse.json()).error,
    "worker_configuration_error",
  );

  const expiredBucket = new MemoryR2Bucket();
  const expiredExportWorker = createR2InstallationExportWorker({
    bucket: expiredBucket,
    downloadBaseUrl: "https://accounts.example",
    downloadSecret: "download-secret",
    ttlMs: 1,
    now: () => new Date("2000-05-17T00:00:00.000Z"),
  });
  const expiredResult = await expiredExportWorker({
    installation,
    operationId: "op_export_expired",
    request: {
      includeData: false,
      format: "bundle",
      encryption: { method: "none", recipients: [] },
      scope: {},
    },
    bundle,
  });
  const expiredResponse = await worker.fetch(
    new Request(expiredResult.downloadUrl),
    createEnv(new InitOnlyD1Database(), {
      TAKOSUMI_ACCOUNTS_EXPORTS: expiredBucket,
      TAKOSUMI_ACCOUNTS_EXPORT_DOWNLOAD_SECRET: "download-secret",
    }),
  );
  assert.equal(expiredResponse.status, 410);
  assert.equal((await expiredResponse.json()).error, "export_download_expired");

  const malformedDownloadResponse = await worker.fetch(
    new Request(
      "https://accounts.example/__takosumi/exports/%E0%A4%A?expires=4102444800000&sig=bad",
    ),
    downloadEnv,
  );
  assert.equal(malformedDownloadResponse.status, 400);
  assert.equal(
    (await malformedDownloadResponse.json()).error,
    "invalid_export_download_url",
  );

  const routeD1 = new MemoryD1Database();
  const routeStore = new D1AccountsStore(routeD1);
  registerSessionHashSaltConfig({ salt: "test-session-hash-salt" });
  const sessionId = await seedD1AccountSession(routeStore);
  const routeBucket = new MemoryR2Bucket();
  const routeWorker = createCloudflareWorker();
  const routeEnv = createEnv(routeD1, {
    TAKOSUMI_ACCOUNTS_ISSUER: "https://accounts.example.test",
    ...LOCAL_READINESS_ENV,
    TAKOSUMI_ACCOUNTS_EXPORTS: routeBucket,
    TAKOSUMI_ACCOUNTS_EXPORT_DOWNLOAD_SECRET: "route-download-secret",
    TAKOSUMI_ACCOUNTS_EXPORT_DOWNLOAD_TTL_MS: "60000",
  });
  const authHeaders = {
    authorization: `Bearer ${sessionId}`,
    "content-type": "application/json",
  };
  const now = Date.now();
  await routeStore.saveLedgerAccount({
    accountId: "acct_route_export",
    legalOwnerSubject: "tsub_route_export",
    createdAt: now,
    updatedAt: now,
  });
  await routeStore.saveSpace({
    spaceId: "space_route_export",
    accountId: "acct_route_export",
    kind: "personal",
    createdAt: now,
    updatedAt: now,
  });
  await routeStore.saveAppInstallation({
    installationId: "inst_route_export",
    accountId: "acct_route_export",
    spaceId: "space_route_export",
    appId: "example.route-export",
    sourceGitUrl: "https://github.com/example/route-export",
    sourceRef: "v1.0.0",
    sourceCommit: "0123456789abcdef0123456789abcdef01234567",
    planDigest: "sha256:app",
    artifactDigest: "sha256:compiled",
    mode: "shared-cell",
    status: "ready",
    createdBySubject: "tsub_route_export",
    createdAt: now,
    updatedAt: now,
  });

  const exportStartedAt = Date.now();
  const exportResponse = await routeWorker.fetch(
    new Request(
      "https://accounts.example.test/v1/installation-projections/inst_route_export/export",
      {
        method: "POST",
        headers: {
          ...authHeaders,
          "Idempotency-Key": "idem-route-export",
        },
        body: JSON.stringify({
          includeData: false,
          format: "bundle",
          encryption: { method: "none" },
          scope: { secrets: "templates-only" },
        }),
      },
    ),
    routeEnv,
  );
  assert.equal(exportResponse.status, 202, await exportResponse.clone().text());
  const exported = (await exportResponse.json()) as {
    status?: string;
    operationId?: string;
    downloadUrl?: string;
    downloadExpiresAt?: string;
  };
  assert.equal(exported.status, "exported");
  if (typeof exported.operationId !== "string") {
    throw new Error("route export response missing operationId");
  }
  if (typeof exported.downloadUrl !== "string") {
    throw new Error("route export response missing downloadUrl");
  }
  assert.equal(
    exported.downloadUrl,
    `/v1/installation-projections/inst_route_export/exports/${exported.operationId}/download`,
  );
  assert.equal(
    routeBucket.puts[0]?.key,
    `installation-exports/inst_route_export/${exported.operationId}/takos-export.json`,
  );
  const downloadExpiresAt = Date.parse(exported.downloadExpiresAt ?? "");
  assert.ok(Number.isFinite(downloadExpiresAt));
  assert.ok(downloadExpiresAt >= exportStartedAt + 59_000);
  assert.ok(downloadExpiresAt <= Date.now() + 61_000);

  const operationDownloadResponse = await routeWorker.fetch(
    new Request(
      `https://accounts.example.test/v1/installation-projections/inst_route_export/exports/${exported.operationId}/download`,
      { headers: { authorization: `Bearer ${sessionId}` } },
    ),
    routeEnv,
  );
  assert.equal(operationDownloadResponse.status, 302);
  const signedLocation =
    operationDownloadResponse.headers.get("location") ?? "";
  assert.ok(
    signedLocation.startsWith(
      "https://accounts.example.test/__takosumi/exports/",
    ),
    `signed location ${signedLocation} should target the private export route`,
  );
  assert.ok(signedLocation.includes("tk_sig="));
  assert.ok(signedLocation.includes("tk_exp="));

  const routedDownloadResponse = await routeWorker.fetch(
    new Request(signedLocation),
    routeEnv,
  );
  assert.equal(routedDownloadResponse.status, 200);
  const routedDownload = (await routedDownloadResponse.json()) as {
    bundle?: { installation?: { installationId?: string } };
  };
  assert.equal(
    routedDownload.bundle?.installation?.installationId,
    "inst_route_export",
  );
});

test("Cloudflare R2 metadata export refuses data-bearing archive modes", async () => {
  const exportWorker = createR2InstallationExportWorker({
    bucket: new MemoryR2Bucket(),
    downloadBaseUrl: "https://accounts.example",
    downloadSecret: "download-secret",
  });
  const installation = sampleInstallation();
  const bundle = buildInstallationExportBundle({ installation });

  await assert.rejects(async () => {
    await exportWorker({
      installation,
      operationId: "op_export_data",
      request: {
        includeData: true,
        format: "bundle",
        encryption: { method: "none", recipients: [] },
        scope: {},
      },
      bundle,
    });
  }, /does not include tenant data/);
  await assert.rejects(async () => {
    await exportWorker({
      installation,
      operationId: "op_export_age",
      request: {
        includeData: false,
        format: "bundle",
        encryption: { method: "age", recipients: ["age1example"] },
        scope: {},
      },
      bundle,
    });
  }, /does not support archive encryption/);
});

test("Cloudflare R2 metadata export rejects non-HTTPS public download bases", () => {
  assert.throws(
    () =>
      createR2InstallationExportWorker({
        bucket: new MemoryR2Bucket(),
        downloadBaseUrl: "http://downloads.example.test/accounts/exports",
        downloadSecret: "download-secret",
      }),
    /https:\/\/ or loopback http:\/\//,
  );
});

// Static, test-only ES256 signing key fixture. The default worker env uses an
// https issuer, which now fails closed on the ephemeral per-process key (the
// CLOUD-OIDC fail-closed guard in createEphemeralAccountsHandler). Production
// Cloudflare deployments must supply a stable JWK; these tests do the same so
// they exercise the stable-key path rather than the (now-rejected) ephemeral
// fallback. This is a committed test fixture, not a real secret.
const TEST_ES256_PRIVATE_JWK = JSON.stringify({
  kty: "EC",
  crv: "P-256",
  d: "MxLuR_Vh9AOJ134l9hOo9-AG0blordOUV101A1xnVpY",
  x: "IcEBfrFfO2ChFPPa6tI-ro1IL7Cbdyi3eVciVAYjYbo",
  y: "EAarhgJ5UEpJaTpMK4U46S9vpCiqOH9j8lBzcsU2yTE",
});

function createEnv(
  d1: D1Database,
  overrides: Partial<CloudflareWorkerEnv> = {},
): CloudflareWorkerEnv {
  return {
    TAKOSUMI_ACCOUNTS_DB: d1,
    // Provide a default issuer so handler.ts no longer falls back to the
    // first-request URL. Individual tests override to assert the configured
    // issuer flows through OIDC discovery.
    TAKOSUMI_ACCOUNTS_ISSUER: "https://accounts.example",
    TAKOSUMI_ACCOUNTS_CLIENT_ID: "takos-local",
    TAKOSUMI_ACCOUNTS_REDIRECT_URIS: "https://takos.example/auth/oidc/callback",
    TAKOSUMI_ACCOUNTS_PLATFORM_ACCESS: "closed",
    // Stable OIDC signing key so the default https issuer does not trip the
    // fail-closed ephemeral-key guard. Tests that specifically exercise the
    // ephemeral path or supply their own key override these.
    TAKOSUMI_ACCOUNTS_ES256_PRIVATE_JWK: TEST_ES256_PRIVATE_JWK,
    TAKOSUMI_ACCOUNTS_ES256_KEY_ID: "test-stable-key",
    TAKOSUMI_ACCOUNTS_OIDC_PAIRWISE_SUBJECT_SECRET: "test-pairwise-secret",
    TAKOSUMI_ACCOUNT_SESSION_HASH_SALT: "test-session-hash-salt",
    TAKOSUMI_ACCOUNTS_LAUNCH_TOKEN_PAIRWISE_SECRET:
      "test-launch-pairwise-secret",
    ...overrides,
  };
}

// Local-only readiness fixture; matches the values used in
// takosumi/deploy/local-substrate/compose.substrate.yml.
const LOCAL_READINESS_ENV: Partial<CloudflareWorkerEnv> = {
  TAKOSUMI_ACCOUNTS_PLATFORM_ACCESS: "open",
  TAKOSUMI_PRODUCTION_HARDENING_GATE: "enforce",
  TAKOSUMI_ACCOUNTS_PLATFORM_READINESS_DIGEST:
    "sha256:e35f7540857c615ddd26a779ca95674237c649bbb99712e7e795e3bdc9ce3357",
  TAKOSUMI_ACCOUNTS_PLATFORM_EVIDENCE_REF:
    "git+https://github.com/tako0614/takos-private.git#docs/launch-readiness/p0-evidence.md",
  TAKOSUMI_ACCOUNTS_PLATFORM_APPROVAL_REF:
    "git+https://github.com/tako0614/takos-private.git#docs/launch-readiness/p0-approval.md",
  TAKOSUMI_ACCOUNTS_PLATFORM_PUBLIC_SUMMARY:
    "Local substrate p0 staged rehearsal — evidence retained with rehearsal log; no production traffic served.",
  TAKOSUMI_CLOUDFLARE_CONTAINER_SMOKE_EVIDENCE_REF:
    "git+https://github.com/tako0614/takosumi-private.git@0123456789abcdef0123456789abcdef01234567#evidence/container-smoke.md",
  TAKOSUMI_CLOUDFLARE_CONTAINER_SMOKE_EVIDENCE_DIGEST:
    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  TAKOSUMI_PLATFORM_CONTROL_PLANE_SMOKE_EVIDENCE_REF:
    "git+https://github.com/tako0614/takosumi-private.git@0123456789abcdef0123456789abcdef01234567#evidence/platform-control-plane-smoke.md",
  TAKOSUMI_PLATFORM_CONTROL_PLANE_SMOKE_EVIDENCE_DIGEST:
    "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  TAKOSUMI_EGRESS_ENFORCEMENT_EVIDENCE_REF:
    "git+https://github.com/tako0614/takosumi-private.git@0123456789abcdef0123456789abcdef01234567#evidence/egress.md",
  TAKOSUMI_EGRESS_ENFORCEMENT_EVIDENCE_DIGEST:
    "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  TAKOSUMI_RESTORE_REHEARSAL_EVIDENCE_REF:
    "git+https://github.com/tako0614/takosumi-private.git@0123456789abcdef0123456789abcdef01234567#evidence/restore-rehearsal.md",
  TAKOSUMI_RESTORE_REHEARSAL_EVIDENCE_DIGEST:
    "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
  TAKOSUMI_PROVIDER_CATALOG_EVIDENCE_REF:
    "git+https://github.com/tako0614/takosumi-private.git@0123456789abcdef0123456789abcdef01234567#evidence/provider-connections.md",
  TAKOSUMI_PROVIDER_CATALOG_EVIDENCE_DIGEST:
    "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  TAKOSUMI_COST_ATTRIBUTION_EVIDENCE_REF:
    "git+https://github.com/tako0614/takosumi-private.git@0123456789abcdef0123456789abcdef01234567#evidence/cost-attribution.md",
  TAKOSUMI_COST_ATTRIBUTION_EVIDENCE_DIGEST:
    "sha256:1111111111111111111111111111111111111111111111111111111111111111",
  TAKOSUMI_SECRET_BOUNDARY_EVIDENCE_REF:
    "git+https://github.com/tako0614/takosumi-private.git@0123456789abcdef0123456789abcdef01234567#evidence/secret-boundary.md",
  TAKOSUMI_SECRET_BOUNDARY_EVIDENCE_DIGEST:
    "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
};

const RELEASE_ACTIVATION_READINESS_ENV: Partial<CloudflareWorkerEnv> = {
  TAKOSUMI_RELEASE_ACTIVATOR_URL: "https://materializer.example.com/activate",
  TAKOSUMI_RELEASE_ACTIVATOR_TOKEN: "release-activator-token",
  TAKOSUMI_RELEASE_ACTIVATION_SUCCESS_EVIDENCE_REF:
    "git+https://github.com/tako0614/takosumi-private.git@0123456789abcdef0123456789abcdef01234567#evidence/release-activation-success.md",
  TAKOSUMI_RELEASE_ACTIVATION_SUCCESS_EVIDENCE_DIGEST:
    "sha256:2222222222222222222222222222222222222222222222222222222222222222",
  TAKOSUMI_RELEASE_ACTIVATION_FAILURE_SURFACING_EVIDENCE_REF:
    "git+https://github.com/tako0614/takosumi-private.git@0123456789abcdef0123456789abcdef01234567#evidence/release-activation-failure-surfacing.md",
  TAKOSUMI_RELEASE_ACTIVATION_FAILURE_SURFACING_EVIDENCE_DIGEST:
    "sha256:3333333333333333333333333333333333333333333333333333333333333333",
  TAKOSUMI_RELEASE_ACTIVATION_LEDGER_INDEPENDENCE_EVIDENCE_REF:
    "git+https://github.com/tako0614/takosumi-private.git@0123456789abcdef0123456789abcdef01234567#evidence/release-activation-ledger-independence.md",
  TAKOSUMI_RELEASE_ACTIVATION_LEDGER_INDEPENDENCE_EVIDENCE_DIGEST:
    "sha256:4444444444444444444444444444444444444444444444444444444444444444",
  TAKOSUMI_RELEASE_ACTIVATION_PAYLOAD_BOUNDARY_EVIDENCE_REF:
    "git+https://github.com/tako0614/takosumi-private.git@0123456789abcdef0123456789abcdef01234567#evidence/release-activation-payload-boundary.md",
  TAKOSUMI_RELEASE_ACTIVATION_PAYLOAD_BOUNDARY_EVIDENCE_DIGEST:
    "sha256:5555555555555555555555555555555555555555555555555555555555555555",
};

test("platform-readiness 'open' allowed on a production issuer with final audit env", async () => {
  const d1 = new InitOnlyD1Database();
  const worker = createCloudflareWorker();
  const env = createEnv(d1, {
    TAKOSUMI_ACCOUNTS_ISSUER: "https://app.takosumi.com",
    ...LOCAL_READINESS_ENV,
  });

  const response = await worker.fetch(
    new Request("https://app.takosumi.com/.well-known/openid-configuration"),
    env,
  );
  assert.equal(response.status, 200);
});

test("platform-readiness 'open' refuses missing production hardening evidence", async () => {
  const d1 = new InitOnlyD1Database();
  const worker = createCloudflareWorker();
  const env = createEnv(d1, {
    TAKOSUMI_ACCOUNTS_ISSUER: "https://app.takosumi.com",
    ...LOCAL_READINESS_ENV,
  });
  delete (env as Partial<CloudflareWorkerEnv>)
    .TAKOSUMI_PLATFORM_CONTROL_PLANE_SMOKE_EVIDENCE_DIGEST;

  const response = await worker.fetch(
    new Request("https://app.takosumi.com/.well-known/openid-configuration"),
    env,
  );
  assert.equal(response.status, 500);
  const body = (await response.json()) as {
    error?: string;
    error_description?: string;
  };
  assert.equal(body.error, "worker_configuration_error");
  assert.match(
    body.error_description ?? "",
    /Open platform readiness access requires TAKOSUMI_PLATFORM_CONTROL_PLANE_SMOKE_EVIDENCE_DIGEST/,
  );
});

test("platform-readiness 'open' requires enforced production hardening gate", async () => {
  const d1 = new InitOnlyD1Database();
  const worker = createCloudflareWorker();
  const env = createEnv(d1, {
    TAKOSUMI_ACCOUNTS_ISSUER: "https://app.takosumi.com",
    ...LOCAL_READINESS_ENV,
    TAKOSUMI_PRODUCTION_HARDENING_GATE: "observe",
  });

  const response = await worker.fetch(
    new Request("https://app.takosumi.com/.well-known/openid-configuration"),
    env,
  );
  assert.equal(response.status, 500);
  const body = (await response.json()) as {
    error?: string;
    error_description?: string;
  };
  assert.equal(body.error, "worker_configuration_error");
  assert.match(
    body.error_description ?? "",
    /Open platform readiness access requires TAKOSUMI_PRODUCTION_HARDENING_GATE=enforce/,
  );
});

test("platform-readiness 'open' refuses mutable production hardening refs", async () => {
  const d1 = new InitOnlyD1Database();
  const worker = createCloudflareWorker();
  const env = createEnv(d1, {
    TAKOSUMI_ACCOUNTS_ISSUER: "https://app.takosumi.com",
    ...LOCAL_READINESS_ENV,
    TAKOSUMI_PROVIDER_CATALOG_EVIDENCE_REF:
      "git+https://github.com/tako0614/takosumi-private.git#evidence/provider-connections.md",
  });

  const response = await worker.fetch(
    new Request("https://app.takosumi.com/.well-known/openid-configuration"),
    env,
  );
  assert.equal(response.status, 500);
  const body = (await response.json()) as {
    error?: string;
    error_description?: string;
  };
  assert.equal(body.error, "worker_configuration_error");
  assert.match(
    body.error_description ?? "",
    /TAKOSUMI_PROVIDER_CATALOG_EVIDENCE_REF must be commit-pinned git\+ ref/,
  );
});

test("platform-readiness 'open' requires release activation evidence when activator is enabled", async () => {
  const d1 = new InitOnlyD1Database();
  const worker = createCloudflareWorker();
  const env = createEnv(d1, {
    TAKOSUMI_ACCOUNTS_ISSUER: "https://app.takosumi.com",
    ...LOCAL_READINESS_ENV,
    TAKOSUMI_RELEASE_ACTIVATOR_URL:
      RELEASE_ACTIVATION_READINESS_ENV.TAKOSUMI_RELEASE_ACTIVATOR_URL,
    TAKOSUMI_RELEASE_ACTIVATOR_TOKEN:
      RELEASE_ACTIVATION_READINESS_ENV.TAKOSUMI_RELEASE_ACTIVATOR_TOKEN,
  });

  const response = await worker.fetch(
    new Request("https://app.takosumi.com/.well-known/openid-configuration"),
    env,
  );
  assert.equal(response.status, 500);
  const body = (await response.json()) as {
    error?: string;
    error_description?: string;
  };
  assert.equal(body.error, "worker_configuration_error");
  assert.match(
    body.error_description ?? "",
    /Open platform readiness access requires TAKOSUMI_RELEASE_ACTIVATION_SUCCESS_EVIDENCE_REF/,
  );
});

test("platform-readiness 'open' accepts release activation evidence when activator is enabled", async () => {
  const d1 = new InitOnlyD1Database();
  const worker = createCloudflareWorker();
  const env = createEnv(d1, {
    TAKOSUMI_ACCOUNTS_ISSUER: "https://app.takosumi.com",
    ...LOCAL_READINESS_ENV,
    ...RELEASE_ACTIVATION_READINESS_ENV,
  });

  const response = await worker.fetch(
    new Request("https://app.takosumi.com/.well-known/openid-configuration"),
    env,
  );
  assert.equal(response.status, 200);
});

test("platform-readiness 'open' allowed on a .test issuer (local-substrate)", async () => {
  const d1 = new InitOnlyD1Database();
  const worker = createCloudflareWorker();
  const env = createEnv(d1, {
    TAKOSUMI_ACCOUNTS_ISSUER: "https://app.takosumi.test",
    ...LOCAL_READINESS_ENV,
  });
  const response = await worker.fetch(
    new Request("https://app.takosumi.test/.well-known/openid-configuration"),
    env,
  );
  assert.equal(response.status, 200);
});

test("Cloudflare Accounts Worker seeds local-substrate account session and space", async () => {
  const d1 = new MemoryD1Database();
  const worker = createCloudflareWorker();
  registerSessionHashSaltConfig({ allowDevFallback: true });
  const env = createEnv(d1, {
    TAKOSUMI_ACCOUNTS_ISSUER: "https://app.takosumi.test",
    LOCAL_SUBSTRATE_TEST_BED: "1",
    TAKOSUMI_ACCOUNTS_LOCAL_DEV_SESSION_ID: "sess_local_substrate",
    TAKOSUMI_ACCOUNTS_LOCAL_DEV_ACCOUNT_ID: "acct_local",
    TAKOSUMI_ACCOUNTS_LOCAL_DEV_SPACE_ID: "space_local",
  });

  const response = await worker.fetch(
    new Request(
      "https://app.takosumi.test/v1/installation-projections?space_id=space_local",
      {
        headers: { authorization: "Bearer sess_local_substrate" },
      },
    ),
    env,
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    installations: [],
    next_cursor: null,
  });
});

test("Cloudflare Accounts Worker bridges billing redirect allowlist from env", async () => {
  const d1 = new MemoryD1Database();
  const worker = createCloudflareWorker({
    controlPlaneOperations: async () =>
      ({
        spaces: {
          getSpace: async (id: string) => ({
            id,
            handle: id,
            displayName: id,
            type: "personal" as const,
            ownerUserId: "tsub_takosumi_local",
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
          }),
        },
      }) as unknown as ControlPlaneOperations,
  });
  registerSessionHashSaltConfig({ allowDevFallback: true });
  const env = createEnv(d1, {
    TAKOSUMI_ACCOUNTS_ISSUER: "https://app.takosumi.test",
    ...LOCAL_READINESS_ENV,
    LOCAL_SUBSTRATE_TEST_BED: "1",
    TAKOSUMI_ACCOUNTS_STRIPE_SECRET_KEY: "sk_test_worker",
    TAKOSUMI_ACCOUNTS_STRIPE_WEBHOOK_SECRET: "whsec_test_worker",
    TAKOSUMI_BILLING_PLANS: JSON.stringify([
      {
        id: "starter",
        kind: "subscription",
        stripePriceId: "price_test_worker",
        credits: 1000,
        name: { ja: "Starter", en: "Starter" },
        priceDisplay: { ja: "1000 JPY / month", en: "1000 JPY / month" },
      },
    ]),
    TAKOSUMI_ACCOUNTS_BILLING_REDIRECT_ALLOWLIST: "https://app.takosumi.test",
  });

  const response = await worker.fetch(
    new Request("https://app.takosumi.test/v1/billing/stripe/checkout", {
      method: "POST",
      headers: {
        authorization: "Bearer sess_local_substrate",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        subject: "tsub_takosumi_local",
        planId: "starter",
        spaceId: "space_local",
        successUrl: "https://evil.example/checkout/success",
        cancelUrl: "https://app.takosumi.test/workspace/settings/billing",
      }),
    }),
    env,
  );

  assert.equal(response.status, 400, await response.clone().text());
  const body = (await response.json()) as { error?: { code?: string } };
  assert.equal(body.error?.code, "invalid_redirect_uri");
});

test("Cloudflare Accounts Worker bridges billing checkout smoke token from operator env", async () => {
  const d1 = new MemoryD1Database();
  const worker = createCloudflareWorker({
    controlPlaneOperations: async () =>
      ({
        spaces: {
          getSpace: async (id: string) => ({
            id,
            handle: id,
            displayName: id,
            type: "personal" as const,
            ownerUserId: "tsub_takosumi_local",
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
          }),
        },
      }) as unknown as ControlPlaneOperations,
  });
  registerSessionHashSaltConfig({ allowDevFallback: true });
  const env = createEnv(d1, {
    TAKOSUMI_ACCOUNTS_ISSUER: "https://app.takosumi.test",
    LOCAL_SUBSTRATE_TEST_BED: "1",
    TAKOSUMI_ACCOUNTS_PLATFORM_ACCESS: "closed",
    TAKOSUMI_DEPLOY_CONTROL_TOKEN: "smoke_operator_token",
    TAKOSUMI_ACCOUNTS_STRIPE_SECRET_KEY: "sk_test_worker",
    TAKOSUMI_ACCOUNTS_STRIPE_WEBHOOK_SECRET: "whsec_test_worker",
    TAKOSUMI_BILLING_PLANS: JSON.stringify([
      {
        id: "starter",
        kind: "subscription",
        stripePriceId: "price_test_worker",
        credits: 1000,
        name: { ja: "Starter", en: "Starter" },
        priceDisplay: { ja: "1000 JPY / month", en: "1000 JPY / month" },
      },
    ]),
    TAKOSUMI_ACCOUNTS_BILLING_REDIRECT_ALLOWLIST: "https://app.takosumi.test",
  });

  const blocked = await worker.fetch(
    new Request("https://app.takosumi.test/v1/billing/stripe/checkout", {
      method: "POST",
      headers: {
        authorization: "Bearer sess_local_substrate",
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    }),
    env,
  );
  assert.equal(blocked.status, 503, await blocked.clone().text());

  const response = await worker.fetch(
    new Request("https://app.takosumi.test/v1/billing/stripe/checkout", {
      method: "POST",
      headers: {
        authorization: "Bearer sess_local_substrate",
        "content-type": "application/json",
        "x-takosumi-billing-smoke-token": "smoke_operator_token",
      },
      body: JSON.stringify({
        subject: "tsub_takosumi_local",
        planId: "starter",
        spaceId: "space_local",
        successUrl: "https://evil.example/checkout/success",
        cancelUrl: "https://app.takosumi.test/workspace/settings/billing",
      }),
    }),
    env,
  );

  assert.equal(response.status, 400, await response.clone().text());
  const body = (await response.json()) as { error?: { code?: string } };
  assert.equal(body.error?.code, "invalid_redirect_uri");
});

test("platform-readiness 'open' refuses an invalid issuer URL", async () => {
  const d1 = new InitOnlyD1Database();
  const worker = createCloudflareWorker();
  const env = createEnv(d1, {
    TAKOSUMI_ACCOUNTS_ISSUER: "not-a-url",
    ...LOCAL_READINESS_ENV,
  });
  const response = await worker.fetch(
    new Request("https://accounts.example/.well-known/openid-configuration"),
    env,
  );
  assert.equal(response.status, 500);
  const body = (await response.json()) as {
    error?: string;
    error_description?: string;
  };
  assert.equal(body.error, "worker_configuration_error");
  assert.match(
    body.error_description ?? "",
    /TAKOSUMI_ACCOUNTS_ISSUER must be an absolute HTTP URL/,
  );
});

for (const issuer of [
  "https://app.takosumi.test",
  "https://accounts.local",
  "https://app.localhost",
  "http://localhost:8080",
  "http://127.0.0.1:9000",
  "http://[::1]:9000",
  "http://10.0.0.5",
  "http://192.168.1.20",
  "http://172.20.10.5",
  "http://169.254.169.254", // IPv4 link-local (AWS-style metadata)
  "http://100.64.0.5", // CGNAT
  "http://100.127.0.5", // CGNAT upper edge
  "http://[fc00::1]", // IPv6 ULA
  "http://[fd00::1]", // IPv6 ULA
  "http://[fe80::1]", // IPv6 link-local
]) {
  test(`platform-readiness 'open' accepts final audit env on issuer ${issuer}`, async () => {
    const d1 = new InitOnlyD1Database();
    const worker = createCloudflareWorker();
    const env = createEnv(d1, {
      TAKOSUMI_ACCOUNTS_ISSUER: issuer,
      ...LOCAL_READINESS_ENV,
    });
    const response = await worker.fetch(
      new Request(`${issuer}/.well-known/openid-configuration`),
      env,
    );
    assert.equal(response.status, 200);
  });
}

test("Worker fails fast when TAKOSUMI_ACCOUNTS_ISSUER is unset (fail-closed)", async () => {
  const d1 = new InitOnlyD1Database();
  const worker = createCloudflareWorker();
  // Deliberately drop TAKOSUMI_ACCOUNTS_ISSUER so the worker has nothing to
  // fall back to. The Worker must refuse to serve account-plane traffic
  // rather than caching the first-request URL as the OIDC issuer.
  const env = createEnv(d1, LOCAL_READINESS_ENV);
  const envWithoutIssuer: CloudflareWorkerEnv = Object.fromEntries(
    Object.entries(env).filter(([key]) => key !== "TAKOSUMI_ACCOUNTS_ISSUER"),
  ) as CloudflareWorkerEnv;
  const response = await worker.fetch(
    new Request("https://something.example/.well-known/openid-configuration"),
    envWithoutIssuer,
  );
  assert.equal(response.status, 500);
  const body = (await response.json()) as {
    error?: string;
    error_description?: string;
  };
  assert.equal(body.error, "worker_configuration_error");
  assert.match(
    body.error_description ?? "",
    /TAKOSUMI_ACCOUNTS_ISSUER must be set/,
  );
});

class InitOnlyD1Database implements D1Database {
  execCount = 0;

  prepare(query: string): D1PreparedStatement {
    // The handler now reads the takosumi_accounts_schema_migrations
    // bookkeeping table to refuse drifted schemas. Allow that read; reject
    // every other query so the test still verifies no document-level traffic.
    if (
      /^\s*SELECT\s+version\s+FROM\s+takosumi_accounts_schema_migrations\b/i.test(
        query,
      )
    ) {
      return new InitOnlySchemaMigrationsStatement();
    }
    throw new Error("direct route test did not expect D1 document queries");
  }

  exec(_query: string): Promise<D1ExecResult> {
    this.execCount += 1;
    return Promise.resolve({ count: 1, duration: 0 });
  }
}

class InitOnlySchemaMigrationsStatement implements D1PreparedStatement {
  bind(..._values: readonly D1Value[]): D1PreparedStatement {
    return this;
  }
  run(): Promise<D1Result> {
    return Promise.resolve({ success: true });
  }
  first<T = unknown>(_column?: string): Promise<T | null> {
    // Fresh database: no migration rows yet. Handler treats this as
    // version 0 which matches the current EXPECTED_D1_SCHEMA_VERSION.
    return Promise.resolve(null);
  }
  all<T = unknown>(): Promise<D1Result<T>> {
    return Promise.resolve({ success: true, results: [] as T[] });
  }
}

async function seedD1AccountSession(store: D1AccountsStore): Promise<string> {
  const now = Date.now();
  const subject = "tsub_route_export";
  const sessionId = "sess_route_export";
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
  return sessionId;
}

interface DocumentRow {
  readonly document: string;
}

interface IndexRow {
  readonly indexName: string;
  readonly indexKey: string;
  readonly bucket: string;
  readonly documentKey: string;
  readonly sortKey: number;
}

class MemoryD1Database implements D1Database {
  readonly documents = new Map<string, string>();
  readonly indexes = new Map<string, IndexRow>();
  execCount = 0;
  lastChanges = 0;

  prepare(query: string): D1PreparedStatement {
    return new MemoryD1Statement(this, query);
  }

  exec(_query: string): Promise<D1ExecResult> {
    this.execCount += 1;
    return Promise.resolve({ count: 1, duration: 0 });
  }
}

class MemoryD1Statement implements D1PreparedStatement {
  #values: readonly D1Value[] = [];

  constructor(
    private readonly db: MemoryD1Database,
    private readonly query: string,
  ) {}

  bind(...values: readonly D1Value[]): D1PreparedStatement {
    this.#values = values;
    return this;
  }

  run(): Promise<D1Result> {
    const query = normalizedQuery(this.query);
    const canonical = canonicalQuery(this.query);
    if (
      canonical.startsWith(
        "insert into takosumi_accounts_documents (bucket, key, document, updated_at) values (?, ?, ?, ?) on conflict",
      )
    ) {
      const [bucket, key] = this.#stringValues(2);
      const document = stringBindValue(this.#rawValues()[4]);
      this.db.documents.set(documentKey(bucket, key), document);
      this.db.lastChanges = 1;
      return Promise.resolve({ success: true, meta: { changes: 1 } });
    }
    if (
      canonical.startsWith(
        "insert into takosumi_accounts_indexes (index_name, index_key, bucket, document_key, sort_key) values (?, ?, ?, ?, ?) on conflict",
      )
    ) {
      const [indexName, indexKey, bucket, key] = this.#stringValues(4);
      const sortKey = numberValue(this.#values[4]);
      this.db.indexes.set(indexRowKey(indexName, indexKey, bucket, key), {
        indexName,
        indexKey,
        bucket,
        documentKey: key,
        sortKey,
      });
      this.db.lastChanges = 1;
      return Promise.resolve({ success: true, meta: { changes: 1 } });
    }
    if (
      canonical.startsWith(
        "delete from takosumi_accounts_indexes where (takosumi_accounts_indexes.bucket = ? and takosumi_accounts_indexes.document_key = ?)",
      )
    ) {
      const [bucket, key] = this.#stringValues(2);
      for (const [indexKey, row] of this.db.indexes) {
        if (row.bucket === bucket && row.documentKey === key) {
          this.db.indexes.delete(indexKey);
        }
      }
      this.db.lastChanges = 1;
      return Promise.resolve({ success: true, meta: { changes: 1 } });
    }
    if (
      canonical.startsWith(
        "delete from takosumi_accounts_indexes where (takosumi_accounts_indexes.index_name = ? and takosumi_accounts_indexes.index_key = ?)",
      )
    ) {
      const [indexName, indexKey] = this.#stringValues(2);
      for (const [rowKey, row] of this.db.indexes) {
        if (row.indexName === indexName && row.indexKey === indexKey) {
          this.db.indexes.delete(rowKey);
        }
      }
      this.db.lastChanges = 1;
      return Promise.resolve({ success: true, meta: { changes: 1 } });
    }
    if (
      canonical.startsWith(
        "delete from takosumi_accounts_documents where (takosumi_accounts_documents.bucket = ? and takosumi_accounts_documents.key = ?)",
      )
    ) {
      const [bucket, key] = this.#stringValues(2);
      this.db.lastChanges = this.db.documents.delete(documentKey(bucket, key))
        ? 1
        : 0;
      return Promise.resolve({
        success: true,
        meta: { changes: this.db.lastChanges },
      });
    }
    if (
      query.startsWith("INSERT OR REPLACE INTO takosumi_accounts_documents")
    ) {
      const [bucket, key, document] = this.#stringValues(3);
      this.db.documents.set(documentKey(bucket, key), document);
      this.db.lastChanges = 1;
      return Promise.resolve({ success: true, meta: { changes: 1 } });
    }
    if (query.startsWith("INSERT OR IGNORE INTO takosumi_accounts_documents")) {
      const [bucket, key, document] = this.#stringValues(3);
      const keyValue = documentKey(bucket, key);
      if (this.db.documents.has(keyValue)) {
        this.db.lastChanges = 0;
        return Promise.resolve({ success: true, meta: { changes: 0 } });
      }
      this.db.documents.set(keyValue, document);
      this.db.lastChanges = 1;
      return Promise.resolve({ success: true, meta: { changes: 1 } });
    }
    if (
      query.startsWith(
        "DELETE FROM takosumi_accounts_indexes WHERE bucket = ? AND document_key = ?",
      )
    ) {
      const [bucket, key] = this.#stringValues(2);
      for (const [indexKey, row] of this.db.indexes) {
        if (row.bucket === bucket && row.documentKey === key) {
          this.db.indexes.delete(indexKey);
        }
      }
      this.db.lastChanges = 1;
      return Promise.resolve({ success: true, meta: { changes: 1 } });
    }
    if (
      query.startsWith(
        "DELETE FROM takosumi_accounts_indexes WHERE index_name = ? AND index_key = ?",
      )
    ) {
      const [indexName, indexKey] = this.#stringValues(2);
      for (const [rowKey, row] of this.db.indexes) {
        if (row.indexName === indexName && row.indexKey === indexKey) {
          this.db.indexes.delete(rowKey);
        }
      }
      this.db.lastChanges = 1;
      return Promise.resolve({ success: true, meta: { changes: 1 } });
    }
    if (query.startsWith("INSERT OR REPLACE INTO takosumi_accounts_indexes")) {
      const [indexName, indexKey, bucket, key] = this.#stringValues(4);
      const sortKey = numberValue(this.#values[4]);
      this.db.indexes.set(indexRowKey(indexName, indexKey, bucket, key), {
        indexName,
        indexKey,
        bucket,
        documentKey: key,
        sortKey,
      });
      this.db.lastChanges = 1;
      return Promise.resolve({ success: true, meta: { changes: 1 } });
    }
    if (
      query.startsWith(
        "DELETE FROM takosumi_accounts_documents WHERE bucket = ? AND key = ?",
      )
    ) {
      const [bucket, key] = this.#stringValues(2);
      this.db.lastChanges = this.db.documents.delete(documentKey(bucket, key))
        ? 1
        : 0;
      return Promise.resolve({
        success: true,
        meta: { changes: this.db.lastChanges },
      });
    }
    throw new Error(`unexpected D1 run query: ${this.query}`);
  }

  first<T = unknown>(_column?: string): Promise<T | null> {
    const query = normalizedQuery(this.query);
    if (
      query.startsWith(
        "SELECT document FROM takosumi_accounts_documents WHERE bucket = ? AND key = ?",
      )
    ) {
      const [bucket, key] = this.#stringValues(2);
      const document = this.db.documents.get(documentKey(bucket, key));
      return Promise.resolve(document ? ({ document } as T) : null);
    }
    if (
      query.startsWith(
        "DELETE FROM takosumi_accounts_documents WHERE bucket = ? AND key = ? RETURNING document",
      )
    ) {
      const [bucket, key] = this.#stringValues(2);
      const keyValue = documentKey(bucket, key);
      const document = this.db.documents.get(keyValue);
      this.db.lastChanges = this.db.documents.delete(keyValue) ? 1 : 0;
      return Promise.resolve(document ? ({ document } as T) : null);
    }
    if (query === "SELECT changes() AS changes") {
      return Promise.resolve({ changes: this.db.lastChanges } as T);
    }
    if (
      query.startsWith(
        "SELECT version FROM takosumi_accounts_schema_migrations ORDER BY version DESC LIMIT 1",
      )
    ) {
      // Memory fixture mirrors a fresh D1: no migrations recorded yet.
      // Returning null lets handler.ts treat the schema as version 0,
      // matching the current EXPECTED_D1_SCHEMA_VERSION baseline.
      return Promise.resolve(null);
    }
    throw new Error(`unexpected D1 first query: ${this.query}`);
  }

  all<T = unknown>(): Promise<D1Result<T>> {
    const query = normalizedQuery(this.query);
    if (query.startsWith("SELECT d.document FROM takosumi_accounts_indexes")) {
      const [indexName, indexKey] = this.#stringValues(2);
      const rows = [...this.db.indexes.values()]
        .filter(
          (row) => row.indexName === indexName && row.indexKey === indexKey,
        )
        .sort(
          (left, right) =>
            left.sortKey - right.sortKey ||
            left.documentKey.localeCompare(right.documentKey),
        )
        .flatMap((row): DocumentRow[] => {
          const document = this.db.documents.get(
            documentKey(row.bucket, row.documentKey),
          );
          return document ? [{ document }] : [];
        });
      return Promise.resolve({ success: true, results: rows as T[] });
    }
    if (
      query.startsWith(
        "SELECT document FROM takosumi_accounts_documents WHERE bucket = ?",
      )
    ) {
      const [bucket] = this.#stringValues(1);
      const rows = [...this.db.documents.entries()]
        .filter(([key]) => key.startsWith(`${bucket}\n`))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([, document]) => ({ document }));
      return Promise.resolve({ success: true, results: rows as T[] });
    }
    throw new Error(`unexpected D1 all query: ${this.query}`);
  }

  raw(): Promise<unknown[][]> {
    const canonical = canonicalQuery(this.query);
    if (
      canonical.startsWith(
        "select document from takosumi_accounts_documents where (takosumi_accounts_documents.bucket = ? and takosumi_accounts_documents.key = ?)",
      )
    ) {
      const [bucket, key] = this.#stringValues(2);
      const document = this.db.documents.get(documentKey(bucket, key));
      return Promise.resolve(document ? [[document]] : []);
    }
    if (
      canonical.startsWith(
        "select takosumi_accounts_documents.document from takosumi_accounts_indexes inner join takosumi_accounts_documents",
      )
    ) {
      const [indexName, indexKey] = this.#stringValues(2);
      const rows = [...this.db.indexes.values()]
        .filter(
          (row) => row.indexName === indexName && row.indexKey === indexKey,
        )
        .sort(
          (left, right) =>
            left.sortKey - right.sortKey ||
            left.documentKey.localeCompare(right.documentKey),
        )
        .flatMap((row): unknown[][] => {
          const document = this.db.documents.get(
            documentKey(row.bucket, row.documentKey),
          );
          return document ? [[document]] : [];
        });
      return Promise.resolve(rows);
    }
    if (
      canonical.startsWith(
        "select document from takosumi_accounts_documents where takosumi_accounts_documents.bucket = ? order by takosumi_accounts_documents.key",
      )
    ) {
      const [bucket] = this.#stringValues(1);
      const rows = [...this.db.documents.entries()]
        .filter(([key]) => key.startsWith(`${bucket}\n`))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([, document]) => [document]);
      return Promise.resolve(rows);
    }
    throw new Error(`unexpected D1 raw query: ${this.query}`);
  }

  #stringValues(count: number): string[] {
    return this.#values.slice(0, count).map((value) => {
      if (typeof value !== "string") {
        throw new TypeError(
          `expected string D1 bind value, got ${typeof value}`,
        );
      }
      return value;
    });
  }

  #rawValues(): readonly D1Value[] {
    return this.#values;
  }
}

function stringBindValue(value: D1Value): string {
  if (typeof value !== "string") {
    throw new TypeError(`expected string D1 bind value, got ${typeof value}`);
  }
  return value;
}

function documentKey(bucket: string, key: string): string {
  return `${bucket}\n${key}`;
}

function indexRowKey(
  indexName: string,
  indexKey: string,
  bucket: string,
  key: string,
): string {
  return [indexName, indexKey, bucket, key].join("\n");
}

function normalizedQuery(query: string): string {
  return query.replace(/\s+/g, " ").trim();
}

function canonicalQuery(query: string): string {
  return query.replace(/"/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

function numberValue(value: D1Value): number {
  if (typeof value !== "number") {
    throw new TypeError(`expected number D1 bind value, got ${typeof value}`);
  }
  return value;
}

function sampleInstallation(): InstallationRecord {
  return {
    installationId: "inst_export",
    accountId: "acct_export",
    spaceId: "space_export",
    appId: "example.export",
    sourceGitUrl: "https://github.com/example/export",
    sourceRef: "main",
    sourceCommit: "abcdef123456",
    planDigest: "sha256:app",
    artifactDigest: "sha256:compiled",
    mode: "shared-cell",
    status: "ready",
    createdBySubject: "tsub_export",
    createdAt: Date.parse("2026-05-17T00:00:00.000Z"),
    updatedAt: Date.parse("2026-05-17T00:00:00.000Z"),
  };
}

class MemoryR2Bucket implements R2Bucket {
  readonly puts: {
    readonly key: string;
    readonly body: string;
    readonly options?: R2PutOptions;
  }[] = [];
  readonly #objects = new Map<
    string,
    {
      readonly body: string;
      readonly options?: R2PutOptions;
    }
  >();

  put(
    key: string,
    value: string | ArrayBuffer | ArrayBufferView | Blob | ReadableStream,
    options?: R2PutOptions,
  ): Promise<unknown> {
    if (typeof value !== "string") {
      throw new TypeError("test R2 bucket expects string bodies");
    }
    this.puts.push({ key, body: value, options });
    this.#objects.set(key, { body: value, options });
    return Promise.resolve({});
  }

  get(key: string): Promise<R2ObjectBody | null> {
    const object = this.#objects.get(key);
    if (!object) return Promise.resolve(null);
    const bytes = new TextEncoder().encode(object.body);
    return Promise.resolve({
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
      httpMetadata: object.options?.httpMetadata,
      customMetadata: object.options?.customMetadata,
      writeHttpMetadata(headers) {
        const contentType = object.options?.httpMetadata?.contentType;
        if (contentType) headers.set("content-type", contentType);
        const contentEncoding = object.options?.httpMetadata?.contentEncoding;
        if (contentEncoding) {
          headers.set("content-encoding", contentEncoding);
        }
      },
    });
  }
}
