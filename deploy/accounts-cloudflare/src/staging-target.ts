/** Fixed official rehearsal target. Self-host Accounts keeps its own entry. */
export const AUTH_STAGING_WORKER = "takosumi-auth-staging";
export const AUTH_STAGING_ISSUER = "https://auth-staging.takos.jp";
export const AUTH_STAGING_HOST = "auth-staging.takos.jp";
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
      "https://takoserver-api-integration-billing-0092.shoutatomiyama0614.workers.dev/auth/oidc/callback",
    ],
    clientSecretEnv: "TAKOSUMI_ACCOUNTS_SERVER_STAGE_CLIENT_SECRET",
  },
] as const;

export function assertAuthStagingVariables(env: Readonly<Record<string, unknown>>): void {
  if (
    env.TAKOSUMI_ENVIRONMENT !== "staging" ||
    env.TAKOSUMI_AUTH_WORKER_NAME !== AUTH_STAGING_WORKER ||
    env.TAKOSUMI_ACCOUNTS_ISSUER !== AUTH_STAGING_ISSUER ||
    env.TAKOSUMI_ACCOUNTS_D1_SCHEMA_MODE !== "predeployed" ||
    env.TAKOSUMI_CONTROL_D1_SCHEMA_MODE !== "predeployed" ||
    env.TAKOSUMI_ACCOUNTS_HOSTED_SESSION_POLICY !== "true" ||
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
  for (const [providerId, protocol, verificationProfile, clientSecretEnv] of [
    ["google", "oidc", "google-oidc", "TAKOSUMI_ACCOUNTS_UPSTREAM_GOOGLE_CLIENT_SECRET"],
    ["github", "oauth2", "github-oauth", "TAKOSUMI_ACCOUNTS_UPSTREAM_GITHUB_CLIENT_SECRET"],
  ]) {
    const matches = providers.filter((provider) => record(provider) && provider.providerId === providerId);
    const provider = matches[0];
    if (matches.length !== 1 || !record(provider) || provider.protocol !== protocol ||
        provider.verificationProfile !== verificationProfile || provider.clientSecretEnv !== clientSecretEnv ||
        provider.redirectUri !== `${AUTH_STAGING_ISSUER}/oauth/upstream/callback` ||
        Object.hasOwn(provider, "clientSecret") || Object.hasOwn(provider, "clientSecretValue")) throw new Error("auth_staging_upstreams_invalid");
    secrets.push(clientSecretEnv!);
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
