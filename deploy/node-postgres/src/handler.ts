/**
 * Env parsing for the Bun + Postgres Takosumi Accounts reference
 * distribution. Mirrors the Cloudflare worker handler's env shape so
 * operators can move secrets between the two substrates by renaming
 * env vars only.
 */
import type {
  PlatformAccessPolicy,
  LoginEmailAllowlist,
  OidcClientRegistration,
  PasskeyHttpOptions,
  UpstreamOAuthClientRegistration,
  UpstreamOAuthOptions,
  RuntimeProjectionMaterialResolverHttpOptions,
} from "@takosjp/takosumi-accounts-service";
import {
  createOpenPlatformAccessPolicy,
  customOidcOAuthProvider,
  googleOAuthProvider,
  isRetiredUpstreamOAuthProviderId,
} from "@takosjp/takosumi-accounts-service";

export interface NodeAccountsStableOidcConfig {
  readonly privateJwkJson: string;
  readonly keyId?: string;
  readonly previousPublicJwksJson?: string;
  readonly subject?: string;
  readonly oidcPairwiseSubjectSecret: string;
  readonly launchTokenPairwiseSecret: string;
}

export interface NodeAccountsExportDownloadConfig {
  /**
   * HMAC-signing secret for export download URLs. The export worker signs
   * each emitted download URL with this secret (`tk_exp` + `tk_sig` query
   * params via `signExportDownloadUrl`), and the in-process download route
   * verifies the signature + expiry before serving the archive. Required
   * when any export-download env var is configured, mirroring the Cloudflare
   * profile's `TAKOSUMI_ACCOUNTS_EXPORT_DOWNLOAD_SECRET`.
   */
  readonly secret: string;
  /**
   * Filesystem directory on the accounts container where export archives
   * are materialized (`takos-export-<op>.tar.zst[.age]`). Caddy / nginx
   * (or any static file server in front of `downloadBaseUrl`) must serve
   * this directory at the same URL prefix.
   */
  readonly outputDirectory: string;
  /**
   * Absolute HTTPS URL prefix that, combined with the archive filename,
   * yields the public download URL embedded in the operation response.
   */
  readonly baseUrl: string;
  readonly ttlMs?: number;
}

export interface NodeAccountsServerConfig {
  /**
   * Bind interface for the in-process Bun listener (e.g. `0.0.0.0`).
   * This is the local listener address Caddy reverse-proxies to; it is
   * **not** the public hostname users dial. The public hostname lives in
   * Caddyfile.example via `TAKOSUMI_ACCOUNTS_PUBLIC_HOSTNAME`.
   */
  readonly bindHost: string;
  readonly port: number;
  readonly issuer: string;
  readonly managedPublicBaseDomain: string | undefined;
  readonly databaseUrl: string;
  readonly clients: readonly OidcClientRegistration[] | undefined;
  readonly platformAccess: PlatformAccessPolicy;
  readonly runtimeProjectionMaterialResolver:
    RuntimeProjectionMaterialResolverHttpOptions | undefined;
  readonly loginEmailAllowlist: LoginEmailAllowlist | undefined;
  readonly passkeys: PasskeyHttpOptions | undefined;
  readonly upstreamOAuth: UpstreamOAuthOptions | undefined;
  readonly stableOidc: NodeAccountsStableOidcConfig | undefined;
  readonly exportDownload: NodeAccountsExportDownloadConfig | undefined;
  readonly privacyOperationsToken: string | undefined;
  readonly subject: string | undefined;
}

