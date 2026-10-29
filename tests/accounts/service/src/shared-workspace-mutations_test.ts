import { expect, test } from "bun:test";
import type { Workspace, WorkspaceMember } from "takosumi-contract/workspaces";
import type { ControlPlaneOperations } from "../../../../accounts/service/src/control-operations.ts";
import { handleAuthenticatedControlRoute } from "../../../../accounts/service/src/control-routes.ts";
import { InMemoryAccountsStore } from "../../../../accounts/service/src/store.ts";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import { WorkspacesService } from "../../../../core/domains/workspaces/mod.ts";

const subject = "tsub_shared_owner";
const target = "tsub_shared_target";
const createdAt = "2026-10-01T00:00:00.000Z";

function fixture() {
  const accounts = new InMemoryAccountsStore();
  accounts.saveAccount({ subject, createdAt: 1, updatedAt: 1 });
  accounts.saveAccount({ subject: target, createdAt: 1, updatedAt: 1 });
  const control = new InMemoryOpenTofuControlStore();
  let id = 0;
  let ownerRepairs = 0;
  let defaultProjectRepairs = 0;
  const repairOwner = control.repairWorkspaceOwnerMember.bind(control);
  control.repairWorkspaceOwnerMember = async (input) => {
    ownerRepairs += 1;
    return await repairOwner(input);
  };
  const service = new WorkspacesService({
    store: control,
    newId: (prefix) => `${prefix}_shared_route_${++id}`,
    now: () => new Date("2026-10-15T00:00:00.000Z"),
    ensureDefaultProject: async () => { defaultProjectRepairs += 1; },
  });
  const facade = {
    workspaces: {
      ensurePersonalWorkspace: service.ensurePersonalWorkspace.bind(service),
      ensurePersonalWorkspaceForSharedAccount: service.ensurePersonalWorkspaceForSharedAccount.bind(service),
      listWorkspaces: service.listWorkspaces.bind(service),
      listWorkspacesByOwner: service.listWorkspacesByOwner.bind(service),
      listWorkspacesForAccount: service.listWorkspacesForAccount.bind(service),
      listWorkspacesForAccountPage: service.listWorkspacesForAccountPage.bind(service),
      getWorkspaceForAccount: service.getWorkspaceForAccount.bind(service),
      getWorkspace: service.getWorkspace.bind(service),
      captureManagementAuthority: service.captureManagementAuthority.bind(service),
      createWorkspace: service.createWorkspace.bind(service),
      createWorkspaceForSharedAccount: service.createWorkspaceForSharedAccount.bind(service),
      updateWorkspace: service.updateWorkspace.bind(service),
      updateWorkspaceForAccount: service.updateWorkspaceForAccount.bind(service),
      deleteWorkspaceForAccount: service.deleteWorkspaceForAccount.bind(service),
    },
    members: {
      getMember: service.getWorkspaceMember.bind(service),
      listMembers: service.listWorkspaceMembers.bind(service),
      upsertMember: async (input: Parameters<ControlPlaneOperations["members"]["upsertMember"]>[0]) =>
        await service.upsertWorkspaceMember({ ...input, actorAccountId: input.actor.actorAccountId }),
    },
    activity: {
      list: async (workspaceId: string, limit?: number) => await control.listActivityEvents(workspaceId, { limit }),
      listAcrossWorkspaces: async (workspaceIds: readonly string[], limit?: number) => await control.listActivityEventsForWorkspaces(workspaceIds, { limit }),
    },
  } satisfies Pick<ControlPlaneOperations, "workspaces" | "members" | "activity">;
  const operations = facade as ControlPlaneOperations;
  return {
    accounts, control, service, operations,
    repairs: () => ({ ownerRepairs, defaultProjectRepairs }),
  };
}

type Fixture = ReturnType<typeof fixture>;

async function seedWorkspace(f: Fixture, owner?: Partial<WorkspaceMember>) {
  const workspace: Workspace = {
    id: "ws_shared_route",
    handle: "shared-route",
    displayName: "Shared route",
    type: "organization",
    ownerUserId: subject,
    createdAt,
    updatedAt: createdAt,
  };
  await f.control.putWorkspace(workspace);
  if (owner !== undefined) await seedMember(f, workspace.id, subject, owner);
  return workspace;
}

