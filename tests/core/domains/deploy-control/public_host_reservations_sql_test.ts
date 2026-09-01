import { afterEach, expect, test } from "bun:test";

import type { ReservePublicHostInput } from "../../../../core/domains/deploy-control/store.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import {
  seedCapsule,
  seedWorkspace,
} from "./public_host_reservations_fixtures.ts";

const clients: PGliteSqlClient[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

test("Postgres serializes owner vanity slots without counting scoped reservations", async () => {
  const client = await PGliteSqlClient.create();
  clients.push(client);
  const store = new SqlOpenTofuControlStore({ client });

  await seedWorkspace(store, "workspace_one", "owner_shared");
  await seedWorkspace(store, "workspace_two", "owner_shared");
  await seedWorkspace(store, "workspace_other", "owner_other");
  await seedCapsule(store, "capsule_scoped_one", "workspace_one");
  await seedCapsule(store, "capsule_scoped_two", "workspace_two");
  await seedCapsule(store, "capsule_vanity_one", "workspace_one");
  await seedCapsule(store, "capsule_vanity_two", "workspace_two");
  await seedCapsule(store, "capsule_other", "workspace_other");

  const scopedClaims: readonly ReservePublicHostInput[] = [
    {
      hostname: "workspace-one-app.app.takos.jp",
      workspaceId: "workspace_one",
      capsuleId: "capsule_scoped_one",
      capsuleName: "scoped-one",
      allocationKind: "scoped",
      vanitySlotLimit: 1,
      now: "2026-07-11T00:00:01.000Z",
    },
    {
      hostname: "workspace-two-app.app.takos.jp",
      workspaceId: "workspace_two",
      capsuleId: "capsule_scoped_two",
      capsuleName: "scoped-two",
      allocationKind: "scoped",
      vanitySlotLimit: 1,
      now: "2026-07-11T00:00:02.000Z",
    },
  ];
  const scopedResults = await Promise.all(
    scopedClaims.map((claim) => store.reservePublicHost(claim)),
  );
  expect(scopedResults.every((result) => result.reserved)).toBe(true);

  const vanityClaims: readonly ReservePublicHostInput[] = [
    {
      hostname: "shared-one.app.takos.jp",
      workspaceId: "workspace_one",
      capsuleId: "capsule_vanity_one",
      capsuleName: "vanity-one",
      allocationKind: "vanity",
      vanitySlotLimit: 1,
      now: "2026-07-11T00:00:03.000Z",
    },
    {
      hostname: "shared-two.app.takos.jp",
      workspaceId: "workspace_two",
      capsuleId: "capsule_vanity_two",
      capsuleName: "vanity-two",
      allocationKind: "vanity",
      vanitySlotLimit: 1,
      now: "2026-07-11T00:00:03.000Z",
    },
  ];
  const sharedOwnerResults = await Promise.all(
    vanityClaims.map((claim) => store.reservePublicHost(claim)),
  );

  expect(sharedOwnerResults.filter((result) => result.reserved)).toHaveLength(
    1,
  );
  expect(
    sharedOwnerResults.filter(
      (result) =>
        !result.reserved && result.reason === "owner_slot_limit_reached",
    ),
  ).toHaveLength(1);

  const otherOwner = await store.reservePublicHost({
    hostname: "other-owner.app.takos.jp",
    workspaceId: "workspace_other",
    capsuleId: "capsule_other",
    capsuleName: "other",
    allocationKind: "vanity",
    vanitySlotLimit: 1,
    now: "2026-07-11T00:00:04.000Z",
  });
  expect(otherOwner.reserved).toBe(true);

  const winnerIndex = sharedOwnerResults.findIndex((result) => result.reserved);
  expect(winnerIndex).toBeGreaterThanOrEqual(0);
  const winningResult = sharedOwnerResults[winnerIndex];
  const winningClaim = vanityClaims[winnerIndex];
  if (!winningResult?.reserved || !winningClaim) {
    throw new Error("expected one shared-owner vanity claim to win");
  }

  const retry = await store.reservePublicHost({
    ...winningClaim,
    now: "2026-07-11T00:00:05.000Z",
  });
  expect(retry.reserved).toBe(true);
  if (!retry.reserved) {
    throw new Error("expected the exact hostname retry to remain reserved");
  }
  expect(retry.reservation.reservedAt).toBe(
    winningResult.reservation.reservedAt,
  );

  const rows = await client.query<{
    hostname: string;
    owner_user_id: string;
    allocation_kind: string;
    status: string;
  }>(
    `select hostname, owner_user_id, allocation_kind, status
     from takosumi_public_host_reservations
     order by hostname`,
  );
  expect(
    rows.rows.filter(
      (row) =>
        row.owner_user_id === "owner_shared" &&
        row.allocation_kind === "scoped" &&
        row.status === "reserved",
    ),
  ).toHaveLength(2);
  expect(
    rows.rows.filter(
      (row) =>
        row.owner_user_id === "owner_shared" &&
        row.allocation_kind === "vanity" &&
        row.status === "reserved",
    ),
  ).toHaveLength(1);
  expect(
    rows.rows.filter(
      (row) =>
        row.owner_user_id === "owner_other" &&
        row.allocation_kind === "vanity" &&
        row.status === "reserved",
    ),
  ).toHaveLength(1);
  expect(
    rows.rows.filter((row) => row.hostname === winningClaim.hostname),
  ).toHaveLength(1);
});

test("Postgres does not claim or reactivate a host for an inactive Capsule", async () => {
  const client = await PGliteSqlClient.create();
  clients.push(client);
  const store = new SqlOpenTofuControlStore({ client });

  await seedWorkspace(store, "workspace_inactive", "owner_inactive");
  await seedCapsule(
    store,
    "capsule_destroyed",
    "workspace_inactive",
    "destroyed",
  );

  await expect(
    store.reservePublicHost({
      hostname: "destroyed.app.takos.jp",
      workspaceId: "workspace_inactive",
      capsuleId: "capsule_destroyed",
      capsuleName: "destroyed",
      allocationKind: "scoped",
      now: "2026-07-11T00:00:00.000Z",
    }),
  ).resolves.toEqual({ reserved: false, reason: "capsule_inactive" });
  await expect(
    store.getPublicHostReservation("destroyed.app.takos.jp"),
  ).resolves.toBeUndefined();

  await seedCapsule(store, "capsule_released", "workspace_inactive");
  const initial = await store.reservePublicHost({
    hostname: "released.app.takos.jp",
    workspaceId: "workspace_inactive",
    capsuleId: "capsule_released",
    capsuleName: "released",
    allocationKind: "scoped",
    now: "2026-07-11T00:00:01.000Z",
  });
  expect(initial.reserved).toBe(true);
  await store.releasePublicHostsForCapsule(
    "capsule_released",
    "2026-07-11T00:00:02.000Z",
  );
  await store.patchCapsule("capsule_released", { status: "destroyed" });

  await expect(
    store.reservePublicHost({
      hostname: "released.app.takos.jp",
      workspaceId: "workspace_inactive",
      capsuleId: "capsule_released",
      capsuleName: "released",
      allocationKind: "scoped",
      now: "2026-07-11T00:00:03.000Z",
    }),
  ).resolves.toEqual({ reserved: false, reason: "capsule_inactive" });
  await expect(
    store.getPublicHostReservation("released.app.takos.jp"),
  ).resolves.toMatchObject({ status: "released" });
});
