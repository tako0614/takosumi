import { expect, test } from "bun:test";
import type { ControlPlaneOperations } from "../../../../accounts/service/src/control-operations.ts";
import { isControlRoutePath } from "../../../../accounts/service/src/control-routes.ts";
import { handleProjects } from "../../../../accounts/service/src/control/projects.ts";
import { handleCapsules } from "../../../../accounts/service/src/control/capsules.ts";
import {
  controllerErrorResponse,
  canAccessWorkspace,
  publicDependency,
  publicOutputShare,
  type ControlDispatchContext,
} from "../../../../accounts/service/src/control/shared.ts";
import { handleWorkspaces } from "../../../../accounts/service/src/control/workspaces.ts";
import { handleDashboard } from "../../../../accounts/service/src/control/dashboard.ts";
import { InMemoryAccountsStore } from "../../../../accounts/service/src/store.ts";
import { encodeCursor } from "../../../../contract/pagination.ts";

const workspace = {
  id: "ws_owner",
  handle: "owner",
  displayName: "Owner",
  type: "personal" as const,
  ownerUserId: "tsub_owner",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

test("account-plane relationship views expose only Workspace and Capsule ids", () => {
  const dependency = publicDependency({
    id: "dep_1",
    workspaceId: "ws_owner",
    producerCapsuleId: "cap_producer",
    consumerCapsuleId: "cap_consumer",
    mode: "variable_injection",
    outputs: {},
    visibility: "workspace",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const share = publicOutputShare({
    id: "share_1",
    fromWorkspaceId: "ws_owner",
    toWorkspaceId: "ws_consumer",
    producerCapsuleId: "cap_producer",
    outputs: [],
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
  });

  expect(dependency).toMatchObject({
    workspaceId: "ws_owner",
    producerCapsuleId: "cap_producer",
    consumerCapsuleId: "cap_consumer",
  });
  expect(share).toMatchObject({
    fromWorkspaceId: "ws_owner",
    toWorkspaceId: "ws_consumer",
    producerCapsuleId: "cap_producer",
  });
  expect(JSON.stringify({ dependency, share })).not.toMatch(
    /"(?:spaceId|installationId)"/u,
  );
});

test("account-plane control errors preserve structured reason details", async () => {
  const error = Object.assign(new Error("Source synchronization is required"), {
    code: "failed_precondition",
    details: { reason: "source_sync_required" },
  });

  const response = controllerErrorResponse(error);

  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({
    error: {
      code: "failed_precondition",
      message: "Source synchronization is required",
      details: { reason: "source_sync_required" },
    },
  });
});

test("account-plane hostname errors redact owner details by structured reason", async () => {
  const error = Object.assign(
    new Error(
      "private.example.test is already claimed by Capsule private-cap in Workspace private-ws",
    ),
    {
      code: "failed_precondition",
      details: { reason: "app_hostname_unavailable" },
    },
  );

  const response = controllerErrorResponse(error);
  const body = await response.json();

  expect(body).toMatchObject({
    error: {
      code: "failed_precondition",
      message: "app_hostname_unavailable: already exists",
      details: { reason: "app_hostname_unavailable" },
    },
  });
  expect(JSON.stringify(body)).not.toContain("private.example.test");
  expect(JSON.stringify(body)).not.toContain("private-cap");
  expect(JSON.stringify(body)).not.toContain("private-ws");
});

function operationsFixture() {
  const projects: Array<{
    id: string;
    workspaceId: string;
    name: string;
    slug: string;
    projectJson?: Readonly<Record<string, unknown>>;
    createdAt: string;
    updatedAt: string;
  }> = [];
  const capsuleCreates: Record<string, unknown>[] = [];
  const workspacePageCalls: Record<string, unknown>[] = [];
  let providerBindingSet:
    | {
        readonly id: string;
        readonly workspaceId: string;
        readonly capsuleId: string;
        readonly environment: string;
        readonly bindings: readonly {
          readonly provider: string;
          readonly connectionId: string;
        }[];
        readonly createdAt: string;
        readonly updatedAt: string;
      }
    | undefined;
  const operations = {
    workspaces: {
      getWorkspace: async () => workspace,
      getWorkspaceForAccount: async (
        _accountId: string,
        workspaceId: string,
      ) => (workspaceId === workspace.id ? workspace : undefined),
      listWorkspacesForAccount: async () => [workspace],
      listWorkspacesForAccountPage: async (
        accountId: string,
        params: Record<string, unknown>,
      ) => {
        workspacePageCalls.push({ accountId, ...params });
        return {
          items: [workspace],
          ...(params.includeTotal === false ? {} : { total: 1 }),
        };
      },
    },
    members: {
      listMembers: async () => [
        {
          id: "wsm_owner",
          workspaceId: workspace.id,
          accountId: "tsub_owner",
          roles: ["owner"],
          status: "active",
          createdAt: workspace.createdAt,
          updatedAt: workspace.updatedAt,
        },
      ],
    },
    projects: {
      createProject: async (input: {
        workspaceId: string;
        name: string;
        slug: string;
        projectJson?: Readonly<Record<string, unknown>>;
      }) => {
        const project = {
          id: `prj_${projects.length + 1}`,
          ...input,
          createdAt: workspace.createdAt,
          updatedAt: workspace.updatedAt,
        };
        projects.push(project);
        return project;
      },
      listProjects: async () => projects,
      getProject: async (id: string) => {
        const project = projects.find((candidate) => candidate.id === id);
        if (!project) throw new Error("project not found");
        return project;
      },
    },
    getSource: async () => ({
      source: {
        id: "src_git",
        workspaceId: workspace.id,
        kind: "git",
        git: { url: "https://example.test/module.git", ref: "main" },
        createdAt: workspace.createdAt,
        updatedAt: workspace.updatedAt,
      },
    }),
    listSourceSnapshots: async () => ({ snapshots: [] }),
    capsules: {
      getCapsule: async () => ({
        id: "cap_1",
        workspaceId: workspace.id,
        projectId: "prj_default_ws_owner",
        name: "service",
        slug: "service",
        sourceId: "src_git",
        installConfigId: "cfg_default",
        environment: "production",
        currentStateGeneration: 0,
        status: "active",
        createdAt: workspace.createdAt,
        updatedAt: workspace.updatedAt,
      }),
      getInstallConfig: async () => ({
        id: "cfg_default",
        workspaceId: workspace.id,
        name: "default",
        sourceKind: "generic_capsule",
        installType: "opentofu_module",
        variableMapping: {},
        outputAllowlist: {},
        policy: {},
        createdAt: workspace.createdAt,
        updatedAt: workspace.updatedAt,
      }),
      createCapsule: async (input: Record<string, unknown>) => {
        capsuleCreates.push(input);
        return {
          id: `cap_${capsuleCreates.length}`,
          ...input,
          projectId: input.projectId ?? "prj_default_ws_owner",
          slug: input.name,
          currentStateGeneration: 0,
          status: "pending",
          createdAt: workspace.createdAt,
          updatedAt: workspace.updatedAt,
        };
      },
      getProviderBindingSetByCapsule: async () => providerBindingSet,
      putProviderBindingSet: async (
        bindingSet: NonNullable<typeof providerBindingSet>,
      ) => {
        providerBindingSet = bindingSet;
        return bindingSet;
      },
    },
    connections: {
      listProviderConnections: async () => [
        {
          id: "conn_1",
          workspaceId: workspace.id,
          provider: "aws",
          providerSource: "registry.opentofu.org/hashicorp/aws",
          scope: "workspace",
          status: "verified",
          materialization: "secret",
          envNames: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],
          createdAt: workspace.createdAt,
          updatedAt: workspace.updatedAt,
        },
      ],
    },
  } as unknown as ControlPlaneOperations;
  return { operations, projects, capsuleCreates, workspacePageCalls };
}

function context(
  operations: ControlPlaneOperations,
  request: Request,
): ControlDispatchContext {
  return {
    request,
    url: new URL(request.url),
    operations,
    store: new InMemoryAccountsStore(),
    session: { subject: "tsub_owner" },
  };
}

test("Project create/list/get routes are a facade over canonical operations", async () => {
  const fixture = operationsFixture();
  const createRequest = new Request(
    `https://app.example.test/api/v1/workspaces/${workspace.id}/projects`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Production",
        slug: "production",
        projectJson: { environment: "prod" },
      }),
    },
  );
  const created = await handleWorkspaces(
    context(fixture.operations, createRequest),
    ["workspaces", workspace.id, "projects"],
    "POST",
  );
  expect(created?.status).toBe(201);
  expect((await created?.json()).project).toMatchObject({
    id: "prj_1",
    workspaceId: workspace.id,
    slug: "production",
  });

  const listRequest = new Request(createRequest.url);
  const listed = await handleWorkspaces(
    context(fixture.operations, listRequest),
    ["workspaces", workspace.id, "projects"],
    "GET",
  );
  expect((await listed?.json()).projects).toHaveLength(1);

  const getRequest = new Request(
    "https://app.example.test/api/v1/projects/prj_1",
  );
  const fetched = await handleProjects(
    context(fixture.operations, getRequest),
    ["projects", "prj_1"],
    "GET",
  );
  expect((await fetched?.json()).project.name).toBe("Production");
});

