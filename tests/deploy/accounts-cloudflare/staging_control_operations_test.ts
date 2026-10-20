import { expect, test } from "bun:test";
import { applyD1AccountsMigrationBatch, loadD1AccountsMigrationCatalog } from "../../../accounts/service/src/d1-migrations.ts";
import { ensureD1OpenTofuLedgerSchema } from "../../../worker/src/d1_opentofu_store.ts";
import { authStagingControlOperations } from "../../../deploy/accounts-cloudflare/src/staging-owner-bundle.ts";
import { AUTH_STAGING_CLIENTS, AUTH_STAGING_CONTROL_SECRETS, AUTH_STAGING_ISSUER, AUTH_STAGING_WORKER } from "../../../deploy/accounts-cloudflare/src/staging-target.ts";
import { SqliteFakeD1 } from "../../helpers/deploy-control/sqlite_fake_d1.ts";

// The live issuer answered every shared-Workspace directory call with 503:
// its released secret set could not construct the in-process Control
// service. Build the environment from exactly the released contract.
async function issuerEnv(controlSecrets: boolean) {
  const accounts = new SqliteFakeD1();
  for (const migration of (await loadD1AccountsMigrationCatalog()).migrations) {
    if (migration.version > 5) break;
    await applyD1AccountsMigrationBatch(accounts, migration, 1_000 + migration.version);
  }
  const control = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(control);
  return {
    TAKOSUMI_ENVIRONMENT: "staging", TAKOSUMI_AUTH_WORKER_NAME: AUTH_STAGING_WORKER, TAKOSUMI_ACCOUNTS_ISSUER: AUTH_STAGING_ISSUER,
    TAKOSUMI_ACCOUNTS_D1_SCHEMA_MODE: "predeployed", TAKOSUMI_CONTROL_D1_SCHEMA_MODE: "predeployed", TAKOSUMI_ACCOUNTS_HOSTED_SESSION_POLICY: "true",
    TAKOSUMI_ACCOUNTS_CLIENTS: JSON.stringify(AUTH_STAGING_CLIENTS.map((client) => ({ ...client, allowedScopes: ["openid", "email", "offline_access"], tokenEndpointAuthMethod: "client_secret_basic", enabled: true, profile: "shared-account" }))),
    TAKOSUMI_ACCOUNTS_DB: accounts, TAKOSUMI_CONTROL_DB: control,
    TAKOSUMI_ACCOUNT_SESSION_HASH_SALT: Buffer.alloc(32, 1).toString("base64url"),
    TAKOSUMI_ACCOUNTS_OIDC_PAIRWISE_SUBJECT_SECRET: Buffer.alloc(32, 2).toString("base64url"),
    TAKOSUMI_ACCOUNTS_SUBJECT_SECRET: Buffer.alloc(32, 3).toString("base64url"),
    ...(controlSecrets ? Object.fromEntries(AUTH_STAGING_CONTROL_SECRETS.map((name, index) => [name, Buffer.alloc(32, 10 + index).toString("base64url")])) : {}),
    TAKOSUMI_VERSION_METADATA: { id: "control-operations-test" },
    R2_ARTIFACTS: {}, R2_SOURCE: {}, R2_STATE: {}, R2_BACKUPS: {}, COORDINATION: {}, RUN_OWNER: {}, RUNNER: {},
  };
}

test("the released issuer secret set constructs the in-process Control operations", async () => {
  const operations = await authStagingControlOperations(await issuerEnv(true) as never);
  expect(typeof operations.workspaces).toBe("object");
});

test("without the control-operation secrets the Control service refuses to start", async () => {
  await expect(authStagingControlOperations(await issuerEnv(false) as never)).rejects.toThrow("secret-store encryption key missing");
});
