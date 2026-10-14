import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  AuthStagingIncompleteError,
  authStagingResourceBindings,
  createAuthStagingPlan,
  executeAuthStagingRelease,
  parseAuthStagingTarget,
  verifyAuthStagingSchemaTarget,
  type AuthStagingProvider,
  type AuthStagingReleaseRuntime,
} from "../../scripts/auth-staging-release.ts";
import { AUTH_STAGING_CLIENTS, AUTH_STAGING_COMPATIBILITY_DATE, AUTH_STAGING_HOST, AUTH_STAGING_ISSUER, AUTH_STAGING_WORKER } from "../../deploy/accounts-cloudflare/src/staging-target.ts";

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
};

function fixtureTarget() {
  return parseAuthStagingTarget({
    kind: "takosumi.auth-staging-target@v1", environment: "staging", worker: AUTH_STAGING_WORKER, issuer: AUTH_STAGING_ISSUER,
    accountId: "a".repeat(32), zoneId: "b".repeat(32), repository: "https://github.com/tako0614/takosumi", sourceCommit: "c".repeat(40),
    canonicalStageConfigSha256: sha(config), canonicalStageVersionId: canonicalVersion, secretsSha256: sha(JSON.stringify(secrets)), jwksSha256: sha(JSON.stringify({ keys: [publicJwk] })), requiredSecrets: Object.keys(secrets),
    vars: { TAKOSUMI_ENVIRONMENT: "staging", TAKOSUMI_AUTH_WORKER_NAME: AUTH_STAGING_WORKER, TAKOSUMI_ACCOUNTS_ISSUER: AUTH_STAGING_ISSUER, TAKOSUMI_ACCOUNTS_D1_SCHEMA_MODE: "predeployed", TAKOSUMI_CONTROL_D1_SCHEMA_MODE: "predeployed", TAKOSUMI_ACCOUNTS_HOSTED_SESSION_POLICY: "true", TAKOSUMI_ACCOUNTS_ES256_KEY_ID: keyId, TAKOSUMI_ACCOUNTS_CLIENTS: JSON.stringify(clientMetadata), TAKOSUMI_ACCOUNTS_UPSTREAM_PROVIDERS: JSON.stringify(upstreamMetadata) },
  });
}