export function parseEnv(
  env: Record<string, string | undefined>,
): NodeAccountsServerConfig {
  const databaseUrl = required(env, "TAKOSUMI_ACCOUNTS_DATABASE_URL");
  const issuer =
    optional(env, "TAKOSUMI_ACCOUNTS_ISSUER") ??
    `http://${optional(env, "HOST") ?? "localhost"}:${parseIntOr(
      env.PORT,
      8787,
    )}`;
  return {
    bindHost: optional(env, "TAKOSUMI_ACCOUNTS_BIND_HOST") ?? "0.0.0.0",
    port: parseIntOr(env.PORT ?? env.TAKOSUMI_ACCOUNTS_PORT, 8787),
    issuer,
    managedPublicBaseDomain: optional(
      env,
      "TAKOSUMI_MANAGED_PUBLIC_BASE_DOMAIN",
    ),
    databaseUrl,
    clients: parseClients(env),
    platformAccess: parsePlatformAccess(env),
    runtimeProjectionMaterialResolver: parseRuntimeProjectionMaterials(env),
    loginEmailAllowlist: parseLoginEmailAllowlist(env, issuer),
    passkeys: parsePasskeys(env),
    upstreamOAuth: parseUpstreamOAuth(env),
    stableOidc: parseStableOidc(env),
    exportDownload: parseExportDownload(env),
    privacyOperationsToken: optional(
      env,
      "TAKOSUMI_ACCOUNTS_PRIVACY_OPERATIONS_TOKEN",
    ),
    subject: optional(env, "TAKOSUMI_ACCOUNTS_SUBJECT"),
  };
}

function parseClients(
  env: Record<string, string | undefined>,
): readonly OidcClientRegistration[] | undefined {
  const raw = optional(env, "TAKOSUMI_ACCOUNTS_CLIENTS");
  if (raw) {
    const value = JSON.parse(raw);
    if (!Array.isArray(value)) {
      throw new TypeError("TAKOSUMI_ACCOUNTS_CLIENTS must be a JSON array");
    }
    return value.map(parseClientRecord);
  }
  const clientId = optional(env, "TAKOSUMI_ACCOUNTS_CLIENT_ID");
  const redirectUris = splitList(env.TAKOSUMI_ACCOUNTS_REDIRECT_URIS);
  if (!clientId && redirectUris.length === 0) return undefined;
  if (!clientId || redirectUris.length === 0) {
    throw new TypeError(
      "TAKOSUMI_ACCOUNTS_CLIENT_ID and TAKOSUMI_ACCOUNTS_REDIRECT_URIS must be set together",
    );
  }
  return [
    {
      clientId,
      redirectUris,
      ...(optional(env, "TAKOSUMI_ACCOUNTS_CLIENT_SECRET")
        ? { clientSecret: optional(env, "TAKOSUMI_ACCOUNTS_CLIENT_SECRET")! }
        : {}),
    },
  ];
}

function parseClientRecord(value: unknown): OidcClientRegistration {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("TAKOSUMI_ACCOUNTS_CLIENTS entries must be objects");
  }
  const record = value as Record<string, unknown>;
  const clientId = typeof record.clientId === "string" ? record.clientId : "";
  const redirectUris = Array.isArray(record.redirectUris)
    ? record.redirectUris.filter(
        (uri): uri is string => typeof uri === "string",
      )
    : [];
  if (!clientId || redirectUris.length === 0) {
    throw new TypeError(
      "TAKOSUMI_ACCOUNTS_CLIENTS entries require clientId and redirectUris",
    );
  }
  return {
    clientId,
    redirectUris,
    ...(typeof record.clientSecret === "string"
      ? { clientSecret: record.clientSecret }
      : {}),
  };
}

function parsePlatformAccess(
  env: Record<string, string | undefined>,
): PlatformAccessPolicy {
  const status = optional(env, "TAKOSUMI_ACCOUNTS_PLATFORM_ACCESS") ?? "closed";
  if (status === "closed") return { status: "closed" };
  if (status !== "open") {
    throw new TypeError(
      "TAKOSUMI_ACCOUNTS_PLATFORM_ACCESS must be one of: closed, open",
    );
  }
  const evidenceDigest = required(
    env,
    "TAKOSUMI_ACCOUNTS_PLATFORM_READINESS_DIGEST",
  );
  requireProductionHardeningEvidence(env);
  requireReleaseActivationEvidenceIfEnabled(env);
  return createOpenPlatformAccessPolicy(
    {
      ...(optional(env, "TAKOSUMI_ACCOUNTS_PLATFORM_EVIDENCE_REF")
        ? {
            evidenceRef: optional(
              env,
              "TAKOSUMI_ACCOUNTS_PLATFORM_EVIDENCE_REF",
            )!,
          }
        : {}),
      ...(optional(env, "TAKOSUMI_ACCOUNTS_PLATFORM_APPROVAL_REF")
        ? {
            approvalRef: optional(
              env,
              "TAKOSUMI_ACCOUNTS_PLATFORM_APPROVAL_REF",
            )!,
          }
        : {}),
      ...(optional(env, "TAKOSUMI_ACCOUNTS_PLATFORM_PUBLIC_SUMMARY")
        ? {
            publicSummary: optional(
              env,
              "TAKOSUMI_ACCOUNTS_PLATFORM_PUBLIC_SUMMARY",
            )!,
          }
        : {}),
    },
    {
      ready: true,
      evidenceDigest,
    },
  );
}

