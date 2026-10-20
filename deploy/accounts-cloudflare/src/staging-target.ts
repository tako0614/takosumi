import { digest as ownerDigest } from "../../../accounts/service/src/owner-operation-evidence.ts";

/** Fixed official rehearsal target. Self-host Accounts keeps its own entry. */
export const AUTH_STAGING_WORKER = "takosumi-auth-staging";
export const AUTH_STAGING_ISSUER = "https://auth-staging.takos.jp";
export const AUTH_STAGING_HOST = "auth-staging.takos.jp";
export const AUTH_STAGING_RETRY_CRON = "*/1 * * * *";
/** Preserve this existing project's qualified platform runtime policy. */
export const AUTH_STAGING_COMPATIBILITY_DATE = "2026-04-01";
export const AUTH_STAGING_CLIENTS = [
  {
    clientId: "takosumi-hosted-staging-v1",
    redirectUris: ["https://app-staging.takosumi.com/auth/oidc/callback"],
    clientSecretEnv: "TAKOSUMI_ACCOUNTS_HOSTED_STAGE_CLIENT_SECRET",
  },
  {
    clientId: "takoserver-console-staging-v1",
    redirectUris: [
      "https://integration-money-8732b77a789fd563406269261bf09e71.shoutatomiyama0614.workers.dev/auth/oidc/callback",
    ],
    clientSecretEnv: "TAKOSUMI_ACCOUNTS_SERVER_STAGE_CLIENT_SECRET",
  },
] as const;

/** Financial's staging TEST realm billing authority for the Takoserver RP.
 * Workspace billing Organizations are derived under it, never created. */
export const AUTH_STAGING_WORKSPACE_BILLING_AUTHORITY = "takoserver.hosted.staging-test.v1";

/** The lazy in-process Control operations port (directory, identity
 * reconciliation) constructs the canonical Control service, which refuses to
 * start in staging without a secret-store key and an Interface API guard
 * token. Both are the issuer's own: it never reads or writes the platform's
 * encrypted secret blobs, and its Interface API is not reachable over HTTP. */
export const AUTH_STAGING_CONTROL_SECRETS = ["TAKOSUMI_SECRET_STORE_PASSPHRASE", "TAKOSUMI_DEPLOY_CONTROL_TOKEN"] as const;

export function assertAuthStagingVariables(env: Readonly<Record<string, unknown>>): void {
  const ownerTarget = env.TAKOSUMI_ACCOUNTS_OWNER_TARGET_BINDING_DIGEST;
  const ownerClientId = env.TAKOSUMI_ACCOUNTS_OWNER_CLIENT_ID;
  if ((ownerTarget !== undefined || ownerClientId !== undefined) &&
    (!ownerDigest(ownerTarget) || typeof ownerClientId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(ownerClientId) ||
     AUTH_STAGING_CLIENTS.some((client) => client.clientId === ownerClientId))) {
    throw new Error("auth_staging_owner_target_invalid");
  }
  if (
    env.TAKOSUMI_ENVIRONMENT !== "staging" ||
    env.TAKOSUMI_AUTH_WORKER_NAME !== AUTH_STAGING_WORKER ||
    env.TAKOSUMI_ACCOUNTS_ISSUER !== AUTH_STAGING_ISSUER ||
    env.TAKOSUMI_ACCOUNTS_D1_SCHEMA_MODE !== "predeployed" ||
    env.TAKOSUMI_CONTROL_D1_SCHEMA_MODE !== "predeployed" ||
    env.TAKOSUMI_ACCOUNTS_HOSTED_SESSION_POLICY !== "true" ||
    env.TAKOSUMI_ACCOUNTS_WORKSPACE_BILLING_AUTHORITY !== AUTH_STAGING_WORKSPACE_BILLING_AUTHORITY ||
    env.LOCAL_SUBSTRATE_TEST_BED !== undefined ||
    env.TAKOSUMI_EXPOSE_INTERNAL_EDGE !== undefined ||
    env.TAKOSUMI_BILLING_REQUIRED !== undefined ||
    env.TAKOSUMI_ACCOUNTS_CLIENT_SECRET !== undefined ||
    env.TAKOSUMI_ACCOUNTS_CLIENT_ID !== undefined
  ) {
    throw new Error("auth_staging_variables_invalid");
  }
  assertAuthStagingClients(env.TAKOSUMI_ACCOUNTS_CLIENTS);
  assertAuthStagingUpstreams(env.TAKOSUMI_ACCOUNTS_UPSTREAM_PROVIDERS);
  if ((env.TAKOSUMI_ACCOUNTS_PASSKEY_RP_ID !== undefined && env.TAKOSUMI_ACCOUNTS_PASSKEY_RP_ID !== AUTH_STAGING_HOST) ||
      (env.TAKOSUMI_ACCOUNTS_PASSKEY_ORIGIN !== undefined && env.TAKOSUMI_ACCOUNTS_PASSKEY_ORIGIN !== AUTH_STAGING_ISSUER)) {
    throw new Error("auth_staging_passkey_target_invalid");
  }
  if ([env.TAKOSUMI_ACCOUNTS_PASSKEY_RP_ID, env.TAKOSUMI_ACCOUNTS_PASSKEY_RP_NAME, env.TAKOSUMI_ACCOUNTS_PASSKEY_ORIGIN].some((value) => value !== undefined) &&
      (env.TAKOSUMI_ACCOUNTS_PASSKEY_RP_ID !== AUTH_STAGING_HOST || env.TAKOSUMI_ACCOUNTS_PASSKEY_ORIGIN !== AUTH_STAGING_ISSUER ||
       typeof env.TAKOSUMI_ACCOUNTS_PASSKEY_RP_NAME !== "string" || !env.TAKOSUMI_ACCOUNTS_PASSKEY_RP_NAME.trim())) throw new Error("auth_staging_passkey_target_invalid");
}

