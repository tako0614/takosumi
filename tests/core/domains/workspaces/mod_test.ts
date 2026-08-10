import { expect, test } from "bun:test";

import { WorkspacesService } from "../../../../core/domains/workspaces/mod.ts";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import { WORKSPACE_HANDLE_PATTERN } from "../../../../contract/workspaces.ts";

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

test("listWorkspacesPage walks the complete durable ledger with a keyset cursor", async () => {
  const { service } = build();
  for (const handle of ["alpha", "beta", "gamma"]) {
    await service.createWorkspace({
      handle,
      displayName: handle,
      type: "organization",
      ownerUserId: "user_1",
    });
  }

  const first = await service.listWorkspacesPage({ limit: 2 });
  expect(first.items.map((workspace) => workspace.handle)).toEqual([
    "alpha",
    "beta",
  ]);
  expect(first.nextCursor).toBeDefined();
  const second = await service.listWorkspacesPage({
    limit: 2,
    cursor: first.nextCursor,
  });
  expect(second.items.map((workspace) => workspace.handle)).toEqual(["gamma"]);
  expect(second.nextCursor).toBeUndefined();
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

test("ensurePersonalWorkspace adopts the oldest personal Workspace and leaves ordinary ones creatable", async () => {
  const { service } = build();
  const ordinaryFirst = await service.createWorkspace({
    handle: "personal-writing",
    displayName: "Personal Writing",
    type: "personal",
    ownerUserId: "user_1",
  });
  const ordinarySecond = await service.createWorkspace({
    handle: "personal-lab",
    displayName: "Personal Lab",
    type: "personal",
    ownerUserId: "user_1",
  });
  const first = await service.ensurePersonalWorkspace("user_1", "shota");
  expect(first.type).toBe("personal");
  expect(first.ownerUserId).toBe("user_1");
  expect(first.id).toBe(ordinaryFirst.id);
  const ordinaryThird = await service.createWorkspace({
    handle: "personal-community",
    displayName: "Personal Community",
    type: "personal",
    ownerUserId: "user_1",
  });
  const second = await service.ensurePersonalWorkspace(
    "user_1",
    "renamed-presentation",
  );
  expect(second.id).toBe(first.id);
  expect((await service.listWorkspaces()).map((row) => row.id)).toEqual([
    ordinaryFirst.id,
    ordinarySecond.id,
    ordinaryThird.id,
  ]);
});

test("ensurePersonalWorkspace never returns a preferred handle owned by another account", async () => {
  const { service, store } = build();
  const foreign = await service.createWorkspace({
    handle: "same-handle",
    displayName: "Same Handle",
    type: "personal",
    ownerUserId: "user_foreign",
  });

  const ensured = await service.ensurePersonalWorkspace(
    "user_requesting",
    "same-handle",
  );

  expect(ensured.id).not.toBe(foreign.id);
  expect(ensured.type).toBe("personal");
  expect(ensured.ownerUserId).toBe("user_requesting");
  expect(ensured.handle).toBe("u-userrequesting");
  expect(await store.listWorkspaceMembers(foreign.id)).toEqual([
    expect.objectContaining({ accountId: "user_foreign", roles: ["owner"] }),
  ]);
  expect(await store.getWorkspaceMember(foreign.id, "user_requesting")).toBe(
    undefined,
  );
  expect(await store.getWorkspaceMember(ensured.id, "user_requesting")).toEqual(
    expect.objectContaining({ roles: ["owner"], status: "active" }),
  );
});

test("ensurePersonalWorkspace escapes foreign squatting of every deterministic handle", async () => {
  const { service, store } = build();
  const deterministicHandles = [
    "squatted-preferred",
    "u-usersquatted",
    "u-usersquatted-1eqj03w",
  ];
  const foreignRows = [];
  for (const handle of deterministicHandles) {
    foreignRows.push(
      await service.createWorkspace({
        handle,
        displayName: `Foreign ${handle}`,
        type: "personal",
        ownerUserId: "user_foreign",
      }),
    );
  }

  const ensured = await service.ensurePersonalWorkspace(
    "user_squatted",
    "squatted-preferred",
  );

  expect(ensured.ownerUserId).toBe("user_squatted");
  expect(ensured.type).toBe("personal");
  expect(ensured.handle).toMatch(/^p-[a-f0-9]{32}$/u);
  expect(deterministicHandles).not.toContain(ensured.handle);
  expect(
    (await store.listWorkspaces()).filter(
      (workspace) => workspace.ownerUserId === "user_squatted",
    ),
  ).toEqual([ensured]);
  for (const foreign of foreignRows) {
    expect(
      await store.getWorkspaceMember(foreign.id, "user_squatted"),
    ).toBeUndefined();
  }
});

test("ensurePersonalWorkspace falls back when the preferred handle is an organization", async () => {
  const { service } = build();
  const foreign = await service.createWorkspace({
    handle: "shared-purpose",
    displayName: "Shared Purpose",
    type: "organization",
    ownerUserId: "org_owner",
  });

  const ensured = await service.ensurePersonalWorkspace(
    "user_personal",
    "shared-purpose",
  );

  expect(ensured.id).not.toBe(foreign.id);
  expect(ensured.type).toBe("personal");
  expect(ensured.ownerUserId).toBe("user_personal");
  expect(ensured.handle).toMatch(/^[a-z0-9][a-z0-9-]{1,38}$/u);
  expect(ensured.handle.length).toBeLessThanOrEqual(39);
});

test("ensurePersonalWorkspace never persists an invalid presentation handle", async () => {
  const { service } = build();

  const ensured = await service.ensurePersonalWorkspace(
    "user_valid_fallback",
    "INVALID PRESENTATION!",
  );

  expect(ensured.handle).toBe("u-uservalidfallback");
  expect(ensured.handle).toMatch(WORKSPACE_HANDLE_PATTERN);
});

test("separate Workspace services converge despite different presentation handles", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const first = new WorkspacesService({
    store,
    newId: (prefix) => `${prefix}_first_service`,
    now: () => new Date("2026-06-06T00:00:00.000Z"),
  });
  const second = new WorkspacesService({
    store,
    newId: (prefix) => `${prefix}_second_service`,
    now: () => new Date("2026-06-06T00:00:01.000Z"),
  });
  const results = await Promise.all([
    first.ensurePersonalWorkspace("user_concurrent", "first-presentation"),
    second.ensurePersonalWorkspace("user_concurrent", "second-presentation"),
  ]);

  expect(new Set(results.map((workspace) => workspace.id)).size).toBe(1);
  expect(new Set(results.map((workspace) => workspace.handle)).size).toBe(1);
  expect(
    (await store.listWorkspaces()).filter(
      (workspace) => workspace.ownerUserId === "user_concurrent",
    ),
  ).toHaveLength(1);
  expect(
    await store.listWorkspaceMembers(results[0].id),
  ).toEqual([expect.objectContaining({
    accountId: "user_concurrent",
    roles: ["owner"],
    status: "active",
  })]);
});

test("separate Workspace services concurrently adopt the same oldest personal Workspace", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const seed = new WorkspacesService({
    store,
    newId: (() => {
      let counter = 0;
      return (prefix: string) => `${prefix}_seed_${(counter += 1)}`;
    })(),
    now: () => new Date("2026-06-06T00:00:00.000Z"),
  });
  const oldest = await seed.createWorkspace({
    handle: "existing-oldest",
    displayName: "Existing Oldest",
    type: "personal",
    ownerUserId: "user_adopt",
  });
  await seed.createWorkspace({
    handle: "existing-newer",
    displayName: "Existing Newer",
    type: "personal",
    ownerUserId: "user_adopt",
  });
  const first = new WorkspacesService({
    store,
    newId: (prefix) => `${prefix}_adopter_first`,
  });
  const second = new WorkspacesService({
    store,
    newId: (prefix) => `${prefix}_adopter_second`,
  });

  const adopted = await Promise.all([
    first.ensurePersonalWorkspace("user_adopt", "first-presentation"),
    second.ensurePersonalWorkspace("user_adopt", "second-presentation"),
  ]);

  expect(adopted.map((workspace) => workspace.id)).toEqual([
    oldest.id,
    oldest.id,
  ]);
  expect(
    (await store.listWorkspaces()).filter(
      (workspace) => workspace.ownerUserId === "user_adopt",
    ),
  ).toHaveLength(2);
});

