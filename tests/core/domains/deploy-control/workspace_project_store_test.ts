import { afterAll, expect, test } from "bun:test";

import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import { CloudflareD1OpenTofuControlStore } from "../../../../worker/src/d1_opentofu_store.ts";
import { ProjectsService } from "../../../../core/domains/projects/mod.ts";
import { WorkspacesService } from "../../../../core/domains/workspaces/mod.ts";
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

afterAll(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

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
