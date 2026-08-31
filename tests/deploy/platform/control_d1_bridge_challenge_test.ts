import { expect, test } from "bun:test";

import {
  CONTROL_D1_BRIDGE_CHALLENGE_PATH,
  controlD1BridgeChallengeResponse,
} from "../../../deploy/platform/control_d1_bridge_challenge.ts";
import { buildControlD1SchemaPlan } from "../../../deploy/platform/control_d1_schema.ts";
import { ensureD1OpenTofuLedgerSchema } from "../../../worker/src/d1_opentofu_store.ts";
import { SqliteFakeD1 } from "../../helpers/deploy-control/sqlite_fake_d1.ts";

const VERSION_ID = "11111111-1111-4111-8111-111111111111";
const NONCE = "a".repeat(64);

test("bridge challenge binds a fresh nonce, immutable Version, and the physical v66 ledger", async () => {
  const database = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(database, {
    throughMigrationVersion: 66,
  });
  const [candidate, predecessor] = await Promise.all([
    buildControlD1SchemaPlan(),
    buildControlD1SchemaPlan({ throughMigrationVersion: 66 }),
  ]);

  const response = await controlD1BridgeChallengeResponse(
    new Request(
      `https://app-staging.takosumi.com${CONTROL_D1_BRIDGE_CHALLENGE_PATH}?nonce=${NONCE}`,
    ),
    {
      TAKOSUMI_CONTROL_DB: database,
      TAKOSUMI_CONTROL_D1_SCHEMA_MODE: "predeployed-bridge",
      TAKOSUMI_ENVIRONMENT: "staging",
      TAKOSUMI_VERSION_METADATA: { id: VERSION_ID },
    },
  );

  expect(response?.status).toBe(200);
  expect(response?.headers.get("cache-control")).toBe("no-store");
  expect(response?.headers.get("x-takosumi-version-id")).toBe(VERSION_ID);
  expect(await response?.json()).toEqual({
    kind: "takosumi.control-d1-schema-compatibility-challenge@v1",
    status: "ready",
    nonce: NONCE,
    environment: "staging",
    workerVersionId: VERSION_ID,
    bindingName: "TAKOSUMI_CONTROL_DB",
    schemaMode: "predeployed-bridge",
    ledger: predecessor.migrations,
    accepted: {
      migrationVersion: 66,
      ledgerDigest: predecessor.ledgerDigest,
    },
    allowset: [
      { migrationVersion: 66, ledgerDigest: predecessor.ledgerDigest },
      { migrationVersion: 67, ledgerDigest: candidate.ledgerDigest },
    ],
  });
});

test("bridge challenge is unavailable outside the exact bridge mode", async () => {
  const database = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(database);
  const response = await controlD1BridgeChallengeResponse(
    new Request(
      `https://app.takosumi.com${CONTROL_D1_BRIDGE_CHALLENGE_PATH}?nonce=${NONCE}`,
    ),
    {
      TAKOSUMI_CONTROL_DB: database,
      TAKOSUMI_CONTROL_D1_SCHEMA_MODE: "predeployed",
      TAKOSUMI_ENVIRONMENT: "production",
      TAKOSUMI_VERSION_METADATA: { id: VERSION_ID },
    },
  );
  expect(response?.status).toBe(503);
  expect(response?.headers.get("cache-control")).toBe("no-store");
});
