/**
 * Standard, same-origin Takosumi Accounts OIDC paths used by installed public
 * clients. Hostnames and issuer origins remain operator-selected.
 */
export const TAKOSUMI_ACCOUNTS_OIDC_DISCOVERY_PATH =
  "/.well-known/openid-configuration" as const;
export const TAKOSUMI_ACCOUNTS_AUTHORIZE_PATH = "/oauth/authorize" as const;
export const TAKOSUMI_ACCOUNTS_TOKEN_PATH = "/oauth/token" as const;
export const TAKOSUMI_ACCOUNTS_JWKS_PATH = "/oauth/jwks" as const;
export const TAKOSUMI_ACCOUNTS_USERINFO_PATH = "/oauth/userinfo" as const;
export const TAKOSUMI_ACCOUNTS_REVOKE_PATH = "/oauth/revoke" as const;
export const TAKOSUMI_ACCOUNTS_INTROSPECT_PATH = "/oauth/introspect" as const;
