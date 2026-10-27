import type {
  ConnectionOAuthDescriptor,
  GuidedConnectionRequestBuilder,
} from "../types.ts";
import { GuidedConnectionSetupError } from "../types.ts";
import { cloudflareOAuthValues } from "./oauth.ts";

const PROVIDER_SOURCE = "registry.opentofu.org/cloudflare/cloudflare";

export const buildCloudflareApiTokenConnection: GuidedConnectionRequestBuilder =
  (input) => {
    rejectFiles(input.files);
    const workspaceId = input.workspaceId;
    return {
      ...(workspaceId ? { workspaceId } : {}),
      provider: PROVIDER_SOURCE,
      credentialRecipe: {
        id: "cloudflare",
        authMode: "api_token",
        secretPartition: "provider-credentials",
      },
      ...(input.displayName ? { displayName: input.displayName } : {}),
      ...(input.scope ? { scope: input.scope } : {}),
      ...(input.scopeHints ? { scopeHints: input.scopeHints } : {}),
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
      values: input.values,
    };
  };

export function cloudflareOAuthDescriptorFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): ConnectionOAuthDescriptor | undefined {
  const clientId = env.TAKOSUMI_CLOUDFLARE_OAUTH_CLIENT_ID;
  const redirectUri = env.TAKOSUMI_CLOUDFLARE_OAUTH_REDIRECT_URI;
  const authorizationUrl = env.TAKOSUMI_CLOUDFLARE_OAUTH_AUTHORIZATION_URL ?? "https://dash.cloudflare.com/oauth2/auth";
  const tokenUrl = env.TAKOSUMI_CLOUDFLARE_OAUTH_TOKEN_URL ?? "https://dash.cloudflare.com/oauth2/token";
  if (!clientId || !redirectUri) {
    return undefined;
  }
  return {
    id: "cloudflare",
    providerSource: PROVIDER_SOURCE,
    credentialRecipe: {
      id: "cloudflare",
      authMode: "oauth",
      secretPartition: "provider-credentials",
    },
    clientId,
    ...(env.TAKOSUMI_CLOUDFLARE_OAUTH_CLIENT_SECRET
      ? { clientSecret: env.TAKOSUMI_CLOUDFLARE_OAUTH_CLIENT_SECRET }
      : {}),
    authorizationUrl,
    tokenUrl,
    redirectUri,
    pkce: true,
    browserBindingRequired: true,
    setupFields: [{ key: "accountId", envName: "CLOUDFLARE_ACCOUNT_ID" }],
    scopes: splitScopes(env.TAKOSUMI_CLOUDFLARE_OAUTH_SCOPES),
    mapTokenResponse: ({ tokenResponse, helperId, scopeHints }) => {
      const token = tokenResponse.access_token;
      if (typeof token !== "string" || token.length === 0) {
        throw new GuidedConnectionSetupError(
          `OAuth token response for helper ${helperId} did not include access_token`,
        );
      }
      const account = scopeHints?.providerSettings?.accountId;
      return { ...cloudflareOAuthValues({ tokenResponse, clientId, now: Date.now() }),
        ...(typeof account === "string" && account ? { CLOUDFLARE_ACCOUNT_ID: account } : {}) };
    },
  };
}

function rejectFiles(files: readonly unknown[] | undefined): void {
  if (files && files.length > 0) {
    throw new GuidedConnectionSetupError(
      "cloudflare/api-token does not accept credential files",
    );
  }
}

function splitScopes(value: string | undefined): readonly string[] {
  return (value ?? "")
    .split(/[\s,]+/u)
    .map((scope) => scope.trim())
    .filter(Boolean);
}
