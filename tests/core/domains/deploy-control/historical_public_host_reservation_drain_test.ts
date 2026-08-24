import { afterEach, expect, test } from "bun:test";

import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import { CloudflareD1OpenTofuControlStore } from "../../../../worker/src/d1_opentofu_store.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

const RESERVED_AT = "2026-07-11T00:00:00.000Z";
const RELEASED_AT = "2026-07-11T00:01:00.000Z";
const HOSTNAME = "historical.app.takos.jp";
const CAPSULE_ID = "capsule_historical_host";

const clients: PGliteSqlClient[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

test("Postgres reads and releases an out-of-band historical public-host row", async () => {
  const client = await PGliteSqlClient.create();
  clients.push(client);
  const store = new SqlOpenTofuControlStore({ client });

  await client.query(
    `insert into takosumi_public_host_reservations (
       hostname, owner_user_id, workspace_id, installation_id,
       installation_name, allocation_kind, status,
       reserved_at, updated_at, released_at
     ) values ($1, $2, $3, $4, $5, 'scoped', 'reserved', $6, $6, null)`,
    [
      HOSTNAME,
      "owner_historical_host",
      "workspace_historical_host",
      CAPSULE_ID,
      "historical-host",
      RESERVED_AT,
    ],
  );

  await expect(store.getPublicHostReservation(HOSTNAME)).resolves.toMatchObject(
    {
      hostname: HOSTNAME,
      capsuleId: CAPSULE_ID,
      status: "reserved",
    },
  );

  await store.releasePublicHostsForCapsule(CAPSULE_ID, RELEASED_AT);

  await expect(store.getPublicHostReservation(HOSTNAME)).resolves.toMatchObject(
    {
      status: "released",
      updatedAt: RELEASED_AT,
      releasedAt: RELEASED_AT,
    },
  );
});

test("D1 reads and releases an out-of-band historical public-host row", async () => {
  const db = new SqliteFakeD1();
  const store = new CloudflareD1OpenTofuControlStore(db);

  // Initialize the current schema before the test fixture performs the same
  // out-of-band insert an operator inventory/drain tool would perform.
  await expect(
    store.getPublicHostReservation(HOSTNAME),
  ).resolves.toBeUndefined();
  await db
    .prepare(
      `insert into public_host_reservations (
         hostname, owner_user_id, workspace_id, installation_id,
         installation_name, allocation_kind, status,
         reserved_at, updated_at, released_at
       ) values (?, ?, ?, ?, ?, 'scoped', 'reserved', ?, ?, null)`,
    )
    .bind(
      HOSTNAME,
      "owner_historical_host",
      "workspace_historical_host",
      CAPSULE_ID,
      "historical-host",
      RESERVED_AT,
      RESERVED_AT,
    )
    .run();

  await expect(store.getPublicHostReservation(HOSTNAME)).resolves.toMatchObject(
    {
      hostname: HOSTNAME,
      capsuleId: CAPSULE_ID,
      status: "reserved",
    },
  );

  await store.releasePublicHostsForCapsule(CAPSULE_ID, RELEASED_AT);

  await expect(store.getPublicHostReservation(HOSTNAME)).resolves.toMatchObject(
    {
      status: "released",
      updatedAt: RELEASED_AT,
      releasedAt: RELEASED_AT,
    },
  );
});
