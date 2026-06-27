import { expect, test } from "bun:test";
import { assertEquals, assertThrows } from "../../../helpers/assert.ts";
import {
  buildOidcDiscoveryDocument,
  canonicalJson,
  normalizeIssuer,
  sha256HexText,
  takosumiAccountsInstallationMaterializeDigest,
  TAKOSUMI_ACCOUNTS_ACCOUNT_TOKENS_PATH,
  TAKOSUMI_ACCOUNTS_INSTALLATION_EXPORT_BUNDLE_KIND,
  TAKOSUMI_ACCOUNTS_PASSKEY_AUTHENTICATE_COMPLETE_PATH,
  TAKOSUMI_ACCOUNTS_PASSKEY_AUTHENTICATE_OPTIONS_PATH,
  TAKOSUMI_ACCOUNTS_PASSKEY_REGISTER_COMPLETE_PATH,
  TAKOSUMI_ACCOUNTS_PASSKEY_REGISTER_OPTIONS_PATH,
  TAKOSUMI_ACCOUNTS_PAT_SCOPES,
  TAKOSUMI_ACCOUNTS_AUTH_PROVIDERS_PATH,
  TAKOSUMI_ACCOUNTS_UPSTREAM_AUTHORIZE_PATH,
  TAKOSUMI_ACCOUNTS_UPSTREAM_CALLBACK_PATH,
  takosumiAccountsAccountTokenRevokePath,
  takosumiAccountsInstallationBillingUsageReportsPath,
  takosumiAccountsInstallationDeploymentPlanRunsPath,
  takosumiAccountsInstallationDeploymentsPath,
  takosumiAccountsInstallationPlanRunsPath,
  takosumiAccountsInstallationEventsPath,
  takosumiAccountsInstallationExportDownloadPath,
  takosumiAccountsInstallationExportOperationPath,
  takosumiAccountsInstallationExportPath,
  takosumiAccountsInstallationMaterializePath,
  takosumiAccountsInstallationPath,
  takosumiAccountsInstallationRollbackPath,
  takosumiAccountsInstallationStatusPath,
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
  expect(TAKOSUMI_ACCOUNTS_PAT_SCOPES).toEqual(["read", "write", "admin"]);
  expect(TAKOSUMI_ACCOUNTS_ACCOUNT_TOKENS_PATH).toEqual("/v1/account/tokens");
  expect(takosumiAccountsAccountTokenRevokePath("pat_1")).toEqual(
    "/v1/account/tokens/pat_1/revoke",
  );
  expect(takosumiAccountsAccountTokenRevokePath("pat/one")).toEqual(
    "/v1/account/tokens/pat%2Fone/revoke",
  );
  assertThrows(
    () => takosumiAccountsAccountTokenRevokePath(""),
    TypeError,
    "tokenId is required",
  );
});

test("optional Accounts HTTP path constants are exported from the contract", () => {
  expect(TAKOSUMI_ACCOUNTS_UPSTREAM_AUTHORIZE_PATH).toEqual(
    "/v1/auth/upstream/authorize",
  );
  expect(TAKOSUMI_ACCOUNTS_UPSTREAM_CALLBACK_PATH).toEqual(
    "/v1/auth/upstream/callback",
  );
  expect(TAKOSUMI_ACCOUNTS_AUTH_PROVIDERS_PATH).toEqual("/v1/auth/providers");
  expect(TAKOSUMI_ACCOUNTS_PASSKEY_REGISTER_OPTIONS_PATH).toEqual(
    "/v1/auth/passkeys/register/options",
  );
  expect(TAKOSUMI_ACCOUNTS_PASSKEY_REGISTER_COMPLETE_PATH).toEqual(
    "/v1/auth/passkeys/register/complete",
  );
  expect(TAKOSUMI_ACCOUNTS_PASSKEY_AUTHENTICATE_OPTIONS_PATH).toEqual(
    "/v1/auth/passkeys/authenticate/options",
  );
  expect(TAKOSUMI_ACCOUNTS_PASSKEY_AUTHENTICATE_COMPLETE_PATH).toEqual(
    "/v1/auth/passkeys/authenticate/complete",
  );
});

test("export bundle kind is stable for portable Installation projection exports", () => {
  expect(TAKOSUMI_ACCOUNTS_INSTALLATION_EXPORT_BUNDLE_KIND).toEqual(
    "takosumi.accounts.installation-export-bundle@v1",
  );
});