function requireReleaseActivationEvidenceIfEnabled(
  env: Record<string, string | undefined>,
): void {
  if (!optional(env, "TAKOSUMI_RELEASE_ACTIVATOR_URL")) return;
  if (!optional(env, "TAKOSUMI_RELEASE_ACTIVATOR_TOKEN")) {
    throw new TypeError(
      "Open platform readiness access requires TAKOSUMI_RELEASE_ACTIVATOR_TOKEN when TAKOSUMI_RELEASE_ACTIVATOR_URL is set",
    );
  }
  requireCommitPinnedEvidencePairs(env, [
    [
      "TAKOSUMI_RELEASE_ACTIVATION_SUCCESS_EVIDENCE_REF",
      "TAKOSUMI_RELEASE_ACTIVATION_SUCCESS_EVIDENCE_DIGEST",
    ],
    [
      "TAKOSUMI_RELEASE_ACTIVATION_FAILURE_SURFACING_EVIDENCE_REF",
      "TAKOSUMI_RELEASE_ACTIVATION_FAILURE_SURFACING_EVIDENCE_DIGEST",
    ],
    [
      "TAKOSUMI_RELEASE_ACTIVATION_LEDGER_INDEPENDENCE_EVIDENCE_REF",
      "TAKOSUMI_RELEASE_ACTIVATION_LEDGER_INDEPENDENCE_EVIDENCE_DIGEST",
    ],
    [
      "TAKOSUMI_RELEASE_ACTIVATION_PAYLOAD_BOUNDARY_EVIDENCE_REF",
      "TAKOSUMI_RELEASE_ACTIVATION_PAYLOAD_BOUNDARY_EVIDENCE_DIGEST",
    ],
  ]);
}

function requireProductionHardeningEvidence(
  env: Record<string, string | undefined>,
): void {
  if (optional(env, "TAKOSUMI_PRODUCTION_HARDENING_GATE") !== "enforce") {
    throw new TypeError(
      "Open platform readiness access requires TAKOSUMI_PRODUCTION_HARDENING_GATE=enforce",
    );
  }
  requireCommitPinnedEvidencePairs(env, [
    [
      "TAKOSUMI_CLOUDFLARE_CONTAINER_SMOKE_EVIDENCE_REF",
      "TAKOSUMI_CLOUDFLARE_CONTAINER_SMOKE_EVIDENCE_DIGEST",
    ],
    [
      "TAKOSUMI_PLATFORM_CONTROL_PLANE_SMOKE_EVIDENCE_REF",
      "TAKOSUMI_PLATFORM_CONTROL_PLANE_SMOKE_EVIDENCE_DIGEST",
    ],
    [
      "TAKOSUMI_EGRESS_ENFORCEMENT_EVIDENCE_REF",
      "TAKOSUMI_EGRESS_ENFORCEMENT_EVIDENCE_DIGEST",
    ],
    [
      "TAKOSUMI_RESTORE_REHEARSAL_EVIDENCE_REF",
      "TAKOSUMI_RESTORE_REHEARSAL_EVIDENCE_DIGEST",
    ],
    [
      "TAKOSUMI_PROVIDER_REGISTRY_EVIDENCE_REF",
      "TAKOSUMI_PROVIDER_REGISTRY_EVIDENCE_DIGEST",
    ],
    [
      "TAKOSUMI_COST_ATTRIBUTION_EVIDENCE_REF",
      "TAKOSUMI_COST_ATTRIBUTION_EVIDENCE_DIGEST",
    ],
    [
      "TAKOSUMI_SECRET_BOUNDARY_EVIDENCE_REF",
      "TAKOSUMI_SECRET_BOUNDARY_EVIDENCE_DIGEST",
    ],
  ]);
}

