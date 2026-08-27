import { expect, test } from "bun:test";

import {
  TAKOSUMI_ACCOUNTS_AUTHORIZE_PATH as PRIVATE_AUTHORIZE_PATH,
  TAKOSUMI_ACCOUNTS_INTROSPECT_PATH as PRIVATE_INTROSPECT_PATH,
  TAKOSUMI_ACCOUNTS_JWKS_PATH as PRIVATE_JWKS_PATH,
  TAKOSUMI_ACCOUNTS_OIDC_DISCOVERY_PATH as PRIVATE_DISCOVERY_PATH,
  TAKOSUMI_ACCOUNTS_REVOKE_PATH as PRIVATE_REVOKE_PATH,
  TAKOSUMI_ACCOUNTS_TOKEN_PATH as PRIVATE_TOKEN_PATH,
  TAKOSUMI_ACCOUNTS_USERINFO_PATH as PRIVATE_USERINFO_PATH,
} from "../../accounts/contract/src/mod.ts";
import * as identityOidc from "../../contract/identity-oidc.ts";

test("identity OIDC publishes only standard installed-client paths", () => {
  expect(Object.keys(identityOidc).sort()).toEqual([
    "TAKOSUMI_ACCOUNTS_AUTHORIZE_PATH",
    "TAKOSUMI_ACCOUNTS_INTROSPECT_PATH",
    "TAKOSUMI_ACCOUNTS_JWKS_PATH",
    "TAKOSUMI_ACCOUNTS_OIDC_DISCOVERY_PATH",
    "TAKOSUMI_ACCOUNTS_REVOKE_PATH",
    "TAKOSUMI_ACCOUNTS_TOKEN_PATH",
    "TAKOSUMI_ACCOUNTS_USERINFO_PATH",
  ]);

  expect(identityOidc.TAKOSUMI_ACCOUNTS_OIDC_DISCOVERY_PATH).toBe(
    "/.well-known/openid-configuration",
  );
  expect(identityOidc.TAKOSUMI_ACCOUNTS_AUTHORIZE_PATH).toBe(
    "/oauth/authorize",
  );
  expect(identityOidc.TAKOSUMI_ACCOUNTS_TOKEN_PATH).toBe("/oauth/token");
  expect(identityOidc.TAKOSUMI_ACCOUNTS_JWKS_PATH).toBe("/oauth/jwks");
  expect(identityOidc.TAKOSUMI_ACCOUNTS_USERINFO_PATH).toBe(
    "/oauth/userinfo",
  );
  expect(identityOidc.TAKOSUMI_ACCOUNTS_REVOKE_PATH).toBe("/oauth/revoke");
  expect(identityOidc.TAKOSUMI_ACCOUNTS_INTROSPECT_PATH).toBe(
    "/oauth/introspect",
  );
});

test("the private Accounts contract re-exports the public OIDC path authority", () => {
  expect(PRIVATE_DISCOVERY_PATH).toBe(
    identityOidc.TAKOSUMI_ACCOUNTS_OIDC_DISCOVERY_PATH,
  );
  expect(PRIVATE_AUTHORIZE_PATH).toBe(
    identityOidc.TAKOSUMI_ACCOUNTS_AUTHORIZE_PATH,
  );
  expect(PRIVATE_TOKEN_PATH).toBe(identityOidc.TAKOSUMI_ACCOUNTS_TOKEN_PATH);
  expect(PRIVATE_JWKS_PATH).toBe(identityOidc.TAKOSUMI_ACCOUNTS_JWKS_PATH);
  expect(PRIVATE_USERINFO_PATH).toBe(
    identityOidc.TAKOSUMI_ACCOUNTS_USERINFO_PATH,
  );
  expect(PRIVATE_REVOKE_PATH).toBe(
    identityOidc.TAKOSUMI_ACCOUNTS_REVOKE_PATH,
  );
  expect(PRIVATE_INTROSPECT_PATH).toBe(
    identityOidc.TAKOSUMI_ACCOUNTS_INTROSPECT_PATH,
  );
});
