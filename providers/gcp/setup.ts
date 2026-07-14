import type {
  ConnectionOAuthDescriptor,
  GuidedConnectionRequestBuilder,
} from "../types.ts";
import { GuidedConnectionSetupError } from "../types.ts";

const PROVIDER_SOURCE = "registry.opentofu.org/hashicorp/google";

export const buildGoogleServiceAccountJsonConnection: GuidedConnectionRequestBuilder =
  (input) => {
    if (input.files && input.files.length > 0) {
      throw new GuidedConnectionSetupError(
        "google/service-account-json does not accept credential files",
      );
    }
    return connectionRequest(input, "service_account_json");
  };

export function googleOAuthDescriptorFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): ConnectionOAuthDescriptor | undefined {
  const clientId = env.TAKOSUMI_GCP_OAUTH_CLIENT_ID;
  const redirectUri = env.TAKOSUMI_GCP_OAUTH_REDIRECT_URI;
  if (!clientId || !redirectUri) return undefined;
  return {
    id: "gcp",
    providerSource: PROVIDER_SOURCE,
    credentialRecipe: {
      id: "google",
      authMode: "oauth",
      secretPartition: "provider-credentials",
    },
    clientId,
    ...(env.TAKOSUMI_GCP_OAUTH_CLIENT_SECRET
      ? { clientSecret: env.TAKOSUMI_GCP_OAUTH_CLIENT_SECRET }
      : {}),
    authorizationUrl:
      env.TAKOSUMI_GCP_OAUTH_AUTHORIZATION_URL ??
      "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl:
      env.TAKOSUMI_GCP_OAUTH_TOKEN_URL ?? "https://oauth2.googleapis.com/token",
    redirectUri,
    scopes: splitScopes(
      env.TAKOSUMI_GCP_OAUTH_SCOPES ??
        "https://www.googleapis.com/auth/cloud-platform",
    ),
    authorizationParams: { access_type: "offline", prompt: "consent" },
    mapTokenResponse: ({
      tokenResponse,
      helperId,
      clientId: descriptorClientId,
      clientSecret,
    }) => {
      const refreshToken = tokenResponse.refresh_token;
      if (typeof refreshToken !== "string" || refreshToken.length === 0) {
        throw new GuidedConnectionSetupError(
          `OAuth token response for helper ${helperId} did not include refresh_token`,
        );
      }
      return {
        GOOGLE_CREDENTIALS: JSON.stringify({
          type: "authorized_user",
          client_id: descriptorClientId,
          ...(clientSecret ? { client_secret: clientSecret } : {}),
          refresh_token: refreshToken,
        }),
      };
    },
  };
}

function connectionRequest(
  input: Parameters<GuidedConnectionRequestBuilder>[0],
  authMode: "service_account_json",
): ReturnType<GuidedConnectionRequestBuilder> {
  const workspaceId = input.workspaceId;
  return {
    ...(workspaceId ? { workspaceId } : {}),
    provider: PROVIDER_SOURCE,
    credentialRecipe: {
      id: "google",
      authMode,
      secretPartition: "provider-credentials",
    },
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.scope ? { scope: input.scope } : {}),
    ...(input.scopeHints ? { scopeHints: input.scopeHints } : {}),
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    values: input.values,
  };
}

function splitScopes(value: string): readonly string[] {
  return value
    .split(/[\s,]+/u)
    .map((scope) => scope.trim())
    .filter(Boolean);
}