test("Workspace list defaults to one bounded created-order page", async () => {
  const fixture = operationsFixture();
  const request = new Request("https://app.example.test/api/v1/workspaces");
  const response = await handleWorkspaces(
    context(fixture.operations, request),
    ["workspaces"],
    "GET",
  );

  expect(response?.status).toBe(200);
  expect(await response?.json()).toEqual({
    workspaces: [workspace],
    returned: 1,
    limit: 100,
    truncated: false,
  });
  expect(fixture.workspacePageCalls).toEqual([
    {
      accountId: "tsub_owner",
      includeArchived: false,
      includeTotal: false,
      order: "created_asc",
      limit: 100,
    },
  ]);
});

test("Workspace list page is bounded and pins an authorized selected Workspace", async () => {
  const fixture = operationsFixture();
  const selected = {
    ...workspace,
    id: "ws_selected",
    handle: "selected",
    displayName: "Selected",
    updatedAt: "2025-01-01T00:00:00.000Z",
  };
  const first = {
    ...workspace,
    id: "ws_recent",
    handle: "recent",
    displayName: "Recent",
    updatedAt: "2026-07-20T00:00:00.000Z",
  };
  const operations = {
    ...fixture.operations,
    workspaces: {
      ...fixture.operations.workspaces,
      listWorkspacesForAccountPage: async (
        accountId: string,
        params: Record<string, unknown>,
      ) => {
        fixture.workspacePageCalls.push({ accountId, ...params });
        return { items: [first], nextCursor: "next_cursor", total: 73 };
      },
      getWorkspaceForAccount: async (
        _accountId: string,
        workspaceId: string,
      ) => (workspaceId === selected.id ? selected : undefined),
    },
  } as ControlPlaneOperations;
  const request = new Request(
    "https://app.example.test/api/v1/workspaces?limit=50&order=updated_desc&selectedWorkspaceId=ws_selected&includeTotal=true",
  );
  const response = await handleWorkspaces(
    context(operations, request),
    ["workspaces"],
    "GET",
  );

  expect(response?.status).toBe(200);
  expect(await response?.json()).toEqual({
    workspaces: [selected, first],
    total: 73,
    returned: 2,
    limit: 50,
    truncated: true,
    nextCursor: "next_cursor",
    pinnedWorkspaceId: selected.id,
  });
  expect(fixture.workspacePageCalls).toEqual([
    {
      accountId: "tsub_owner",
      includeArchived: false,
      includeTotal: true,
      order: "updated_desc",
      limit: 50,
    },
  ]);
});

