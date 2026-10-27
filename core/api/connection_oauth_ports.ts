/**
 * Provider-neutral executable OAuth contribution accepted by Core.
 *
 * Provider packages own vendor response mapping; Core owns state, redirects,
 * token exchange, and registration of the resulting opaque credential values.
 */
export interface ConnectionOAuthTokenResponseInput {
  readonly tokenResponse: Readonly<Record<string, unknown>>;
  readonly helperId: string;
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly scopeHints?: import("takosumi-contract/connections").ConnectionScopeHints;
}

export type ConnectionOAuthTokenResponseMapper = (
  input: ConnectionOAuthTokenResponseInput,
) => Readonly<Record<string, string>>;

export interface ConnectionOAuthDescriptor {
  readonly id: string;
  readonly providerSource: string;
  readonly credentialRecipe: {
    readonly id: string;
    readonly authMode: string;
    readonly secretPartition: string;
  };
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly authorizationUrl: string;
  readonly tokenUrl: string;
  readonly redirectUri: string;
  readonly scopes: readonly string[];
  readonly authorizationParams?: Readonly<Record<string, string>>;
  readonly pkce?: boolean;
  readonly browserBindingRequired?: boolean;
  /** Non-secret setup fields mapped to provider-owned settings, not execution authority. */
  readonly setupFields?: readonly { readonly key: string; readonly envName: string }[];
  readonly mapTokenResponse: ConnectionOAuthTokenResponseMapper;
}