test("ensurePersonalWorkspace repairs the durable bootstrap owner and default Project", async () => {
  const store = new InMemoryOpenTofuControlStore();
  let idCounter = 0;
  let defaultProjectEnsures = 0;
  const service = new WorkspacesService({
    store,
    newId: (prefix) => `${prefix}_repair_${(idCounter += 1)}`,
    now: () => new Date("2026-06-06T00:00:00.000Z"),
    ensureDefaultProject: async () => {
      defaultProjectEnsures += 1;
    },
  });
  const workspace = await service.ensurePersonalWorkspace(
    "user_repair",
    "repair-me",
  );
  const member = await store.getWorkspaceMember(workspace.id, "user_repair");
  expect(member).toBeDefined();
  await store.putWorkspaceMember({
    ...member!,
    roles: ["member"],
    status: "suspended",
  });

  const repaired = await service.ensurePersonalWorkspace(
    "user_repair",
    "changed-presentation",
  );

  expect(repaired.id).toBe(workspace.id);
  expect(await store.getWorkspaceMember(workspace.id, "user_repair")).toEqual(
    expect.objectContaining({ roles: ["owner"], status: "active" }),
  );
  expect(defaultProjectEnsures).toBe(2);
});

test("ensurePersonalWorkspace never uses the unbounded owner list", async () => {
  const { service, store } = build();
  store.listWorkspacesByOwner = async () => {
    throw new Error("bootstrap must use the exact owner-scoped identity");
  };

  const workspace = await service.ensurePersonalWorkspace(
    "user_exact",
    "exact-owner",
  );

  expect(workspace.ownerUserId).toBe("user_exact");
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