function requireCommitPinnedEvidencePairs(
  env: Record<string, string | undefined>,
  pairs: readonly (readonly [string, string])[],
): void {
  const commitPinnedGitRefPattern = /^git\+.+@[0-9a-f]{40,64}#.+/i;
  for (const [refName, digestName] of pairs) {
    const ref = optional(env, refName);
    if (!ref) {
      throw new TypeError(`Open platform readiness access requires ${refName}`);
    }
    if (!commitPinnedGitRefPattern.test(ref)) {
      throw new TypeError(`${refName} must be commit-pinned git+ ref`);
    }
    const digest = optional(env, digestName);
    if (!digest) {
      throw new TypeError(
        `Open platform readiness access requires ${digestName}`,
      );
    }
    if (!/^sha256:[0-9a-f]{64}$/.test(digest)) {
      throw new TypeError(`${digestName} must be sha256:<64hex>`);
    }
  }
}

function parseRuntimeProjectionMaterials(
  env: Record<string, string | undefined>,
): RuntimeProjectionMaterialResolverHttpOptions | undefined {
  const token = optional(
    env,
    "TAKOSUMI_ACCOUNTS_RUNTIME_PROJECTION_MATERIAL_RESOLVER_TOKEN",
  );
  if (!token) return undefined;
  const billingPortalUrl = optional(
    env,
    "TAKOSUMI_ACCOUNTS_BILLING_PORTAL_URL",
  );
  const internalUrl = optional(
    env,
    "TAKOSUMI_ACCOUNTS_RUNTIME_PROJECTION_MATERIALS_INTERNAL_URL",
  );
  return {
    token,
    ...(billingPortalUrl ? { billingPortalUrl } : {}),
    ...(internalUrl ? { internalUrl } : {}),
    ...(bool(
      env,
      "TAKOSUMI_ACCOUNTS_RUNTIME_PROJECTION_MATERIALS_ALLOW_DIRECT_DEPLOY_CONTROL",
    )
      ? { allowDeployControlInstallations: true }
      : {}),
  };
}

const TAKOSUMI_CLOUD_PRE_GA_LOGIN_EMAIL = "shoutatomiyama0614@gmail.com";

function parseLoginEmailAllowlist(
  env: Record<string, string | undefined>,
  issuer: string,
): LoginEmailAllowlist | undefined {
  if (isOfficialTakosumiCloudIssuer(issuer)) {
    return {
      emails: [TAKOSUMI_CLOUD_PRE_GA_LOGIN_EMAIL],
      requireVerifiedEmail: true,
    };
  }
  const configured = optional(env, "TAKOSUMI_ACCOUNTS_LOGIN_EMAIL_ALLOWLIST");
  if (configured?.trim() === "*") return undefined;
  const emails = configured !== undefined ? splitList(configured) : [];
  if (emails.length === 0) return undefined;
  return {
    emails,
    requireVerifiedEmail: !(
      optional(
        env,
        "TAKOSUMI_ACCOUNTS_LOGIN_EMAIL_ALLOWLIST_REQUIRE_VERIFIED",
      )?.toLowerCase() === "false"
    ),
  };
}

function isOfficialTakosumiCloudIssuer(issuer: string): boolean {
  try {
    const url = new URL(issuer);
    return (
      url.protocol === "https:" &&
      (url.hostname === "app.takosumi.com" ||
        url.hostname === "app-staging.takosumi.com")
    );
  } catch {
    return false;
  }
}

