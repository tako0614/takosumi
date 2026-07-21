import { expect, test } from "bun:test";

import { WorkspacesService } from "../../../../core/domains/workspaces/mod.ts";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";

function build() {
  const store = new InMemoryOpenTofuControlStore();
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

test("createWorkspace persists a personal Workspace with derived id + timestamps", async () => {
  const { store, service } = build();
  const workspace = await service.createWorkspace({
    handle: "shota",
    displayName: "Shota",
    type: "personal",
    ownerUserId: "user_1",
  });
  expect(workspace.id).toBe("ws_test00000001");
  expect(workspace.handle).toBe("shota");
  expect(workspace.type).toBe("personal");
  expect(workspace.createdAt).toBe("2026-06-06T00:00:00.000Z");
  expect(workspace.updatedAt).toBe("2026-06-06T00:00:00.000Z");
  expect((await store.getWorkspaceByHandle("shota"))?.id).toBe(workspace.id);
});

test("createWorkspace rejects an empty handle", async () => {
  const { service } = build();
  await expect(
    service.createWorkspace({
      handle: "",
      displayName: "Empty",
      type: "personal",
      ownerUserId: "user_1",
    }),
  ).rejects.toMatchObject({ code: "invalid_argument" });
});

test("createWorkspace rejects a handle that violates the grammar", async () => {
  const { service } = build();
  for (const handle of [
    "-bad",
    "a",
    "Has-Upper",
    "white space",
    "x".repeat(40),
  ]) {
    await expect(
      service.createWorkspace({
        handle,
        displayName: "Bad",
        type: "personal",
        ownerUserId: "user_1",
      }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
  }
});

test("createWorkspace accepts a 2-char and a 39-char handle", async () => {
  const { service } = build();
  const short = await service.createWorkspace({
    handle: "ab",
    displayName: "AB",
    type: "personal",
    ownerUserId: "user_1",
  });
  expect(short.handle).toBe("ab");
  const long = "a" + "b".repeat(38);
  const full = await service.createWorkspace({
    handle: long,
    displayName: "Long",
    type: "personal",
    ownerUserId: "user_1",
  });
  expect(full.handle).toBe(long);
});

test("createWorkspace rejects an unknown type", async () => {
  const { service } = build();
  await expect(
    service.createWorkspace({
      handle: "shota",
      displayName: "Shota",
      // deliberately invalid type
      type: "team" as never,
      ownerUserId: "user_1",
    }),
  ).rejects.toMatchObject({ code: "invalid_argument" });
});

test("createWorkspace rejects a duplicate handle", async () => {
  const { service } = build();
  await service.createWorkspace({
    handle: "shota",
    displayName: "Shota",
    type: "personal",
    ownerUserId: "user_1",
  });
  await expect(
    service.createWorkspace({
      handle: "shota",
      displayName: "Shota 2",
      type: "organization",
      ownerUserId: "user_2",
    }),
  ).rejects.toMatchObject({ code: "failed_precondition" });
});

test("createWorkspace recovers an exact retry after a partial first attempt", async () => {
  const store = new InMemoryOpenTofuControlStore();
  let defaultProjectAttempts = 0;
  let counter = 0;
  const service = new WorkspacesService({
    store,
    newId: (prefix) =>
      `${prefix}_retry${(counter += 1).toString().padStart(8, "0")}`,
    now: () => new Date("2026-06-06T00:00:00.000Z"),
    ensureDefaultProject: async () => {
      defaultProjectAttempts += 1;
      if (defaultProjectAttempts === 1) throw new Error("response lost");
    },
  });
  const request = {
    handle: "retry-safe",
    displayName: "Retry Safe",
    type: "organization" as const,
    ownerUserId: "user_owner",
  };

  await expect(service.createWorkspace(request)).rejects.toThrow(
    "response lost",
  );
  const recovered = await service.createWorkspace(request);

  expect(recovered.id).toBe("ws_retry00000001");
  expect(defaultProjectAttempts).toBe(2);
  expect(await store.listWorkspaces()).toHaveLength(1);
  expect(await store.listWorkspaceMembers(recovered.id)).toEqual([
    expect.objectContaining({
      accountId: "user_owner",
      roles: ["owner"],
      status: "active",
    }),
  ]);
});

test("createWorkspace recovers a durable write with an ambiguous store error", async () => {
  const { store, service } = build();
  const putWorkspace = store.putWorkspace.bind(store);
  let failAfterWrite = true;
  store.putWorkspace = async (workspace) => {
    const persisted = await putWorkspace(workspace);
    if (failAfterWrite) {
      failAfterWrite = false;
      throw new Error("ambiguous D1 response");
    }
    return persisted;
  };

  const workspace = await service.createWorkspace({
    handle: "ambiguous-write",
    displayName: "Ambiguous Write",
    type: "personal",
    ownerUserId: "user_1",
  });

  expect(workspace.id).toBe("ws_test00000001");
  expect(await store.listWorkspaces()).toHaveLength(1);
  expect(await store.listWorkspaceMembers(workspace.id)).toHaveLength(1);
});

test("getWorkspace returns the record and throws not_found when missing", async () => {
  const { service } = build();
  const workspace = await service.createWorkspace({
    handle: "shota",
    displayName: "Shota",
    type: "personal",
    ownerUserId: "user_1",
  });
  expect((await service.getWorkspace(workspace.id)).handle).toBe("shota");
  await expect(service.getWorkspace("ws_missing")).rejects.toMatchObject({
    code: "not_found",
  });
});

test("updateWorkspace persists displayName and Workspace policy", async () => {
  const { service } = build();
  const workspace = await service.createWorkspace({
    handle: "shota",
    displayName: "Shota",
    type: "personal",
    ownerUserId: "user_1",
  });
  const updated = await service.updateWorkspace(workspace.id, {
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

test("updateWorkspace archives and restores a Workspace without deleting it", async () => {
  const { service } = build();
  const workspace = await service.createWorkspace({
    handle: "shota",
    displayName: "Shota",
    type: "personal",
    ownerUserId: "user_1",
  });
  const archived = await service.updateWorkspace(workspace.id, {
    archived: true,
  });
  expect(archived.archivedAt).toBe("2026-06-06T00:00:00.000Z");
  expect((await service.getWorkspace(workspace.id)).archivedAt).toBe(
    "2026-06-06T00:00:00.000Z",
  );

  const restored = await service.updateWorkspace(workspace.id, {
    archived: false,
  });
  expect(restored.archivedAt).toBeUndefined();
  expect((await service.getWorkspace(workspace.id)).archivedAt).toBeUndefined();
});

test("ensurePersonalWorkspace creates once and is idempotent by handle", async () => {
  const { service } = build();
  const first = await service.ensurePersonalWorkspace("user_1", "shota");
  expect(first.type).toBe("personal");
  expect(first.ownerUserId).toBe("user_1");
  const second = await service.ensurePersonalWorkspace("user_1", "shota");
  expect(second.id).toBe(first.id);
  expect((await service.listWorkspaces()).length).toBe(1);
});

test("listWorkspaces returns all created Workspaces", async () => {
  const { service } = build();
  const shota = await service.createWorkspace({
    handle: "shota",
    displayName: "Shota",
    type: "personal",
    ownerUserId: "user_1",
  });
  const acme = await service.createWorkspace({
    handle: "acme",
    displayName: "Acme",
    type: "organization",
    ownerUserId: "user_2",
  });
  expect((await service.listWorkspaces()).length).toBe(2);
  expect(
    (await service.listWorkspacesByIds([acme.id, "ws_missing", shota.id])).map(
      (workspace) => workspace.id,
    ),
  ).toEqual([acme.id, shota.id]);
});

test("Workspace creation persists its namespace owner in the canonical roster", async () => {
  const { store, service } = build();
  const workspace = await service.createWorkspace({
    handle: "owner-ledger",
    displayName: "Owner Ledger",
    type: "organization",
    ownerUserId: "user_owner",
  });
  expect(await store.listWorkspaceMembers(workspace.id)).toEqual([
    expect.objectContaining({
      workspaceId: workspace.id,
      accountId: "user_owner",
      roles: ["owner"],
      status: "active",
    }),
  ]);
});

test("canonical Workspace membership controls mutation and account visibility", async () => {
  const { service, store } = build();
  const workspacePageCalls: unknown[] = [];
  const listWorkspacePage = store.listWorkspacesForAccountPage.bind(store);
  store.listWorkspacesForAccountPage = async (accountId, params) => {
    workspacePageCalls.push({ accountId, params });
    return await listWorkspacePage(accountId, params);
  };
  const workspace = await service.createWorkspace({
    handle: "team-ledger",
    displayName: "Team Ledger",
    type: "organization",
    ownerUserId: "user_owner",
  });
  const member = await service.upsertWorkspaceMember({
    workspaceId: workspace.id,
    accountId: "user_member",
    roles: ["member"],
    status: "active",
    actorAccountId: "user_owner",
  });
  expect(member.roles).toEqual(["member"]);
  expect(
    (await service.listWorkspacesForAccount("user_member")).map(
      (row) => row.id,
    ),
  ).toEqual([workspace.id]);
  expect(workspacePageCalls).toEqual([
    {
      accountId: "user_member",
      params: {
        includeArchived: true,
        includeTotal: false,
        order: "created_asc",
      },
    },
  ]);
  await expect(
    service.upsertWorkspaceMember({
      workspaceId: workspace.id,
      accountId: "user_other",
      roles: ["member"],
      actorAccountId: "user_member",
    }),
  ).rejects.toMatchObject({ code: "permission_denied" });
});

test("namespace owner cannot be demoted or suspended", async () => {
  const { service } = build();
  const workspace = await service.createWorkspace({
    handle: "root-owner",
    displayName: "Root Owner",
    type: "organization",
    ownerUserId: "user_owner",
  });
  await expect(
    service.upsertWorkspaceMember({
      workspaceId: workspace.id,
      accountId: "user_owner",
      roles: ["member"],
      status: "suspended",
      actorAccountId: "user_owner",
    }),
  ).rejects.toMatchObject({ code: "failed_precondition" });
});
