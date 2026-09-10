import { afterEach, expect, test } from "bun:test";

import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import { CloudflareD1OpenTofuControlStore } from "../../../../worker/src/d1_opentofu_store.ts";
import { ProjectsService } from "../../../../core/domains/projects/mod.ts";
import { WorkspacesService } from "../../../../core/domains/workspaces/mod.ts";
import { InMemoryOpenTofuControlStore, WorkspaceManagementAdmissionConflictError } from "../../../../core/domains/deploy-control/store.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

const clients: PGliteSqlClient[] = [];

async function expectCompleteWorkspacePages(
  service: WorkspacesService,
): Promise<void> {
  for (const handle of ["paging-two", "paging-three"]) {
    await service.createWorkspace({
      handle,
      displayName: handle,
      type: "organization",
      ownerUserId: "account_owner",
    });
  }
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await service.listWorkspacesPage({
      limit: 2,
      ...(cursor ? { cursor } : {}),
    });
    expect(page.items.length).toBeLessThanOrEqual(2);
    ids.push(...page.items.map((workspace) => workspace.id));
    cursor = page.nextCursor;
  } while (cursor);
  expect(ids).toHaveLength(3);
  expect(new Set(ids).size).toBe(3);
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

test("Project creation atomically checks Workspace authority and slug uniqueness on every store", async () => {
  const client = await PGliteSqlClient.create();
  clients.push(client);
  for (const [label, store] of [
    ["memory", new InMemoryOpenTofuControlStore()],
    ["postgres", new SqlOpenTofuControlStore({ client })],
    ["d1", new CloudflareD1OpenTofuControlStore(new SqliteFakeD1())],
  ] as const) {
    const now = "2026-09-08T00:00:00.000Z";
    const project = { id: "project_admission", workspaceId: "workspace_admission", name: "Application", slug: "application", projectJson: { label: "retained" }, createdAt: now, updatedAt: now };
    const authority = { workspaceId: project.workspaceId, managementState: "active" as const, managementEpoch: 1 };
    await store.putWorkspace({ id: project.workspaceId, handle: "project-admission", displayName: "Project admission", type: "personal", ownerUserId: "owner_admission", createdAt: now, updatedAt: now });
    await expect(store.createProjectRecord({ project, expectedWorkspaceManagementAuthority: { ...authority, managementEpoch: 2 } }), label)
      .rejects.toBeInstanceOf(WorkspaceManagementAdmissionConflictError);
    const outcomes = await Promise.all([
      store.createProjectRecord({ project, expectedWorkspaceManagementAuthority: authority }),
      store.createProjectRecord({ project: { ...project, id: "project_competing" }, expectedWorkspaceManagementAuthority: authority }),
    ]);
    expect(outcomes.map((result) => result.status).sort(), label).toEqual(["conflict", "created"]);
    const created = outcomes.find((result) => result.status === "created");
    if (!created || created.status !== "created") throw new Error("one Project must win creation");
    expect(await store.listProjectsByWorkspace(project.workspaceId), label).toEqual([created.project]);
    await store.beginWorkspaceDraining(project.workspaceId, authority);
    expect(await store.createProjectRecord({ project: created.project, expectedWorkspaceManagementAuthority: authority }), label)
      .toEqual({ status: "replayed", project: created.project });
    expect(await store.createProjectRecord({ project: { ...created.project, projectJson: { label: "overwrite" } } }), label)
      .toEqual({ status: "conflict" });
    await expect(store.createProjectRecord({ project: { ...project, id: "project_after_drain", slug: "after-drain" } }), label)
      .rejects.toBeInstanceOf(WorkspaceManagementAdmissionConflictError);
    await expect(store.createProjectRecord({ project: { ...project, id: "project_missing_workspace", workspaceId: "missing" } }), label)
      .rejects.toBeInstanceOf(WorkspaceManagementAdmissionConflictError);
    expect(await store.listProjectsByWorkspace(project.workspaceId), label).toEqual([created.project]);
  }
}, 30_000);

test("Postgres persists Project and WorkspaceMember in the canonical control ledger", async () => {
  const client = await PGliteSqlClient.create();
  clients.push(client);
  const store = new SqlOpenTofuControlStore({ client });
  let counter = 0;
  const newId = (prefix: string) => `${prefix}_sql_${++counter}`;
  const now = () => new Date("2026-07-13T00:00:00.000Z");
  const workspaces = new WorkspacesService({ store, newId, now });
  const projects = new ProjectsService({ store, newId, now });

  const workspace = await workspaces.createWorkspace({
    handle: "sql-team",
    displayName: "SQL Team",
    type: "organization",
    ownerUserId: "account_owner",
  });
  const defaultProject = await projects.ensureDefaultProject(workspace.id);
  const appProject = await projects.createProject({
    workspaceId: workspace.id,
    name: "Application",
    slug: "application",
  });
  await workspaces.upsertWorkspaceMember({
    workspaceId: workspace.id,
    accountId: "account_member",
    roles: ["member"],
    actorAccountId: "account_owner",
  });

  expect((await store.getProject(defaultProject.id))?.workspaceId).toBe(
    workspace.id,
  );
  expect(await store.getProjectBySlug(workspace.id, "application")).toEqual(
    appProject,
  );
  expect(await store.listProjectsByWorkspace(workspace.id)).toEqual([
    defaultProject,
    appProject,
  ]);
  expect(await store.listWorkspaceMembers(workspace.id)).toEqual([
    expect.objectContaining({
      accountId: "account_owner",
      roles: ["owner"],
      status: "active",
    }),
    expect.objectContaining({
      accountId: "account_member",
      roles: ["member"],
      status: "active",
    }),
  ]);
  expect(await store.listWorkspaceMembersByAccount("account_member")).toEqual([
    expect.objectContaining({ workspaceId: workspace.id }),
  ]);
  await expectCompleteWorkspacePages(workspaces);
});

test("D1 persists Project and WorkspaceMember in the canonical control ledger", async () => {
  const store = new CloudflareD1OpenTofuControlStore(new SqliteFakeD1());
  let counter = 0;
  const newId = (prefix: string) => `${prefix}_d1_${++counter}`;
  const now = () => new Date("2026-07-13T00:00:00.000Z");
  const workspaces = new WorkspacesService({ store, newId, now });
  const projects = new ProjectsService({ store, newId, now });

  const workspace = await workspaces.createWorkspace({
    handle: "d1-team",
    displayName: "D1 Team",
    type: "organization",
    ownerUserId: "account_owner",
  });
  const project = await projects.createProject({
    workspaceId: workspace.id,
    name: "Application",
    slug: "application",
  });
  await workspaces.upsertWorkspaceMember({
    workspaceId: workspace.id,
    accountId: "account_member",
    roles: ["viewer"],
    actorAccountId: "account_owner",
  });

  expect(await store.getProject(project.id)).toEqual(project);
  expect(await store.getProjectBySlug(workspace.id, "application")).toEqual(
    project,
  );
  expect(await store.listWorkspaceMembersByAccount("account_member")).toEqual([
    expect.objectContaining({
      workspaceId: workspace.id,
      roles: ["viewer"],
      status: "active",
    }),
  ]);
  await expectCompleteWorkspacePages(workspaces);
});