function parsePasskeys(
  env: Record<string, string | undefined>,
): PasskeyHttpOptions | undefined {
  const rpId = optional(env, "TAKOSUMI_ACCOUNTS_PASSKEY_RP_ID");
  const rpName = optional(env, "TAKOSUMI_ACCOUNTS_PASSKEY_RP_NAME");
  const origin =
    optional(env, "TAKOSUMI_ACCOUNTS_PASSKEY_RP_ORIGIN") ??
    optional(env, "TAKOSUMI_ACCOUNTS_PASSKEY_ORIGIN");
  const sessionTtlMs = parsePasskeyTtlMs(env);
  if (!rpId && !rpName && !origin && sessionTtlMs === undefined) {
    return undefined;
  }
  if (!rpId || !rpName || !origin) {
    throw new TypeError(
      "Passkeys require TAKOSUMI_ACCOUNTS_PASSKEY_RP_ID, TAKOSUMI_ACCOUNTS_PASSKEY_RP_NAME, and TAKOSUMI_ACCOUNTS_PASSKEY_RP_ORIGIN",
    );
  }
  return {
    rpId,
    rpName,
    origin,
    ...(sessionTtlMs !== undefined ? { sessionTtlMs } : {}),
  };
}

function parsePasskeyTtlMs(
  env: Record<string, string | undefined>,
): number | undefined {
  const ttlSeconds = optionalNonNegativeInteger(
    env,
    "TAKOSUMI_ACCOUNTS_PASSKEY_TTL_SECONDS",
  );
  if (ttlSeconds !== undefined) return ttlSeconds * 1000;
  return optionalNonNegativeInteger(
    env,
    "TAKOSUMI_ACCOUNTS_PASSKEY_SESSION_TTL_MS",
  );
}

function parseUpstreamOAuth(
  env: Record<string, string | undefined>,
): UpstreamOAuthOptions | undefined {
  const providers: UpstreamOAuthClientRegistration[] = [];
  const google = parseBuiltinUpstreamProvider(env, "GOOGLE");
  if (google) {
    providers.push({
      ...google,
      provider: googleOAuthProvider(
        parseBuiltinProviderOverrides(env, "GOOGLE"),
      ),
    });
  }
  const oidc = parseCustomOidcUpstreamProvider(env);
  if (oidc) providers.push(oidc);

  const subjectSecret = optional(env, "TAKOSUMI_ACCOUNTS_SUBJECT_SECRET");
  const sessionTtlMs = optionalNonNegativeInteger(
    env,
    "TAKOSUMI_ACCOUNTS_UPSTREAM_SESSION_TTL_MS",
  );
  if (providers.length === 0 && sessionTtlMs === undefined) {
    return undefined;
  }
  if (!subjectSecret || providers.length === 0) {
    throw new TypeError(
      "Upstream OAuth requires TAKOSUMI_ACCOUNTS_SUBJECT_SECRET and at least one upstream provider client",
    );
  }
  return {
    subjectSecret,
    providers,
    ...(sessionTtlMs !== undefined ? { sessionTtlMs } : {}),
  };
}

function parseBuiltinUpstreamProvider(
  env: Record<string, string | undefined>,
  provider: "GOOGLE",
): Omit<UpstreamOAuthClientRegistration, "provider"> | undefined {
  const prefix = `TAKOSUMI_ACCOUNTS_UPSTREAM_${provider}_`;
  const clientId = optional(env, `${prefix}CLIENT_ID`);
  const clientSecret = optional(env, `${prefix}CLIENT_SECRET`);
  const redirectUri = optional(env, `${prefix}REDIRECT_URI`);
  const scopes = splitList(env[`${prefix}SCOPES`]);
  if (!clientId && !clientSecret && !redirectUri && scopes.length === 0) {
    return undefined;
  }
  if (!clientId || !clientSecret || !redirectUri) {
    throw new TypeError(
      `${prefix}CLIENT_ID, ${prefix}CLIENT_SECRET, and ${prefix}REDIRECT_URI are required when configuring ${provider.toLowerCase()} upstream OAuth`,
    );
  }
  return {
    providerId: provider.toLowerCase(),
    clientId,
    clientSecret,
    redirectUri,
    ...(scopes.length > 0 ? { scopes } : {}),
  };
}

