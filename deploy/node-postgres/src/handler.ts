/**
 * Env parsing for the Bun + Postgres Takosumi Accounts reference
 * distribution. Mirrors the Cloudflare worker handler's env shape so
 * operators can move secrets between the two substrates by renaming
 * env vars only.
 */
import type {
  PlatformAccessPolicy,
  OidcClientRegistration,
  PasskeyHttpOptions,
  StripeBillingOptions,
  UpstreamOAuthClientRegistration,
  UpstreamOAuthOptions,
  ServiceGraphMaterialResolverHttpOptions,
} from "@takosjp/takosumi-accounts-service";
import {
  createOpenPlatformAccessPolicy,
  customOidcOAuthProvider,
  googleOAuthProvider,
} from "@takosjp/takosumi-accounts-service";

export interface NodeAccountsStableOidcConfig {
  readonly privateJwkJson: string;
  readonly keyId?: string;
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
  readonly databaseUrl: string;
  readonly clients: readonly OidcClientRegistration[] | undefined;
  readonly platformAccess: PlatformAccessPolicy;
  readonly serviceGraphMaterialResolver:
    | ServiceGraphMaterialResolverHttpOptions
    | undefined;
  readonly stripeBilling: StripeBillingOptions | undefined;
  readonly passkeys: PasskeyHttpOptions | undefined;
  readonly upstreamOAuth: UpstreamOAuthOptions | undefined;
  readonly stableOidc: NodeAccountsStableOidcConfig | undefined;
  readonly exportDownload: NodeAccountsExportDownloadConfig | undefined;
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
    databaseUrl,
    clients: parseClients(env),
    platformAccess: parsePlatformAccess(env),
    serviceGraphMaterialResolver: parseServiceGraphMaterials(env),
    stripeBilling: parseStripeBilling(env),
    passkeys: parsePasskeys(env),
    upstreamOAuth: parseUpstreamOAuth(env),
    stableOidc: parseStableOidc(env),
    exportDownload: parseExportDownload(env),
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

function requireProductionHardeningEvidence(
  env: Record<string, string | undefined>,
): void {
  if (optional(env, "TAKOSUMI_PRODUCTION_HARDENING_GATE") !== "enforce") {
    throw new TypeError(
      "Open platform readiness access requires TAKOSUMI_PRODUCTION_HARDENING_GATE=enforce",
    );
  }
  const commitPinnedGitRefPattern = /^git\+.+@[0-9a-f]{40,64}#.+/i;
  for (const [refName, digestName] of [
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
      "TAKOSUMI_PROVIDER_CATALOG_EVIDENCE_REF",
      "TAKOSUMI_PROVIDER_CATALOG_EVIDENCE_DIGEST",
    ],
    [
      "TAKOSUMI_COST_ATTRIBUTION_EVIDENCE_REF",
      "TAKOSUMI_COST_ATTRIBUTION_EVIDENCE_DIGEST",
    ],
    [
      "TAKOSUMI_SECRET_BOUNDARY_EVIDENCE_REF",
      "TAKOSUMI_SECRET_BOUNDARY_EVIDENCE_DIGEST",
    ],
  ] as const) {
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

function parseServiceGraphMaterials(
  env: Record<string, string | undefined>,
): ServiceGraphMaterialResolverHttpOptions | undefined {
  const token = optional(
    env,
    "TAKOSUMI_ACCOUNTS_SERVICE_GRAPH_MATERIAL_RESOLVER_TOKEN",
  );
  if (!token) return undefined;
  const billingPortalUrl = optional(
    env,
    "TAKOSUMI_ACCOUNTS_BILLING_PORTAL_URL",
  );
  const internalUrl = optional(
    env,
    "TAKOSUMI_ACCOUNTS_SERVICE_GRAPH_MATERIALS_INTERNAL_URL",
  );
  return {
    token,
    ...(billingPortalUrl ? { billingPortalUrl } : {}),
    ...(internalUrl ? { internalUrl } : {}),
    ...(bool(
      env,
      "TAKOSUMI_ACCOUNTS_SERVICE_GRAPH_MATERIALS_ALLOW_DIRECT_DEPLOY_CONTROL",
    )
      ? { allowDeployControlInstallations: true }
      : {}),
  };
}

/**
 * Parse Stripe billing config. Mirrors the Cloudflare worker's
 * `parseStripeBilling`. The Node profile uses `_STRIPE_API_KEY` as
 * the spec-required name.
 *
 * `TAKOSUMI_ACCOUNTS_STRIPE_PUBLIC_KEY` is intentionally **not** wired
 * into the returned `StripeBillingOptions`: the upstream
 * `@takosjp/takosumi-accounts-service` `StripeBillingOptions` type
 * (see `accounts/service/src/mod.ts`) currently exposes only
 * `secretKey`, `webhookSecret`, `fetch`, `stripeApiBase`, and
 * `webhookToleranceSeconds`. The publishable key is surfaced to the
 * dashboard / SDKs through the operator distribution's separate
 * dashboard-config plumbing, not through `StripeBillingOptions`. The
 * parser still validates the env var so operators get a deterministic
 * error rather than a silent typo, and so the Node-Postgres .env.example
 * documents a complete operator surface.
 */
export function parseStripeBilling(
  env: Record<string, string | undefined>,
): StripeBillingOptions | undefined {
  const secretKey = optional(env, "TAKOSUMI_ACCOUNTS_STRIPE_API_KEY");
  const webhookSecret = optional(
    env,
    "TAKOSUMI_ACCOUNTS_STRIPE_WEBHOOK_SECRET",
  );
  const stripeApiBase = optional(env, "TAKOSUMI_ACCOUNTS_STRIPE_API_BASE");
  const webhookToleranceSeconds = optionalNonNegativeInteger(
    env,
    "TAKOSUMI_ACCOUNTS_STRIPE_WEBHOOK_TOLERANCE_SECONDS",
  );
  const publicKey = optional(env, "TAKOSUMI_ACCOUNTS_STRIPE_PUBLIC_KEY");
  if (!secretKey && !webhookSecret && !stripeApiBase && !publicKey) {
    return undefined;
  }
  if (!secretKey || !webhookSecret) {
    throw new TypeError(
      "Stripe billing requires TAKOSUMI_ACCOUNTS_STRIPE_API_KEY and TAKOSUMI_ACCOUNTS_STRIPE_WEBHOOK_SECRET",
    );
  }
  if (publicKey && !publicKey.startsWith("pk_")) {
    throw new TypeError(
      "TAKOSUMI_ACCOUNTS_STRIPE_PUBLIC_KEY must be a Stripe publishable key (pk_live_... or pk_test_...)",
    );
  }
  // `publicKey` is parsed for env-surface completeness; see the function
  // docstring for why it is not forwarded into the returned options.
  void publicKey;
  return {
    secretKey,
    webhookSecret,
    ...(stripeApiBase ? { stripeApiBase } : {}),
    ...(webhookToleranceSeconds !== undefined
      ? { webhookToleranceSeconds }
      : {}),
  };
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
  const apple = parseAppleUpstreamProvider(env);
  if (apple) providers.push(apple);
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

/**
 * Apple Sign-In is wired through the generic OIDC provider since the
 * accounts-service package does not currently ship a dedicated Apple
 * provider helper. Operators configure issuer + endpoints explicitly.
 */
function parseAppleUpstreamProvider(
  env: Record<string, string | undefined>,
): UpstreamOAuthClientRegistration | undefined {
  const clientId = optional(env, "TAKOSUMI_ACCOUNTS_UPSTREAM_APPLE_CLIENT_ID");
  const clientSecret = optional(
    env,
    "TAKOSUMI_ACCOUNTS_UPSTREAM_APPLE_CLIENT_SECRET",
  );
  const redirectUri = optional(
    env,
    "TAKOSUMI_ACCOUNTS_UPSTREAM_APPLE_REDIRECT_URI",
  );
  const scopes = splitList(env.TAKOSUMI_ACCOUNTS_UPSTREAM_APPLE_SCOPES);
  if (!clientId && !clientSecret && !redirectUri && scopes.length === 0) {
    return undefined;
  }
  if (!clientId || !redirectUri) {
    throw new TypeError(
      "TAKOSUMI_ACCOUNTS_UPSTREAM_APPLE_CLIENT_ID and _REDIRECT_URI are required when configuring apple upstream OAuth",
    );
  }
  const issuer =
    optional(env, "TAKOSUMI_ACCOUNTS_UPSTREAM_APPLE_ISSUER") ??
    "https://appleid.apple.com";
  const authorizationEndpoint =
    optional(env, "TAKOSUMI_ACCOUNTS_UPSTREAM_APPLE_AUTHORIZATION_ENDPOINT") ??
    "https://appleid.apple.com/auth/authorize";
  const tokenEndpoint =
    optional(env, "TAKOSUMI_ACCOUNTS_UPSTREAM_APPLE_TOKEN_ENDPOINT") ??
    "https://appleid.apple.com/auth/token";
  const userInfoEndpoint =
    optional(env, "TAKOSUMI_ACCOUNTS_UPSTREAM_APPLE_USERINFO_ENDPOINT") ??
    "https://appleid.apple.com/auth/userinfo";
  const subjectClaim = optional(
    env,
    "TAKOSUMI_ACCOUNTS_UPSTREAM_APPLE_SUBJECT_CLAIM",
  );
  return {
    providerId: "apple",
    clientId,
    ...(clientSecret ? { clientSecret } : {}),
    redirectUri,
    ...(scopes.length > 0 ? { scopes } : {}),
    provider: customOidcOAuthProvider({
      id: "apple",
      issuer,
      authorizationEndpoint,
      tokenEndpoint,
      userInfoEndpoint,
      ...(scopes.length > 0 ? { defaultScopes: scopes } : {}),
      ...(subjectClaim ? { subjectClaim } : {}),
    }),
  };
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
  const subject = optional(env, "TAKOSUMI_ACCOUNTS_SUBJECT");
  return {
    privateJwkJson,
    ...(keyId ? { keyId } : {}),
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