test("Workspace cursor pages do not repeat selected lookup or pinned row", async () => {
  const fixture = operationsFixture();
  let selectedLookups = 0;
  const cursor = encodeCursor({
    createdAt: "2026-01-01T00:00:00.000Z",
    id: "ws_cursor",
  });
  const operations = {
    ...fixture.operations,
    workspaces: {
      ...fixture.operations.workspaces,
      getWorkspaceForAccount: async () => {
        selectedLookups += 1;
        return workspace;
      },
    },
  } as ControlPlaneOperations;
  const request = new Request(
    `https://app.example.test/api/v1/workspaces?limit=50&order=updated_desc&cursor=${cursor}&selectedWorkspaceId=ws_test`,
  );
  const response = await handleWorkspaces(
    context(operations, request),
    ["workspaces"],
    "GET",
  );

  expect(response?.status).toBe(200);
  expect(await response?.json()).toEqual({
    workspaces: [workspace],
    returned: 1,
    limit: 50,
    truncated: false,
  });
  expect(selectedLookups).toBe(0);
  expect(fixture.workspacePageCalls).toEqual([
    {
      accountId: "tsub_owner",
      includeArchived: false,
      includeTotal: false,
      order: "updated_desc",
      limit: 50,
      cursor,
    },
  ]);
});