async function seedMember(f: Fixture, workspaceId: string, accountId: string, patch: Partial<WorkspaceMember> = {}) {
  const member: WorkspaceMember = {
    id: `wsm_${accountId}`,
    workspaceId,
    accountId,
    roles: ["owner"],
    status: "active",
    createdAt,
    updatedAt: createdAt,
    ...patch,
  };
  await f.control.putWorkspaceMember(member);
  return member;
}

async function changeActor(f: Fixture, workspaceId: string, patch: Partial<WorkspaceMember>) {
  const current = await f.control.getWorkspaceMember(workspaceId, subject);
  if (!current) throw new Error("fixture actor is missing");
  const changed = { ...current, ...patch, updatedAt: "2026-10-15T00:00:01.000Z" };
  await f.control.putWorkspaceMember(changed);
  return changed;
}

async function request(f: Fixture, method: string, path: string, body?: Record<string, unknown>, workspaceMutationsFrozen = false) {
  const url = new URL(`https://accounts.example.test/api/v1/${path}`);
  const response = await handleAuthenticatedControlRoute({
    request: new Request(url, {
      method,
      ...(body === undefined ? {} : {
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    }),
    url,
    store: f.accounts,
    operations: f.operations,
    subject,
    requireCurrentMembership: true,
    workspaceMutationsFrozen,
  });
  if (!response) throw new Error("Workspace route was not dispatched");
  return response;
}

function latch() {
  let entered!: () => void;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  return { ready, held, entered, release };
}

test("trusted shared POST creates one canonical Workspace and owner, then replays without owner repair", async () => {
  const f = fixture();
  const body = {
    handle: "shared-create", displayName: "Shared create", type: "organization",
    ownerUserId: target, requireCurrentMembership: false,
  };
  const first = await request(f, "POST", "workspaces", body);
  expect(first.status).toBe(201);
  const workspace = (await first.json()).workspace as Workspace;
  expect(workspace.ownerUserId).toBe(subject);
  const owner = await f.control.getWorkspaceMember(workspace.id, subject);
  expect(owner).toMatchObject({ workspaceId: workspace.id, accountId: subject, roles: ["owner"], status: "active" });
  const replay = await request(f, "POST", "workspaces", body);
  expect(replay.status).toBe(201);
  expect((await replay.json()).workspace).toEqual(workspace);
  expect(await f.control.listWorkspaces()).toEqual([workspace]);
  expect(await f.control.listWorkspaceMembers(workspace.id)).toEqual([owner!]);
  expect(f.repairs().ownerRepairs).toBe(0);
});

test("Workspace creation and membership writes return the standard 409 envelope when frozen", async () => {
  const f = fixture();
  const create = await request(f, "POST", "workspaces", {
    handle: "frozen-create", displayName: "Frozen create", type: "organization",
  }, true);
  expect(create.status).toBe(409);
  expect(await create.json()).toMatchObject({ error: { code: "workspace_frozen", requestId: expect.any(String) } });
  expect(await f.control.listWorkspaces()).toEqual([]);

  const workspace = await seedWorkspace(f);
  const owner = await seedMember(f, workspace.id, subject);
  const add = await request(f, "POST", `workspaces/${workspace.id}/members`, { accountId: target, role: "member" }, true);
  expect(add.status).toBe(409);
  expect(await add.json()).toMatchObject({ error: { code: "workspace_frozen" } });
  expect(await f.control.listWorkspaceMembers(workspace.id)).toEqual([owner]);

  const remove = await request(f, "DELETE", `workspaces/${workspace.id}/members/${target}`, undefined, true);
  expect(remove.status).toBe(409);
  expect(await remove.json()).toMatchObject({ error: { code: "workspace_frozen" } });
  expect(await f.control.listWorkspaceMembers(workspace.id)).toEqual([owner]);
});

test("default-frozen Workspace inventory bootstraps only the owner's personal singleton", async () => {
  const f = fixture();
  let ensured = 0;
  (f.operations.workspaces as ControlPlaneOperations["workspaces"]).ensurePersonalWorkspace = async (owner, handle) => {
    ensured += 1;
    return await f.service.ensurePersonalWorkspace(owner, handle);
  };
  const url = new URL("https://accounts.example.test/api/v1/workspaces");
  const response = await handleAuthenticatedControlRoute({
    request: new Request(url),
    url,
    store: f.accounts,
    operations: f.operations,
    subject,
  });
  expect(response?.status).toBe(200);
  expect(ensured).toBe(1);
  expect((await f.control.listWorkspaces())).toMatchObject([{ type: "personal", ownerUserId: subject }]);
});

test("default-frozen personal POST uses strict owner-bound singleton and rejects owner hints", async () => {
  const f = fixture();
  const call = async (body: Record<string, unknown>) => {
    const url = new URL("https://accounts.example.test/api/v1/workspaces");
    return await handleAuthenticatedControlRoute({
      request: new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      url, store: f.accounts, operations: f.operations, subject, requireCurrentMembership: true,
    });
  };
  const first = await call({ handle: "first-personal", type: "personal" });
  expect(first?.status).toBe(201);
  const personal = (await first?.json()).workspace as Workspace;
  expect(personal).toMatchObject({ ownerUserId: subject, type: "personal" });
  expect((await call({ handle: "another-handle" }))?.status).toBe(201);
  expect(await f.control.listWorkspaces()).toEqual([personal]);
  expect(await f.control.getWorkspaceMember(personal.id, subject)).toMatchObject({ status: "active", roles: ["owner"] });
  for (const key of ["ownerUserId", "accountId", "workspaceId", "requireCurrentMembership"]) {
    const response = await call({ handle: "injected", type: "personal", [key]: target });
    expect(response?.status).toBe(400);
  }
  const organization = await call({ handle: "blocked-team", type: "organization" });
  expect(organization?.status).toBe(409);
  expect(await organization?.json()).toMatchObject({ error: { code: "workspace_frozen" } });
  expect(await f.control.listWorkspaces()).toEqual([personal]);
});

for (const [label, type] of [
  ["omitted type defaults to personal", undefined],
  ["explicit personal type", "personal"],
] as const) {
  test(`shared POST rejects ${label} before creation and preserves the canonical personal singleton`, async () => {
    const f = fixture();
    const body = {
      handle: "second-personal", displayName: "Second personal",
      ...(type === undefined ? {} : { type }),
      ownerUserId: target, requireCurrentMembership: false,
    };
    const emptyResponse = await request(f, "POST", "workspaces", body);
    expect(emptyResponse.status).toBe(400);
    expect(await emptyResponse.json()).toMatchObject({ error: { code: "invalid_argument" } });
    expect(await f.control.listWorkspaces()).toEqual([]);
    expect(f.repairs()).toEqual({ ownerRepairs: 0, defaultProjectRepairs: 0 });

    const personal = await f.service.ensurePersonalWorkspaceForSharedAccount(subject, "canonical-personal");
    const roster = await f.control.listWorkspaceMembers(personal.id);
    const repairs = f.repairs();
    const response = await request(f, "POST", "workspaces", body);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_argument" } });
    expect(await f.control.listWorkspaces()).toEqual([personal]);
    expect(await f.control.listWorkspaceMembers(personal.id)).toEqual(roster);
    expect(f.repairs()).toEqual(repairs);
  });
}

for (const [label, owner] of [
  ["suspended", { status: "suspended" }],
  ["demoted admin", { roles: ["admin"] }],
  ["demoted viewer", { roles: ["viewer"] }],
  ["missing", undefined],
] satisfies readonly (readonly [string, Partial<WorkspaceMember> | undefined])[]) {
  test(`shared POST same DTO refuses a ${label} namespace owner without repairing any row`, async () => {
    const f = fixture();
    const workspace = await seedWorkspace(f, owner);
    const roster = await f.control.listWorkspaceMembers(workspace.id);
    const response = await request(f, "POST", "workspaces", {
      handle: workspace.handle, displayName: workspace.displayName, type: workspace.type,
      requireCurrentMembership: false,
    });
    expect(response.status).toBe(403);
    expect(await f.control.listWorkspaces()).toEqual([workspace]);
    expect(await f.control.listWorkspaceMembers(workspace.id)).toEqual(roster);
    expect(f.repairs()).toEqual({ ownerRepairs: 0, defaultProjectRepairs: 0 });
  });
}

test("shared POST refuses a missing strict creation capability before calling the legacy creator", async () => {
  const f = fixture();
  let legacyCalls = 0;
  f.operations.workspaces.createWorkspaceForSharedAccount = undefined;
  f.operations.workspaces.createWorkspace = async () => { legacyCalls += 1; throw new Error("legacy creator must not be called"); };
  const response = await request(f, "POST", "workspaces", {
    handle: "strict-unavailable", displayName: "Unavailable", type: "organization",
    requireCurrentMembership: false,
  });
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ error: { code: "capability_unavailable" } });
  expect(legacyCalls).toBe(0);
  expect(await f.control.listWorkspaces()).toEqual([]);
});

