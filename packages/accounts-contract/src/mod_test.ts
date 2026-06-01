import { expect, test } from "bun:test";
import { assertEquals, assertThrows } from "../../../test/assert.ts";
import {
  buildOidcDiscoveryDocument,
  normalizeIssuer,
  TAKOSUMI_ACCOUNTS_ACCOUNT_TOKENS_PATH,
  TAKOSUMI_ACCOUNTS_EXAMPLE_ISSUER,
  TAKOSUMI_ACCOUNTS_INSTALLATION_EXPORT_BUNDLE_KIND,
  TAKOSUMI_ACCOUNTS_PASSKEY_AUTHENTICATE_COMPLETE_PATH,
  TAKOSUMI_ACCOUNTS_PASSKEY_AUTHENTICATE_OPTIONS_PATH,
  TAKOSUMI_ACCOUNTS_PASSKEY_REGISTER_COMPLETE_PATH,
  TAKOSUMI_ACCOUNTS_PASSKEY_REGISTER_OPTIONS_PATH,
  TAKOSUMI_ACCOUNTS_PAT_SCOPES,
  TAKOSUMI_ACCOUNTS_STRIPE_CHECKOUT_PATH,
  TAKOSUMI_ACCOUNTS_STRIPE_WEBHOOK_PATH,
  TAKOSUMI_ACCOUNTS_UPSTREAM_AUTHORIZE_PATH,
  TAKOSUMI_ACCOUNTS_UPSTREAM_CALLBACK_PATH,
 takosumiAccountsAccountTokenRevokePath,
 takosumiAccountsInstallationBillingUsageReportsPath,
 takosumiAccountsInstallationDeploymentDryRunPath,
 takosumiAccountsInstallationDeploymentsPath,
 takosumiAccountsInstallationDryRunPath,
 takosumiAccountsInstallationEventsPath,
 takosumiAccountsInstallationExportDownloadPath,
 takosumiAccountsInstallationExportOperationPath,
 takosumiAccountsInstallationExportPath,
 takosumiAccountsInstallationMaterializePath,
 takosumiAccountsInstallationPath,
 takosumiAccountsInstallationRollbackPath,
 takosumiAccountsInstallationsImportPath,
 takosumiAccountsInstallationStatusPath,
} from "./mod.ts";

test("normalizeIssuer removes trailing slashes", () => {
  expect(normalizeIssuer("https://accounts.example.test///")).toEqual("https://accounts.example.test");
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
  const discovery = buildOidcDiscoveryDocument({
    issuer: TAKOSUMI_ACCOUNTS_EXAMPLE_ISSUER,
  });
  expect(discovery.issuer).toEqual("https://accounts.takosumi.com");
  expect(discovery.authorization_endpoint).toEqual("https://accounts.takosumi.com/oauth/authorize");
  expect(discovery.token_endpoint).toEqual("https://accounts.takosumi.com/oauth/token");
  expect(discovery.jwks_uri).toEqual("https://accounts.takosumi.com/oauth/jwks");
  expect(discovery.revocation_endpoint).toEqual("https://accounts.takosumi.com/oauth/revoke");
  expect(discovery.introspection_endpoint).toEqual("https://accounts.takosumi.com/oauth/introspect");
  expect(discovery.subject_types_supported).toEqual(["pairwise"]);
});

test("account token contract exposes the Accounts PAT route surface", () => {
  expect(TAKOSUMI_ACCOUNTS_PAT_SCOPES).toEqual(["read", "write", "admin"]);
  expect(TAKOSUMI_ACCOUNTS_ACCOUNT_TOKENS_PATH).toEqual("/v1/account/tokens");
  expect(takosumiAccountsAccountTokenRevokePath("pat_1")).toEqual("/v1/account/tokens/pat_1/revoke");
  expect(takosumiAccountsAccountTokenRevokePath("pat/one")).toEqual("/v1/account/tokens/pat%2Fone/revoke");
  assertThrows(
    () => takosumiAccountsAccountTokenRevokePath(""),
    TypeError,
    "tokenId is required",
  );
});