test("Workspace list page rejects malformed order before reading a page", async () => {
  const fixture = operationsFixture();
  const request = new Request(
    "https://app.example.test/api/v1/workspaces?limit=50&order=random",
  );
  const response = await handleWorkspaces(
    context(fixture.operations, request),
    ["workspaces"],
    "GET",
  );

  expect(response?.status).toBe(400);
  expect(fixture.workspacePageCalls).toEqual([]);
});

test("Dashboard Workspace projection pushes active latest-first limit into the store", async () => {
  const fixture = operationsFixture();
  const request = new Request(
    "https://app.example.test/api/v1/dashboard/bootstrap?includeWorkspaces=true&workspaceLimit=50",
  );
  const response = await handleDashboard(
    context(fixture.operations, request),
    ["dashboard", "bootstrap"],
    "GET",
  );

  expect(response?.status).toBe(200);
  const body = await response?.json();
  expect(body).toMatchObject({
    workspaces: [workspace],
    workspaceList: { returned: 1, limit: 50, truncated: false },
  });
  expect(fixture.workspacePageCalls).toEqual([
    {
      accountId: "tsub_owner",
      includeArchived: false,
      includeTotal: false,
      order: "updated_desc",
      limit: 50,
    },
  ]);
});

test("Dashboard notification projection batches authorized Workspace activity", async () => {
  const fixture = operationsFixture();
  const activityCalls: unknown[] = [];
  const capsuleBatchCalls: string[][] = [];
  const operations = {
    ...fixture.operations,
    capsules: {
      ...fixture.operations.capsules,
      getCapsulesByIds: async (ids: readonly string[]) => {
        capsuleBatchCalls.push([...ids]);
        return ids.map((id) => ({
          id,
          workspaceId: workspace.id,
          projectId: "prj_default_ws_owner",
          name: id === "cap_1" ? "api" : "worker",
          slug: id === "cap_1" ? "api" : "worker",
          sourceId: "src_git",
          installConfigId: `cfg_${id}`,
          environment: "production",
          currentStateGeneration: 0,
          status: "active" as const,
          createdAt: workspace.createdAt,
          updatedAt: workspace.updatedAt,
        }));
      },
    },
    activity: {
      list: async () => [],
      listAcrossWorkspaces: async (
        workspaceIds: readonly string[],
        limit?: number,
      ) => {
        activityCalls.push({ workspaceIds, limit });
        return [
          {
            id: "act_1",
            workspaceId: workspace.id,
            action: "run.failed",
            targetType: "run",
            targetId: "run_1",
            metadata: {
              capsuleId: "cap_1",
              errorCode: "runner_failed",
              secret: "must-not-project",
            },
            createdAt: "2026-07-20T00:00:00.000Z",
          },
          {
            id: "act_2",
            workspaceId: workspace.id,
            action: "capsule.auto_update_failed",
            targetType: "capsule",
            targetId: "cap_2",
            metadata: { errorCode: "runner_failed" },
            createdAt: "2026-07-20T00:00:01.000Z",
          },
        ];
      },
    },
  } as unknown as ControlPlaneOperations;
  const request = new Request(
    `https://app.example.test/api/v1/dashboard/bootstrap?includeWorkspaces=true&includeNotifications=true&workspaceId=${workspace.id}`,
  );
  const response = await handleDashboard(
    context(operations, request),
    ["dashboard", "bootstrap"],
    "GET",
  );

  expect(response?.status).toBe(200);
  const body = await response?.json();
  expect(body).toMatchObject({
    notifications: [
      {
        workspaceHandle: workspace.handle,
        event: {
          id: "act_1",
          metadata: {
            capsuleId: "cap_1",
            capsuleName: "api",
            errorCode: "runner_failed",
          },
        },
      },
      {
        workspaceHandle: workspace.handle,
        event: {
          id: "act_2",
          metadata: {
            capsuleName: "worker",
            errorCode: "runner_failed",
          },
        },
      },
    ],
  });
  expect(JSON.stringify(body)).not.toContain("must-not-project");
  expect(activityCalls).toEqual([{ workspaceIds: [workspace.id], limit: 60 }]);
  expect(capsuleBatchCalls).toEqual([["cap_1", "cap_2"]]);
});