for (const [label, owner] of [
  ["missing", undefined],
  ["suspended", { status: "suspended" }],
] satisfies readonly (readonly [string, Partial<WorkspaceMember> | undefined])[]) {
  test(`shared PATCH refuses a ${label} namespace owner even when the body disables strict membership`, async () => {
    const f = fixture();
    const workspace = await seedWorkspace(f, owner);
    const roster = await f.control.listWorkspaceMembers(workspace.id);
    const response = await request(f, "PATCH", `workspaces/${workspace.id}`, {
      displayName: "Unauthorized change", requireCurrentMembership: false,
    });
    expect(response.status).toBe(403);
    expect(await f.control.getWorkspace(workspace.id)).toEqual(workspace);
    expect(await f.control.listWorkspaceMembers(workspace.id)).toEqual(roster);
    expect(f.repairs().ownerRepairs).toBe(0);
  });
}

test("shared DELETE requires the real owner role and retains a Workspace whose namespace owner is now admin", async () => {
  const f = fixture();
  const workspace = await seedWorkspace(f, { roles: ["admin"] });
  const owner = await f.control.getWorkspaceMember(workspace.id, subject);
  const response = await request(f, "DELETE", `workspaces/${workspace.id}`);
  expect(response.status).toBe(403);
  expect(await f.control.getWorkspace(workspace.id)).toEqual(workspace);
  expect(await f.control.getWorkspaceMember(workspace.id, subject)).toEqual(owner);
  expect(f.repairs().ownerRepairs).toBe(0);
});

