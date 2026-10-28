import { afterEach, expect, test } from "bun:test";

import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import { CloudflareD1OpenTofuControlStore } from "../../../../worker/src/d1_opentofu_store.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

const legacyDependency = {
  id: "legacy-dependency",
  workspaceId: "legacy-workspace",
  producerCapsuleId: "legacy-producer",
  consumerCapsuleId: "legacy-consumer",
  createdAt: "2026-10-28T00:00:00.000Z",
};

const pgClients: PGliteSqlClient[] = [];

afterEach(async () => {
  await Promise.all(pgClients.splice(0).map((client) => client.close()));
});

test("memory guard detects seeded retired consumer rows without a CRUD port", async () => {
  const empty = new InMemoryOpenTofuControlStore();
  const seeded = new InMemoryOpenTofuControlStore({
    legacyDependencyConsumerCapsuleIds: [legacyDependency.consumerCapsuleId],
  });

  expect(await empty.hasRetiredDependenciesForConsumer("legacy-consumer")).toBe(
    false,
  );
  expect(
    await seeded.hasRetiredDependenciesForConsumer("legacy-consumer"),
  ).toBe(true);
  expect(
    await seeded.hasRetiredDependenciesForConsumer("another-consumer"),
  ).toBe(false);
  expect("putDependency" in seeded).toBe(false);
  expect("listDependenciesForConsumer" in seeded).toBe(false);
});

test("Postgres and D1 guards query raw retired consumer rows", async () => {
  const pg = await PGliteSqlClient.create();
  pgClients.push(pg);
  const pgStore = new SqlOpenTofuControlStore({ client: pg });
  await pgStore.listWorkspaces();
  await pg.query(
    `insert into takosumi_installation_dependencies (
       id, space_id, producer_installation_id, consumer_installation_id,
       dependency_json, created_at
     ) values ($1, $2, $3, $4, $5::jsonb, $6)`,
    [
      legacyDependency.id,
      legacyDependency.workspaceId,
      legacyDependency.producerCapsuleId,
      legacyDependency.consumerCapsuleId,
      JSON.stringify(legacyDependency),
      legacyDependency.createdAt,
    ],
  );

  expect(await pgStore.hasRetiredDependenciesForConsumer("legacy-consumer")).toBe(
    true,
  );
  expect(await pgStore.hasRetiredDependenciesForConsumer("another-consumer")).toBe(
    false,
  );
  expect("putDependency" in pgStore).toBe(false);
  expect("getDependencySnapshot" in pgStore).toBe(false);
  expect("putOutputShare" in pgStore).toBe(false);

  const d1 = new SqliteFakeD1();
  const d1Store = new CloudflareD1OpenTofuControlStore(d1);
  await d1Store.listWorkspaces();
  await d1
    .prepare(
      `insert into installation_dependencies (
         id, space_id, producer_installation_id, consumer_installation_id,
         record_json, created_at
       ) values (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      legacyDependency.id,
      legacyDependency.workspaceId,
      legacyDependency.producerCapsuleId,
      legacyDependency.consumerCapsuleId,
      JSON.stringify(legacyDependency),
      legacyDependency.createdAt,
    )
    .run();

  expect(
    await d1Store.hasRetiredDependenciesForConsumer("legacy-consumer"),
  ).toBe(true);
  expect(
    await d1Store.hasRetiredDependenciesForConsumer("another-consumer"),
  ).toBe(false);
  expect("putDependency" in d1Store).toBe(false);
  expect("getDependencySnapshot" in d1Store).toBe(false);
  expect("putOutputShare" in d1Store).toBe(false);
});
