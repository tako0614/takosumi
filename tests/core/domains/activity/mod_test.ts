/**
 * Activity domain service tests (Core Specification §27 / §34).
 *
 * Covers: record mints id + createdAt and persists; list is newest-first +
 * limit-clamped + Workspace-scoped; record is fire-and-forget (a store error is
 * swallowed, never thrown into the caller).
 */

import { expect, test } from "bun:test";
import { ActivityService } from "../../../../core/domains/activity/mod.ts";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import type { OpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import type { ActivityEvent } from "takosumi-contract/activity";

function makeService(
  store: OpenTofuControlStore = new InMemoryOpenTofuControlStore(),
): { service: ActivityService; store: OpenTofuControlStore } {
  let counter = 0;
  let clock = 0;
  return {
    service: new ActivityService({
      store,
      newId: (prefix) => `${prefix}_${String(++counter).padStart(8, "0")}`,
      now: () => new Date(Date.UTC(2026, 5, 6, 0, 0, ++clock)),
    }),
    store,
  };
}

test("record mints id + createdAt and persists", async () => {
  const { service } = makeService();
  const event = await service.record({
    workspaceId: "workspace_1",
    actorId: "user_1",
    action: "capsule.created",
    targetType: "capsule",
    targetId: "capsule_1",
    metadata: { name: "shop" },
  });

  expect(event?.id).toBe("act_00000001");
  expect(event?.createdAt).toBe("2026-06-06T00:00:01.000Z");
  expect(event?.workspaceId).toBe("workspace_1");

  const listed = await service.list("workspace_1");
  expect(listed.map((e) => e.id)).toEqual(["act_00000001"]);
});

test("record redacts secret-shaped metadata before persisting", async () => {
  const { service, store } = makeService();
  await service.record({
    workspaceId: "workspace_1",
    action: "connection.created",
    targetType: "connection",
    targetId: "conn_1",
    metadata: {
      displayName: "Cloudflare",
      apiToken: "raw-token",
      detail: "Authorization: Bearer abc.def password=hunter2",
      nested: { databaseUrl: "postgres://user:secret@example/db" },
    },
  });

  const [event] = await store.listActivityEvents("workspace_1");
  expect(event?.metadata).toEqual({
    displayName: "Cloudflare",
    apiToken: "[REDACTED]",
    detail: "Authorization: Bearer [REDACTED] password=[REDACTED]",
    nested: { databaseUrl: "[REDACTED]" },
  });
});

test("list is newest-first, Workspace-scoped, and limit-clamped", async () => {
  const { service } = makeService();
  // Three in workspace_1 (clock advances each record), one in workspace_2.
  await service.record(base({ targetId: "capsule_a" })); // :01
  await service.record(base({ targetId: "capsule_b" })); // :02
  await service.record(base({ targetId: "capsule_c" })); // :03
  await service.record(
    base({ workspaceId: "workspace_2", targetId: "capsule_x" }),
  ); // :04

  // Newest first within the Workspace.
  const listed = await service.list("workspace_1");
  expect(listed.map((e) => e.targetId)).toEqual([
    "capsule_c",
    "capsule_b",
    "capsule_a",
  ]);

  // Workspace isolation.
  expect((await service.list("workspace_2")).map((e) => e.targetId)).toEqual([
    "capsule_x",
  ]);
  expect((await service.list("workspace_missing")).length).toBe(0);

  // Limit caps the page (newest two).
  expect((await service.list("workspace_1", 2)).map((e) => e.targetId)).toEqual(
    ["capsule_c", "capsule_b"],
  );
});

test("listAcrossWorkspaces performs one bounded newest-first projection", async () => {
  const { service } = makeService();
  await service.record(base({ workspaceId: "workspace_1", targetId: "a" }));
  await service.record(base({ workspaceId: "workspace_2", targetId: "b" }));
  await service.record(base({ workspaceId: "workspace_3", targetId: "c" }));

  expect(
    (
      await service.listAcrossWorkspaces(
        ["workspace_1", "workspace_2", "workspace_1"],
        2,
      )
    ).map((event) => event.targetId),
  ).toEqual(["b", "a"]);
  expect(await service.listAcrossWorkspaces([], 2)).toEqual([]);
  await expect(
    service.listAcrossWorkspaces(
      Array.from({ length: 13 }, (_, index) => `workspace_${index}`),
    ),
  ).rejects.toBeInstanceOf(RangeError);
});

test("listTargetPage filters one target and carries an opaque cursor", async () => {
  const { service } = makeService();
  for (const targetId of ["resource_a", "resource_b", "resource_a"] as const) {
    await service.record(
      base({ targetType: "resource", targetId, action: "resource.changed" }),
    );
  }

  const first = await service.listTargetPage(
    "workspace_1",
    "resource",
    "resource_a",
    { limit: 1 },
  );
  expect(first.items.map((event) => event.targetId)).toEqual(["resource_a"]);
  expect(first.nextCursor).toBeDefined();

  const second = await service.listTargetPage(
    "workspace_1",
    "resource",
    "resource_a",
    { limit: 1, cursor: first.nextCursor! },
  );
  expect(second.items.map((event) => event.targetId)).toEqual(["resource_a"]);
  expect(second.nextCursor).toBeUndefined();
  expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
});

test("record is fire-and-forget: a store error is swallowed, not thrown", async () => {
  const throwingStore = new InMemoryOpenTofuControlStore();
  throwingStore.putActivityEvent = () =>
    Promise.reject(new Error("ledger unavailable"));
  const { service } = makeService(throwingStore);

  // Must NOT reject: the audit write failing cannot fail the caller's action.
  const result = await service.record(base({}));
  expect(result).toBeUndefined();
});

function base(
  over: Partial<Omit<ActivityEvent, "id" | "createdAt">>,
): Omit<ActivityEvent, "id" | "createdAt"> {
  return {
    workspaceId: "workspace_1",
    action: "capsule.created",
    targetType: "capsule",
    targetId: "capsule_1",
    metadata: {},
    ...over,
  };
}
