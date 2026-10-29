import { expect, setSystemTime, test } from "bun:test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  AUTH_STAGING_DEFAULT_HANDLERS,
  AUTH_STAGING_NAMED_HANDLERS,
  AUTH_STAGING_SIGNING_KEY_MIN_OVERLAP_MS,
  AuthStagingIncompleteError,
  createAuthStagingIdentityRotation,
  parseAuthStagingIdentityRotation,
  runAuthStagingRelease,
  type AuthStagingIdentityRotation,
  type AuthStagingIdentityRotationScope,
  assertAuthStagingPlacement,
  uploadedPlacementTarget,
  assertAuthStagingVersion,
  authStagingResourceBindings,
  createAuthStagingPlan,
  executeAuthStagingRelease,
  parseAuthStagingTarget,
  verifyAuthStagingSchemaTarget,
  type AuthStagingProvider,
  type AuthStagingReleaseRuntime,
} from "../../scripts/auth-staging-release.ts";
import { AUTH_STAGING_CLIENTS, AUTH_STAGING_COMPATIBILITY_DATE, AUTH_STAGING_HOST, AUTH_STAGING_ISSUER, AUTH_STAGING_PLACEMENT, AUTH_STAGING_WORKER } from "../../deploy/accounts-cloudflare/src/staging-target.ts";
import { parseAppOwnershipMutationsFrozen } from "../../accounts/service/src/app-ownership-mutations-freeze.ts";
import { parseWorkspaceMutationsFrozen } from "../../accounts/service/src/workspace-mutations-freeze.ts";
import { parseInstalledAppDelegationSources } from "../../accounts/service/src/installed-app-delegation.ts";

const sha = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const uuid = (character: string) => `${character.repeat(8)}-${character.repeat(4)}-${character.repeat(4)}-${character.repeat(4)}-${character.repeat(12)}`;
const canonicalVersion = uuid("1");
const previousVersion = uuid("2");
const uploadedVersion = uuid("3");
const bytes = new TextEncoder().encode("export default {fetch(){return new Response('fixture')}}");
const config = `name = "takosumi-staging"
[vars]
TAKOSUMI_ENVIRONMENT = "staging"
TAKOSUMI_ACCOUNTS_ISSUER = "https://app-staging.takosumi.com"
TAKOSUMI_ACCOUNTS_D1_SCHEMA_MODE = "predeployed"
TAKOSUMI_CONTROL_D1_SCHEMA_MODE = "predeployed"
${["TAKOSUMI_ACCOUNTS_DB", "TAKOSUMI_CONTROL_DB"].map((name, index) => `[[d1_databases]]\nbinding = "${name}"\ndatabase_id = "${uuid(String(index + 4))}"`).join("\n")}
${["R2_ARTIFACTS", "R2_SOURCE", "R2_STATE", "R2_BACKUPS"].map((name) => `[[r2_buckets]]\nbinding = "${name}"\nbucket_name = "${name.toLowerCase()}-staging"`).join("\n")}
${[["COORDINATION", "CoordinationObject"], ["RUN_OWNER", "OpenTofuRunOwnerObject"], ["RUNNER", "OpenTofuRunnerObject"]].map(([name, className]) => `[[durable_objects.bindings]]\nname = "${name}"\nclass_name = "${className}"`).join("\n")}
`;
const clientMetadata = AUTH_STAGING_CLIENTS.map((client) => ({ ...client, allowedScopes: ["openid", "email", "offline_access"], tokenEndpointAuthMethod: "client_secret_basic", profile: "shared-account", enabled: true }));
const upstreamMetadata = [
  { providerId: "google", protocol: "oidc", verificationProfile: "google-oidc", issuer: "https://accounts.google.com", authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth", tokenEndpoint: "https://oauth2.googleapis.com/token", userInfoEndpoint: "https://openidconnect.googleapis.com/v1/userinfo", clientId: "fixture-google-client", clientSecretEnv: "TAKOSUMI_ACCOUNTS_UPSTREAM_GOOGLE_CLIENT_SECRET", redirectUri: `${AUTH_STAGING_ISSUER}/oauth/upstream/callback` },
  { providerId: "github", protocol: "oauth2", verificationProfile: "github-oauth", issuer: "https://github.com", authorizationEndpoint: "https://github.com/login/oauth/authorize", tokenEndpoint: "https://github.com/login/oauth/access_token", userInfoEndpoint: "https://api.github.com/user", clientId: "fixture-github-client", clientSecretEnv: "TAKOSUMI_ACCOUNTS_UPSTREAM_GITHUB_CLIENT_SECRET", redirectUri: `${AUTH_STAGING_ISSUER}/oauth/upstream/callback` },
];
const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const privateJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);
const keyId = "fixture-auth-staging-key";
const publicJwk = { kty: "EC", crv: "P-256", x: privateJwk.x, y: privateJwk.y, kid: keyId, use: "sig", alg: "ES256" };
const secrets = {
  TAKOSUMI_ACCOUNTS_ES256_PRIVATE_JWK: JSON.stringify(privateJwk),
  TAKOSUMI_ACCOUNTS_OIDC_PAIRWISE_SUBJECT_SECRET: Buffer.alloc(32, 21).toString("base64url"),
  TAKOSUMI_ACCOUNT_SESSION_HASH_SALT: Buffer.alloc(32, 22).toString("base64url"),
  TAKOSUMI_ACCOUNTS_HOSTED_STAGE_CLIENT_SECRET: Buffer.alloc(32, 11).toString("base64url"),
  TAKOSUMI_ACCOUNTS_SERVER_STAGE_CLIENT_SECRET: Buffer.alloc(32, 12).toString("base64url"),
  TAKOSUMI_ACCOUNTS_SUBJECT_SECRET: Buffer.alloc(32, 23).toString("base64url"),
  TAKOSUMI_ACCOUNTS_UPSTREAM_GOOGLE_CLIENT_SECRET: "fixture-google-secret",
  TAKOSUMI_ACCOUNTS_UPSTREAM_GITHUB_CLIENT_SECRET: "fixture-github-secret",
  TAKOSUMI_SECRET_STORE_PASSPHRASE: Buffer.alloc(32, 31).toString("base64url"),
  TAKOSUMI_DEPLOY_CONTROL_TOKEN: Buffer.alloc(32, 32).toString("base64url"),
};
const identityContinuity = sha(JSON.stringify(["TAKOSUMI_ACCOUNTS_ES256_PRIVATE_JWK", "TAKOSUMI_ACCOUNTS_OIDC_PAIRWISE_SUBJECT_SECRET", "TAKOSUMI_ACCOUNTS_SUBJECT_SECRET", "TAKOSUMI_ACCOUNT_SESSION_HASH_SALT"].map((name) => [name, sha((secrets as Record<string, string>)[name]!)])));
const continuityBinding = { name: "TAKOSUMI_AUTH_IDENTITY_CONTINUITY_DIGEST", type: "plain_text", text: identityContinuity };

function fixtureTarget() {
  return parseAuthStagingTarget({
    kind: "takosumi.auth-staging-target@v1", environment: "staging", worker: AUTH_STAGING_WORKER, issuer: AUTH_STAGING_ISSUER,
    accountId: "a".repeat(32), zoneId: "b".repeat(32), repository: "https://github.com/tako0614/takosumi", sourceCommit: "c".repeat(40),
    canonicalStageConfigSha256: sha(config), canonicalStageVersionId: canonicalVersion, secretsSha256: sha(JSON.stringify(secrets)), jwksSha256: sha(JSON.stringify({ keys: [publicJwk] })), requiredSecrets: Object.keys(secrets),
    vars: { TAKOSUMI_ENVIRONMENT: "staging", TAKOSUMI_AUTH_WORKER_NAME: AUTH_STAGING_WORKER, TAKOSUMI_ACCOUNTS_ISSUER: AUTH_STAGING_ISSUER, TAKOSUMI_ACCOUNTS_D1_SCHEMA_MODE: "predeployed", TAKOSUMI_CONTROL_D1_SCHEMA_MODE: "predeployed", TAKOSUMI_ACCOUNTS_HOSTED_SESSION_POLICY: "true", TAKOSUMI_ACCOUNTS_WORKSPACE_BILLING_AUTHORITY: "takoserver.hosted.staging-test.v1", TAKOSUMI_ACCOUNTS_ES256_KEY_ID: keyId, TAKOSUMI_ACCOUNTS_CLIENTS: JSON.stringify(clientMetadata), TAKOSUMI_ACCOUNTS_UPSTREAM_PROVIDERS: JSON.stringify(upstreamMetadata) },
  });
}