test("shared member routes let an actual admin add members without repairing namespace ownership or granting owner powers", async () => {
  const f = fixture();
  const workspace = await seedWorkspace(f, { roles: ["admin"] });
  const actor = await f.control.getWorkspaceMember(workspace.id, subject);
  const added = await request(f, "POST", `workspaces/${workspace.id}/members`, {
    accountId: target, role: "member", requireCurrentMembership: false,
  });
  expect(added.status).toBe(201);
  const member = await f.control.getWorkspaceMember(workspace.id, target);
  expect(member).toMatchObject({ accountId: target, roles: ["member"], status: "active" });
  for (const [method, path, body] of [
    ["POST", `workspaces/${workspace.id}/members`, { accountId: target, role: "owner", requireCurrentMembership: false }],
    ["PATCH", `workspaces/${workspace.id}/members/${target}`, { role: "viewer", requireCurrentMembership: false }],
    ["DELETE", `workspaces/${workspace.id}/members/${target}`, undefined],
  ] as const) {
    expect((await request(f, method, path, body)).status).toBe(403);
  }
  expect(await f.control.getWorkspaceMember(workspace.id, target)).toEqual(member);
  expect(await f.control.getWorkspaceMember(workspace.id, subject)).toEqual(actor);
  expect(f.repairs().ownerRepairs).toBe(0);
});

for (const [label, owner] of [
  ["missing", undefined],
  ["suspended", { status: "suspended" }],
] satisfies readonly (readonly [string, Partial<WorkspaceMember> | undefined])[]) {
  test(`shared member POST never synthesizes a ${label} namespace owner from ownerUserId`, async () => {
    const f = fixture();
    const workspace = await seedWorkspace(f, owner);
    const roster = await f.control.listWorkspaceMembers(workspace.id);
    const response = await request(f, "POST", `workspaces/${workspace.id}/members`, {
      accountId: target, role: "member", requireCurrentMembership: false,
    });
    expect(response.status).toBe(403);
    expect(await f.control.listWorkspaceMembers(workspace.id)).toEqual(roster);
    expect(f.repairs().ownerRepairs).toBe(0);
  });
}

