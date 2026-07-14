import { expect, test } from "bun:test";
import {
  InMemoryOpenTofuControlStore,
  type OpenTofuControlStore,
} from "../../../../core/domains/deploy-control/store.ts";
import { CloudflareD1OpenTofuControlStore } from "../../../../worker/src/d1_opentofu_store.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

function stores(): readonly [string, OpenTofuControlStore][] {
  return [
    ["memory", new InMemoryOpenTofuControlStore()],
    ["d1", new CloudflareD1OpenTofuControlStore(new SqliteFakeD1())],
  ];
}

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

test("managed hostname vanity slots are owner-scoped while scoped names remain available", async () => {
  for (const [label, store] of stores()) {
    await seedWorkspace(store, "workspace_one", "user_owner");
    await seedWorkspace(store, "workspace_two", "user_owner");
    await seedWorkspace(store, "workspace_three", "user_other");
    const firstVanity = await store.reservePublicHost({
      hostname: "short-one.app.takos.jp",
      workspaceId: "workspace_one",
      capsuleId: "capsule_one",
      capsuleName: "one",
      allocationKind: "vanity",
      vanitySlotLimit: 1,
      now: "2026-07-11T00:00:00.000Z",
    });
    expect(firstVanity.reserved, label).toBe(true);

    const sameCapsuleSecondHostname = await store.reservePublicHost({
      hostname: "short-one-alt.app.takos.jp",
      workspaceId: "workspace_one",
      capsuleId: "capsule_one",
      capsuleName: "one",
      allocationKind: "vanity",
      vanitySlotLimit: 1,
      now: "2026-07-11T00:00:00.500Z",
    });
    expect(sameCapsuleSecondHostname, label).toEqual({
      reserved: false,
      reason: "owner_slot_limit_reached",
      vanitySlotLimit: 1,
    });

    const scoped = await store.reservePublicHost({
      hostname: "workspace-two-app.app.takos.jp",
      workspaceId: "workspace_two",
      capsuleId: "capsule_two",
      capsuleName: "two",
      allocationKind: "scoped",
      vanitySlotLimit: 1,
      now: "2026-07-11T00:00:01.000Z",
    });
    expect(scoped.reserved, label).toBe(true);

    const secondVanity = await store.reservePublicHost({
      hostname: "short-two.app.takos.jp",
      workspaceId: "workspace_two",
      capsuleId: "capsule_two",
      capsuleName: "two",
      allocationKind: "vanity",
      vanitySlotLimit: 1,
      now: "2026-07-11T00:00:02.000Z",
    });
    expect(secondVanity, label).toEqual({
      reserved: false,
      reason: "owner_slot_limit_reached",
      vanitySlotLimit: 1,
    });

    const otherOwner = await store.reservePublicHost({
      hostname: "short-three.app.takos.jp",
      workspaceId: "workspace_three",
      capsuleId: "capsule_three",
      capsuleName: "three",
      allocationKind: "vanity",
      vanitySlotLimit: 1,
      now: "2026-07-11T00:00:03.000Z",
    });
    expect(otherOwner.reserved, label).toBe(true);

    await store.releasePublicHostsForCapsule(
      "capsule_one",
      "2026-07-11T00:00:04.000Z",
    );
    const afterRelease = await store.reservePublicHost({
      hostname: "short-two.app.takos.jp",
      workspaceId: "workspace_two",
      capsuleId: "capsule_two",
      capsuleName: "two",
      allocationKind: "vanity",
      vanitySlotLimit: 1,
      now: "2026-07-11T00:00:05.000Z",
    });
    expect(afterRelease.reserved, label).toBe(true);
  }
});

test("concurrent vanity claims cannot exceed the owner slot limit", async () => {
  for (const [label, store] of stores()) {
    await seedWorkspace(store, "workspace_one", "user_race");
    await seedWorkspace(store, "workspace_two", "user_race");
    const results = await Promise.all(
      ["one", "two"].map((suffix) =>
        store.reservePublicHost({
          hostname: `race-${suffix}.app.takos.jp`,
          workspaceId: `workspace_${suffix}`,
          capsuleId: `capsule_${suffix}`,
          capsuleName: suffix,
          allocationKind: "vanity",
          vanitySlotLimit: 1,
          now: "2026-07-11T00:00:00.000Z",
        }),
      ),
    );
    expect(
      results.filter((result) => result.reserved).length,
      label,
    ).toBe(1);
    expect(
      results.filter(
        (result) =>
          !result.reserved && result.reason === "owner_slot_limit_reached",
      ).length,
      label,
    ).toBe(1);
  }
});