export function assertAuthStagingUpstreams(value: unknown): readonly string[] {
  let providers: unknown;
  try { if (typeof value !== "string") throw new Error(); providers = JSON.parse(value); }
  catch { throw new Error("auth_staging_upstreams_invalid"); }
  if (!Array.isArray(providers) || providers.length !== 2) throw new Error("auth_staging_upstreams_invalid");
  const secrets = ["TAKOSUMI_ACCOUNTS_SUBJECT_SECRET"];
  // Provider selection is this dedicated target's contract; secret lookup is
  // still an explicit operator descriptor, never a fixed global provider slot.
  for (const [providerId, protocol, verificationProfile] of [
    ["google", "oidc", "google-oidc"],
    ["github", "oauth2", "github-oauth"],
  ]) {
    const matches = providers.filter((provider) => record(provider) && provider.providerId === providerId);
    const provider = matches[0];
    if (matches.length !== 1 || !record(provider) || provider.protocol !== protocol ||
        provider.verificationProfile !== verificationProfile ||
        typeof provider.clientSecretEnv !== "string" || provider.clientSecretEnv.length > 128 ||
        !/^TAKOSUMI_ACCOUNTS_UPSTREAM_[A-Z][A-Z0-9_]*_SECRET$/u.test(provider.clientSecretEnv) ||
        secrets.includes(provider.clientSecretEnv) ||
        provider.redirectUri !== `${AUTH_STAGING_ISSUER}/oauth/upstream/callback` ||
        Object.hasOwn(provider, "clientSecret") || Object.hasOwn(provider, "clientSecretValue")) throw new Error("auth_staging_upstreams_invalid");
    secrets.push(provider.clientSecretEnv);
  }
  return secrets;
}

/** Metadata only: values always arrive through separate secret bindings. */
export function assertAuthStagingClients(value: unknown): void {
  let clients: unknown;
  try {
    if (typeof value !== "string") throw new Error();
    clients = JSON.parse(value);
  } catch {
    throw new Error("auth_staging_clients_invalid");
  }
  if (!Array.isArray(clients) || clients.length !== AUTH_STAGING_CLIENTS.length) {
    throw new Error("auth_staging_clients_invalid");
  }
  for (const expected of AUTH_STAGING_CLIENTS) {
    const matches = clients.filter((client) => record(client) && client.clientId === expected.clientId);
    const client = matches[0];
    if (
      matches.length !== 1 || !record(client) ||
      Object.keys(client).sort().join(",") !== "allowedScopes,clientId,clientSecretEnv,enabled,profile,redirectUris,tokenEndpointAuthMethod" ||
      client.profile !== "shared-account" || client.enabled !== true ||
      client.tokenEndpointAuthMethod !== "client_secret_basic" ||
      client.clientSecretEnv !== expected.clientSecretEnv ||
      JSON.stringify(client.redirectUris) !== JSON.stringify(expected.redirectUris) ||
      !Array.isArray(client.allowedScopes) ||
      JSON.stringify([...client.allowedScopes].sort()) !== JSON.stringify(["email", "offline_access", "openid"])
    ) throw new Error("auth_staging_clients_invalid");
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