test("optional Accounts HTTP path constants are exported from the contract", () => {
  expect(TAKOSUMI_ACCOUNTS_STRIPE_CHECKOUT_PATH).toEqual("/v1/billing/stripe/checkout");
  expect(TAKOSUMI_ACCOUNTS_STRIPE_WEBHOOK_PATH).toEqual("/v1/billing/stripe/webhook");
  expect(TAKOSUMI_ACCOUNTS_UPSTREAM_AUTHORIZE_PATH).toEqual("/v1/auth/upstream/authorize");
  expect(TAKOSUMI_ACCOUNTS_UPSTREAM_CALLBACK_PATH).toEqual("/v1/auth/upstream/callback");
  expect(TAKOSUMI_ACCOUNTS_PASSKEY_REGISTER_OPTIONS_PATH).toEqual("/v1/auth/passkeys/register/options");
  expect(TAKOSUMI_ACCOUNTS_PASSKEY_REGISTER_COMPLETE_PATH).toEqual("/v1/auth/passkeys/register/complete");
  expect(TAKOSUMI_ACCOUNTS_PASSKEY_AUTHENTICATE_OPTIONS_PATH).toEqual("/v1/auth/passkeys/authenticate/options");
  expect(TAKOSUMI_ACCOUNTS_PASSKEY_AUTHENTICATE_COMPLETE_PATH).toEqual("/v1/auth/passkeys/authenticate/complete");
});

test("export bundle kind is stable for portable AppInstallation exports", () => {
  expect(TAKOSUMI_ACCOUNTS_INSTALLATION_EXPORT_BUNDLE_KIND).toEqual("takosumi.accounts.installation-export-bundle@v1");
});

test("AppInstallation path helpers expose the Accounts route surface", () => {
  expect(takosumiAccountsInstallationDryRunPath()).toEqual("/v1/installations/dry-run");
  expect(takosumiAccountsInstallationPath("inst_1")).toEqual("/v1/installations/inst_1");
  expect(takosumiAccountsInstallationsImportPath()).toEqual("/v1/installations/import");
  expect(takosumiAccountsInstallationStatusPath("inst_1")).toEqual("/v1/installations/inst_1/status");
  expect(takosumiAccountsInstallationDeploymentsPath("inst_1")).toEqual("/v1/installations/inst_1/deployments");
  expect(takosumiAccountsInstallationDeploymentDryRunPath("inst_1")).toEqual("/v1/installations/inst_1/deployments/dry-run");
  expect(takosumiAccountsInstallationRollbackPath("inst_1")).toEqual("/v1/installations/inst_1/rollback");
  expect(takosumiAccountsInstallationMaterializePath("inst_1")).toEqual("/v1/installations/inst_1/materialize");
  expect(takosumiAccountsInstallationExportPath("inst_1")).toEqual("/v1/installations/inst_1/export");
  expect(takosumiAccountsInstallationExportOperationPath("inst_1", "op_1")).toEqual("/v1/installations/inst_1/exports/op_1");
  expect(takosumiAccountsInstallationExportDownloadPath("inst_1", "op_1")).toEqual("/v1/installations/inst_1/exports/op_1/download");
  expect(takosumiAccountsInstallationEventsPath("inst_1")).toEqual("/v1/installations/inst_1/events");
  expect(takosumiAccountsInstallationBillingUsageReportsPath("inst_1")).toEqual("/v1/installations/inst_1/billing/usage-reports");
  expect(takosumiAccountsInstallationPath("inst/one")).toEqual("/v1/installations/inst%2Fone");
  expect(takosumiAccountsInstallationExportOperationPath("inst/one", "op/one")).toEqual("/v1/installations/inst%2Fone/exports/op%2Fone");
  expect(takosumiAccountsInstallationExportDownloadPath("inst/one", "op/one")).toEqual("/v1/installations/inst%2Fone/exports/op%2Fone/download");
  assertThrows(
    () => takosumiAccountsInstallationPath(""),
    TypeError,
    "installationId is required",
  );
  assertThrows(
    () => takosumiAccountsInstallationExportOperationPath("inst_1", ""),
    TypeError,
    "operationId is required",
  );
});
