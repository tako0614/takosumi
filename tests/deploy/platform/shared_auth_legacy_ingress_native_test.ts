import { expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { D1AccountsStore } from "../../../accounts/service/src/d1-store.ts";
import { applyD1AccountsMigrationBatch, loadD1AccountsMigrationCatalog } from "../../../accounts/service/src/d1-migrations.ts";
import { CloudflareD1OpenTofuControlStore, ensureD1OpenTofuLedgerSchema } from "../../../worker/src/d1_opentofu_store.ts";
import type { D1Database } from "../../../worker/src/bindings.ts";
import { createRunCredentialToken } from "../../../core/shared/run_credential_tokens.ts";
import { acquireControlD1MaintenanceFence } from "../../../worker/src/d1_schema_maintenance.ts";
import { seedCapsuleModel } from "../../helpers/deploy-control/model_fixture.ts";
import { base64UrlEncodeBytes } from "../../../accounts/service/src/encoding.ts";

const origin = "https://hosted.staging.example.test";
const aliases = [origin, "https://gateway.example.workers.dev",
  "https://version-preview-gateway.example.workers.dev", "https://alternate.example.test"];
const rpCookie = "__Host-takosumi_hosted_session=server-held-native-session";
const legacyCookie = "takosumi_session=sess_legacy_native";
const operatorToken = "fixture-independent-native-operator";
const runSecret = "fixture-run-signature-key-0123456789abcdef";
const clientSecret = "fixture-confidential-native-client";
const salt = "fixture-session-hash-salt-0123456789abcdef";
const protocolSecret = "fixture-external-service-signature-0123456789abcdef";
const privacySecret = "fixture-independent-privacy-operator";
const privacyRequestId = "prq_" + "a".repeat(20);
const provider = "registry.example/fixture/provider";
const issuance = { context: "capsule-run.v1", operatorConnection: "workspace-bindable",
  storedMaterial: "none", audience: "fixture.native.v1", scopes: ["fixture:invoke"] } as const;
const descriptor = { basePath: "/extensions/legacy-test", handlerKey: "LEGACY_TEST_EXTENSION",
  authDelivery: "context", runCredential: { audience: issuance.audience, requiredScopes: issuance.scopes } };

test("native platform HTTP closes primary and alias legacy ingress while preserving actual operator and current Run credentials", async () => {
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "fixtures/shared_auth_legacy_ingress_runtime.ts")],
    target: "browser", format: "esm", external: ["cloudflare:workers"],
  });
  expect(build.success, build.logs.map(String).join("\n")).toBe(true);
  const artifact = build.outputs[0];
  if (!artifact) throw new Error("native platform ingress bundle missing");
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const signingJwk = await crypto.subtle.exportKey("jwk", keys.privateKey);
  const bindings = {
    TAKOSUMI_SHARED_AUTH_PROFILE: "shared-account", TAKOSUMI_SHARED_AUTH_ORIGIN: origin,
    TAKOSUMI_ENVIRONMENT: "staging", TAKOSUMI_ACCOUNTS_ISSUER: origin,
    TAKOSUMI_ACCOUNTS_D1_SCHEMA_MODE: "predeployed",
    TAKOSUMI_ACCOUNTS_CLIENT_ID: "fixture-client", TAKOSUMI_ACCOUNTS_CLIENT_SECRET: clientSecret,
    TAKOSUMI_ACCOUNTS_REDIRECT_URIS: origin + "/fixture/callback",
    TAKOSUMI_ACCOUNT_SESSION_HASH_SALT: salt,
    FIXTURE_PROTOCOL_KEY: protocolSecret,
    TAKOSUMI_ACCOUNTS_PRIVACY_OPERATIONS_TOKEN: privacySecret,
    TAKOSUMI_ACCOUNTS_ES256_PRIVATE_JWK: JSON.stringify({ ...signingJwk, kid: "native-fixture" }),
    TAKOSUMI_ACCOUNTS_OIDC_PAIRWISE_SUBJECT_SECRET: "fixture-pairwise-subject-key-0123456789abcdef",
    TAKOSUMI_DEPLOY_CONTROL_TOKEN: operatorToken,
    TAKOSUMI_RUN_CREDENTIAL_TOKEN_SECRET: runSecret,
    TAKOSUMI_SECRET_STORE_KEY: "fixture-storage-encryption-key-0123456789abcdef",
    TAKOSUMI_PLATFORM_EXTENSIONS: JSON.stringify([descriptor, {
      basePath: "/extensions/protocol-test", handlerKey: "PROTOCOL_TEST_EXTENSION", authMode: "handler",
    }]),
  };
  const modules = [{ type: "ESModule" as const, path: "legacy-ingress.mjs", contents: await artifact.text() }];
  const runtime = new Miniflare({ workers: [
    { name: "gateway", compatibilityDate: "2026-07-17", compatibilityFlags: ["nodejs_compat"],
      modules, bindings, serviceBindings: { HOSTED: { name: "rp", entrypoint: "Authentication" } },
      d1Databases: { TAKOSUMI_ACCOUNTS_DB: "legacy-ingress-accounts", TAKOSUMI_CONTROL_DB: "legacy-ingress-control" } },
    { name: "missing-rp", compatibilityDate: "2026-07-17", compatibilityFlags: ["nodejs_compat"],
      modules, bindings, d1Databases: { TAKOSUMI_ACCOUNTS_DB: "legacy-ingress-accounts", TAKOSUMI_CONTROL_DB: "legacy-ingress-control" } },
    { name: "stock", compatibilityDate: "2026-07-17", compatibilityFlags: ["nodejs_compat"], modules,
      bindings: Object.fromEntries(Object.entries(bindings).filter(([key]) => !key.startsWith("TAKOSUMI_SHARED_AUTH_"))),
      d1Databases: { TAKOSUMI_ACCOUNTS_DB: "legacy-ingress-accounts", TAKOSUMI_CONTROL_DB: "legacy-ingress-control" } },
    { name: "unavailable-accounts", compatibilityDate: "2026-07-17", compatibilityFlags: ["nodejs_compat"], modules, bindings,
      serviceBindings: { HOSTED: { name: "rp", entrypoint: "Authentication" } },
      d1Databases: { TAKOSUMI_ACCOUNTS_DB: "legacy-ingress-empty-accounts", TAKOSUMI_CONTROL_DB: "legacy-ingress-control" } },
    { name: "rp", compatibilityDate: "2026-07-17",
      modules: [{ type: "ESModule", path: "rp.mjs", contents: await readFile(resolve(import.meta.dir, "fixtures/shared-auth-rpc-runtime.mjs"), "utf8") }],
      durableObjects: { SESSIONS: "Sessions" } },
  ] });
  try {
    const accountsDb = await runtime.getD1Database("TAKOSUMI_ACCOUNTS_DB", "gateway") as unknown as D1Database;
    for (const migration of (await loadD1AccountsMigrationCatalog()).migrations) {
      await applyD1AccountsMigrationBatch(accountsDb, migration, 1_000 + migration.version);
    }
    const accounts = new D1AccountsStore(accountsDb, { sessionHashSalt: salt, schemaMode: "predeployed" });
    const now = Date.now();
    await accounts.saveAccount({ subject: "tsub_native", createdAt: now, updatedAt: now });
    await accounts.saveAccountSession({ sessionId: "sess_legacy_native", subject: "tsub_native", createdAt: now, expiresAt: now + 60_000 });
    await accounts.saveAccessToken("fixture-valid-legacy-human", { clientId: "fixture-client", subject: "tsub_native", scope: "admin", expiresAt: now + 60_000 });
    await accounts.savePersonalAccessToken("fixture-valid-legacy-pat", { tokenId: "pat_native", tokenPrefix: "fixture", subject: "tsub_native",
      name: "Native legacy authority fixture", scopes: ["admin"], createdAt: now, expiresAt: now + 60_000 });
    await accounts.savePersonalAccessToken("fixture-revoked-legacy-pat", { tokenId: "pat_native_revoked", tokenPrefix: "fixture", subject: "tsub_native",
      name: "Retained revoked credential", scopes: ["admin"], createdAt: now, revokedAt: now });
    await accounts.saveAccountSession({ sessionId: "opaque-expired-local-human", subject: "tsub_native", createdAt: now - 120_000, expiresAt: now - 60_000 });
    await accounts.saveAccessToken("opaque-expired-local-oauth", { clientId: "fixture-client", subject: "tsub_native", scope: "openid", expiresAt: now - 60_000 });
    await accounts.savePrivacyRequest({ requestId: privacyRequestId, subject: "tsub_native", kind: "export", status: "processing",
      retentionRecordId: "retention_native", policyRef: "fixture-policy", createdAt: now, updatedAt: now });
    const protocolPayload = base64UrlEncodeBytes(new TextEncoder().encode(JSON.stringify({ kind: "service", sub: "independent-native-service",
      aud: "fixture-native-protocol", exp: now + 60_000 })));
    const protocolKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(protocolSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const protocolSignature = base64UrlEncodeBytes(new Uint8Array(await crypto.subtle.sign("HMAC", protocolKey, new TextEncoder().encode(protocolPayload))));
    const protocolToken = protocolPayload + "." + protocolSignature;
    const beforeClassifier = await accountsDb.prepare("SELECT bucket,key,document,updated_at FROM takosumi_accounts_documents ORDER BY bucket,key").all();
    const controlDb = await runtime.getD1Database("TAKOSUMI_CONTROL_DB", "gateway") as unknown as D1Database;
    await ensureD1OpenTofuLedgerSchema(controlDb);
    const store = new CloudflareD1OpenTofuControlStore(controlDb);
    const seeded = await seedCapsuleModel(store, { workspaceId: "ws_native", capsuleId: "cap_native" });
    await store.putCapsule({ ...seeded.capsule, installingPrincipalId: "principal_native" });
    await store.putWorkspaceMember({ id: "member_native", workspaceId: "ws_native", accountId: "tsub_native",
      status: "active", roles: ["owner"], createdAt: seeded.workspace.createdAt, updatedAt: seeded.workspace.updatedAt });
    await store.putPlanRun({ id: "plan_native", workspaceId: "ws_native", capsuleId: "cap_native", operation: "update", status: "running",
      source: { kind: "git", url: seeded.source.url, ref: "main", path: "." }, sourceDigest: "fixture-digest", variablesDigest: "fixture-variables",
      runnerProfileId: "fixture-runner", requiredProviders: [], policy: { allowed: true, reasons: [] }, policyDecisionDigest: "fixture-policy",
      auditEvents: [], createdAt: now, updatedAt: now } as never);
    await store.putConnection({ id: "conn_native", provider, providerSource: provider, scope: "operator", status: "verified",
      envNames: ["RUN_CREDENTIAL_TOKEN"], materialization: "run-issued",
      credentialRecipe: { id: "fixture-run-credential", authMode: "broker", preRunAction: "issue_run_credential", runIssuance: issuance },
      createdAt: seeded.workspace.createdAt, updatedAt: seeded.workspace.updatedAt });
    const run = await createRunCredentialToken({ secret: runSecret, audience: issuance.audience, subject: "forged-token-subject",
      workspaceId: "ws_native", capsuleId: "cap_native", runId: "plan_native", installingPrincipalId: "principal_native",
      connectionId: "conn_native", provider, phase: "plan", scopes: issuance.scopes });
    const gateway = await runtime.getWorker("gateway");
    // Fetcher.fetch enters real workerd HTTP routing with the supplied HTTPS
    // URL, including aliases. No session verifier or platform route is mocked.
    const fetch = (alias: string, path: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      // Miniflare rejects non-local Host/Origin before entering workerd. The
      // test-only driver restores them before the real platform entrypoint.
      for (const name of ["host", "origin"]) {
        const value = headers.get(name);
        if (value !== null) {
          headers.delete(name);
          headers.set(`x-fixture-original-${name}`, value);
        }
      }
      return gateway.fetch(alias + path, { ...init, headers, redirect: "manual" });
    };
    for (const alias of aliases) {
      const forgedHeaders = { cookie: legacyCookie, host: new URL(origin).host,
        "x-forwarded-host": new URL(origin).host, "forwarded": `host=${new URL(origin).host};proto=https`,
        "x-takosumi-platform-subject": "tsub_native", "x-takosumi-platform-auth-kind": "service-token" };
      for (const path of ["/api/v1/auth/providers", "/api/v1/auth/passkeys/authenticate/options", "/api/v1/auth/passkeys/register/complete",
        "/api/v1/account/tokens", "/api/v1/account/session/global-logout", "/oauth/upstream/authorize", "/oauth/upstream/callback", "/oauth/authorize"]) {
        const response = await fetch(alias, path, { headers: forgedHeaders });
        expect(response.status, alias + path + " " + await response.clone().text()).toBe(404);
        expect(response.headers.get("set-cookie")).toBeNull();
      }
      expect((await fetch(alias, "/sign-in", { headers: forgedHeaders })).status).toBe(alias === origin ? 302 : 404);
      const control = await fetch(alias, "/api/v1/workspaces/ws_native", { headers: forgedHeaders });
      expect(control.status, alias).toBe(401);
      for (const path of ["/api/v1/workspaces/ws_native", "/extensions/legacy-test"]) {
        for (const credential of ["fixture-valid-legacy-human", "fixture-valid-legacy-pat", "sess_legacy_native"]) {
          expect((await fetch(alias, path, { headers: { authorization: `Bearer ${credential}`, "x-takosumi-platform-auth-kind": "service-token" } })).status).toBe(401);
        }
        expect((await fetch(alias, path, { headers: { cookie: rpCookie, authorization: `Bearer ${operatorToken}` } })).status).toBe(401);
      }
      const operator = await fetch(alias, "/extensions/legacy-test", { headers: { authorization: `Bearer ${operatorToken}`, "x-takosumi-platform-subject": "forged" } });
      expect(operator.status).toBe(200);
      expect(await operator.json()).toMatchObject({ actor: { authKind: "service-token", subject: "takosumi:deploy-control" }, cookie: null, authorization: null, forgedSubject: null });
      const machine = await fetch(alias, "/extensions/legacy-test", { headers: { authorization: `Bearer ${run.token}` } });
      expect(machine.status, await machine.clone().text()).toBe(200);
      expect(await machine.json()).toMatchObject({ actor: { authKind: "run-credential", subject: "principal_native", runId: "plan_native", workspaceId: "ws_native" } });
      expect((await fetch(alias, "/extensions/legacy-test", { headers: { authorization: `Bearer ${run.token}tampered` } })).status).toBe(401);
      for (const credential of ["fixture-valid-legacy-human", "fixture-valid-legacy-pat", "sess_legacy_native",
        "fixture-revoked-legacy-pat", "opaque-expired-local-human", "opaque-expired-local-oauth"]) {
        const denied = await fetch(alias, "/extensions/protocol-test", { headers: { authorization: `Bearer ${credential}` } });
        expect(denied.status).toBe(401);
        expect(denied.headers.get("x-fixture-protocol-handler")).toBeNull();
      }
      const external = await fetch(alias, "/extensions/protocol-test", { headers: { authorization: `Bearer ${protocolToken}`, "x-takosumi-platform-subject": "forged-owner" } });
      expect(external.status, await external.clone().text()).toBe(200);
      expect(await external.json()).toEqual({ actor: { kind: "service", subject: "independent-native-service" }, cookie: null, trustedSubject: null });
      const invalidExternal = await fetch(alias, "/extensions/protocol-test", { headers: { authorization: `Bearer ${protocolToken}bad` } });
      expect(invalidExternal.status).toBe(401);
      expect(invalidExternal.headers.get("x-fixture-protocol-handler")).toBe("reached");
      const ambiguousProtocol = await fetch(alias, "/extensions/protocol-test", { headers: { authorization: `Bearer ${protocolToken}`, cookie: rpCookie } });
      expect(ambiguousProtocol.status).toBe(401);
      expect(ambiguousProtocol.headers.get("x-fixture-protocol-handler")).toBeNull();
    }
    expect((await accountsDb.prepare("SELECT bucket,key,document,updated_at FROM takosumi_accounts_documents ORDER BY bucket,key").all()).results).toEqual(beforeClassifier.results);
    // Native confidential introspection still returns the same valid human
    // grant: the product boundary denies its authority without changing OIDC.
    const introspect = await fetch(origin, "/oauth/introspect", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: "fixture-valid-legacy-human", client_id: "fixture-client", client_secret: clientSecret }).toString() });
    expect(introspect.status, await introspect.clone().text()).toBe(200);
    expect(await introspect.json()).toMatchObject({ active: true, token_use: "oauth_access", sub: "tsub_native", scope: "admin" });
    expect((await fetch(origin, "/oauth/jwks")).status).toBe(200);
    const token = await fetch(origin, "/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "unsupported", client_id: "fixture-client", client_secret: clientSecret }).toString() });
    expect(token.status).toBe(400);
    expect(await token.json()).toMatchObject({ error: "unsupported_grant_type" });
    const stock = await runtime.getWorker("stock");
    expect((await stock.fetch(origin + "/api/v1/auth/providers")).status).toBe(200);
    const oldSession = await stock.fetch(origin + "/api/v1/account/session/me", { headers: { cookie: legacyCookie } });
    expect(oldSession.status).toBe(200);
    expect(await oldSession.json()).toMatchObject({ subject: "tsub_native" });
    const stockHuman = await stock.fetch(origin + "/extensions/legacy-test", { headers: { authorization: "Bearer fixture-valid-legacy-human" } });
    expect(stockHuman.status, await stockHuman.clone().text()).toBe(200);
    expect((await stock.fetch(origin + "/extensions/legacy-test", { headers: { authorization: "Bearer fixture-valid-legacy-pat" } })).status).toBe(200);
    const stockKnown = await stock.fetch(origin + "/extensions/protocol-test", { headers: { authorization: "Bearer fixture-revoked-legacy-pat" } });
    expect(stockKnown.headers.get("x-fixture-protocol-handler")).toBe("reached");
    const unavailable = await runtime.getWorker("unavailable-accounts");
    const unavailableDb = await runtime.getD1Database("TAKOSUMI_ACCOUNTS_DB", "unavailable-accounts");
    const noSchemaBefore = await unavailableDb.prepare("SELECT name FROM sqlite_master WHERE name='takosumi_accounts_documents'").all();
    const readFailure = await unavailable.fetch(origin + "/extensions/protocol-test", { headers: { authorization: `Bearer ${protocolToken}` } });
    expect(readFailure.status).toBe(503);
    expect(readFailure.headers.get("x-fixture-protocol-handler")).toBeNull();
    expect((await unavailableDb.prepare("SELECT name FROM sqlite_master WHERE name='takosumi_accounts_documents'").all()).results).toEqual(noSchemaBefore.results);
    const completePath = `/api/v1/privacy/requests/${privacyRequestId}/complete`;
    for (const headers of [{ cookie: legacyCookie }, { "x-takosumi-privacy-operations-token": "wrong-secret" }]) {
      const denied = await fetch(origin, completePath, { method: "POST", headers: { ...headers, "content-type": "application/json", origin },
        body: JSON.stringify({ status: "exported", export_ref: "fixture/export" }) });
      expect(denied.status).toBe(401);
    }
    const privacy = await fetch(origin, completePath, { method: "POST", headers: { origin, "content-type": "application/json",
      "x-takosumi-privacy-operations-token": privacySecret }, body: JSON.stringify({ status: "exported", export_ref: "fixture/export" }) });
    expect(privacy.status, await privacy.clone().text()).toBe(200);
    expect(await privacy.json()).toMatchObject({ request: { request_id: privacyRequestId, status: "exported" } });
    const missing = await runtime.getWorker("missing-rp");
    expect((await missing.fetch(origin + "/extensions/legacy-test", { headers: { authorization: `Bearer ${operatorToken}` } })).status).toBe(503);
    const sessions = await runtime.getDurableObjectNamespace("SESSIONS", "rp");
    const session = sessions.get(sessions.idFromName("current"));
    const current = await fetch(origin, "/api/v1/workspaces/ws_native", { headers: { cookie: rpCookie } });
    expect(current.status, await current.clone().text()).toBe(200);
    await session.change("revoked");
    expect((await fetch(origin, "/api/v1/workspaces/ws_native", { headers: { cookie: rpCookie } })).status).toBe(401);
    await session.change("unavailable");
    expect((await fetch(origin, "/api/v1/workspaces/ws_native", { headers: { cookie: rpCookie } })).status).toBe(503);
    await session.change("tsub_native");
    // Current Run state is re-read rather than inferred from its signed subject.
    const plan = await store.getPlanRun("plan_native");
    await store.putPlanRun({ ...plan!, status: "succeeded" });
    expect((await fetch(origin, "/extensions/legacy-test", { headers: { authorization: `Bearer ${run.token}` } })).status).toBe(401);
    const revoke = await fetch(origin, "/oauth/revoke", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: "fixture-valid-legacy-human", client_id: "fixture-client", client_secret: clientSecret }).toString() });
    expect(revoke.status).toBe(200);
    expect(await accounts.findAccessToken("fixture-valid-legacy-human")).toBeUndefined();
    await acquireControlD1MaintenanceFence(controlDb, { sourceCommit: "f".repeat(40), manifestDigest: "sha256:" + "f".repeat(64),
      environment: "staging", databaseRole: "in_place", releasePolicy: "in_place" }, new Date().toISOString());
    const fenced = await fetch(origin, "/api/v1/workspaces/ws_native", { headers: { cookie: rpCookie } });
    // Existing Control error translation is 500, still an explicit denial
    // with no Workspace data. This fixture does not claim retryable readiness.
    expect(fenced.status, await fenced.clone().text()).toBe(500);
    expect(await fenced.json()).toMatchObject({ error: { code: "internal_error" } });
  } finally {
    await runtime.dispose();
  }
}, 90_000);
