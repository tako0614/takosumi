import { expect, test } from "bun:test";

import { WorkspacesService } from "../../../../core/domains/workspaces/mod.ts";
import { InMemoryOpenTofuDeploymentStore } from "../../../../core/domains/deploy-control/store.ts";

function build() {
  const store = new InMemoryOpenTofuDeploymentStore();
  let counter = 0;
  const newId = (prefix: string) =>
    `${prefix}_test${(counter += 1).toString().padStart(8, "0")}`;
  const service = new WorkspacesService({
    store,
    newId,
    now: () => new Date("2026-06-06T00:00:00.000Z"),
  });
  return { store, service };
}

test("createSpace persists a personal space with derived id + timestamps", async () => {
  const { store, service } = build();
  const space = await service.createSpace({
    handle: "shota",
    displayName: "Shota",
    type: "personal",
    ownerUserId: "user_1",
  });
  expect(space.id).toBe("space_test00000001");
  expect(space.handle).toBe("shota");
  expect(space.type).toBe("personal");
  expect(space.createdAt).toBe("2026-06-06T00:00:00.000Z");
  expect(space.updatedAt).toBe("2026-06-06T00:00:00.000Z");
  expect((await store.getSpaceByHandle("shota"))?.id).toBe(space.id);
});

test("createSpace keeps an optional billingAccountId", async () => {
  const { service } = build();
  const space = await service.createSpace({
    handle: "acme",
    displayName: "Acme",
    type: "organization",
    ownerUserId: "user_1",
    billingAccountId: "billing_1",
  });
  expect(space.billingAccountId).toBe("billing_1");
});

test("createSpace rejects an empty handle", async () => {
  const { service } = build();
  await expect(
    service.createSpace({
      handle: "",
      displayName: "Empty",
      type: "personal",
      ownerUserId: "user_1",
    }),
  ).rejects.toMatchObject({ code: "invalid_argument" });
});

test("createSpace rejects a handle that violates the grammar", async () => {
  const { service } = build();
  for (const handle of [
    "-bad",
    "a",
    "Has-Upper",
    "white space",
    "x".repeat(40),
  ]) {
    await expect(
      service.createSpace({
        handle,
        displayName: "Bad",
        type: "personal",
        ownerUserId: "user_1",
      }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
  }
});

test("createSpace accepts a 2-char and a 39-char handle", async () => {
  const { service } = build();
  const short = await service.createSpace({
    handle: "ab",
    displayName: "AB",
    type: "personal",
    ownerUserId: "user_1",
  });
  expect(short.handle).toBe("ab");
  const long = "a" + "b".repeat(38);
  const full = await service.createSpace({
    handle: long,
    displayName: "Long",
    type: "personal",
    ownerUserId: "user_1",
  });
  expect(full.handle).toBe(long);
});

test("createSpace rejects an unknown type", async () => {
  const { service } = build();
  await expect(
    service.createSpace({
      handle: "shota",
      displayName: "Shota",
      // deliberately invalid type
      type: "team" as never,
      ownerUserId: "user_1",
    }),
  ).rejects.toMatchObject({ code: "invalid_argument" });
});

test("createSpace rejects a duplicate handle", async () => {
  const { service } = build();
  await service.createSpace({
    handle: "shota",
    displayName: "Shota",
    type: "personal",
    ownerUserId: "user_1",
  });
  await expect(
    service.createSpace({
      handle: "shota",
      displayName: "Shota 2",
      type: "organization",
      ownerUserId: "user_2",
    }),
  ).rejects.toMatchObject({ code: "failed_precondition" });
});

test("getSpace returns the record and throws not_found when missing", async () => {
  const { service } = build();
  const space = await service.createSpace({
    handle: "shota",
    displayName: "Shota",
    type: "personal",
    ownerUserId: "user_1",
  });
  expect((await service.getSpace(space.id)).handle).toBe("shota");
  await expect(service.getSpace("space_missing")).rejects.toMatchObject({
    code: "not_found",
  });
});

test("updateSpace persists displayName and Space policy", async () => {
  const { service } = build();
  const space = await service.createSpace({
    handle: "shota",
    displayName: "Shota",
    type: "personal",
    ownerUserId: "user_1",
  });
  const updated = await service.updateSpace(space.id, {
    displayName: "Shota Lab",
    policy: {
      allowedProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
      quota: { "resources.total": 10 },
    },
  });
  expect(updated.displayName).toBe("Shota Lab");
  expect(updated.policy).toEqual({
    allowedProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
    quota: { "resources.total": 10 },
  });
  expect(updated.updatedAt).toBe("2026-06-06T00:00:00.000Z");
});

test("updateSpace archives and restores a Space without deleting it", async () => {
  const { service } = build();
  const space = await service.createSpace({
    handle: "shota",
    displayName: "Shota",
    type: "personal",
    ownerUserId: "user_1",
  });
  const archived = await service.updateSpace(space.id, { archived: true });
  expect(archived.archivedAt).toBe("2026-06-06T00:00:00.000Z");
  expect((await service.getSpace(space.id)).archivedAt).toBe(
    "2026-06-06T00:00:00.000Z",
  );

  const restored = await service.updateSpace(space.id, { archived: false });
  expect(restored.archivedAt).toBeUndefined();
  expect((await service.getSpace(space.id)).archivedAt).toBeUndefined();
});

test("ensurePersonalSpace creates once and is idempotent by handle", async () => {
  const { service } = build();
  const first = await service.ensurePersonalSpace("user_1", "shota");
  expect(first.type).toBe("personal");
  expect(first.ownerUserId).toBe("user_1");
  const second = await service.ensurePersonalSpace("user_1", "shota");
  expect(second.id).toBe(first.id);
  expect((await service.listSpaces()).length).toBe(1);
});

test("listSpaces returns all created spaces", async () => {
  const { service } = build();
  const shota = await service.createSpace({
    handle: "shota",
    displayName: "Shota",
    type: "personal",
    ownerUserId: "user_1",
  });
  const acme = await service.createSpace({
    handle: "acme",
    displayName: "Acme",
    type: "organization",
    ownerUserId: "user_2",
  });
  expect((await service.listSpaces()).length).toBe(2);
  expect(
    (
      await service.listWorkspacesByIds([acme.id, "space_missing", shota.id])
    ).map((workspace) => workspace.id),
  ).toEqual([acme.id, shota.id]);
});