test("Dashboard notifications survive optional Capsule-name lookup failure", async () => {
  const fixture = operationsFixture();
  const operations = {
    ...fixture.operations,
    capsules: {
      ...fixture.operations.capsules,
      getCapsulesByIds: async () => {
        throw new Error("Capsule projection unavailable");
      },
    },
    activity: {
      list: async () => [],
      listAcrossWorkspaces: async () => [
        {
          id: "act_1",
          workspaceId: workspace.id,
          action: "run.failed",
          targetType: "run",
          targetId: "run_1",
          metadata: { capsuleId: "cap_1", errorCode: "runner_failed" },
          createdAt: "2026-07-20T00:00:00.000Z",
        },
      ],
    },
  } as unknown as ControlPlaneOperations;
  const request = new Request(
    `https://app.example.test/api/v1/dashboard/bootstrap?includeNotifications=true&workspaceId=${workspace.id}`,
  );
  const response = await handleDashboard(
    context(operations, request),
    ["dashboard", "bootstrap"],
    "GET",
  );

  expect(response?.status).toBe(200);
  const body = await response?.json();
  expect(body.notifications).toHaveLength(1);
  expect(body.notifications[0].event).toMatchObject({
    id: "act_1",
    metadata: { capsuleId: "cap_1", errorCode: "runner_failed" },
  });
  expect(body.notifications[0].event.metadata.capsuleName).toBeUndefined();
});

test("Dashboard notifications keep fetched Activity when Capsule-name lookup times out", async () => {
  const fixture = operationsFixture();
  const operations = {
    ...fixture.operations,
    capsules: {
      ...fixture.operations.capsules,
      getCapsulesByIds: async () =>
        await new Promise<never>(() => {
          // Deliberately never resolves: the shared notification deadline must
          // return the already-fetched Activity without a service name.
        }),
    },
    activity: {
      list: async () => [],
      listAcrossWorkspaces: async () => [
        {
          id: "act_timeout",
          workspaceId: workspace.id,
          action: "run.failed",
          targetType: "run",
          targetId: "run_timeout",
          metadata: { capsuleId: "cap_slow", errorCode: "runner_failed" },
          createdAt: "2026-07-20T00:00:00.000Z",
        },
      ],
    },
  } as unknown as ControlPlaneOperations;
  const request = new Request(
    `https://app.example.test/api/v1/dashboard/bootstrap?includeNotifications=true&workspaceId=${workspace.id}`,
  );
  const startedAt = Date.now();
  const response = await handleDashboard(
    context(operations, request),
    ["dashboard", "bootstrap"],
    "GET",
  );

  expect(response?.status).toBe(200);
  const body = await response?.json();
  expect(body.notifications).toHaveLength(1);
  expect(body.notifications[0].event.id).toBe("act_timeout");
  expect(body.notifications[0].event.metadata.capsuleName).toBeUndefined();
  expect(Date.now() - startedAt).toBeLessThan(2_000);
});

test("Workspace authorization uses one exact membership lookup instead of scanning the roster", async () => {
  const fixture = operationsFixture();
  let exactLookups = 0;
  let rosterLists = 0;
  const operations = {
    ...fixture.operations,
    members: {
      getMember: async (workspaceId: string, accountId: string) => {
        exactLookups += 1;
        return {
          id: "wsm_member",
          workspaceId,
          accountId,
          roles: ["member"],
          status: "active",
          createdAt: workspace.createdAt,
          updatedAt: workspace.updatedAt,
        } as const;
      },
      listMembers: async () => {
        rosterLists += 1;
        return [];
      },
    },
  } as unknown as ControlPlaneOperations;

  expect(
    await canAccessWorkspace({
      operations,
      store: new InMemoryAccountsStore(),
      subject: "tsub_member",
      workspaceId: workspace.id,
      workspace,
    }),
  ).toBe(true);
  expect(exactLookups).toBe(1);
  expect(rosterLists).toBe(0);
});

