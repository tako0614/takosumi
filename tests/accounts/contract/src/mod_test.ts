import { expect, test } from "bun:test";
import { assertThrows } from "../../../helpers/assert.ts";
import {
  buildOidcDiscoveryDocument,
  normalizeIssuer,
  TAKOSUMI_ACCOUNTS_CURRENT_PAT_AUTHORITY_KIND,
  TAKOSUMI_ACCOUNTS_CURRENT_PAT_AUTHORITY_PATH,
  TAKOSUMI_ACCOUNTS_PAT_INVENTORY_KIND,
  TAKOSUMI_ACCOUNTS_PAT_INVENTORY_PATH,
  TAKOSUMI_ACCOUNTS_PAT_SCOPE_CATALOG_KIND,
  TAKOSUMI_ACCOUNTS_PAT_SCOPE_CATALOG_PATH,
  TAKOSUMI_ACCOUNTS_ACCOUNT_TOKENS_PATH,
  TAKOSUMI_ACCOUNTS_PASSKEY_AUTHENTICATE_COMPLETE_PATH,
  TAKOSUMI_ACCOUNTS_PASSKEY_AUTHENTICATE_OPTIONS_PATH,
  TAKOSUMI_ACCOUNTS_PASSKEY_REGISTER_COMPLETE_PATH,
  TAKOSUMI_ACCOUNTS_PASSKEY_REGISTER_OPTIONS_PATH,
  TAKOSUMI_ACCOUNTS_PAT_SCOPES,
  TAKOSUMI_ACCOUNTS_SELF_SERVICE_PAT_SCOPES,
  TAKOSUMI_ACCOUNTS_AUTH_PROVIDERS_PATH,
  TAKOSUMI_ACCOUNTS_UPSTREAM_AUTHORIZE_PATH,
  TAKOSUMI_ACCOUNTS_UPSTREAM_CALLBACK_PATH,
  takosumiAccountsAccountTokenRevokePath,
} from "../../../../accounts/contract/src/mod.ts";

test("normalizeIssuer removes trailing slashes", () => {
  expect(normalizeIssuer("https://accounts.example.test///")).toEqual(
    "https://accounts.example.test",
  );
});

test("normalizeIssuer rejects query strings", () => {
  assertThrows(
    () => normalizeIssuer("https://accounts.example.test?tenant=bad"),
    TypeError,
    "query or fragment",
  );
});

test("normalizeIssuer requires explicit operator issuer", () => {
  assertThrows(
    () => normalizeIssuer(),
    TypeError,
    "operator-selected issuer required",
  );
  assertThrows(
    () => normalizeIssuer(""),
    TypeError,
    "operator-selected issuer required",
  );
});

test("buildOidcDiscoveryDocument returns stable account endpoints", () => {
  // The issuer is the bare worker origin supplied by the operator; the
  // discovery doc is derived from whatever origin is passed in.
  const issuer = "https://app.takosumi.test";
  const discovery = buildOidcDiscoveryDocument({ issuer });
  expect(discovery.issuer).toEqual(issuer);
  expect(discovery.authorization_endpoint).toEqual(`${issuer}/oauth/authorize`);
  expect(discovery.token_endpoint).toEqual(`${issuer}/oauth/token`);
  expect(discovery.jwks_uri).toEqual(`${issuer}/oauth/jwks`);
  expect(discovery.revocation_endpoint).toEqual(`${issuer}/oauth/revoke`);
  expect(discovery.introspection_endpoint).toEqual(
    `${issuer}/oauth/introspect`,
  );
  expect(discovery.subject_types_supported).toEqual(["pairwise"]);
});

test("account token contract exposes the Accounts PAT route surface", () => {
  expect(TAKOSUMI_ACCOUNTS_PAT_SCOPES).toEqual([
    "read",
    "write",
    "admin",
    "resources:read",
    "ai.models.read",
    "ai.chat",
    "ai.embeddings",
  ]);
  expect(TAKOSUMI_ACCOUNTS_SELF_SERVICE_PAT_SCOPES).toEqual(["read", "write"]);
  expect(TAKOSUMI_ACCOUNTS_ACCOUNT_TOKENS_PATH).toEqual(
    "/api/v1/account/tokens",
  );
  expect(TAKOSUMI_ACCOUNTS_PAT_SCOPE_CATALOG_PATH).toEqual(
    "/api/v1/account/tokens/scopes",
  );
  expect(TAKOSUMI_ACCOUNTS_PAT_SCOPE_CATALOG_KIND).toEqual(
    "takosumi.account-pat-scope-catalog@v1",
  );
  expect(TAKOSUMI_ACCOUNTS_CURRENT_PAT_AUTHORITY_PATH).toEqual(
    "/api/v1/account/tokens/current",
  );
  expect(TAKOSUMI_ACCOUNTS_CURRENT_PAT_AUTHORITY_KIND).toEqual(
    "takosumi.account-pat-authority@v1",
  );
  expect(TAKOSUMI_ACCOUNTS_PAT_INVENTORY_PATH).toEqual(
    "/api/v1/account/tokens/inventory.v1",
  );
  expect(TAKOSUMI_ACCOUNTS_PAT_INVENTORY_KIND).toEqual(
    "takosumi.account-pat-inventory@v1",
  );
  expect(takosumiAccountsAccountTokenRevokePath("pat_1")).toEqual(
    "/api/v1/account/tokens/pat_1/revoke",
  );
  expect(takosumiAccountsAccountTokenRevokePath("pat/one")).toEqual(
    "/api/v1/account/tokens/pat%2Fone/revoke",
  );
  assertThrows(
    () => takosumiAccountsAccountTokenRevokePath(""),
    TypeError,
    "tokenId is required",
  );
});

test("optional Accounts HTTP path constants are exported from the contract", () => {
  expect(TAKOSUMI_ACCOUNTS_UPSTREAM_AUTHORIZE_PATH).toEqual(
    "/oauth/upstream/authorize",
  );
  expect(TAKOSUMI_ACCOUNTS_UPSTREAM_CALLBACK_PATH).toEqual(
    "/oauth/upstream/callback",
  );
  expect(TAKOSUMI_ACCOUNTS_AUTH_PROVIDERS_PATH).toEqual(
    "/api/v1/auth/providers",
  );
  expect(TAKOSUMI_ACCOUNTS_PASSKEY_REGISTER_OPTIONS_PATH).toEqual(
    "/api/v1/auth/passkeys/register/options",
  );
  expect(TAKOSUMI_ACCOUNTS_PASSKEY_REGISTER_COMPLETE_PATH).toEqual(
    "/api/v1/auth/passkeys/register/complete",
  );
  expect(TAKOSUMI_ACCOUNTS_PASSKEY_AUTHENTICATE_OPTIONS_PATH).toEqual(
    "/api/v1/auth/passkeys/authenticate/options",
  );
  expect(TAKOSUMI_ACCOUNTS_PASSKEY_AUTHENTICATE_COMPLETE_PATH).toEqual(
    "/api/v1/auth/passkeys/authenticate/complete",
  );
});
