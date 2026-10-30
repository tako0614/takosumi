import { expect, test } from "bun:test";
import {
  configuredOidcClientsWithTakosumiMobile,
  createCloudflareWorker,
  parseConfiguredOidcClients,
  parseHostedSessionPolicy,
  type CloudflareWorkerEnv,
} from "../../../../deploy/accounts-cloudflare/src/handler.ts";
import type { D1Database } from "../../../../accounts/service/src/d1-store.ts";
import { applyD1AccountsMigrationBatch, loadD1AccountsMigrationCatalog } from "../../../../accounts/service/src/d1-migrations.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

function environment(values: Record<string, unknown> = {}): CloudflareWorkerEnv {
  const database: D1Database = {
    prepare() { throw new Error("configuration parsing must not query a database"); },
    async batch() { throw new Error("configuration parsing must not mutate a database"); },
  };
  return { TAKOSUMI_ACCOUNTS_DB: database, ...values };
}

function registration(clientId: string, secretEnv: string) {
  return {
    profile: "shared-account",
    enabled: true,
    clientId,
    clientSecretEnv: secretEnv,
    redirectUris: ["https://rp.example.test/auth/oidc/callback"],
    allowedScopes: ["openid", "email", "offline_access"],
    tokenEndpointAuthMethod: "client_secret_basic",
  };
}

test("shared hosted clients resolve independent secret bindings, keeping descriptors value-free", () => {
  const records = [registration("server-staging", "SERVER_RP_SECRET"), registration("hosted-staging", "HOSTED_RP_SECRET")];
  const clients = parseConfiguredOidcClients(environment({
    TAKOSUMI_ACCOUNTS_CLIENTS: JSON.stringify(records),
    SERVER_RP_SECRET: "fixture-server-secret",
    HOSTED_RP_SECRET: "fixture-hosted-secret",
  }));
  expect(clients?.map((client) => [client.clientId, client.profile, client.enabled, client.clientSecret])).toEqual([
    ["server-staging", "shared-account", true, "fixture-server-secret"],
    ["hosted-staging", "shared-account", true, "fixture-hosted-secret"],
  ]);
  expect(JSON.stringify(records)).not.toContain("fixture-server-secret");
  expect(JSON.stringify(records)).not.toContain("fixture-hosted-secret");
});

test("shared hosted configuration refuses inline and missing secrets without disclosing values", () => {
  const inline = { ...registration("server-staging", "SERVER_RP_SECRET"), clientSecret: "fixture-inline-not-a-binding" };
  expect(() => parseConfiguredOidcClients(environment({
    TAKOSUMI_ACCOUNTS_CLIENTS: JSON.stringify([inline]),
    SERVER_RP_SECRET: "fixture-server-secret",
  }))).toThrow("binding and inline secret cannot both be supplied");
  expect(() => parseConfiguredOidcClients(environment({
    TAKOSUMI_ACCOUNTS_CLIENTS: JSON.stringify([registration("server-staging", "SERVER_RP_SECRET")]),
  }))).toThrow("secret binding is unavailable");
  const withoutBinding = { ...registration("server-staging", "SERVER_RP_SECRET"), clientSecretEnv: undefined };
  expect(() => parseConfiguredOidcClients(environment({
    TAKOSUMI_ACCOUNTS_CLIENTS: JSON.stringify([withoutBinding]),
  }))).toThrow("require a separate clientSecretEnv");
});

test("profile and enabling declarations cannot be coerced into hosted authority", () => {
  for (const invalid of [
    { ...registration("server-staging", "SERVER_RP_SECRET"), profile: "admin" },
    { ...registration("server-staging", "SERVER_RP_SECRET"), enabled: "true" },
    { ...registration("server-staging", "SERVER_RP_SECRET"), clientSecretEnv: "../../secret" },
  ]) {
    expect(() => parseConfiguredOidcClients(environment({
      TAKOSUMI_ACCOUNTS_CLIENTS: JSON.stringify([invalid]), SERVER_RP_SECRET: "fixture-server-secret",
    }))).toThrow();
  }
  const disabled = parseConfiguredOidcClients(environment({
    TAKOSUMI_ACCOUNTS_CLIENTS: JSON.stringify([{ ...registration("server-staging", "SERVER_RP_SECRET"), enabled: undefined }]),
    SERVER_RP_SECRET: "fixture-server-secret",
  }));
  expect(disabled?.[0]?.enabled).toBe(false);
});

test("shared hosted policy is absent by default and accepts exact opt-in only", () => {
  expect(parseHostedSessionPolicy(environment())).toBe(false);
  expect(parseHostedSessionPolicy(environment({ TAKOSUMI_ACCOUNTS_HOSTED_SESSION_POLICY: "false" }))).toBe(false);
  expect(parseHostedSessionPolicy(environment({ TAKOSUMI_ACCOUNTS_HOSTED_SESSION_POLICY: "true" }))).toBe(true);
  for (const value of ["TRUE", "yes", "", 1, true]) {
    expect(() => parseHostedSessionPolicy(environment({ TAKOSUMI_ACCOUNTS_HOSTED_SESSION_POLICY: value }))).toThrow();
  }
});

