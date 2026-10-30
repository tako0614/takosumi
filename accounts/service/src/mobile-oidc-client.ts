export const TAKOSUMI_MOBILE_OIDC_REDIRECT_URI =
  "takosumi://oauth/callback" as const;

export const TAKOSUMI_MOBILE_OIDC_SCOPES = [
  "openid",
  "profile",
  "offline_access",
  "capsules:read",
  "capsules:write",
] as const;

/**
 * Client id every Takosumi instance accepts for Takosumi Mobile unless the
 * operator turns the built-in registration off. One id on every instance is
 * what lets the app connect anywhere without Dynamic Client Registration.
 */
export const TAKOSUMI_MOBILE_BUILTIN_OIDC_CLIENT_ID = "takosumi-mobile" as const;

/** Name shown on the consent screen for the Takosumi Mobile client. */
export const TAKOSUMI_MOBILE_OIDC_CLIENT_DISPLAY_NAME = "Takosumi Mobile";

interface MobileOidcClientRegistration {
  readonly clientId: string;
  readonly redirectUris: readonly string[];
  readonly allowedScopes?: readonly string[];
  readonly clientSecret?: string;
  readonly tokenEndpointAuthMethod?: string;
}

/**
 * Fields the composition adds to the client that Takosumi Mobile uses. A
 * custom-scheme redirect can be claimed by any app on the device, so PKCE alone
 * does not prove which app started the flow (RFC 8252 §8.6). Every
 * authorization for this client therefore shows an explicit consent screen.
 */
export interface TakosumiMobileOidcClientMarking {
  readonly consent: "always";
  readonly displayName: string;
}

/** Public PKCE registration of the built-in Takosumi Mobile client. */
export function takosumiMobileBuiltinOidcClient(): MobileOidcClientRegistration &
  TakosumiMobileOidcClientMarking & { readonly tokenEndpointAuthMethod: "none" } {
  return {
    clientId: TAKOSUMI_MOBILE_BUILTIN_OIDC_CLIENT_ID,
    redirectUris: [TAKOSUMI_MOBILE_OIDC_REDIRECT_URI],
    tokenEndpointAuthMethod: "none",
    allowedScopes: [...TAKOSUMI_MOBILE_OIDC_SCOPES],
    consent: "always",
    displayName: TAKOSUMI_MOBILE_OIDC_CLIENT_DISPLAY_NAME,
  };
}

/**
 * Parses `TAKOSUMI_MOBILE_OIDC_BUILTIN_CLIENT`. Absent keeps the deployment
 * default; only the exact strings `true` and `false` are accepted so a typo
 * cannot silently enable or disable native sign-in.
 */
export function parseTakosumiMobileBuiltinClientSetting(
  value: string | undefined,
  defaultEnabled: boolean,
): boolean {
  const normalized = value?.trim();
  if (normalized === undefined || normalized === "") return defaultEnabled;
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new TypeError(
    "TAKOSUMI_MOBILE_OIDC_BUILTIN_CLIENT must be true or false",
  );
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
  assertTakosumiMobileClientShape(client);
  return client.clientId;
}

function assertTakosumiMobileClientShape(
  client: MobileOidcClientRegistration,
): void {
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
}

/**
 * Composes the static client list with the Takosumi Mobile client and returns
 * the id `/.well-known/takosumi` advertises.
 *
 * - The built-in `takosumi-mobile` registration is added when `builtinClient`
 *   is true, unless the operator already registered that id (then their entry
 *   is validated as a Takosumi Mobile client and used instead).
 * - `TAKOSUMI_MOBILE_OIDC_CLIENT_ID` still selects an operator-registered
 *   client; when set it is the advertised id.
 * - Every client that serves Takosumi Mobile (the advertised one, the
 *   built-in id, and any other client registered for the Takosumi Mobile
 *   redirect) is marked to always show the consent screen, so none of them
 *   issues a code silently.
 */
export function composeTakosumiMobileOidcClients<
  T extends MobileOidcClientRegistration,
>(input: {
  readonly configuredClientId?: string;
  readonly builtinClient: boolean;
  readonly clients?: readonly T[];
}): {
  readonly clients:
    | readonly (T | (T & TakosumiMobileOidcClientMarking) | ReturnType<
      typeof takosumiMobileBuiltinOidcClient
    >)[]
    | undefined;
  readonly mobileOidcClientId: string | undefined;
} {
  const configuredClientId = resolveTakosumiMobileOidcClientId({
    configuredClientId: input.configuredClientId,
    clients: input.clients,
  });
  const mobileClientIds = new Set<string>();
  if (configuredClientId) mobileClientIds.add(configuredClientId);
  if (input.builtinClient) {
    mobileClientIds.add(TAKOSUMI_MOBILE_BUILTIN_OIDC_CLIENT_ID);
  }
  const marked = (input.clients ?? []).map((client) => {
    if (mobileClientIds.has(client.clientId)) {
      assertTakosumiMobileClientShape(client);
      return {
        ...client,
        consent: "always" as const,
        displayName: TAKOSUMI_MOBILE_OIDC_CLIENT_DISPLAY_NAME,
      };
    }
    // A leftover registration for the Takosumi Mobile redirect (for example
    // one created from older docs and no longer selected) must not issue
    // codes without consent: any app can claim the custom scheme.
    if (client.redirectUris.includes(TAKOSUMI_MOBILE_OIDC_REDIRECT_URI)) {
      return { ...client, consent: "always" as const };
    }
    return client;
  });
  const hasBuiltinId = marked.some(
    (client) => client.clientId === TAKOSUMI_MOBILE_BUILTIN_OIDC_CLIENT_ID,
  );
  const clients =
    input.builtinClient && !hasBuiltinId
      ? [...marked, takosumiMobileBuiltinOidcClient()]
      : marked;
  return {
    clients: clients.length > 0 || input.clients ? clients : undefined,
    mobileOidcClientId:
      configuredClientId ??
      (input.builtinClient ? TAKOSUMI_MOBILE_BUILTIN_OIDC_CLIENT_ID : undefined),
  };
}