function harness(options: { exists?: boolean; active?: boolean; schemaError?: boolean; lostUploadAck?: boolean; badBinding?: boolean; badNamespace?: boolean; wrongCanonical?: boolean; wrongCurrent?: boolean; extraPreview?: boolean; publicError?: boolean; domainOwned?: boolean; schedules?: readonly {cron:string}[]; lostScheduleAck?: boolean; placement?: (uploaded: unknown) => unknown; versionPlacement?: unknown; predecessor?: (bindings: Record<string, unknown>[]) => Record<string, unknown>[]; servedSince?: number | null; staleContinuity?: boolean } = {}) {
  const target = fixtureTarget();
  const plan = createAuthStagingPlan(target, config, bytes);
  let exists = options.exists ?? true;
  let active = options.active ?? false;
  let schedules = options.schedules ?? (active ? [{cron:"*/1 * * * *"}] : []);
  let current = previousVersion;
  // Deployments list `created_on` as the Workers deployments API does; null omits it.
  let servedSince: number | null = options.servedSince === undefined ? Date.now() - 24 * 60 * 60 * 1000 : options.servedSince;
  let version: Record<string, unknown> = {};
  let settings: Record<string, unknown> = { placement: {} };
  const requests: { method: string; path: string; body?: BodyInit }[] = [];
  let schemaCalls = 0;
  let publicCalls = 0;
  let bootstrapCalls = 0;
  const canonicalBindings = plan.bindings.map((binding) => ({ ...binding, ...(binding.type === "durable_object_namespace" ? { namespace_id: `fixture-${binding.name}`, script_name: undefined } : {}) }));
  const provider: AuthStagingProvider = {
    async request(method, path, body) {
      requests.push({ method, path, body });
      if (path === `/workers/scripts/${AUTH_STAGING_WORKER}/script-settings`) return exists ? {} : null;
      if (path === `/workers/scripts/${AUTH_STAGING_WORKER}/settings`) return settings;
      if (path === `/workers/scripts/takosumi-staging/versions/${canonicalVersion}`) return { resources: { bindings: canonicalBindings.map((binding) => options.wrongCanonical && binding.name === "TAKOSUMI_ACCOUNTS_DB" ? { ...binding, id: uuid("f") } : binding) } };
      if (path === "/workers/scripts/takosumi-staging/deployments") return { deployments: [{ versions: [{ version_id: options.wrongCurrent ? uuid("f") : canonicalVersion, percentage: 100 }] }] };
      if (path.endsWith("/subdomain")) return { enabled: false, previews_enabled: false };
      if (path.endsWith("/schedules")) { if (method === "PUT") { schedules = JSON.parse(String(body)); if (options.lostScheduleAck) throw new Error("fixture_lost_schedule_ack"); } return { schedules }; }
      if (path.endsWith("/workers/routes")) return [];
      if (path.startsWith("/workers/domains?service=")) return active ? [{ hostname: AUTH_STAGING_HOST, service: AUTH_STAGING_WORKER, zone_id: target.zoneId, enabled: true, previews_enabled: options.extraPreview ?? false }] : [];
      if (path.startsWith("/workers/domains?hostname=")) return options.domainOwned ? [{ service: "foreign-worker" }] : [];
      if (method === "PUT" && path === "/workers/domains") { active = true; return {}; }
      if (path.endsWith("/deployments")) {
        if (method === "POST") { current = uploadedVersion; servedSince = Date.now(); }
        return { deployments: [{ ...(servedSince === null ? {} : { created_on: new Date(servedSince).toISOString() }), versions: [{ version_id: current, percentage: 100 }] }] };
      }
      if (method === "POST" && path.endsWith("/versions")) {
        const form = body as FormData;
        const metadata = JSON.parse(String(form.get("metadata")));
        // Provider echo observed 2026-10-22: the Version names the region, settings only the target id.
        settings = { placement: options.placement ? options.placement(metadata.placement) : { mode: metadata.placement.mode, target: [30] } };
        const bindings = metadata.bindings.map((binding: Record<string, unknown>) => {
          if (options.badBinding && binding.name === "TAKOSUMI_ACCOUNTS_DB") return { ...binding, id: uuid("f") };
          if (binding.type === "durable_object_namespace") return { ...binding, namespace_id: options.badNamespace ? "foreign-namespace" : `fixture-${binding.name}` };
          if (binding.type === "secret_text") return { name: binding.name, type: binding.type };
          if (options.staleContinuity && binding.name === "TAKOSUMI_AUTH_IDENTITY_CONTINUITY_DIGEST") return { ...binding, text: identityContinuity };
          return binding;
        });
        version = { resources: { script: { placement: options.versionPlacement === undefined ? { mode: metadata.placement.mode, target: [{ id: 30, region: metadata.placement.region, type: "region" }] } : options.versionPlacement, placement_mode: "targeted", handlers: ["scheduled", "fetch"], named_handlers: [{ name: "AccountsFinancialProof", handlers: ["fetch", "prove", "loadFinancialIdentityProof", "verifyCurrentFinancialIdentityProof"] }, { name: "AccountsOwnerAdmission", handlers: ["readOwnerOperation"] }] }, script_runtime: { compatibility_date: AUTH_STAGING_COMPATIBILITY_DATE, compatibility_flags: ["nodejs_compat"] }, bindings } };
        if (options.lostUploadAck) throw new Error("fixture_lost_ack");
        return { id: uploadedVersion };
      }
      if (path.endsWith(`/versions/${uploadedVersion}`)) return version;
      if (path.endsWith(`/versions/${previousVersion}`)) {
        const value = existingVersion();
        return options.predecessor ? { resources: { ...value.resources, bindings: options.predecessor(value.resources.bindings as Record<string, unknown>[]) } } : value;
      }
      throw new Error(`unexpected fixture path ${path}`);
    },
  };
  const existingVersion = () => ({ resources: { script: { handlers: ["scheduled", "fetch"], named_handlers: [{ name: "AccountsFinancialProof", handlers: ["fetch", "prove", "loadFinancialIdentityProof", "verifyCurrentFinancialIdentityProof"] }, { name: "AccountsOwnerAdmission", handlers: ["readOwnerOperation"] }] }, script_runtime: { compatibility_date: AUTH_STAGING_COMPATIBILITY_DATE, compatibility_flags: ["nodejs_compat"] }, bindings: [
    ...plan.bindings.map((binding) => ({ ...binding, ...(binding.type === "durable_object_namespace" ? { namespace_id: `fixture-${binding.name}` } : {}) })),
    ...Object.entries(target.vars).map(([name, text]) => ({ name, type: "plain_text", text })),
    { name: "TAKOSUMI_AUTH_ARTIFACT_DIGEST", type: "plain_text", text: plan.artifactDigest }, { name: "TAKOSUMI_AUTH_AUTHORITY_DIGEST", type: "plain_text", text: plan.authorityDigest },
    { name: "TAKOSUMI_AUTH_SOURCE_COMMIT", type: "plain_text", text: target.sourceCommit }, continuityBinding, { name: "TAKOSUMI_VERSION_METADATA", type: "version_metadata" }, ...target.requiredSecrets.map((name) => ({ name, type: "secret_text" })),
  ] } });
  const runtime: AuthStagingReleaseRuntime = {
    provider, async verifySchema() { schemaCalls++; if (options.schemaError) throw new Error("fixture_v4_or_drifted_schema"); },
    async publicReadback() { publicCalls++; if (options.publicError) throw new Error("fixture_readback_failed"); },
    async bootstrap() { bootstrapCalls++; exists = true; },
  };
  const execute = (action: "bootstrap" | "authority" | "code" | "topology", overrides = {}) => executeAuthStagingRelease({ action, target, plan, artifact: bytes, secrets, confirmation: plan.confirmation, reviewer: "independent-fixture-reviewer", ...overrides }, runtime);
  return { target, plan, runtime, requests, execute, counts: () => ({ schemaCalls, publicCalls, bootstrapCalls }) };
}