function harness(options: { exists?: boolean; active?: boolean; schemaError?: boolean; lostUploadAck?: boolean; badBinding?: boolean; badNamespace?: boolean; wrongCanonical?: boolean; wrongCurrent?: boolean; extraPreview?: boolean; publicError?: boolean; domainOwned?: boolean } = {}) {
  const target = fixtureTarget();
  const plan = createAuthStagingPlan(target, config, bytes);
  let exists = options.exists ?? true;
  let active = options.active ?? false;
  let current = previousVersion;
  let version: Record<string, unknown> = {};
  const requests: { method: string; path: string; body?: BodyInit }[] = [];
  let schemaCalls = 0;
  let publicCalls = 0;
  let bootstrapCalls = 0;
  const canonicalBindings = plan.bindings.map((binding) => ({ ...binding, ...(binding.type === "durable_object_namespace" ? { namespace_id: `fixture-${binding.name}`, script_name: undefined } : {}) }));
  const provider: AuthStagingProvider = {
    async request(method, path, body) {
      requests.push({ method, path, body });
      if (path === `/workers/scripts/${AUTH_STAGING_WORKER}/script-settings`) return exists ? {} : null;
      if (path === `/workers/scripts/takosumi-staging/versions/${canonicalVersion}`) return { resources: { bindings: { bindings: canonicalBindings.map((binding) => options.wrongCanonical && binding.name === "TAKOSUMI_ACCOUNTS_DB" ? { ...binding, id: uuid("f") } : binding) } } };
      if (path === "/workers/scripts/takosumi-staging/deployments") return { deployments: [{ versions: [{ version_id: options.wrongCurrent ? uuid("f") : canonicalVersion, percentage: 100 }] }] };
      if (path.endsWith("/subdomain")) return { enabled: false, previews_enabled: false };
      if (path.endsWith("/schedules") || path.endsWith("/workers/routes")) return [];
      if (path.startsWith("/workers/domains?service=")) return active ? [{ hostname: AUTH_STAGING_HOST, service: AUTH_STAGING_WORKER, zone_id: target.zoneId, enabled: true, previews_enabled: options.extraPreview ?? false }] : [];
      if (path.startsWith("/workers/domains?hostname=")) return options.domainOwned ? [{ service: "foreign-worker" }] : [];
      if (method === "PUT" && path === "/workers/domains") { active = true; return {}; }
      if (path.endsWith("/deployments")) {
        if (method === "POST") current = uploadedVersion;
        return { deployments: [{ versions: [{ version_id: current, percentage: 100 }] }] };
      }
      if (method === "POST" && path.endsWith("/versions")) {
        const form = body as FormData;
        const metadata = JSON.parse(String(form.get("metadata")));
        const bindings = metadata.bindings.map((binding: Record<string, unknown>) => {
          if (options.badBinding && binding.name === "TAKOSUMI_ACCOUNTS_DB") return { ...binding, id: uuid("f") };
          if (binding.type === "durable_object_namespace") return { ...binding, namespace_id: options.badNamespace ? "foreign-namespace" : `fixture-${binding.name}` };
          if (binding.type === "secret_text") return { name: binding.name, type: binding.type };
          return binding;
        });
        version = { resources: { script: { handlers: ["fetch"] }, script_runtime: { compatibility_date: AUTH_STAGING_COMPATIBILITY_DATE, compatibility_flags: ["nodejs_compat"] }, bindings: { bindings } } };
        if (options.lostUploadAck) throw new Error("fixture_lost_ack");
        return { id: uploadedVersion };
      }
      if (path.endsWith(`/versions/${uploadedVersion}`)) return version;
      if (path.endsWith(`/versions/${previousVersion}`)) return existingVersion();
      throw new Error(`unexpected fixture path ${path}`);
    },
  };
  const existingVersion = () => ({ resources: { script: { handlers: ["fetch"] }, script_runtime: { compatibility_date: AUTH_STAGING_COMPATIBILITY_DATE, compatibility_flags: ["nodejs_compat"] }, bindings: { bindings: [
    ...plan.bindings.map((binding) => ({ ...binding, ...(binding.type === "durable_object_namespace" ? { namespace_id: `fixture-${binding.name}` } : {}) })),
    ...Object.entries(target.vars).map(([name, text]) => ({ name, type: "plain_text", text })),
    { name: "TAKOSUMI_AUTH_ARTIFACT_DIGEST", type: "plain_text", text: plan.artifactDigest }, { name: "TAKOSUMI_AUTH_AUTHORITY_DIGEST", type: "plain_text", text: plan.authorityDigest },
    { name: "TAKOSUMI_AUTH_SOURCE_COMMIT", type: "plain_text", text: target.sourceCommit }, { name: "TAKOSUMI_VERSION_METADATA", type: "version_metadata" }, ...target.requiredSecrets.map((name) => ({ name, type: "secret_text" })),
  ] } } });
  const runtime: AuthStagingReleaseRuntime = {
    provider, async verifySchema() { schemaCalls++; if (options.schemaError) throw new Error("fixture_v4_or_drifted_schema"); },
    async publicReadback() { publicCalls++; if (options.publicError) throw new Error("fixture_readback_failed"); },
    async bootstrap() { bootstrapCalls++; exists = true; },
  };
  const execute = (action: "bootstrap" | "authority" | "code" | "topology", overrides = {}) => executeAuthStagingRelease({ action, target, plan, artifact: bytes, secrets, confirmation: plan.confirmation, reviewer: "independent-fixture-reviewer", ...overrides }, runtime);
  return { target, plan, runtime, requests, execute, counts: () => ({ schemaCalls, publicCalls, bootstrapCalls }) };
}

test("target rejects production Worker/environment/issuer, unregistered callbacks, inline secrets and client disable", () => {
  const target = fixtureTarget();
  for (const patch of [{ worker: "takosumi" }, { issuer: "https://auth.takos.jp" }, { environment: "production" }, { clientId: "extra" }]) expect(() => parseAuthStagingTarget({ ...target, ...patch })).toThrow();
  for (const patch of [{ redirectUris: ["https://app.takosumi.com/auth/oidc/callback"] }, { clientSecret: "inline" }, { enabled: false }, { allowedScopes: ["openid", "admin"] }, { tokenEndpointAuthMethod: "none" }]) expect(() => parseAuthStagingTarget({ ...target, vars: { ...target.vars, TAKOSUMI_ACCOUNTS_CLIENTS: JSON.stringify([{ ...clientMetadata[0], ...patch }, clientMetadata[1]]) } })).toThrow();
  expect(() => parseAuthStagingTarget({ ...target, vars: { ...target.vars, TAKOSUMI_ACCOUNTS_CLIENTS: JSON.stringify([clientMetadata[0], { ...clientMetadata[1], redirectUris: ["https://takoserver-console-integration.shoutatomiyama0614.workers.dev/auth/oidc/callback"] }]) } })).toThrow();
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
  for (const options of [{ schemaError: true }, { wrongCanonical: true }, { wrongCurrent: true }, { active: true }, { domainOwned: true }]) {
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
  expect(writes).toHaveLength(1);
  expect(JSON.parse(String(writes[0]?.body))).toEqual({ hostname: AUTH_STAGING_HOST, service: AUTH_STAGING_WORKER, zone_id: h.target.zoneId, enabled: true, previews_enabled: false });
  expect(h.counts().publicCalls).toBe(1);
});

test("routine code preserves authority/topology and rejects enabled custom-domain previews", async () => {
  const h = harness({ active: true });
  expect(await h.execute("code")).toMatchObject({ status: "ready", version: uploadedVersion });
  const drift = harness({ active: true, extraPreview: true });
  await expect(drift.execute("code")).rejects.toThrow("domain_readback_mismatch");
  expect(drift.requests.filter((request) => request.method !== "GET")).toHaveLength(0);
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