test("Installation projection path helpers expose the Accounts route surface", () => {
  expect(takosumiAccountsInstallationPlanRunsPath()).toEqual(
    "/v1/installation-projections/plan-runs",
  );
  expect(takosumiAccountsInstallationPath("inst_1")).toEqual(
    "/v1/installation-projections/inst_1",
  );
  expect(takosumiAccountsInstallationStatusPath("inst_1")).toEqual(
    "/v1/installation-projections/inst_1/status",
  );
  expect(takosumiAccountsInstallationDeploymentsPath("inst_1")).toEqual(
    "/v1/installation-projections/inst_1/deployments",
  );
  expect(takosumiAccountsInstallationDeploymentPlanRunsPath("inst_1")).toEqual(
    "/v1/installation-projections/inst_1/deployments/plan-runs",
  );
  expect(takosumiAccountsInstallationRollbackPath("inst_1")).toEqual(
    "/v1/installation-projections/inst_1/rollback",
  );
  expect(takosumiAccountsInstallationMaterializePath("inst_1")).toEqual(
    "/v1/installation-projections/inst_1/materialize",
  );
  expect(takosumiAccountsInstallationExportPath("inst_1")).toEqual(
    "/v1/installation-projections/inst_1/export",
  );
  expect(
    takosumiAccountsInstallationExportOperationPath("inst_1", "op_1"),
  ).toEqual("/v1/installation-projections/inst_1/exports/op_1");
  expect(
    takosumiAccountsInstallationExportDownloadPath("inst_1", "op_1"),
  ).toEqual("/v1/installation-projections/inst_1/exports/op_1/download");
  expect(takosumiAccountsInstallationEventsPath("inst_1")).toEqual(
    "/v1/installation-projections/inst_1/events",
  );
  expect(takosumiAccountsInstallationBillingUsageReportsPath("inst_1")).toEqual(
    "/v1/installation-projections/inst_1/billing/usage-reports",
  );
  expect(takosumiAccountsInstallationPath("inst/one")).toEqual(
    "/v1/installation-projections/inst%2Fone",
  );
  expect(
    takosumiAccountsInstallationExportOperationPath("inst/one", "op/one"),
  ).toEqual("/v1/installation-projections/inst%2Fone/exports/op%2Fone");
  expect(
    takosumiAccountsInstallationExportDownloadPath("inst/one", "op/one"),
  ).toEqual(
    "/v1/installation-projections/inst%2Fone/exports/op%2Fone/download",
  );
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

test("canonicalJson sorts object keys and stabilizes scalars", () => {
  expect(canonicalJson({ b: 1, a: { d: 4, c: 3 } })).toEqual(
    `{"a":{"c":3,"d":4},"b":1}`,
  );
  expect(canonicalJson([3, 1, 2])).toEqual("[3,1,2]");
  expect(canonicalJson(undefined)).toEqual("null");
  expect(canonicalJson({ x: undefined })).toEqual(`{"x":null}`);
});

test("sha256HexText returns a sha256:<64-hex> digest", async () => {
  expect(await sha256HexText("")).toEqual(
    "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
  expect(await sha256HexText("abc")).toMatch(/^sha256:[0-9a-f]{64}$/);
});

test("materialize permission digest is the canonical form the server verifies", async () => {
  // Pinned golden: the materialize endpoint recomputes this exact digest and
  // rejects the request on any byte mismatch. The server now derives it from
  // this same builder, so a change here is a deliberate, breaking change.
  const digest = await takosumiAccountsInstallationMaterializeDigest({
    installationId: "inst_1",
    mode: "dedicated",
    region: "default",
    plan: {},
    cutover: {},
  });
  expect(digest).toEqual(
    "sha256:94a00d4f8b3ecc85eaaa9ed56d8ec922d2f8a876c29518d42b7b2d8d78d64394",
  );
  // The digest is sha256(canonicalJson(operation envelope)); recompute it the
  // long way to lock the envelope shape the server expects.
  const expected = await sha256HexText(
    canonicalJson({
      operation: "materialize",
      installationId: "inst_1",
      mode: "dedicated",
      region: "default",
      plan: {},
      cutover: {},
    }),
  );
  expect(digest).toEqual(expected);
});