test("Dashboard overview pushes the config limit into one union page and batches referenced ids", async () => {
  const fixture = operationsFixture();
  const unionCalls: unknown[] = [];
  const batchCalls: string[][] = [];
  let exactGets = 0;
  const capsule = (id: string, installConfigId: string) => ({
    id,
    workspaceId: workspace.id,
    projectId: "prj_default_ws_owner",
    name: id,
    slug: id,
    sourceId: "src_git",
    installConfigId,
    environment: "production",
    currentStateGeneration: 0,
    status: "active" as const,
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
  });
  const config = (id: string) => ({
    id,
    name: id,
    variableMapping: {},
    outputAllowlist: {},
    policy: {},
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
  });
  const operations = {
    ...fixture.operations,
    capsules: {
      ...fixture.operations.capsules,
      listCapsulesPage: async () => ({
        items: [
          capsule("cap_a", "cfg_ref_a"),
          capsule("cap_b", "cfg_ref_b"),
          capsule("cap_c", "cfg_ref_a"),
        ],
      }),
      listInstallConfigUnionPage: async (
        workspaceId: string | undefined,
        params: Record<string, unknown>,
        options: Record<string, unknown>,
      ) => {
        unionCalls.push({ workspaceId, params, options });
        return { items: [config("cfg_visible")] };
      },
      getInstallConfigsByIds: async (ids: readonly string[]) => {
        batchCalls.push([...ids]);
        return ids.map(config);
      },
      getInstallConfig: async () => {
        exactGets += 1;
        return config("unexpected");
      },
    },
    activity: { list: async () => [] },
  } as unknown as ControlPlaneOperations;
  const request = new Request(
    `https://app.example.test/api/v1/dashboard/overview?workspaceId=${workspace.id}&includeWorkspaces=false&installConfigLimit=7&capsuleLimit=3`,
  );
  const response = await handleDashboard(
    context(operations, request),
    ["dashboard", "overview"],
    "GET",
  );

  expect(response?.status).toBe(200);
  expect(unionCalls).toEqual([
    {
      workspaceId: workspace.id,
      params: { limit: 7 },
      options: { includeInternal: true },
    },
  ]);
  expect(batchCalls).toEqual([["cfg_ref_a", "cfg_ref_b"]]);
  expect(exactGets).toBe(0);
  expect(
    ((await response?.json()).installConfigs as Array<{ id: string }>).map(
      (row) => row.id,
    ),
  ).toEqual(["cfg_visible", "cfg_ref_a", "cfg_ref_b"]);
});

test("Dashboard overview follows bounded union pages beyond the store page cap", async () => {
  const fixture = operationsFixture();
  const unionCalls: Array<Record<string, unknown>> = [];
  const config = (id: string) => ({
    id,
    name: id,
    variableMapping: {},
    outputAllowlist: {},
    policy: {},
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
  });
  const firstPage = Array.from({ length: 100 }, (_, index) =>
    config(`cfg_${index.toString().padStart(3, "0")}`),
  );
  const secondPage = Array.from({ length: 20 }, (_, index) =>
    config(`cfg_${(index + 100).toString().padStart(3, "0")}`),
  );
  const operations = {
    ...fixture.operations,
    capsules: {
      ...fixture.operations.capsules,
      listCapsulesPage: async () => ({ items: [] }),
      listInstallConfigUnionPage: async (
        workspaceId: string | undefined,
        params: Record<string, unknown>,
        options: Record<string, unknown>,
      ) => {
        unionCalls.push({ workspaceId, params, options });
        return params.cursor === "after-100"
          ? { items: secondPage }
          : { items: firstPage, nextCursor: "after-100" };
      },
    },
    activity: { list: async () => [] },
  } as unknown as ControlPlaneOperations;
  const request = new Request(
    `https://app.example.test/api/v1/dashboard/overview?workspaceId=${workspace.id}&includeWorkspaces=false&installConfigLimit=150`,
  );
  const response = await handleDashboard(
    context(operations, request),
    ["dashboard", "overview"],
    "GET",
  );

  expect(response?.status).toBe(200);
  expect(unionCalls).toEqual([
    {
      workspaceId: workspace.id,
      params: { limit: 150 },
      options: { includeInternal: true },
    },
    {
      workspaceId: workspace.id,
      params: { limit: 50, cursor: "after-100" },
      options: { includeInternal: true },
    },
  ]);
  expect(
    ((await response?.json()).installConfigs as Array<{ id: string }>).map(
      (row) => row.id,
    ),
  ).toEqual([...firstPage, ...secondPage].map((row) => row.id));
});

