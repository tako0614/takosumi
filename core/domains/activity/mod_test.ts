/**
 * Activity domain service tests (Core Specification §27 / §34).
 *
 * Covers: record mints id + createdAt and persists; list is newest-first +
 * limit-clamped + space-scoped; record is fire-and-forget (a store error is
 * swallowed, never thrown into the caller).
 */

import { expect, test } from "bun:test";
import { ActivityService } from "./mod.ts";
import { InMemoryOpenTofuDeploymentStore } from "../deploy-control/store.ts";
import type { OpenTofuDeploymentStore } from "../deploy-control/store.ts";
import type { ActivityEvent } from "takosumi-contract/activity";

function makeService(
  store: OpenTofuDeploymentStore = new InMemoryOpenTofuDeploymentStore(),
): { service: ActivityService; store: OpenTofuDeploymentStore } {
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
    spaceId: "space_1",
    actorId: "user_1",
    action: "installation.created",
    targetType: "installation",
    targetId: "inst_1",
    metadata: { name: "shop" },
  });

  expect(event?.id).toBe("act_00000001");
  expect(event?.createdAt).toBe("2026-06-06T00:00:01.000Z");
  expect(event?.spaceId).toBe("space_1");

  const listed = await service.list("space_1");
  expect(listed.map((e) => e.id)).toEqual(["act_00000001"]);
});

test("record redacts secret-shaped metadata before persisting", async () => {
  const { service, store } = makeService();
  await service.record({
    spaceId: "space_1",
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

  const [event] = await store.listActivityEvents("space_1");
  expect(event?.metadata).toEqual({
    displayName: "Cloudflare",
    apiToken: "[REDACTED]",
    detail: "Authorization: Bearer [REDACTED] password=[REDACTED]",
    nested: { databaseUrl: "[REDACTED]" },
  });
});

test("list is newest-first, space-scoped, and limit-clamped", async () => {
  const { service } = makeService();
  // Three in space_1 (clock advances each record), one in space_2.
  await service.record(base({ targetId: "inst_a" })); // :01
  await service.record(base({ targetId: "inst_b" })); // :02
  await service.record(base({ targetId: "inst_c" })); // :03
  await service.record(base({ spaceId: "space_2", targetId: "inst_x" })); // :04

  // Newest first within the Space.
  const listed = await service.list("space_1");
  expect(listed.map((e) => e.targetId)).toEqual(["inst_c", "inst_b", "inst_a"]);

  // Space isolation.
  expect((await service.list("space_2")).map((e) => e.targetId))
    .toEqual(["inst_x"]);
  expect((await service.list("space_missing")).length).toBe(0);

  // Limit caps the page (newest two).
  expect((await service.list("space_1", 2)).map((e) => e.targetId))
    .toEqual(["inst_c", "inst_b"]);
});

test("record is fire-and-forget: a store error is swallowed, not thrown", async () => {
  const throwingStore = new InMemoryOpenTofuDeploymentStore();
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
    spaceId: "space_1",
    action: "installation.created",
    targetType: "installation",
    targetId: "inst_1",
    metadata: {},
    ...over,
  };
}
