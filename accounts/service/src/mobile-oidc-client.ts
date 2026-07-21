export const TAKOSUMI_MOBILE_OIDC_REDIRECT_URI =
  "takosumi://oauth/callback" as const;

export const TAKOSUMI_MOBILE_OIDC_SCOPES = [
  "openid",
  "profile",
  "offline_access",
  "capsules:read",
  "capsules:write",
] as const;

interface MobileOidcClientRegistration {
  readonly clientId: string;
  readonly redirectUris: readonly string[];
  readonly allowedScopes?: readonly string[];
  readonly clientSecret?: string;
  readonly tokenEndpointAuthMethod?: string;
}

/**
 * Resolves the exact public PKCE client published to Takosumi Mobile.
 * Configuration fails closed instead of advertising a client that cannot
 * safely complete the native authorization-code flow.
 */
export function resolveTakosumiMobileOidcClientId(input: {
  readonly configuredClientId?: string;
  readonly clients?: readonly MobileOidcClientRegistration[];
}): string | undefined {
  const clientId = input.configuredClientId?.trim();
  if (!clientId) return undefined;
  const client = input.clients?.find(
    (candidate) => candidate.clientId === clientId,
  );
  if (!client) {
    throw new TypeError(
      "TAKOSUMI_MOBILE_OIDC_CLIENT_ID must name a TAKOSUMI_ACCOUNTS_CLIENTS entry",
    );
  }
  if (client.tokenEndpointAuthMethod !== "none" || client.clientSecret) {
    throw new TypeError(
      "Takosumi Mobile OIDC client must be a public client with tokenEndpointAuthMethod none and no client secret",
    );
  }
  if (!client.redirectUris.includes(TAKOSUMI_MOBILE_OIDC_REDIRECT_URI)) {
    throw new TypeError(
      `Takosumi Mobile OIDC client must register ${TAKOSUMI_MOBILE_OIDC_REDIRECT_URI}`,
    );
  }
  const scopes = new Set(client.allowedScopes ?? []);
  const missingScopes = TAKOSUMI_MOBILE_OIDC_SCOPES.filter(
    (scope) => !scopes.has(scope),
  );
  if (missingScopes.length > 0) {
    throw new TypeError(
      `Takosumi Mobile OIDC client is missing allowedScopes: ${missingScopes.join(", ")}`,
    );
  }
  return client.clientId;
}