function parseBuiltinProviderOverrides(
  env: Record<string, string | undefined>,
  provider: "GOOGLE",
): {
  issuer?: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  userInfoEndpoint?: string;
} {
  const prefix = `TAKOSUMI_ACCOUNTS_UPSTREAM_${provider}_`;
  const result: {
    issuer?: string;
    authorizationEndpoint?: string;
    tokenEndpoint?: string;
    userInfoEndpoint?: string;
  } = {};
  const issuer = optional(env, `${prefix}ISSUER`);
  if (issuer) result.issuer = issuer;
  const authorizationEndpoint = optional(
    env,
    `${prefix}AUTHORIZATION_ENDPOINT`,
  );
  if (authorizationEndpoint) {
    result.authorizationEndpoint = authorizationEndpoint;
  }
  const tokenEndpoint = optional(env, `${prefix}TOKEN_ENDPOINT`);
  if (tokenEndpoint) result.tokenEndpoint = tokenEndpoint;
  const userInfoEndpoint = optional(env, `${prefix}USERINFO_ENDPOINT`);
  if (userInfoEndpoint) result.userInfoEndpoint = userInfoEndpoint;
  return result;
}

function parseCustomOidcUpstreamProvider(
  env: Record<string, string | undefined>,
): UpstreamOAuthClientRegistration | undefined {
  const providerId = optional(
    env,
    "TAKOSUMI_ACCOUNTS_UPSTREAM_OIDC_PROVIDER_ID",
  );
  const issuer = optional(env, "TAKOSUMI_ACCOUNTS_UPSTREAM_OIDC_ISSUER");
  const authorizationEndpoint = optional(
    env,
    "TAKOSUMI_ACCOUNTS_UPSTREAM_OIDC_AUTHORIZATION_ENDPOINT",
  );
  const tokenEndpoint = optional(
    env,
    "TAKOSUMI_ACCOUNTS_UPSTREAM_OIDC_TOKEN_ENDPOINT",
  );
  const userInfoEndpoint = optional(
    env,
    "TAKOSUMI_ACCOUNTS_UPSTREAM_OIDC_USERINFO_ENDPOINT",
  );
  const clientId = optional(env, "TAKOSUMI_ACCOUNTS_UPSTREAM_OIDC_CLIENT_ID");
  const clientSecret = optional(
    env,
    "TAKOSUMI_ACCOUNTS_UPSTREAM_OIDC_CLIENT_SECRET",
  );
  const redirectUri = optional(
    env,
    "TAKOSUMI_ACCOUNTS_UPSTREAM_OIDC_REDIRECT_URI",
  );
  const scopes = splitList(env.TAKOSUMI_ACCOUNTS_UPSTREAM_OIDC_SCOPES);
  const configured = Boolean(
    providerId ||
    issuer ||
    authorizationEndpoint ||
    tokenEndpoint ||
    userInfoEndpoint ||
    clientId ||
    clientSecret ||
    redirectUri ||
    scopes.length > 0,
  );
  if (!configured) return undefined;
  if (
    !providerId ||
    !issuer ||
    !authorizationEndpoint ||
    !tokenEndpoint ||
    !userInfoEndpoint ||
    !clientId ||
    !redirectUri
  ) {
    throw new TypeError(
      "Custom upstream OIDC requires provider id, issuer, endpoints, client id, and redirect uri",
    );
  }
  if (isRetiredUpstreamOAuthProviderId(providerId)) {
    throw new TypeError(
      `Custom upstream OIDC provider id ${providerId} is reserved or retired`,
    );
  }
  const subjectClaim = optional(
    env,
    "TAKOSUMI_ACCOUNTS_UPSTREAM_OIDC_SUBJECT_CLAIM",
  );
  return {
    providerId,
    clientId,
    ...(clientSecret ? { clientSecret } : {}),
    redirectUri,
    ...(scopes.length > 0 ? { scopes } : {}),
    provider: customOidcOAuthProvider({
      id: providerId,
      issuer,
      authorizationEndpoint,
      tokenEndpoint,
      userInfoEndpoint,
      ...(scopes.length > 0 ? { defaultScopes: scopes } : {}),
      ...(subjectClaim ? { subjectClaim } : {}),
    }),
  };
}