for (const [label, patch] of [
  ["revoked", { status: "suspended" }],
  ["demoted", { roles: ["viewer"] }],
] satisfies readonly (readonly [string, Partial<WorkspaceMember>])[]) {
  test(`shared PATCH retains its original actor snapshot and refuses an owner ${label} during awaited preparation`, async () => {
    const f = fixture();
    const workspace = await seedWorkspace(f, {});
    const actor = await f.control.getWorkspaceMember(workspace.id, subject);
    const write = f.control.replaceWorkspaceForAccount.bind(f.control);
    const gate = latch();
    let captured: Parameters<typeof write>[0] | undefined;
    f.control.replaceWorkspaceForAccount = async (input) => {
      captured = input;
      gate.entered();
      await gate.held;
      return await write(input);
    };
    const responsePending = request(f, "PATCH", `workspaces/${workspace.id}`, {
      displayName: "Must not persist", requireCurrentMembership: false,
    });
    await gate.ready;
    const changed = await changeActor(f, workspace.id, patch);
    gate.release();
    const response = await responsePending;
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "failed_precondition" } });
    expect(captured).toMatchObject({ actorAccountId: subject, expectedActor: actor, requireCurrentMembership: true });
    expect(await f.control.getWorkspace(workspace.id)).toEqual(workspace);
    expect(await f.control.getWorkspaceMember(workspace.id, subject)).toEqual(changed);
    expect(f.repairs().ownerRepairs).toBe(0);
  });
}

for (const [label, patch] of [
  ["revoked", { status: "suspended" }],
  ["demoted to admin", { roles: ["admin"] }],
] satisfies readonly (readonly [string, Partial<WorkspaceMember>])[]) {
  test(`shared DELETE retains its original actor snapshot and refuses an owner ${label} during awaited preparation`, async () => {
    const f = fixture();
    const workspace = await seedWorkspace(f, {});
    const actor = await f.control.getWorkspaceMember(workspace.id, subject);
    const write = f.control.deleteWorkspaceExclusive.bind(f.control);
    const gate = latch();
    let captured: Parameters<typeof write>[0] | undefined;
    f.control.deleteWorkspaceExclusive = async (input) => {
      captured = input;
      gate.entered();
      await gate.held;
      return await write(input);
    };
    const responsePending = request(f, "DELETE", `workspaces/${workspace.id}`);
    await gate.ready;
    const changed = await changeActor(f, workspace.id, patch);
    gate.release();
    const response = await responsePending;
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "failed_precondition" } });
    expect(captured).toMatchObject({ expectedActor: actor, requireCurrentMembership: true });
    expect(await f.control.getWorkspace(workspace.id)).toEqual(workspace);
    expect(await f.control.getWorkspaceMember(workspace.id, subject)).toEqual(changed);
    expect(f.repairs().ownerRepairs).toBe(0);
  });
}

for (const [method, leaf, body, actorPatch] of [
  ["POST", "", { accountId: target, role: "member", requireCurrentMembership: false }, { status: "suspended" }],
  ["PATCH", `/${target}`, { role: "viewer", requireCurrentMembership: false }, { roles: ["admin"] }],
  ["DELETE", `/${target}`, undefined, { roles: ["admin"] }],
] satisfies readonly (readonly [string, string, Record<string, unknown> | undefined, Partial<WorkspaceMember>])[]) {
  test(`shared member ${method} refuses actor authority lost after authorization and before its atomic write`, async () => {
    const f = fixture();
    const workspace = await seedWorkspace(f, {});
    const actor = await f.control.getWorkspaceMember(workspace.id, subject);
    const targetBefore = method === "POST" ? undefined : await seedMember(f, workspace.id, target, { roles: ["member"] });
    const write = f.control.mutateWorkspaceMember.bind(f.control);
    const gate = latch();
    let captured: Parameters<typeof write>[0] | undefined;
    f.control.mutateWorkspaceMember = async (input) => {
      captured = input;
      gate.entered();
      await gate.held;
      return await write(input);
    };
    const responsePending = request(f, method, `workspaces/${workspace.id}/members${leaf}`, body);
    await gate.ready;
    const changed = await changeActor(f, workspace.id, actorPatch);
    gate.release();
    const response = await responsePending;
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "failed_precondition" } });
    expect(captured?.expectedActor).toEqual(actor);
    if (method !== "POST") expect(captured?.requiredActorRole).toBe("owner");
    expect(await f.control.getWorkspace(workspace.id)).toEqual(workspace);
    expect(await f.control.getWorkspaceMember(workspace.id, target)).toEqual(targetBefore);
    expect(await f.control.getWorkspaceMember(workspace.id, subject)).toEqual(changed);
    expect(f.repairs().ownerRepairs).toBe(0);
  });
}