test("shared hosted registration refuses duplicate IDs and global credential overrides", () => {
  const client = registration("server-staging", "SERVER_RP_SECRET");
  expect(() => parseConfiguredOidcClients(environment({
    TAKOSUMI_ACCOUNTS_CLIENTS: JSON.stringify([client, client]), SERVER_RP_SECRET: "fixture-server-secret",
  }))).toThrow("clientId values must be unique");
  expect(() => parseConfiguredOidcClients(environment({
    TAKOSUMI_ACCOUNTS_CLIENTS: JSON.stringify([client]), SERVER_RP_SECRET: "fixture-server-secret",
    TAKOSUMI_ACCOUNTS_CLIENT_ID: "server-staging", TAKOSUMI_ACCOUNTS_CLIENT_SECRET: "fixture-global-override",
  }))).toThrow("cannot be overridden");
});

test("shared hosted bootstrap mode fails before request-time DDL or database reads", async () => {
  let queries = 0;
  const database: D1Database = {
    prepare() { queries++; throw new Error("protected ledger must not be queried or bootstrapped"); },
    async batch() { queries++; throw new Error("protected ledger must not be mutated"); },
  };
  const response = await createCloudflareWorker().fetch(
    new Request("https://issuer.example.test/.well-known/openid-configuration"),
    environment({
      TAKOSUMI_ACCOUNTS_DB: database,
      TAKOSUMI_ACCOUNTS_HOSTED_SESSION_POLICY: "true",
      TAKOSUMI_ACCOUNTS_D1_SCHEMA_MODE: "bootstrap",
      TAKOSUMI_ACCOUNTS_ISSUER: "https://issuer.example.test",
      TAKOSUMI_ACCOUNT_SESSION_HASH_SALT: "fixture-protected-salt-32-characters-minimum",
    }),
  );
  expect(response.status).toBe(500);
  expect(queries).toBe(0);
});

test("protected bridge accepts exact v4/v5 while shared mode needs v5 without request DDL", async () => {
  const signingKey = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const privateJwk = await crypto.subtle.exportKey("jwk", signingKey.privateKey);
  for (const headVersion of [4, 5]) {
    const database = new SqliteFakeD1();
    const catalog = await loadD1AccountsMigrationCatalog();
    for (const migration of catalog.migrations) {
      if (migration.version > headVersion) break;
      await applyD1AccountsMigrationBatch(database, migration, 1_000 + migration.version);
    }
    let ddlAttempts = 0;
    const guarded = {
      prepare(sql: string) {
        if (/^\s*(CREATE|ALTER|DROP)\b/iu.test(sql)) { ddlAttempts++; throw new Error("request DDL refused"); }
        return database.prepare(sql);
      },
      batch: database.batch.bind(database),
      exec() { ddlAttempts++; throw new Error("request DDL refused"); },
    } as D1Database;
    const common = {
      TAKOSUMI_ACCOUNTS_DB: guarded,
      TAKOSUMI_ACCOUNTS_D1_SCHEMA_MODE: "predeployed",
      TAKOSUMI_ACCOUNTS_ISSUER: "https://issuer.example.test",
      TAKOSUMI_ACCOUNT_SESSION_HASH_SALT: "fixture-protected-session-salt",
      TAKOSUMI_ACCOUNTS_ES256_PRIVATE_JWK: JSON.stringify(privateJwk),
      TAKOSUMI_ACCOUNTS_OIDC_PAIRWISE_SUBJECT_SECRET: "fixture-pairwise-subject-secret",
    };
    const request = () => new Request("https://issuer.example.test/.well-known/openid-configuration");
    expect((await createCloudflareWorker().fetch(request(), environment(common))).status).toBe(200);
    const shared = await createCloudflareWorker().fetch(request(), environment({ ...common, TAKOSUMI_ACCOUNTS_HOSTED_SESSION_POLICY: "true" }));
    expect(shared.status).toBe(headVersion === 5 ? 200 : 500);
    if (headVersion === 5) expect(await shared.json()).toMatchObject({ issuer: "https://issuer.example.test", token_endpoint_auth_methods_supported: ["client_secret_basic"] });
    expect(ddlAttempts).toBe(0);
  }
});

test("the built-in Takosumi Mobile client is on by default and off under the shared hosted policy", () => {
  const plain = configuredOidcClientsWithTakosumiMobile(environment());
  expect(plain.mobileOidcClientId).toBe("takosumi-mobile");
  expect(plain.clients?.map((client) => [client.clientId, client.consent, client.tokenEndpointAuthMethod])).toEqual([
    ["takosumi-mobile", "always", "none"],
  ]);

  const hosted = configuredOidcClientsWithTakosumiMobile(environment({
    TAKOSUMI_ACCOUNTS_HOSTED_SESSION_POLICY: "true",
    TAKOSUMI_ACCOUNTS_CLIENTS: JSON.stringify([registration("server-staging", "SERVER_RP_SECRET")]),
    SERVER_RP_SECRET: "fixture-server-secret",
  }));
  expect(hosted.mobileOidcClientId).toBeUndefined();
  expect(hosted.clients?.map((client) => client.clientId)).toEqual(["server-staging"]);

  const hostedOptIn = configuredOidcClientsWithTakosumiMobile(environment({
    TAKOSUMI_ACCOUNTS_HOSTED_SESSION_POLICY: "true",
    TAKOSUMI_MOBILE_OIDC_BUILTIN_CLIENT: "true",
  }));
  expect(hostedOptIn.mobileOidcClientId).toBe("takosumi-mobile");

  expect(() => configuredOidcClientsWithTakosumiMobile(environment({
    TAKOSUMI_MOBILE_OIDC_BUILTIN_CLIENT: "yes",
  }))).toThrow("TAKOSUMI_MOBILE_OIDC_BUILTIN_CLIENT must be true or false");
});