function parseStableOidc(
  env: Record<string, string | undefined>,
): NodeAccountsStableOidcConfig | undefined {
  const privateJwkJson = optional(env, "TAKOSUMI_ACCOUNTS_ES256_PRIVATE_JWK");
  if (!privateJwkJson) return undefined;
  const oidcPairwiseSubjectSecret = optional(
    env,
    "TAKOSUMI_ACCOUNTS_OIDC_PAIRWISE_SUBJECT_SECRET",
  );
  const launchTokenPairwiseSecret = optional(
    env,
    "TAKOSUMI_ACCOUNTS_LAUNCH_TOKEN_PAIRWISE_SECRET",
  );
  if (!oidcPairwiseSubjectSecret || !launchTokenPairwiseSecret) {
    throw new TypeError(
      "Stable OIDC signing requires TAKOSUMI_ACCOUNTS_OIDC_PAIRWISE_SUBJECT_SECRET and TAKOSUMI_ACCOUNTS_LAUNCH_TOKEN_PAIRWISE_SECRET",
    );
  }
  const keyId = optional(env, "TAKOSUMI_ACCOUNTS_ES256_KEY_ID");
  const previousPublicJwksJson = optional(
    env,
    "TAKOSUMI_ACCOUNTS_ES256_PREVIOUS_PUBLIC_JWKS",
  );
  const subject = optional(env, "TAKOSUMI_ACCOUNTS_SUBJECT");
  return {
    privateJwkJson,
    ...(keyId ? { keyId } : {}),
    ...(previousPublicJwksJson ? { previousPublicJwksJson } : {}),
    ...(subject ? { subject } : {}),
    oidcPairwiseSubjectSecret,
    launchTokenPairwiseSecret,
  };
}

function parseExportDownload(
  env: Record<string, string | undefined>,
): NodeAccountsExportDownloadConfig | undefined {
  const secret = optional(env, "TAKOSUMI_ACCOUNTS_EXPORT_DOWNLOAD_SECRET");
  const outputDirectory = optional(env, "TAKOSUMI_ACCOUNTS_EXPORT_OUTPUT_DIR");
  const baseUrl = optional(env, "TAKOSUMI_ACCOUNTS_EXPORT_DOWNLOAD_BASE_URL");
  const ttlMs = optionalNonNegativeInteger(
    env,
    "TAKOSUMI_ACCOUNTS_EXPORT_DOWNLOAD_TTL_MS",
  );
  const configured = Boolean(
    secret || outputDirectory || baseUrl || ttlMs !== undefined,
  );
  if (!configured) return undefined;
  if (!secret || !outputDirectory || !baseUrl) {
    throw new TypeError(
      "Capsule export downloads require TAKOSUMI_ACCOUNTS_EXPORT_DOWNLOAD_SECRET, TAKOSUMI_ACCOUNTS_EXPORT_OUTPUT_DIR, and TAKOSUMI_ACCOUNTS_EXPORT_DOWNLOAD_BASE_URL",
    );
  }
  if (ttlMs !== undefined && ttlMs <= 0) {
    throw new TypeError(
      "TAKOSUMI_ACCOUNTS_EXPORT_DOWNLOAD_TTL_MS must be greater than zero",
    );
  }
  return {
    secret,
    outputDirectory,
    baseUrl,
    ...(ttlMs !== undefined ? { ttlMs } : {}),
  };
}

function required(
  env: Record<string, string | undefined>,
  name: string,
): string {
  const value = env[name]?.trim();
  if (!value) throw new TypeError(`missing required env var: ${name}`);
  return value;
}

function optional(
  env: Record<string, string | undefined>,
  name: string,
): string | undefined {
  const value = env[name]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function bool(env: Record<string, string | undefined>, name: string): boolean {
  const value = optional(env, name)?.toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function parseIntOr(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function optionalNonNegativeInteger(
  env: Record<string, string | undefined>,
  name: string,
): number | undefined {
  const raw = optional(env, name);
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new TypeError(`${name} must be a non-negative integer, got ${raw}`);
  }
  return parsed;
}

function splitList(value: unknown): readonly string[] {
  if (typeof value !== "string") return [];
  return value
    .split(/[,\s]+/u)
    .map((s) => s.trim())
    .filter(Boolean);
}