test("Capsule create forwards optional projectId and otherwise uses the canonical default", async () => {
  const fixture = operationsFixture();
  for (const [name, projectId] of [
    ["explicit", "prj_explicit"],
    ["default", undefined],
  ] as const) {
    const request = new Request(
      `https://app.example.test/api/v1/workspaces/${workspace.id}/capsules`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          environment: "prod",
          sourceId: "src_git",
          installConfigId: "cfg_default",
          ...(projectId ? { projectId } : {}),
        }),
      },
    );
    const response = await handleWorkspaces(
      context(fixture.operations, request),
      ["workspaces", workspace.id, "capsules"],
      "POST",
    );
    expect(response?.status).toBe(201);
  }

  expect(fixture.capsuleCreates[0].projectId).toBe("prj_explicit");
  expect("projectId" in fixture.capsuleCreates[1]).toBe(false);
});

test("Capsule ProviderBindings accept only the canonical route and payload", async () => {
  const fixture = operationsFixture();
  const bindings = [
    {
      provider: "registry.opentofu.org/hashicorp/aws",
      connectionId: "conn_1",
    },
  ];
  const putRequest = new Request(
    "https://app.example.test/api/v1/capsules/cap_1/provider-bindings",
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bindings }),
    },
  );
  const written = await handleCapsules(
    context(fixture.operations, putRequest),
    ["capsules", "cap_1", "provider-bindings"],
    "PUT",
  );
  expect(written?.status).toBe(200);
  expect(await written?.json()).toMatchObject({
    providerBindingSet: { bindings },
  });

  const legacyRequest = new Request(
    "https://app.example.test/api/v1/capsules/cap_1/provider-connections",
  );
  expect(
    await handleCapsules(
      context(fixture.operations, legacyRequest),
      ["capsules", "cap_1", "provider-connections"],
      "GET",
    ),
  ).toBeUndefined();
});

test("a Workspace-restricted credential cannot reach another Workspace it is a member of", async () => {
  // A workspace-scoped PAT (or a Capsule OAuth access token, bound to its
  // Capsule's Workspace at issuance) may name only its own Workspace. Its
  // subject is a legitimate member of ws_owner here, so membership alone would
  // let it read that Workspace's Capsules, Runs, and Outputs by id.
  const fixture = operationsFixture();
  const boundContext = (request: Request): ControlDispatchContext => ({
    ...context(fixture.operations, request),
    session: { subject: "tsub_owner", workspaceId: "ws_other" },
  });

  const capsuleRequest = new Request(
    "https://app.example.test/api/v1/capsules/cap_1",
  );
  const capsule = await handleCapsules(
    boundContext(capsuleRequest),
    ["capsules", "cap_1"],
    "GET",
  );
  expect(capsule?.status).toBe(403);

  const workspaceRequest = new Request(
    `https://app.example.test/api/v1/workspaces/${workspace.id}/projects`,
  );
  const projects = await handleWorkspaces(
    boundContext(workspaceRequest),
    ["workspaces", workspace.id, "projects"],
    "GET",
  );
  expect(projects?.status).toBe(403);

  // …and it does not learn the other Workspace exists through the list route.
  const listRequest = new Request("https://app.example.test/api/v1/workspaces");
  const listed = await handleWorkspaces(
    boundContext(listRequest),
    ["workspaces"],
    "GET",
  );
  expect((await listed?.json()).workspaces).toEqual([]);

  // The same subject without a restriction keeps its membership access.
  const unrestricted = await handleCapsules(
    context(fixture.operations, capsuleRequest),
    ["capsules", "cap_1"],
    "GET",
  );
  expect(unrestricted?.status).toBe(200);
});

test("retired projection and upload operations have no Accounts handler", async () => {
  expect(isControlRoutePath("/v1/capsule-projections")).toBe(false);
  const fixture = operationsFixture();
  const upload = new Request(
    "https://app.example.test/api/v1/workspaces/ws_owner/uploads",
    { method: "POST", body: "archive" },
  );
  expect(
    await handleWorkspaces(
      context(fixture.operations, upload),
      ["workspaces", workspace.id, "uploads"],
      "POST",
    ),
  ).toBeUndefined();
});
