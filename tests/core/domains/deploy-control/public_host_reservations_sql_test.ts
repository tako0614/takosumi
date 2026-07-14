import { afterAll, expect, test } from "bun:test";

import type {
  OpenTofuControlStore,
  ReservePublicHostInput,
} from "../../../../core/domains/deploy-control/store.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";

const clients: PGliteSqlClient[] = [];

afterAll(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

async function seedWorkspace(
  store: OpenTofuControlStore,
  id: string,
  ownerUserId: string,
): Promise<void> {
  await store.putWorkspace({
    id,
    handle: id.replaceAll("_", "-"),
    displayName: id,
    type: "personal",
    ownerUserId,
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z",
  });
}

test("Postgres serializes owner vanity slots without counting scoped reservations", async () => {
  const client = await PGliteSqlClient.create();
  clients.push(client);
  const store = new SqlOpenTofuControlStore({ client });

  await seedWorkspace(store, "workspace_one", "owner_shared");
  await seedWorkspace(store, "workspace_two", "owner_shared");
  await seedWorkspace(store, "workspace_other", "owner_other");

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
