import { expect, spyOn, test } from "bun:test";
import {
  createCloudflareWorker,
  type CloudflareWorkerEnv,
} from "../../../../deploy/accounts-cloudflare/src/handler.ts";
import { applyD1AccountsMigrationBatch, loadD1AccountsMigrationCatalog } from "../../../../accounts/service/src/d1-migrations.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

const VALID = JSON.stringify([{
  id: "chat-mobile",
  name: "Chat",
  android: {
    package: "com.example.chat",
    schemes: ["chat"],
    appLinkHosts: [],
    templates: ["chat://connect?server={origin}"],
  },
}]);

test("absent, valid and malformed trusted native clients all keep OIDC and Accounts serving", async () => {
  const signingKey = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const privateJwk = await crypto.subtle.exportKey("jwk", signingKey.privateKey);
  const catalog = await loadD1AccountsMigrationCatalog();
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    // One malformed value: the handler reads it for both the identity and the control handler.
    for (const value of [undefined, VALID, "[{\"id\":\"accounts-cloudflare-marker\"}]"]) {
      const database = new SqliteFakeD1();
      for (const migration of catalog.migrations) {
        await applyD1AccountsMigrationBatch(database, migration, 1_000 + migration.version);
      }
      const env = {
        TAKOSUMI_ACCOUNTS_DB: database,
        TAKOSUMI_ACCOUNTS_D1_SCHEMA_MODE: "predeployed",
        TAKOSUMI_ACCOUNTS_ISSUER: "https://issuer.example.test",
        TAKOSUMI_ACCOUNT_SESSION_HASH_SALT: "fixture-trusted-native-clients-salt",
        TAKOSUMI_ACCOUNTS_ES256_PRIVATE_JWK: JSON.stringify(privateJwk),
        TAKOSUMI_ACCOUNTS_OIDC_PAIRWISE_SUBJECT_SECRET: "fixture-pairwise-subject-secret",
        ...(value === undefined ? {} : { TAKOSUMI_ACCOUNTS_TRUSTED_NATIVE_CLIENTS: value }),
      } as unknown as CloudflareWorkerEnv;
      const worker = createCloudflareWorker();
      // Identity-only OIDC sign-in.
      const discovery = await worker.fetch(
        new Request("https://issuer.example.test/.well-known/openid-configuration"),
        env,
      );
      expect(discovery.status, String(value)).toBe(200);
      expect(await discovery.json()).toMatchObject({ issuer: "https://issuer.example.test" });
      // The full Accounts handler.
      const retired = await worker.fetch(new Request("https://issuer.example.test/v1/account/session/me"), env);
      expect(retired.status, String(value)).toBe(404);
      expect(await retired.json()).toMatchObject({ error: { code: "not_found" } });
    }
    const lines = error.mock.calls.map((call) => String(call[0]));
    expect(lines.filter((line) => line.includes("trusted_native_clients_config_invalid"))).toHaveLength(1);
    expect(lines.join("\n")).not.toContain("accounts-cloudflare-marker");
  } finally {
    error.mockRestore();
  }
});