test("the readback handler surface is exactly what entry-worker exports", async () => {
  // Build the issuer entry as the release does, with a stub runtime base class,
  // so a new export or method fails here instead of after a live upload.
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "../../deploy/accounts-cloudflare/src/entry-worker.ts")], target: "browser", format: "esm",
    plugins: [{ name: "stub-cloudflare-workers", setup(builder) {
      builder.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: "cloudflare:workers", namespace: "stub" }));
      builder.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "export class WorkerEntrypoint {}", loader: "js" }));
    } }],
  });
  expect(build.success).toBe(true);
  const directory = mkdtempSync(join(tmpdir(), "takosumi-auth-entry-surface-"));
  try {
    const path = join(directory, "entry.mjs");
    writeFileSync(path, await build.outputs[0]!.text());
    const module = await import(path) as Record<string, unknown>;
    const functions = (value: object) => Object.keys(value).filter((key) => typeof (value as Record<string, unknown>)[key] === "function").sort();
    expect(functions(module.default as object)).toEqual([...AUTH_STAGING_DEFAULT_HANDLERS].sort());
    const named = Object.keys(module).filter((key) => key !== "default").sort();
    expect(named).toEqual(Object.keys(AUTH_STAGING_NAMED_HANDLERS).sort());
    for (const name of named) {
      const prototype = (module[name] as { prototype: object }).prototype;
      const methods = Object.getOwnPropertyNames(prototype).filter((key) => key !== "constructor").sort();
      expect({ name, methods }).toEqual({ name, methods: [...AUTH_STAGING_NAMED_HANDLERS[name]!].sort() });
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("version readback accepts only the exact provider-reported handler surface of entry-worker", () => {
  const { target, plan } = harness();
  const version = () => ({ resources: {
    // Named entrypoint order as the Workers versions API reported it for the uploaded issuer.
    script: { handlers: ["scheduled", "fetch"], named_handlers: [
      { name: "AccountsFinancialProof", handlers: ["fetch", "prove", "loadFinancialIdentityProof", "verifyCurrentFinancialIdentityProof"] },
      { name: "AccountsOwnerAdmission", handlers: ["readOwnerOperation"] },
    ] },
    script_runtime: { compatibility_date: AUTH_STAGING_COMPATIBILITY_DATE, compatibility_flags: ["nodejs_compat"], usage_model: "standard" },
    bindings: [
      ...plan.bindings.map((binding) => ({ ...binding, ...(binding.type === "durable_object_namespace" ? { namespace_id: `fixture-${binding.name}` } : {}) })),
      ...Object.entries(target.vars).map(([name, text]) => ({ name, type: "plain_text", text })),
      { name: "TAKOSUMI_AUTH_ARTIFACT_DIGEST", type: "plain_text", text: plan.artifactDigest }, { name: "TAKOSUMI_AUTH_AUTHORITY_DIGEST", type: "plain_text", text: plan.authorityDigest },
      { name: "TAKOSUMI_AUTH_SOURCE_COMMIT", type: "plain_text", text: target.sourceCommit }, continuityBinding, { name: "TAKOSUMI_VERSION_METADATA", type: "version_metadata" },
      ...target.requiredSecrets.map((name) => ({ name, type: "secret_text" })),
    ],
  } });
  expect(() => assertAuthStagingVersion(version(), plan, target)).not.toThrow();
  const changes: ((script: { handlers: string[]; named_handlers: { name: string; handlers: string[] }[] }) => void)[] = [
    (script) => { script.handlers.push("queue"); },
    (script) => { script.handlers.push("resolvePrivateFinancialSource"); },
    (script) => { script.handlers = ["fetch"]; },
    (script) => { script.named_handlers = script.named_handlers.filter((entry) => entry.name !== "AccountsFinancialProof"); },
    (script) => { script.named_handlers.push({ name: "AccountsDebug", handlers: ["fetch"] }); },
    (script) => { script.named_handlers[0]!.handlers.push("control"); },
    (script) => { script.named_handlers[1]!.handlers = []; },
    (script) => { script.named_handlers.push({ ...script.named_handlers[1]! }); },
  ];
  for (const change of changes) {
    const value = version();
    change(value.resources.script as never);
    expect(() => assertAuthStagingVersion(value, plan, target)).toThrow("auth_staging_entrypoint_invalid");
  }
});

test("target rejects production Worker/environment/issuer, unregistered callbacks, inline secrets and client disable", () => {
  const target = fixtureTarget();
  for (const patch of [{ worker: "takosumi" }, { issuer: "https://auth.takos.jp" }, { environment: "production" }, { clientId: "extra" }]) expect(() => parseAuthStagingTarget({ ...target, ...patch })).toThrow();
  for (const patch of [{ redirectUris: ["https://app.takosumi.com/auth/oidc/callback"] }, { clientSecret: "inline" }, { enabled: false }, { allowedScopes: ["openid", "admin"] }, { tokenEndpointAuthMethod: "none" }]) expect(() => parseAuthStagingTarget({ ...target, vars: { ...target.vars, TAKOSUMI_ACCOUNTS_CLIENTS: JSON.stringify([{ ...clientMetadata[0], ...patch }, clientMetadata[1]]) } })).toThrow();
  expect(() => parseAuthStagingTarget({ ...target, vars: { ...target.vars, TAKOSUMI_ACCOUNTS_CLIENTS: JSON.stringify([clientMetadata[0], { ...clientMetadata[1], redirectUris: ["https://takoserver-console-integration.shoutatomiyama0614.workers.dev/auth/oidc/callback"] }]) } })).toThrow();
});

test("staging console accepts exactly the existing callbacks and the new 9d Root callback", () => {
  const previous = "https://integration-money-8732b77a789fd563406269261bf09e71.shoutatomiyama0614.workers.dev/auth/oidc/callback";
  const existingRoot = "https://integration-root-ga-573f46e4.shoutatomiyama0614.workers.dev/auth/oidc/callback";
  const freshRoot = "https://integration-root-ga-9d9c84f4281649c884e0579d93e5c926.shoutatomiyama0614.workers.dev/auth/oidc/callback";
  const client = AUTH_STAGING_CLIENTS.find((entry) => entry.clientId === "takoserver-console-staging-v1");
  expect(client?.redirectUris).toEqual([previous, existingRoot, freshRoot]);
  const target = fixtureTarget();
  expect(() => parseAuthStagingTarget(target)).not.toThrow();
  for (const redirectUris of [
    [previous],
    [previous, existingRoot],
    [previous, freshRoot],
    [previous, existingRoot, `${freshRoot}/`],
    [previous, existingRoot, `${freshRoot}?next=/`],
    [previous, existingRoot, freshRoot.replace("9d9c84f4281649c884e0579d93e5c926", "9d9c84f4281649c884e0579d93e5c927")],
    [previous, existingRoot, freshRoot, freshRoot],
    [previous, existingRoot, freshRoot, "https://integration-root-ga-unregistered.shoutatomiyama0614.workers.dev/auth/oidc/callback"],
    [previous, "https://takoserver.takos.jp/auth/oidc/callback"],
  ]) {
    expect(() => parseAuthStagingTarget({ ...target, vars: { ...target.vars, TAKOSUMI_ACCOUNTS_CLIENTS: JSON.stringify(clientMetadata.map((entry) => entry.clientId === "takoserver-console-staging-v1" ? { ...entry, redirectUris } : entry)) } })).toThrow("auth_staging_clients_invalid");
  }
});

test("the staging target pins Financial's Workspace billing authority", () => {
  const base = fixtureTarget();
  const { TAKOSUMI_ACCOUNTS_WORKSPACE_BILLING_AUTHORITY: _pinned, ...missing } = base.vars;
  for (const vars of [missing, { ...base.vars, TAKOSUMI_ACCOUNTS_WORKSPACE_BILLING_AUTHORITY: "takoserver.hosted.production.v1" }]) {
    expect(() => parseAuthStagingTarget({ ...base, vars })).toThrow("auth_staging_variables_invalid");
  }
});

test("upstream and passkey cannot cross to production and all secret refs must be closed", () => {
  const target = fixtureTarget();
  for (const patch of [{ redirectUri: "https://auth.takos.jp/oauth/upstream/callback" }, { clientSecretEnv: "FOREIGN_SECRET" }, { verificationProfile: "unverified" }]) expect(() => parseAuthStagingTarget({ ...target, vars: { ...target.vars, TAKOSUMI_ACCOUNTS_UPSTREAM_PROVIDERS: JSON.stringify([{ ...upstreamMetadata[0], ...patch }, upstreamMetadata[1]]) } })).toThrow();
  expect(() => parseAuthStagingTarget({ ...target, vars: { ...target.vars, TAKOSUMI_ACCOUNTS_PASSKEY_ORIGIN: "https://auth.takos.jp" } })).toThrow();
  expect(() => parseAuthStagingTarget({ ...target, requiredSecrets: target.requiredSecrets.filter((name) => name !== "TAKOSUMI_ACCOUNTS_UPSTREAM_GITHUB_CLIENT_SECRET") })).toThrow();
});

test("canonical config hash and database separation are checked", () => {
  const target = fixtureTarget();
  expect(() => authStagingResourceBindings(`${config}\n`, target)).toThrow("digest_mismatch");
  const alias = config.replaceAll(uuid("5"), uuid("4"));
  expect(() => authStagingResourceBindings(alias, { ...target, canonicalStageConfigSha256: sha(alias) })).toThrow("database_alias");
});

test("malformed plan or source/artifact confirmation does not touch provider", async () => {
  for (const patch of [{ confirmation: sha("wrong") }, { artifact: new Uint8Array([0]) }, { plan: { ...harness().plan, sourceCommit: "f".repeat(40) } }, { plan: { ...harness().plan, authorityDigest: sha("wrong") } }]) {
    const h = harness();
    await expect(h.execute("authority", patch)).rejects.toThrow();
    expect(h.requests).toHaveLength(0);
  }
});

test("bootstrap creates an inert unregistered slot and refuses any existing Worker", async () => {
  const created = harness({ exists: false });
  expect(await created.execute("bootstrap")).toMatchObject({ status: "inert-slot-created", issuerActive: false });
  expect(created.counts()).toEqual({ schemaCalls: 0, publicCalls: 0, bootstrapCalls: 1 });
  await expect(harness().execute("bootstrap")).rejects.toThrow("existing_worker");
});

test("authority needs schema5 and canonical physical resources before uploading", async () => {
  for (const options of [{ schemaError: true }, { wrongCanonical: true }, { wrongCurrent: true }, { domainOwned: true }, { active: true, schedules: [] }]) {
    const h = harness(options);
    await expect(h.execute("authority")).rejects.toThrow();
    expect(h.requests.filter((request) => request.method !== "GET")).toHaveLength(0);
  }
});

test("schema guard rejects mutually consistent files with an unqualified production DB", async () => {
  const h = harness({ wrongCanonical: true });
  await expect(verifyAuthStagingSchemaTarget(h.runtime.provider, h.target, h.plan.bindings)).rejects.toThrow("canonical_binding_mismatch");
  expect(h.requests.every((request) => request.method === "GET")).toBe(true);
});

test("authority uploads once and leaves route disabled with no product schema writes", async () => {
  const h = harness();
  expect(await h.execute("authority")).toMatchObject({ status: "authority-ready-route-disabled", version: uploadedVersion, predecessor: previousVersion });
  expect(h.requests.filter((request) => request.method !== "GET").map((request) => request.path)).toEqual([`/workers/scripts/${AUTH_STAGING_WORKER}/versions`, `/workers/scripts/${AUTH_STAGING_WORKER}/deployments`]);
  expect(h.counts().publicCalls).toBe(0);
});

test("authority on a served issuer replaces it once, keeps its domain and schedule and reads it back publicly", async () => {
  const h = harness({ active: true });
  expect(await h.execute("authority")).toMatchObject({ status: "authority-ready-served", version: uploadedVersion, predecessor: previousVersion });
  expect(h.requests.filter((request) => request.method !== "GET").map((request) => request.path)).toEqual([`/workers/scripts/${AUTH_STAGING_WORKER}/versions`, `/workers/scripts/${AUTH_STAGING_WORKER}/deployments`]);
  expect(h.counts().publicCalls).toBe(1);
  const failing = harness({ active: true, publicError: true });
  await expect(failing.execute("authority")).rejects.toBeInstanceOf(AuthStagingIncompleteError);
});

test("a served authority change keeps the identity-continuity secrets", async () => {
  for (const name of ["TAKOSUMI_ACCOUNTS_OIDC_PAIRWISE_SUBJECT_SECRET", "TAKOSUMI_ACCOUNTS_SUBJECT_SECRET", "TAKOSUMI_ACCOUNT_SESSION_HASH_SALT"]) {
    const h = harness({ active: true });
    await expect(h.execute("authority", { secrets: { ...secrets, [name]: Buffer.alloc(32, 99).toString("base64url") } })).rejects.toThrow("auth_staging_identity_continuity_changed");
    expect(h.requests.filter((request) => request.method !== "GET")).toHaveLength(0);
  }
  // A predecessor from before the continuity digest needs an unchanged signing key id.
  const legacy = (bindings: Record<string, unknown>[]) => bindings.filter((binding) => binding.name !== "TAKOSUMI_AUTH_IDENTITY_CONTINUITY_DIGEST");
  expect(await harness({ active: true, predecessor: legacy }).execute("authority")).toMatchObject({ status: "authority-ready-served" });
  const rekeyed = harness({ active: true, predecessor: (bindings) => legacy(bindings).map((binding) => binding.name === "TAKOSUMI_ACCOUNTS_ES256_KEY_ID" ? { ...binding, text: "other-key" } : binding) });
  await expect(rekeyed.execute("authority")).rejects.toThrow("auth_staging_identity_continuity_changed");
  expect(rekeyed.requests.filter((request) => request.method !== "GET")).toHaveLength(0);
});

test("control-operation secrets are required and must be distinct from every other secret", async () => {
  const h = harness();
  for (const name of ["TAKOSUMI_SECRET_STORE_PASSPHRASE", "TAKOSUMI_DEPLOY_CONTROL_TOKEN"]) {
    const { [name]: _removed, ...missing } = secrets as Record<string, string>;
    await expect(h.execute("authority", { secrets: missing })).rejects.toThrow("auth_staging_secret_bundle_invalid");
    await expect(h.execute("authority", { secrets: { ...secrets, [name]: secrets.TAKOSUMI_ACCOUNTS_SUBJECT_SECRET } })).rejects.toThrow("auth_staging_control_secrets_not_separate");
    await expect(h.execute("authority", { secrets: { ...secrets, [name]: "short" } })).rejects.toThrow("auth_staging_signing_configuration_invalid");
  }
  expect(h.requests.filter((request) => request.method !== "GET")).toHaveLength(0);
});

test("wrong uploaded DB or DO namespace prevents activation after a single upload", async () => {
  for (const options of [{ badBinding: true }, { badNamespace: true }]) {
    const h = harness(options);
    await expect(h.execute("authority")).rejects.toBeInstanceOf(AuthStagingIncompleteError);
    expect(h.requests.filter((request) => request.method !== "GET").map((request) => request.path)).toEqual([`/workers/scripts/${AUTH_STAGING_WORKER}/versions`]);
  }
});

test("lost upload acknowledgement never repeats upload or activates", async () => {
  const h = harness({ lostUploadAck: true });
  await expect(h.execute("authority")).rejects.toBeInstanceOf(AuthStagingIncompleteError);
  expect(h.requests.filter((request) => request.method === "POST")).toHaveLength(1);
});

test("topology attaches only exact staging domain after strict proofs and reads it back", async () => {
  const h = harness();
  expect(await h.execute("topology")).toMatchObject({ status: "ready", version: previousVersion });
  const writes = h.requests.filter((request) => request.method !== "GET");
  expect(writes).toHaveLength(2);
  expect(writes[0]?.path).toEndWith("/schedules");
  expect(JSON.parse(String(writes[0]?.body))).toEqual([{cron:"*/1 * * * *"}]);
  expect(JSON.parse(String(writes[1]?.body))).toEqual({ hostname: AUTH_STAGING_HOST, service: AUTH_STAGING_WORKER, zone_id: h.target.zoneId, enabled: true, previews_enabled: false });
  expect(h.counts().publicCalls).toBe(1);
});

test("routine code preserves authority/topology and rejects enabled custom-domain previews", async () => {
  const h = harness({ active: true });
  expect(await h.execute("code")).toMatchObject({ status: "ready", version: uploadedVersion });
  const drift = harness({ active: true, extraPreview: true });
  await expect(drift.execute("code")).rejects.toThrow("domain_readback_mismatch");
  expect(drift.requests.filter((request) => request.method !== "GET")).toHaveLength(0);
});

test("unreviewed or missing active cron is rejected before provider mutation",async()=>{
  for(const options of [{schedules:[{cron:"*/5 * * * *"}]},{active:true,schedules:[]}]){
    const h=harness(options);
    await expect(h.execute(options.active?"code":"topology")).rejects.toThrow("topology_invalid");
    expect(h.requests.filter(request=>request.method!=="GET")).toHaveLength(0);
  }
});

test("lost schedule acknowledgement stops before domain; an explicit later run reads the exact approved cron without repeating PUT",async()=>{
  const h=harness({lostScheduleAck:true});
  await expect(h.execute("topology")).rejects.toBeInstanceOf(AuthStagingIncompleteError);
  expect(h.requests.filter(request=>request.method!=="GET").map(request=>request.path)).toEqual([`/workers/scripts/${AUTH_STAGING_WORKER}/schedules`]);
  expect(await h.execute("topology")).toMatchObject({status:"ready"});
  expect(h.requests.filter(request=>request.method==="PUT"&&request.path.endsWith("/schedules"))).toHaveLength(1);
  expect(h.requests.filter(request=>request.method==="PUT"&&request.path==="/workers/domains")).toHaveLength(1);
});

test("post-activation public readback failure reports incomplete without retry", async () => {
  const h = harness({ active: true, publicError: true });
  await expect(h.execute("code")).rejects.toBeInstanceOf(AuthStagingIncompleteError);
  expect(h.requests.filter((request) => request.method === "POST")).toHaveLength(2);
});

test("invalid signing key, public-key pin or weak salt refuses before provider access", async () => {
  for (const patch of [{ TAKOSUMI_ACCOUNTS_ES256_PRIVATE_JWK: "not-json" }, { TAKOSUMI_ACCOUNT_SESSION_HASH_SALT: "short" }]) {
    const h = harness();
    await expect(h.execute("authority", { secrets: { ...secrets, ...patch } })).rejects.toThrow("signing_configuration_invalid");
    expect(h.requests).toHaveLength(0);
  }
});

test("ambient Git checkout/config overrides cannot attest dirty build source", async () => {
  const directory = mkdtempSync(join(tmpdir(), "auth-stage-source-guard-"));
  try {
    const fakeRoot = join(directory, "fake-clean-repo");
    mkdirSync(fakeRoot);
    const git = (...args: string[]) => execFileSync("git", ["-c", "commit.gpgSign=false", "-c", "user.name=Stage Fixture", "-c", "user.email=stage-fixture@example.invalid", "-C", fakeRoot, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    git("init", "-b", "main");
    writeFileSync(join(fakeRoot, "README.md"), "Synthetic source fixture\n");
    git("add", "README.md");
    git("commit", "-m", "synthetic source fixture");
    git("remote", "add", "origin", "https://github.com/tako0614/takosumi");
    const fakeCommit = git("rev-parse", "HEAD");
    git("update-ref", "refs/remotes/origin/main", fakeCommit);
    const targetPath = join(directory, "target.json");
    const configPath = join(directory, "canonical.toml");
    writeFileSync(targetPath, JSON.stringify({ ...fixtureTarget(), sourceCommit: fakeCommit }), { mode: 0o600 });
    writeFileSync(configPath, config, { mode: 0o600 });
    const child = Bun.spawn([process.execPath, "scripts/deploy.mjs", "takosumi-auth-staging-authority", "plan", "--target", targetPath, "--canonical-config", configPath], {
      cwd: resolve(import.meta.dir, "../.."),
      env: { ...process.env, GIT_DIR: join(fakeRoot, ".git"), GIT_WORK_TREE: fakeRoot, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.fsmonitor", GIT_CONFIG_VALUE_0: "false", CLOUDFLARE_API_TOKEN: undefined }, stdout: "pipe", stderr: "pipe",
    });
    const [output, error, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exitCode).not.toBe(0);
    expect(output).toBe("");
    expect(error).toContain("auth_staging_source_mismatch");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});


test("upstream secret custody follows explicit descriptors, without fixed provider slots or aliases",()=>{
  const target=fixtureTarget();
  const custom=upstreamMetadata.map((provider,index)=>({...provider,clientSecretEnv:`TAKOSUMI_ACCOUNTS_UPSTREAM_LOGIN_${index+1}_SECRET`}));
  const originalRefs=upstreamMetadata.map(provider=>provider.clientSecretEnv);
  const requiredSecrets=target.requiredSecrets.filter(name=>!originalRefs.includes(name)).concat(custom.map(provider=>provider.clientSecretEnv));
  const vars={...target.vars,TAKOSUMI_ACCOUNTS_UPSTREAM_PROVIDERS:JSON.stringify(custom)};
  const parsed=parseAuthStagingTarget({...target,vars,requiredSecrets});
  expect(parsed.requiredSecrets).toEqual(requiredSecrets);
  expect(()=>parseAuthStagingTarget({...target,vars})).toThrow("secrets_invalid");
  expect(()=>parseAuthStagingTarget({...target,vars,requiredSecrets:[...requiredSecrets,originalRefs[0]]})).toThrow("secrets_invalid");
  for(const ref of [custom[1]!.clientSecretEnv,"TAKOSUMI_ACCOUNTS_ES256_PRIVATE_JWK","TAKOSUMI_ACCOUNTS_DB","TAKOSUMI_ACCOUNTS_UPSTREAM_FOO_SECRET;INJECT","TAKOSUMI_ACCOUNTS_UPSTREAM_"+"A".repeat(130)+"_SECRET"]){
    expect(()=>parseAuthStagingTarget({...target,vars:{...vars,TAKOSUMI_ACCOUNTS_UPSTREAM_PROVIDERS:JSON.stringify([{...custom[0],clientSecretEnv:ref},custom[1]])},requiredSecrets})).toThrow();
  }
});

test("private owner qualification reads exact realized graph, schema and topology without mutating a release", async () => {
  const { inspectAuthStagingOwnerReleaseTopology } = await import("../../scripts/auth-staging-release.ts");
  const { authStagingOwnerTargetBindingDigest, parseAuthStagingOwnerGraphExpectation, assertAuthStagingOwnerGraphQualification } = await import("../../scripts/auth-staging-owner-graph.ts");
  const expected = parseAuthStagingOwnerGraphExpectation({ kind: "takosumi.auth-owner-graph-expectation@v1", ownerClientId: "fixture-private-service-owner",
    issuer: { worker: AUTH_STAGING_WORKER, versionId: uploadedVersion, sourceCommit: "c".repeat(40), sourceCommitBinding: "TAKOSUMI_AUTH_SOURCE_COMMIT", accountsDatabaseId: uuid("4"), controlDatabaseId: uuid("5") },
    owner: { worker: "fixture-private-owner", versionId: previousVersion, sourceCommit: "d".repeat(40), sourceCommitBinding: "OWNER_SOURCE", binding: "PRIVATE_ADMISSION", custodyResources: [{ binding: "CUSTODY_DB", type: "d1", resourceId: uuid("6") }] } });
  const target = parseAuthStagingTarget({ ...fixtureTarget(), vars: { ...fixtureTarget().vars, TAKOSUMI_ACCOUNTS_OWNER_CLIENT_ID: expected.ownerClientId, TAKOSUMI_ACCOUNTS_OWNER_TARGET_BINDING_DIGEST: authStagingOwnerTargetBindingDigest(expected) } });
  const plan = createAuthStagingPlan(target, config, bytes);
  const text = (name: string, value: string) => ({ name, type: "plain_text", text: value });
  const issuerVersion = { id: uploadedVersion, resources: { bindings: [
    ...plan.bindings, ...Object.entries(target.vars).map(([name, value]) => text(name, value)),
    text("TAKOSUMI_AUTH_ARTIFACT_DIGEST", plan.artifactDigest), text("TAKOSUMI_AUTH_AUTHORITY_DIGEST", plan.authorityDigest), text("TAKOSUMI_AUTH_SOURCE_COMMIT", target.sourceCommit), continuityBinding,
    { name: "TAKOSUMI_VERSION_METADATA", type: "version_metadata" }, ...target.requiredSecrets.map((name) => ({ name, type: "secret_text" })),
  ], script: { handlers: ["scheduled", "fetch"], named_handlers: [{ name: "AccountsFinancialProof", handlers: ["fetch", "prove", "loadFinancialIdentityProof", "verifyCurrentFinancialIdentityProof"] }, { name: "AccountsOwnerAdmission", handlers: ["readOwnerOperation"] }] },
    script_runtime: { compatibility_date: AUTH_STAGING_COMPATIBILITY_DATE, compatibility_flags: ["nodejs_compat"], exports: { AccountsOwnerAdmission: { type: "worker" } } } } };
  const ownerVersion = { id: previousVersion, resources: { bindings: [text("TAKOSUMI_ENVIRONMENT", "staging"), text("OWNER_SOURCE", expected.owner.sourceCommit),
    { name: "PRIVATE_ADMISSION", type: "service", service: AUTH_STAGING_WORKER, entrypoint: "AccountsOwnerAdmission" }, { name: "CUSTODY_DB", type: "d1", id: uuid("6") }], script: {}, script_runtime: {} } };
  let schema = 0;
  const paths: string[] = [];
  const provider: AuthStagingProvider = { async request(method, path) {
    expect(method).toBe("GET"); paths.push(path);
    if (path === "/workers/scripts") return [{ id: AUTH_STAGING_WORKER }, { id: expected.owner.worker }];
    if (path.endsWith("/subdomain")) return { enabled: false, previews_enabled: false };
    if (path.endsWith("/schedules")) return { schedules: [{ cron: "*/1 * * * *" }] };
    if (path.startsWith("/workers/domains?service=")) return [{ hostname: AUTH_STAGING_HOST, service: AUTH_STAGING_WORKER, zone_id: target.zoneId, enabled: true, previews_enabled: false }];
    if (path.endsWith("/workers/routes")) return [];
    const version = path.startsWith(`/workers/scripts/${AUTH_STAGING_WORKER}/`) ? issuerVersion : ownerVersion;
    if (path.endsWith("/deployments")) return { deployments: [{ versions: [{ version_id: version.id, percentage: 100 }] }] };
    if (path.includes("/versions?page=")) return { items: path.includes("page=1&") ? [{ id: version.id, metadata: { hasPreview: false } }] : [] };
    if (path.endsWith(`/versions/${version.id}`)) return structuredClone(version);
    throw new Error("unexpected qualification fixture path " + path);
  } };
  const runtime: AuthStagingReleaseRuntime = { provider, verifySchema: async () => { schema++; }, publicReadback: async () => { throw new Error("no public mutation smoke"); }, bootstrap: async () => { throw new Error("no mutation"); } };
  const result = await inspectAuthStagingOwnerReleaseTopology({ target, plan, expectation: expected }, runtime);
  expect(() => assertAuthStagingOwnerGraphQualification(result, expected)).not.toThrow(); expect(schema).toBe(1);
  const before = paths.length;
  await expect(inspectAuthStagingOwnerReleaseTopology({ target, plan, expectation: { ...expected, issuer: { ...expected.issuer, accountsDatabaseId: uuid("8") } } }, runtime)).rejects.toThrow("target_mismatch");
  expect(paths).toHaveLength(before);
  await expect(inspectAuthStagingOwnerReleaseTopology({ target, plan, expectation: expected }, { ...runtime, verifySchema: async () => { throw new Error("actual schema unavailable"); } })).rejects.toThrow("actual schema unavailable");
  issuerVersion.resources.script.named_handlers[0]!.handlers = ["fetch"];
  await expect(inspectAuthStagingOwnerReleaseTopology({ target, plan, expectation: expected }, runtime)).rejects.toThrow("entrypoint_invalid");
  for (const vars of [{ TAKOSUMI_ACCOUNTS_OWNER_CLIENT_ID: expected.ownerClientId }, { TAKOSUMI_ACCOUNTS_OWNER_TARGET_BINDING_DIGEST: authStagingOwnerTargetBindingDigest(expected) },
    { TAKOSUMI_ACCOUNTS_OWNER_CLIENT_ID: AUTH_STAGING_CLIENTS[0].clientId, TAKOSUMI_ACCOUNTS_OWNER_TARGET_BINDING_DIGEST: authStagingOwnerTargetBindingDigest(expected) },
    { TAKOSUMI_ACCOUNTS_OWNER_CLIENT_ID: expected.ownerClientId, TAKOSUMI_ACCOUNTS_OWNER_TARGET_BINDING_DIGEST: "sha256:" + "A".repeat(42) + "B" }]) {
    expect(() => parseAuthStagingTarget({ ...fixtureTarget(), vars: { ...fixtureTarget().vars, ...vars } })).toThrow();
  }
});


test("the staging descriptor admits only exact boolean request-phase opt-in", () => {
  const original = fixtureTarget();
  for (const value of ["true", "false"]) {
    const target = parseAuthStagingTarget({ ...original, vars: { ...original.vars, TAKOSUMI_REQUEST_PHASE_DIAGNOSTICS: value } });
    expect(target.vars.TAKOSUMI_REQUEST_PHASE_DIAGNOSTICS).toBe(value);
    expect(createAuthStagingPlan(target, config, bytes).authorityDigest).not.toBe(createAuthStagingPlan(original, config, bytes).authorityDigest);
  }
  for (const value of ["TRUE", "1", "", " true", "{}", true, null]) {
    expect(() => parseAuthStagingTarget({ ...original, vars: { ...original.vars, TAKOSUMI_REQUEST_PHASE_DIAGNOSTICS: value } })).toThrow("auth_staging_vars_invalid");
  }
  for (const name of ["TAKOSUMI_REQUEST_PHASE_DIAGNOSTICS_EXTRA", "TAKOSUMI_UNREVIEWED_FLAG"]) {
    expect(() => parseAuthStagingTarget({ ...original, vars: { ...original.vars, [name]: "true" } })).toThrow("auth_staging_vars_invalid");
  }
});

test("the staging descriptor admits the app ownership kill switch only as the runtime's canonical frozen or enabled", () => {
  const original = fixtureTarget();
  for (const [value, frozen] of [["frozen", true], ["enabled", false]] as const) {
    const target = parseAuthStagingTarget({ ...original, vars: { ...original.vars, TAKOSUMI_APP_OWNERSHIP_MUTATIONS: value } });
    expect(target.vars.TAKOSUMI_APP_OWNERSHIP_MUTATIONS).toBe(value);
    // The D1 backfill adapter reads the served binding back with this parser.
    expect(parseAppOwnershipMutationsFrozen(target.vars.TAKOSUMI_APP_OWNERSHIP_MUTATIONS)).toBe(frozen);
    expect(createAuthStagingPlan(target, config, bytes).authorityDigest).not.toBe(createAuthStagingPlan(original, config, bytes).authorityDigest);
  }
  for (const value of ["FROZEN", "Frozen", " frozen", "frozen ", "", "paused", "true", "0", "{}", true, null]) {
    expect(() => parseAuthStagingTarget({ ...original, vars: { ...original.vars, TAKOSUMI_APP_OWNERSHIP_MUTATIONS: value } })).toThrow("auth_staging_vars_invalid");
  }
  // The issuer does not run the Source retirement sweep; only the platform Worker reads that switch.
  for (const name of ["TAKOSUMI_APP_OWNERSHIP_MUTATIONS_EXTRA", "TAKOSUMI_SOURCE_RETIREMENT_SWEEP_ENABLED"]) {
    expect(() => parseAuthStagingTarget({ ...original, vars: { ...original.vars, [name]: "frozen" } })).toThrow("auth_staging_vars_invalid");
  }
});

test("the rollout's step 1 issuer target carries both freezes and the delegation sources the Accounts handler reads", () => {
  const original = fixtureTarget();
  const delegated = JSON.stringify([{ url: "https://github.com/tako0614/takos", path: ".", refs: ["refs/heads/main"] }]);
  const target = parseAuthStagingTarget({ ...original, vars: { ...original.vars, TAKOSUMI_ACCOUNTS_WORKSPACE_MUTATIONS_FROZEN: "true", TAKOSUMI_APP_OWNERSHIP_MUTATIONS: "frozen", TAKOSUMI_ACCOUNTS_DELEGATED_APP_SOURCES: delegated } });
  expect(parseWorkspaceMutationsFrozen(target.vars.TAKOSUMI_ACCOUNTS_WORKSPACE_MUTATIONS_FROZEN)).toBe(true);
  expect(parseAppOwnershipMutationsFrozen(target.vars.TAKOSUMI_APP_OWNERSHIP_MUTATIONS)).toBe(true);
  expect(parseInstalledAppDelegationSources(target.vars.TAKOSUMI_ACCOUNTS_DELEGATED_APP_SOURCES)).toHaveLength(1);
});

test("freezing app ownership on the served issuer needs the authority lane and serves an exact frozen binding", async () => {
  const h = harness({ active: true });
  const target = parseAuthStagingTarget({ ...h.target, vars: { ...h.target.vars, TAKOSUMI_APP_OWNERSHIP_MUTATIONS: "frozen" } });
  const plan = createAuthStagingPlan(target, config, bytes);
  await expect(h.execute("code", { target, plan, confirmation: plan.confirmation })).rejects.toThrow("auth_staging_code_authority_drift");
  expect(h.requests.filter((request) => request.method !== "GET")).toHaveLength(0);
  expect(await h.execute("authority", { target, plan, confirmation: plan.confirmation })).toMatchObject({ status: "authority-ready-served", version: uploadedVersion });
  const upload = h.requests.find((request) => request.method === "POST" && request.path.endsWith("/versions"));
  const bindings = JSON.parse(String((upload!.body as FormData).get("metadata"))).bindings as Record<string, unknown>[];
  // The shape the D1 backfill adapter's freeze proof requires: one plain_text binding that parses to frozen.
  expect(bindings.filter((binding) => binding.name === "TAKOSUMI_APP_OWNERSHIP_MUTATIONS")).toEqual([{ name: "TAKOSUMI_APP_OWNERSHIP_MUTATIONS", type: "plain_text", text: "frozen" }]);
  expect(bindings.some((binding) => binding.type === "d1" && binding.name === "TAKOSUMI_CONTROL_DB")).toBe(true);
});

test("diagnostic flag activation still requires the authority lane before any write", async () => {
  const h = harness({ active: true });
  const target = parseAuthStagingTarget({ ...h.target, vars: { ...h.target.vars, TAKOSUMI_REQUEST_PHASE_DIAGNOSTICS: "true" } });
  const plan = createAuthStagingPlan(target, config, bytes);
  await expect(h.execute("code", { target, plan, confirmation: plan.confirmation })).rejects.toThrow("auth_staging_code_authority_drift");
  expect(h.requests.filter((request) => request.method !== "GET")).toHaveLength(0);
});

test("authority and code uploads carry the issuer placement and read it back from the serving settings", async () => {
  for (const action of ["authority", "code"] as const) {
    const h = harness({ active: true });
    expect(await h.execute(action)).toMatchObject({ version: uploadedVersion });
    const upload = h.requests.find((request) => request.method === "POST" && request.path.endsWith("/versions"));
    expect(JSON.parse(String((upload!.body as FormData).get("metadata"))).placement).toEqual(AUTH_STAGING_PLACEMENT);
    expect(h.requests.some((request) => request.method === "GET" && request.path === `/workers/scripts/${AUTH_STAGING_WORKER}/settings`)).toBe(true);
  }
});

test("serving settings that do not name the uploaded placement target are incomplete, never ready", async () => {
  for (const action of ["authority", "code"] as const) {
    for (const placement of [() => ({}), () => ({ mode: "smart" }), () => ({ mode: "targeted", target: [31] }), () => ({ mode: "targeted", target: [30, 31] }), () => ({ mode: "targeted", target: [30], hint: "apac" }), () => ({ mode: "targeted", region: AUTH_STAGING_PLACEMENT.region })]) {
      const h = harness({ active: true, placement });
      await expect(h.execute(action)).rejects.toMatchObject({ recovery: { reason: "auth_staging_placement_invalid" } });
      expect(h.counts().publicCalls).toBe(0);
    }
  }
  expect(() => assertAuthStagingPlacement(null, 30)).toThrow("auth_staging_placement_invalid");
  expect(() => assertAuthStagingPlacement({ placement: { mode: "targeted", target: [30] } }, 30)).not.toThrow();
});

test("an uploaded Version without the exact targeted region stops before activation", async () => {
  const region = AUTH_STAGING_PLACEMENT.region;
  for (const versionPlacement of [null, {}, { mode: "smart" }, AUTH_STAGING_PLACEMENT, { mode: "targeted", target: [] },
    { mode: "targeted", target: [{ id: 30, region: "aws:us-east-1", type: "region" }] },
    { mode: "targeted", target: [{ id: 30, region, type: "host" }] },
    { mode: "targeted", target: [{ id: 0, region, type: "region" }] },
    { mode: "targeted", target: [{ id: 30, region, type: "region" }, { id: 31, region, type: "region" }] },
    { mode: "targeted", target: [{ id: 30, region, type: "region", extra: true }] }]) {
    const h = harness({ active: true, versionPlacement });
    await expect(h.execute("authority")).rejects.toMatchObject({ recovery: { reason: "auth_staging_placement_invalid", uploadedVersion } });
    expect(h.requests.filter((request) => request.method === "POST").map((request) => request.path)).toEqual([`/workers/scripts/${AUTH_STAGING_WORKER}/versions`]);
  }
  expect(uploadedPlacementTarget({ resources: { script: { placement: { mode: "targeted", target: [{ id: 30, region, type: "region" }] } } } })).toBe(30);
});

// Identity rotation fixtures: the served issuer runs `fixtureTarget()` with `secrets`.
const nextKeyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const nextPrivateJwk = await crypto.subtle.exportKey("jwk", nextKeyPair.privateKey);
const nextKeyId = "fixture-auth-staging-key-rotated";
const nextPublicJwk = { kty: "EC", crv: "P-256", x: nextPrivateJwk.x, y: nextPrivateJwk.y, kid: nextKeyId, use: "sig", alg: "ES256" };
const foreignKeyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const foreignPrivateJwk = await crypto.subtle.exportKey("jwk", foreignKeyPair.privateKey);
const foreignPublicJwk = { kty: "EC", crv: "P-256", x: foreignPrivateJwk.x, y: foreignPrivateJwk.y, kid: "fixture-foreign-key", use: "sig", alg: "ES256" };
const nextSalt = Buffer.alloc(32, 24).toString("base64url");
const servedBundleSha256 = sha(JSON.stringify(secrets));
const jwksDigest = (keys: readonly { kid: string }[]) => sha(JSON.stringify({ keys: [...keys].sort((left, right) => left.kid.localeCompare(right.kid)) }));
const writes = (requests: readonly { method: string; path: string; body?: BodyInit }[]) => requests.filter((request) => request.method !== "GET");
const uploadedBindings = (requests: readonly { method: string; path: string; body?: BodyInit }[]) => {
  const uploads = requests.filter((request) => request.method === "POST" && request.path.endsWith("/versions"));
  return JSON.parse(String((uploads[uploads.length - 1]!.body as FormData).get("metadata"))).bindings as Record<string, unknown>[];
};
const textOf = (bindings: readonly Record<string, unknown>[], name: string) => bindings.find((binding) => binding.name === name)?.text;

/** The new target derived from the served one by editing only identity fields in place. */
function rotated(scopes: readonly AuthStagingIdentityRotationScope[], change: { vars?: Record<string, string>; secrets?: Record<string, string>; previousKeys?: readonly unknown[]; sourceCommit?: string } = {}) {
  const served = fixtureTarget();
  const signing = scopes.includes("signing-key");
  const next: Record<string, string> = { ...secrets, ...(signing ? { TAKOSUMI_ACCOUNTS_ES256_PRIVATE_JWK: JSON.stringify(nextPrivateJwk) } : {}), ...(scopes.includes("session-salt") ? { TAKOSUMI_ACCOUNT_SESSION_HASH_SALT: nextSalt } : {}), ...change.secrets };
  const previousKeys = change.previousKeys ?? [publicJwk];
  const target = parseAuthStagingTarget({ ...served, sourceCommit: change.sourceCommit ?? served.sourceCommit, secretsSha256: sha(JSON.stringify(next)),
    jwksSha256: signing ? jwksDigest([nextPublicJwk, ...previousKeys as { kid: string }[]]) : served.jwksSha256,
    vars: { ...served.vars, ...(signing ? { TAKOSUMI_ACCOUNTS_ES256_KEY_ID: nextKeyId, TAKOSUMI_ACCOUNTS_ES256_PREVIOUS_PUBLIC_JWKS: JSON.stringify({ keys: previousKeys }) } : {}), ...change.vars } });
  return { target, plan: createAuthStagingPlan(target, config, bytes), secrets: next };
}
const rotationInput = (rotation: AuthStagingIdentityRotation, extra: Record<string, unknown> = {}) => ({
  rotate: rotation.rotate, previousSecrets: secrets, previousSecretsSha256: servedBundleSha256, confirmation: rotation.confirmation,
  acknowledgeSessionInvalidation: rotation.sessions === "all-invalidated", ...extra,
});
async function rotate(h: ReturnType<typeof harness>, scopes: readonly AuthStagingIdentityRotationScope[], next = rotated(scopes), extra: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) {
  const rotation = await createAuthStagingIdentityRotation(next.target, next.secrets, secrets, scopes);
  return h.execute("authority", { target: next.target, plan: next.plan, confirmation: next.plan.confirmation, secrets: next.secrets, identityRotation: rotationInput(rotation, extra), ...overrides });
}

test("without the rotation mode a served issuer still refuses a new signing key or salt, and any public key set change", async () => {
  for (const scopes of [["signing-key"], ["session-salt"]] as const) {
    const h = harness({ active: true });
    const next = rotated(scopes);
    await expect(h.execute("authority", { target: next.target, plan: next.plan, confirmation: next.plan.confirmation, secrets: next.secrets })).rejects.toThrow("auth_staging_identity_continuity_changed");
    expect(writes(h.requests)).toHaveLength(0);
  }
  // Same signing key and secrets, but an added previous key or a new kid.
  for (const [vars, keys] of [
    [{ TAKOSUMI_ACCOUNTS_ES256_PREVIOUS_PUBLIC_JWKS: JSON.stringify({ keys: [foreignPublicJwk] }) }, [publicJwk, foreignPublicJwk]],
    [{ TAKOSUMI_ACCOUNTS_ES256_KEY_ID: "fixture-renamed-key" }, [{ ...publicJwk, kid: "fixture-renamed-key" }]],
  ] as const) {
    const h = harness({ active: true });
    const target = parseAuthStagingTarget({ ...h.target, jwksSha256: jwksDigest(keys), vars: { ...h.target.vars, ...vars } });
    const plan = createAuthStagingPlan(target, config, bytes);
    await expect(h.execute("authority", { target, plan, confirmation: plan.confirmation })).rejects.toThrow("auth_staging_jwks_continuity_changed");
    expect(writes(h.requests)).toHaveLength(0);
  }
});

test("a signing-key rotation needs a reviewer and the confirmation naming both continuity digests, publishes both keys and records the new identity", async () => {
  const next = rotated(["signing-key"]);
  const rotation = await createAuthStagingIdentityRotation(next.target, next.secrets, secrets, ["signing-key"]);
  expect(rotation).toMatchObject({ rotate: ["signing-key"], fromContinuityDigest: identityContinuity, sessions: "preserved",
    signingKey: { fromKid: keyId, toKid: nextKeyId, publishedKids: [nextKeyId, keyId], minimumOverlapSeconds: AUTH_STAGING_SIGNING_KEY_MIN_OVERLAP_MS / 1000 } });
  expect(rotation.confirmation).toBe(`rotate-identity:signing-key:${identityContinuity}:${rotation.toContinuityDigest}`);
  expect(rotation.toContinuityDigest).not.toBe(identityContinuity);
  for (const [extra, overrides, error] of [
    [{}, { reviewer: undefined }, "auth_staging_independent_review_required"],
    [{ confirmation: `rotate-identity:signing-key:${rotation.toContinuityDigest}:${identityContinuity}` }, {}, "auth_staging_identity_rotation_confirmation_mismatch"],
    [{ confirmation: next.plan.confirmation }, {}, "auth_staging_identity_rotation_confirmation_mismatch"],
    [{ acknowledgeSessionInvalidation: true }, {}, "auth_staging_session_invalidation_not_rotated"],
    [{ previousSecretsSha256: "" }, {}, "auth_staging_identity_rotation_secrets_required"],
  ] as const) {
    const h = harness({ active: true });
    await expect(rotate(h, ["signing-key"], next, extra, overrides)).rejects.toThrow(error);
    expect(h.requests).toHaveLength(0);
  }
  const code = harness({ active: true });
  await expect(code.execute("code", { target: next.target, plan: next.plan, confirmation: next.plan.confirmation, secrets: next.secrets, identityRotation: rotationInput(rotation) })).rejects.toThrow("auth_staging_identity_rotation_action_invalid");
  await expect(code.execute("authority", { target: next.target, plan: next.plan, confirmation: next.plan.confirmation, secrets: next.secrets, identityRotation: rotationInput(rotation), retirePreviousKeys: [keyId] })).rejects.toThrow("auth_staging_identity_rotation_action_invalid");
  expect(code.requests).toHaveLength(0);

  const h = harness({ active: true });
  const result = await rotate(h, ["signing-key"], next);
  expect(result).toMatchObject({ status: "identity-rotated-served", version: uploadedVersion, predecessor: previousVersion,
    identityRotation: { rotate: ["signing-key"], fromContinuityDigest: identityContinuity, toContinuityDigest: rotation.toContinuityDigest, sessions: "preserved", signingKey: { fromKid: keyId, toKid: nextKeyId } } });
  expect(Date.parse(String((result.identityRotation as { signingKey: { retireNotBefore: string } }).signingKey.retireNotBefore)) - Date.now()).toBeGreaterThan(AUTH_STAGING_SIGNING_KEY_MIN_OVERLAP_MS - 60_000);
  expect(writes(h.requests).map((request) => request.path)).toEqual([`/workers/scripts/${AUTH_STAGING_WORKER}/versions`, `/workers/scripts/${AUTH_STAGING_WORKER}/deployments`]);
  expect(h.counts().publicCalls).toBe(1);
  const bindings = uploadedBindings(h.requests);
  expect(textOf(bindings, "TAKOSUMI_AUTH_IDENTITY_CONTINUITY_DIGEST")).toBe(rotation.toContinuityDigest);
  expect(textOf(bindings, "TAKOSUMI_ACCOUNTS_ES256_KEY_ID")).toBe(nextKeyId);
  // The new key signs; the previous public key is published for verification only.
  expect(JSON.parse(String(textOf(bindings, "TAKOSUMI_ACCOUNTS_ES256_PREVIOUS_PUBLIC_JWKS")))).toEqual({ keys: [publicJwk] });
  expect(next.target.jwksSha256).toBe(jwksDigest([nextPublicJwk, publicJwk]));
});

test("a provider readback that does not record the new continuity digest leaves the rotation incomplete before activation", async () => {
  const h = harness({ active: true, staleContinuity: true });
  await expect(rotate(h, ["signing-key"])).rejects.toMatchObject({ recovery: { reason: "auth_staging_binding_identity_mismatch", uploadedVersion } });
  expect(writes(h.requests).map((request) => request.path)).toEqual([`/workers/scripts/${AUTH_STAGING_WORKER}/versions`]);
});

test("a session-salt rotation states that every session ends and requires that explicit acknowledgement", async () => {
  const next = rotated(["session-salt"]);
  const rotation = await createAuthStagingIdentityRotation(next.target, next.secrets, secrets, ["session-salt"]);
  expect(rotation).toMatchObject({ rotate: ["session-salt"], sessions: "all-invalidated", signingKey: null });
  expect(rotation.statement.join(" ")).toContain("invalidates every issuer account session: every user must sign in again");
  const refused = harness({ active: true });
  await expect(rotate(refused, ["session-salt"], next, { acknowledgeSessionInvalidation: false })).rejects.toThrow("auth_staging_session_invalidation_unacknowledged");
  expect(refused.requests).toHaveLength(0);
  const h = harness({ active: true });
  expect(await rotate(h, ["session-salt"], next)).toMatchObject({ status: "identity-rotated-served", identityRotation: { sessions: "all-invalidated", signingKey: null } });
  const bindings = uploadedBindings(h.requests);
  expect(textOf(bindings, "TAKOSUMI_AUTH_IDENTITY_CONTINUITY_DIGEST")).toBe(rotation.toContinuityDigest);
  expect(textOf(bindings, "TAKOSUMI_ACCOUNTS_ES256_KEY_ID")).toBe(keyId);
  expect(textOf(bindings, "TAKOSUMI_ACCOUNTS_ES256_PREVIOUS_PUBLIC_JWKS")).toBeUndefined();
  // A salt-only rotation keeps the public key set exactly as served.
  const moved = harness({ active: true });
  const renamed = rotated(["session-salt"], { vars: { TAKOSUMI_ACCOUNTS_ES256_KEY_ID: "fixture-renamed-key" } });
  const renamedTarget = parseAuthStagingTarget({ ...renamed.target, jwksSha256: jwksDigest([{ ...publicJwk, kid: "fixture-renamed-key" }]) });
  await expect(rotate(moved, ["session-salt"], { target: renamedTarget, plan: createAuthStagingPlan(renamedTarget, config, bytes), secrets: renamed.secrets })).rejects.toThrow("auth_staging_jwks_continuity_changed");
  expect(writes(moved.requests)).toHaveLength(0);
  // Both identity secrets in one reviewed change.
  const both = harness({ active: true });
  const combined = rotated(["signing-key", "session-salt"]);
  expect(await rotate(both, ["session-salt", "signing-key"], combined)).toMatchObject({ status: "identity-rotated-served", identityRotation: { rotate: ["session-salt", "signing-key"], sessions: "all-invalidated", signingKey: { toKid: nextKeyId } } });
});

test("pairwise and subject secrets never rotate, and a rotation changes exactly the named identity secrets", async () => {
  for (const value of ["pairwise-subject-secret", "subject-secret", "pairwise", "signing-key,TAKOSUMI_ACCOUNTS_SUBJECT_SECRET", "TAKOSUMI_ACCOUNTS_OIDC_PAIRWISE_SUBJECT_SECRET"]) {
    expect(() => parseAuthStagingIdentityRotation(value)).toThrow("auth_staging_identity_rotation_subject_refused");
  }
  for (const value of ["", "signing-key,signing-key", "client-secret", "signing-key,", "SIGNING-KEY"]) {
    expect(() => parseAuthStagingIdentityRotation(value)).toThrow("auth_staging_identity_rotation_invalid");
  }
  expect(parseAuthStagingIdentityRotation("signing-key,session-salt")).toEqual(["session-salt", "signing-key"]);
  const other = Buffer.alloc(32, 77).toString("base64url");
  for (const [change, error] of [
    [{ TAKOSUMI_ACCOUNTS_OIDC_PAIRWISE_SUBJECT_SECRET: other }, "auth_staging_identity_rotation_subject_refused"],
    [{ TAKOSUMI_ACCOUNTS_SUBJECT_SECRET: other }, "auth_staging_identity_rotation_subject_refused"],
    [{ TAKOSUMI_ACCOUNT_SESSION_HASH_SALT: other }, "auth_staging_identity_rotation_scope_exceeded"],
    [{ TAKOSUMI_ACCOUNTS_HOSTED_STAGE_CLIENT_SECRET: other }, "auth_staging_identity_rotation_non_identity_changed"],
    [{ TAKOSUMI_ACCOUNTS_UPSTREAM_GITHUB_CLIENT_SECRET: "fixture-github-secret-2" }, "auth_staging_identity_rotation_non_identity_changed"],
  ] as const) {
    const next = rotated(["signing-key"], { secrets: change });
    await expect(createAuthStagingIdentityRotation(next.target, next.secrets, secrets, ["signing-key"])).rejects.toThrow(error);
  }
  // Nothing rotated, or the same key material re-encoded.
  const unchanged = rotated([]);
  await expect(createAuthStagingIdentityRotation(unchanged.target, unchanged.secrets, secrets, ["session-salt"])).rejects.toThrow("auth_staging_identity_rotation_unchanged");
  const reencoded = rotated(["signing-key"], { secrets: { TAKOSUMI_ACCOUNTS_ES256_PRIVATE_JWK: JSON.stringify({ ...privateJwk, ext: false }) } });
  await expect(createAuthStagingIdentityRotation(parseAuthStagingTarget({ ...reencoded.target, jwksSha256: jwksDigest([{ ...publicJwk, kid: nextKeyId }, publicJwk]) }), reencoded.secrets, secrets, ["signing-key"])).rejects.toThrow("auth_staging_identity_rotation_unchanged");
  // The operator entry refuses these before reading any private file or credential.
  const missing = ["--target", "/nonexistent/auth-staging-target.json", "--canonical-config", "/nonexistent/canonical.toml"];
  await expect(runAuthStagingRelease("takosumi-auth-staging-authority", ["apply", ...missing, "--rotate-identity", "pairwise-subject-secret"])).rejects.toThrow("auth_staging_identity_rotation_subject_refused");
  await expect(runAuthStagingRelease("takosumi-auth-staging-code", ["apply", ...missing, "--rotate-identity", "signing-key"])).rejects.toThrow("auth_staging_identity_rotation_action_invalid");
  await expect(runAuthStagingRelease("takosumi-auth-staging-topology", ["apply", ...missing, "--retire-previous-key", keyId])).rejects.toThrow("auth_staging_identity_rotation_action_invalid");
  for (const extra of [["--acknowledge-session-invalidation"], ["--previous-secrets", "/nonexistent/served.json"], ["--rotate-identity", "signing-key", "--retire-previous-key", keyId], ["--rotate-identity", "session-salt", "--acknowledge-session-invalidation", "--acknowledge-session-invalidation"]]) {
    await expect(runAuthStagingRelease("takosumi-auth-staging-authority", ["apply", ...missing, ...extra])).rejects.toThrow("auth_staging_arguments_invalid");
  }
});

test("a rotation is identity-only against the served Version", async () => {
  const otherClient = Buffer.alloc(32, 78).toString("base64url");
  const cases: { name: string; error: string; run: (h: ReturnType<typeof harness>) => Promise<unknown>; options?: Parameters<typeof harness>[0] }[] = [
    { name: "another variable", error: "auth_staging_identity_only_authority_changed", run: (h) => rotate(h, ["signing-key"], rotated(["signing-key"], { vars: { TAKOSUMI_REQUEST_PHASE_DIAGNOSTICS: "true" } })) },
    { name: "another source commit", error: "auth_staging_identity_only_code_changed", run: (h) => rotate(h, ["signing-key"], rotated(["signing-key"], { sourceCommit: "d".repeat(40) })) },
    { name: "another artifact", error: "auth_staging_identity_only_code_changed", run: (h) => {
      const next = rotated(["signing-key"]);
      const artifact = new TextEncoder().encode("export default {fetch(){return new Response('changed')}}");
      const plan = createAuthStagingPlan(next.target, config, artifact);
      return rotate(h, ["signing-key"], { ...next, plan }, {}, { artifact });
    } },
    { name: "a served bundle with other non-identity secrets", error: "auth_staging_identity_only_authority_changed", run: async (h) => {
      const previous = { ...secrets, TAKOSUMI_ACCOUNTS_SERVER_STAGE_CLIENT_SECRET: otherClient };
      const next = rotated(["signing-key"], { secrets: { TAKOSUMI_ACCOUNTS_SERVER_STAGE_CLIENT_SECRET: otherClient } });
      const rotation = await createAuthStagingIdentityRotation(next.target, next.secrets, previous, ["signing-key"]);
      return h.execute("authority", { target: next.target, plan: next.plan, confirmation: next.plan.confirmation, secrets: next.secrets,
        identityRotation: { ...rotationInput(rotation), previousSecrets: previous, previousSecretsSha256: sha(JSON.stringify(previous)) } });
    } },
    { name: "a served bundle with another identity", error: "auth_staging_identity_rotation_predecessor_mismatch", run: async (h) => {
      const previous = { ...secrets, TAKOSUMI_ACCOUNT_SESSION_HASH_SALT: nextSalt };
      const next = rotated(["signing-key"], { secrets: { TAKOSUMI_ACCOUNT_SESSION_HASH_SALT: nextSalt } });
      const rotation = await createAuthStagingIdentityRotation(next.target, next.secrets, previous, ["signing-key"]);
      return h.execute("authority", { target: next.target, plan: next.plan, confirmation: next.plan.confirmation, secrets: next.secrets,
        identityRotation: { ...rotationInput(rotation), previousSecrets: previous, previousSecretsSha256: sha(JSON.stringify(previous)) } });
    } },
    { name: "a previous key the issuer never served", error: "auth_staging_identity_rotation_overlap_missing", run: (h) => rotate(h, ["signing-key"], rotated(["signing-key"], { previousKeys: [publicJwk, foreignPublicJwk] })) },
    { name: "a route-less slot", error: "auth_staging_identity_rotation_requires_served_issuer", options: {}, run: (h) => rotate(h, ["signing-key"]) },
    { name: "a predecessor without a recorded digest", error: "auth_staging_identity_rotation_predecessor_unrecorded", options: { active: true, predecessor: (bindings) => bindings.filter((binding) => binding.name !== "TAKOSUMI_AUTH_IDENTITY_CONTINUITY_DIGEST") }, run: (h) => rotate(h, ["signing-key"]) },
  ];
  for (const entry of cases) {
    const h = harness(entry.options ?? { active: true });
    await expect(entry.run(h)).rejects.toThrow(entry.error);
    expect({ name: entry.name, writes: writes(h.requests).length }).toEqual({ name: entry.name, writes: 0 });
  }
  // The new JWKS must carry the previous public key at all.
  const dropped = rotated(["signing-key"], { previousKeys: [] });
  await expect(createAuthStagingIdentityRotation(dropped.target, dropped.secrets, secrets, ["signing-key"])).rejects.toThrow("auth_staging_identity_rotation_overlap_missing");
});

test("after a rotation ordinary releases pass with the new bundle, and retirement drops the previous key only after the overlap", async () => {
  const h = harness({ active: true });
  const next = rotated(["signing-key"]);
  await rotate(h, ["signing-key"], next);
  const ordinary = { target: next.target, plan: next.plan, confirmation: next.plan.confirmation, secrets: next.secrets };
  expect(await h.execute("code", ordinary)).toMatchObject({ status: "ready" });
  expect(await h.execute("authority", ordinary)).toMatchObject({ status: "authority-ready-served" });
  // The served identity is now the rotated one: the leaked bundle cannot come back unreviewed.
  await expect(h.execute("authority")).rejects.toThrow("auth_staging_identity_continuity_changed");

  const vars: Record<string, string> = { ...next.target.vars };
  delete vars.TAKOSUMI_ACCOUNTS_ES256_PREVIOUS_PUBLIC_JWKS;
  const retiredTarget = parseAuthStagingTarget({ ...next.target, jwksSha256: jwksDigest([nextPublicJwk]), vars });
  const retiredPlan = createAuthStagingPlan(retiredTarget, config, bytes);
  const retirement = { target: retiredTarget, plan: retiredPlan, confirmation: retiredPlan.confirmation, secrets: next.secrets };
  const before = h.requests.length;
  // An ordinary authority change cannot drop the published previous key.
  await expect(h.execute("authority", retirement)).rejects.toThrow("auth_staging_jwks_continuity_changed");
  await expect(h.execute("authority", { ...retirement, retirePreviousKeys: [keyId] })).rejects.toThrow("auth_staging_previous_key_overlap_active");
  await expect(h.execute("authority", { ...retirement, retirePreviousKeys: ["fixture-other-key"] })).rejects.toThrow("auth_staging_previous_key_retirement_mismatch");
  await expect(h.execute("authority", { ...retirement, retirePreviousKeys: [nextKeyId] })).rejects.toThrow("auth_staging_previous_key_retirement_invalid");
  await expect(h.execute("authority", { ...retirement, reviewer: undefined, retirePreviousKeys: [keyId] })).rejects.toThrow("auth_staging_independent_review_required");
  expect(writes(h.requests.slice(before))).toHaveLength(0);
  try {
    setSystemTime(new Date(Date.now() + AUTH_STAGING_SIGNING_KEY_MIN_OVERLAP_MS + 60_000));
    expect(await h.execute("authority", { ...retirement, retirePreviousKeys: [keyId] })).toMatchObject({ status: "previous-key-retired-served", retiredKids: [keyId] });
    const bindings = uploadedBindings(h.requests);
    expect(textOf(bindings, "TAKOSUMI_ACCOUNTS_ES256_PREVIOUS_PUBLIC_JWKS")).toBeUndefined();
    expect(textOf(bindings, "TAKOSUMI_ACCOUNTS_ES256_KEY_ID")).toBe(nextKeyId);
    expect(textOf(bindings, "TAKOSUMI_AUTH_IDENTITY_CONTINUITY_DIGEST")).toBe(sha(JSON.stringify(["TAKOSUMI_ACCOUNTS_ES256_PRIVATE_JWK", "TAKOSUMI_ACCOUNTS_OIDC_PAIRWISE_SUBJECT_SECRET", "TAKOSUMI_ACCOUNTS_SUBJECT_SECRET", "TAKOSUMI_ACCOUNT_SESSION_HASH_SALT"].map((name) => [name, sha(next.secrets[name]!)]))));
    setSystemTime(new Date(Date.now() + AUTH_STAGING_SIGNING_KEY_MIN_OVERLAP_MS + 60_000));
    await expect(h.execute("authority", { ...retirement, retirePreviousKeys: [keyId] })).rejects.toThrow("auth_staging_previous_key_absent");
    expect(await h.execute("authority", retirement)).toMatchObject({ status: "authority-ready-served" });
  } finally { setSystemTime(); }
});

test("retirement needs a verifiable serving deployment time and changes nothing but the previous keys", async () => {
  const next = rotated(["signing-key"]);
  const vars: Record<string, string> = { ...next.target.vars };
  delete vars.TAKOSUMI_ACCOUNTS_ES256_PREVIOUS_PUBLIC_JWKS;
  const retire = (h: ReturnType<typeof harness>, change: Record<string, string> = {}) => {
    const target = parseAuthStagingTarget({ ...next.target, jwksSha256: jwksDigest([nextPublicJwk]), vars: { ...vars, ...change } });
    const plan = createAuthStagingPlan(target, config, bytes);
    return h.execute("authority", { target, plan, confirmation: plan.confirmation, secrets: next.secrets, retirePreviousKeys: [keyId] });
  };
  // A served Version that already carries the rotation, published long ago.
  const served = (overrides: Parameters<typeof harness>[0] = {}) => harness({ active: true, ...overrides, predecessor: (bindings) => {
    const identity = sha(JSON.stringify(["TAKOSUMI_ACCOUNTS_ES256_PRIVATE_JWK", "TAKOSUMI_ACCOUNTS_OIDC_PAIRWISE_SUBJECT_SECRET", "TAKOSUMI_ACCOUNTS_SUBJECT_SECRET", "TAKOSUMI_ACCOUNT_SESSION_HASH_SALT"].map((name) => [name, sha(next.secrets[name]!)])));
    const plain = Object.entries(next.target.vars).map(([name, text]) => ({ name, type: "plain_text", text }));
    return [...bindings.filter((binding) => binding.type !== "plain_text" || ["TAKOSUMI_AUTH_ARTIFACT_DIGEST", "TAKOSUMI_AUTH_SOURCE_COMMIT"].includes(String(binding.name))), ...plain,
      { name: "TAKOSUMI_AUTH_AUTHORITY_DIGEST", type: "plain_text", text: next.plan.authorityDigest }, { name: "TAKOSUMI_AUTH_IDENTITY_CONTINUITY_DIGEST", type: "plain_text", text: identity }];
  } });
  expect(await retire(served())).toMatchObject({ status: "previous-key-retired-served", retiredKids: [keyId] });
  for (const [options, change, error] of [
    [{ servedSince: null }, {}, "auth_staging_previous_key_overlap_unverifiable"],
    [{ servedSince: Date.now() + 10 * 60_000 }, {}, "auth_staging_previous_key_overlap_unverifiable"],
    [{}, { TAKOSUMI_REQUEST_PHASE_DIAGNOSTICS: "true" }, "auth_staging_identity_only_authority_changed"],
  ] as const) {
    const h = served(options);
    await expect(retire(h, change)).rejects.toThrow(error);
    expect(writes(h.requests)).toHaveLength(0);
  }
  // Nothing to retire on an issuer that never rotated.
  const plain = harness({ active: true });
  await expect(plain.execute("authority", { retirePreviousKeys: [keyId.replace("key", "old")] })).rejects.toThrow("auth_staging_previous_key_absent");
  expect(writes(plain.requests)).toHaveLength(0);
});
