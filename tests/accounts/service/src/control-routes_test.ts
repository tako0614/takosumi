import { expect, test } from "bun:test";
import type { ControlPlaneOperations } from "../../../../accounts/service/src/control-operations.ts";
import {
  createControlOperationsSharedAttempt,
  handleAuthenticatedControlRoute,
  handleControlRoute,
  isControlRoutePath,
} from "../../../../accounts/service/src/control-routes.ts";
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
import { handleAccountWorkspaceViews } from "../../../../accounts/service/src/control/account-workspace-views.ts";
import { handleDashboard } from "../../../../accounts/service/src/control/dashboard.ts";
import { handleProviderConnections } from "../../../../accounts/service/src/control/providers.ts";
import {
  InMemoryAccountsStore,
  type AccountsStore,
} from "../../../../accounts/service/src/store.ts";
import { encodeCursor } from "../../../../contract/pagination.ts";
import { WorkspacesService } from "../../../../core/domains/workspaces/mod.ts";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";

const workspace = {
  id: "ws_owner",
  handle: "owner",
  displayName: "Owner",
  type: "personal" as const,
  ownerUserId: "tsub_owner",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const otherWorkspace = {
  ...workspace,
  id: "ws_other",
  handle: "other",
  displayName: "Other",
};

function workspaceAuthorizationOperations(input?: {
  readonly onGetWorkspace?: (workspaceId: string) => void;
}): ControlPlaneOperations {
  const workspaces = [workspace, otherWorkspace];
  return {
    workspaces: {
      getWorkspace: async (workspaceId: string) => {
        input?.onGetWorkspace?.(workspaceId);
        const found = workspaces.find(
          (candidate) => candidate.id === workspaceId,
        );
        if (!found) throw new Error("workspace not found");
        return found;
      },
      listWorkspacesForAccount: async () => workspaces,
      createWorkspace: async () => {
        throw new Error("scoped credential must not create a Workspace");
      },
    },
    members: {
      listMembers: async () => [],
    },
  } as unknown as ControlPlaneOperations;
}

async function authenticatedControlRequest(input: {
  readonly store: InMemoryAccountsStore;
  readonly operations: ControlPlaneOperations;
  readonly token: string;
  readonly path: string;
  readonly method?: string;
}): Promise<Response> {
  const url = new URL(`https://app.example.test${input.path}`);
  const response = await handleControlRoute({
    request: new Request(url, {
      method: input.method ?? "GET",
      headers: { authorization: `Bearer ${input.token}` },
    }),
    url,
    store: input.store,
    operations: input.operations,
  });
  expect(response).toBeDefined();
  return response!;
}

test("release-owned ProviderConnection projection bypasses the durable provider list", async () => {
  let durableListReads = 0;
  let releaseProjectionReads = 0;
  const fixed = {
    id: "conn_release_takoform",
    provider: "takoform",
    providerSource: "registry.opentofu.org/tako0614/takoform",
    kind: "takosumi_cloud_takoform",
    scope: "operator",
    status: "verified",
    materialization: "run-issued",
    credentialRecipe: {
      id: "takosumi-cloud-takoform-v02",
      authMode: "broker",
      runIssuance: {
        context: "capsule-run.v1",
        operatorConnection: "workspace-bindable",
        storedMaterial: "none",
        audience: "takosumi-cloud-takoform.v1",
        scopes: ["takoform:invoke"],
      },
    },
    createdAt: "1970-01-01T00:00:00.000Z",
    updatedAt: "1970-01-01T00:00:00.000Z",
  } as const;
  const operations = {
    ...workspaceAuthorizationOperations(),
    connections: {
      listProviderConnections: async () => {
        durableListReads += 1;
        return [];
      },
      listReleaseOwnedProviderConnections: async () => {
        releaseProjectionReads += 1;
        return [fixed];
      },
    },
  } as unknown as ControlPlaneOperations;
  const request = new Request(
    "https://app.example.test/api/v1/provider-connections?workspaceId=ws_owner&projection=release-owned",
  );

  const response = await handleProviderConnections(
    context(operations, request),
    ["provider-connections"],
    "GET",
  );

  expect(response?.status).toBe(200);
  expect(await response?.json()).toEqual({ providerConnections: [fixed] });
  expect(releaseProjectionReads).toBe(1);
  expect(durableListReads).toBe(0);
});

test("Workspace-scoped PAT and OAuth credentials cannot select another Workspace", async () => {
  for (const credential of ["pat", "oauth"] as const) {
    const store = new InMemoryAccountsStore();
    const token = `opaque-${credential}-workspace-scope`;
    if (credential === "pat") {
      store.savePersonalAccessToken(token, {
        tokenId: "pat_workspace_scope",
        tokenPrefix: "display",
        subject: "tsub_owner",
        name: "Workspace automation",
        scopes: ["read"],
        workspaceId: workspace.id,
        createdAt: Date.now(),
      });
    } else {
      store.saveAccessToken(token, {
        clientId: "client_workspace_scope",
        scope: "capsules:read",
        subject: "client-local-subject",
        takosumiSubject: "tsub_owner",
        workspaceId: workspace.id,
        expiresAt: Date.now() + 60_000,
      });
    }
    let workspaceReads = 0;
    const operations = workspaceAuthorizationOperations({
      onGetWorkspace: () => {
        workspaceReads += 1;
      },
    });

    const denied = await authenticatedControlRequest({
      store,
      operations,
      token,
      path: `/api/v1/workspaces/${otherWorkspace.id}`,
    });
    expect(denied.status).toBe(403);
    expect(workspaceReads).toBe(0);

    const allowed = await authenticatedControlRequest({
      store,
      operations,
      token,
      path: `/api/v1/workspaces/${workspace.id}`,
    });
    expect(allowed.status).toBe(200);
    expect(workspaceReads).toBe(2);

    const invalidDashboardSelection = await authenticatedControlRequest({
      store,
      operations,
      token,
      path: `/api/v1/dashboard/bootstrap?workspaceId=${otherWorkspace.id}`,
    });
    expect(invalidDashboardSelection.status).toBe(403);
    expect(workspaceReads).toBe(2);
  }
});

test("Workspace-scoped PAT lists only its Workspace and cannot create another", async () => {
  const store = new InMemoryAccountsStore();
  const token = "opaque-pat-workspace-list";
  store.savePersonalAccessToken(token, {
    tokenId: "pat_workspace_list",
    tokenPrefix: "display",
    subject: "tsub_owner",
    name: "Workspace automation",
    scopes: ["read", "write"],
    workspaceId: workspace.id,
    createdAt: Date.now(),
  });
  const operations = workspaceAuthorizationOperations();

  const listed = await authenticatedControlRequest({
    store,
    operations,
    token,
    path: "/api/v1/workspaces",
  });
  expect(listed.status).toBe(200);
  expect(await listed.json()).toMatchObject({ workspaces: [workspace] });

  const createDenied = await authenticatedControlRequest({
    store,
    operations,
    token,
    path: "/api/v1/workspaces",
    method: "POST",
  });
  expect(createDenied.status).toBe(403);
});

test("an account session remains unscoped across owned Workspaces", async () => {
  const store = new InMemoryAccountsStore();
  const now = Date.now();
  const token = "sess_workspace_scope_regression";
  store.saveAccount({
    subject: "tsub_owner",
    createdAt: now,
    updatedAt: now,
  });
  store.saveAccountSession({
    sessionId: token,
    subject: "tsub_owner",
    createdAt: now,
    expiresAt: now + 60_000,
  });

  const response = await authenticatedControlRequest({
    store,
    operations: workspaceAuthorizationOperations(),
    token,
    path: `/api/v1/workspaces/${otherWorkspace.id}`,
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ workspace: otherWorkspace });
});

test("the session API cannot reach the legacy backup restore operation", async () => {
  const store = new InMemoryAccountsStore();
  const now = Date.now();
  const token = "sess_backup_restore_absent";
  store.saveAccount({
    subject: "tsub_owner",
    createdAt: now,
    updatedAt: now,
  });
  store.saveAccountSession({
    sessionId: token,
    subject: "tsub_owner",
    createdAt: now,
    expiresAt: now + 60_000,
  });
  let restoreCalls = 0;
  const operations = {
    ...workspaceAuthorizationOperations(),
    createRestoreRun: async () => {
      restoreCalls += 1;
      throw new Error("legacy restore operation must remain unreachable");
    },
  } as unknown as ControlPlaneOperations;

  const response = await authenticatedControlRequest({
    store,
    operations,
    token,
    path: `/api/v1/workspaces/${workspace.id}/backups/bkp_legacy/restores`,
    method: "POST",
  });

  expect(response.status).toBe(404);
  expect(restoreCalls).toBe(0);
});

function roleAuthorizationOperations(role: "member" | "admin"): {
  readonly operations: ControlPlaneOperations;
  readonly mutations: { workspaceUpdates: number; runCancels: number };
} {
  const roleWorkspace = { ...workspace, ownerUserId: "tsub_owner_other" };
  const run = {
    id: "run_role_guard",
    workspaceId: roleWorkspace.id,
    capsuleId: "cap_role_guard",
    environment: "production",
    type: "plan" as const,
    status: "running" as const,
    createdBy: "tsub_owner_other",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const mutations = { workspaceUpdates: 0, runCancels: 0 };
  const operations = {
    workspaces: {
      getWorkspace: async () => roleWorkspace,
      listWorkspacesForAccount: async () => [roleWorkspace],
      updateWorkspace: async () => {
        mutations.workspaceUpdates += 1;
        return roleWorkspace;
      },
    },
    members: {
      listMembers: async () => [
        {
          id: `wsm_${role}`,
          workspaceId: roleWorkspace.id,
          accountId: "tsub_role_actor",
          roles: [role],
          status: "active",
          createdAt: roleWorkspace.createdAt,
          updatedAt: roleWorkspace.updatedAt,
        },
      ],
    },
    getRun: async () => run,
    cancelRun: async () => {
      mutations.runCancels += 1;
      return { ...run, status: "cancelled" as const };
    },
  } as unknown as ControlPlaneOperations;
  return { operations, mutations };
}

function roleSessionStore(): {
  readonly store: InMemoryAccountsStore;
  readonly token: string;
} {
  const store = new InMemoryAccountsStore();
  const now = Date.now();
  const token = "sess_role_guard";
  store.saveAccount({
    subject: "tsub_role_actor",
    createdAt: now,
    updatedAt: now,
  });
  store.saveAccountSession({
    sessionId: token,
    subject: "tsub_role_actor",
    createdAt: now,
    expiresAt: now + 60_000,
  });
  return { store, token };
}

test("a Workspace member can read but cannot mutate Workspace settings or control Runs", async () => {
  const auth = roleSessionStore();
  const fixture = roleAuthorizationOperations("member");

  const read = await authenticatedControlRequest({
    ...auth,
    operations: fixture.operations,
    path: "/api/v1/runs/run_role_guard",
  });
  expect(read.status).toBe(200);

  const patch = await authenticatedControlRequest({
    ...auth,
    operations: fixture.operations,
    path: `/api/v1/workspaces/${workspace.id}`,
    method: "PATCH",
  });
  expect(patch.status).toBe(403);

  const cancel = await authenticatedControlRequest({
    ...auth,
    operations: fixture.operations,
    path: "/api/v1/runs/run_role_guard/cancel",
    method: "POST",
  });
  expect(cancel.status).toBe(403);
  expect(fixture.mutations).toEqual({ workspaceUpdates: 0, runCancels: 0 });
});

test("a Workspace admin can control a Run", async () => {
  const auth = roleSessionStore();
  const fixture = roleAuthorizationOperations("admin");
  const response = await authenticatedControlRequest({
    ...auth,
    operations: fixture.operations,
    path: "/api/v1/runs/run_role_guard/cancel",
    method: "POST",
  });
  expect(response.status).toBe(200);
  expect(fixture.mutations.runCancels).toBe(1);
});

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

test("no-state Capsule DELETE fails closed without the safe abandon operation", async () => {
  const fixture = operationsFixture();
  let statusPatches = 0;
  const operations = {
    ...fixture.operations,
    capsules: {
      ...fixture.operations.capsules,
      patchCapsuleStatus: async () => {
        statusPatches += 1;
        return await fixture.operations.capsules.getCapsule("cap_1");
      },
    },
  } as ControlPlaneOperations;
  const request = new Request(
    "https://app.example.test/api/v1/capsules/cap_1",
    { method: "DELETE" },
  );

  const response = await handleCapsules(
    context(operations, request),
    ["capsules", "cap_1"],
    "DELETE",
  ).catch(controllerErrorResponse);

  expect(response?.status).toBe(409);
  expect(await response?.json()).toMatchObject({
    error: {
      code: "failed_precondition",
      details: { reason: "capsule_abandon_unavailable" },
    },
  });
  expect(statusPatches).toBe(0);
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
      getCapsuleExecutionAuthorityEpoch: async () => 1,
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

function workspaceCreateFixture() {
  const createCalls: Parameters<
    ControlPlaneOperations["workspaces"]["createWorkspace"]
  >[0][] = [];
  const operations = {
    workspaces: {
      createWorkspace: async (
        input: Parameters<
          ControlPlaneOperations["workspaces"]["createWorkspace"]
        >[0],
      ) => {
        createCalls.push(input);
        return {
          ...workspace,
          ...input,
          id: `ws_created_${createCalls.length}`,
        };
      },
    },
  } as unknown as ControlPlaneOperations;
  return { operations, createCalls };
}

test("Workspace create rejects unknown types before calling canonical operations", async () => {
  for (const [label, type] of [
    ["team", "team"],
    ["typo", "persoanl"],
    ["null", null],
    ["object", { kind: "organization" }],
    ["number", 42],
  ] as const) {
    const fixture = workspaceCreateFixture();
    const request = new Request("https://app.example.test/api/v1/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        handle: `invalid-${label}`,
        displayName: "Invalid Workspace",
        type,
      }),
    });

    const response = await handleWorkspaces(
      context(fixture.operations, request),
      ["workspaces"],
      "POST",
    );

    expect(response?.status).toBe(400);
    expect(await response?.json()).toMatchObject({
      error: { code: "invalid_request" },
    });
    expect(fixture.createCalls).toHaveLength(0);
  }
});

test("Workspace create defaults only an omitted type and preserves canonical types", async () => {
  for (const [label, body, expectedType] of [
    ["omitted", {}, "personal"],
    ["personal", { type: "personal" }, "personal"],
    ["organization", { type: "organization" }, "organization"],
  ] as const) {
    const fixture = workspaceCreateFixture();
    const request = new Request("https://app.example.test/api/v1/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        handle: `valid-${label}`,
        displayName: "Valid Workspace",
        ...body,
      }),
    });

    const response = await handleWorkspaces(
      context(fixture.operations, request),
      ["workspaces"],
      "POST",
    );

    expect(response?.status).toBe(201);
    expect(fixture.createCalls).toHaveLength(1);
    expect(fixture.createCalls[0]).toMatchObject({
      handle: `valid-${label}`,
      displayName: "Valid Workspace",
      type: expectedType,
      ownerUserId: "tsub_owner",
    });
  }
});

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

test("account Workspace inventory is a fixed, read-only public projection", async () => {
  const pageCalls: Array<{ accountId: string; params: Record<string, unknown> }> = [];
  let writerCalls = 0;
  const archivedWorkspace = {
    ...workspace,
    id: "ws_archived",
    handle: "archived",
    displayName: "Archived",
    archivedAt: "2026-08-01T00:00:00.000Z",
    internalSecretId: "must-not-leak",
  } as typeof workspace & { archivedAt: string; internalSecretId: string };
  const operations = {
    workspaces: {
      listWorkspacesForAccountPage: async (
        accountId: string,
        params: Record<string, unknown>,
      ) => {
        pageCalls.push({ accountId, params });
        return {
          items: [archivedWorkspace],
          total: 1,
        };
      },
      ensurePersonalWorkspace: async () => {
        writerCalls += 1;
        throw new Error("inventory must not ensure");
      },
      createWorkspace: async () => {
        writerCalls += 1;
        throw new Error("inventory must not create");
      },
    },
    members: {
      listMembers: async () => {
        writerCalls += 1;
        throw new Error("inventory must not read membership separately");
      },
    },
    projects: {
      listProjects: async () => {
        writerCalls += 1;
        throw new Error("inventory must not read projects");
      },
    },
  } as unknown as ControlPlaneOperations;
  const cursor = encodeCursor({
    createdAt: "2026-01-01T00:00:00.000Z",
    id: "ws_before",
  });
  const request = new Request(
    `https://app.example.test/api/v1/views/workspaces.v1?limit=101&cursor=${cursor}`,
  );
  const response = await handleAccountWorkspaceViews(
    {
      request,
      url: new URL(request.url),
      operations,
      store: new InMemoryAccountsStore(),
      session: { subject: "tsub_owner" },
    },
    ["views", "workspaces.v1"],
    "GET",
  );

  expect(response?.status).toBe(200);
  expect(await response?.json()).toEqual({
    kind: "takosumi.account-workspace-inventory@v1",
    workspaces: [
      {
        id: archivedWorkspace.id,
        handle: archivedWorkspace.handle,
        displayName: archivedWorkspace.displayName,
        type: archivedWorkspace.type,
        ownerUserId: archivedWorkspace.ownerUserId,
        archivedAt: archivedWorkspace.archivedAt,
        createdAt: archivedWorkspace.createdAt,
        updatedAt: archivedWorkspace.updatedAt,
      },
    ],
    total: 1,
    returned: 1,
    limit: 100,
    truncated: false,
  });
  expect(pageCalls).toEqual([
    {
      accountId: "tsub_owner",
      params: {
        includeArchived: true,
        includeTotal: true,
        order: "created_asc",
        limit: 100,
        cursor,
      },
    },
  ]);
  expect(writerCalls).toBe(0);
});

test("account Workspace inventory is mounted through the public control dispatcher", async () => {
  const operations = {
    workspaces: {
      listWorkspacesForAccountPage: async () => ({
        items: [],
        total: 0,
      }),
    },
  } as unknown as ControlPlaneOperations;
  const request = new Request(
    "https://app.example.test/api/v1/views/workspaces.v1",
  );
  const response = await handleAuthenticatedControlRoute({
    request,
    url: new URL(request.url),
    operations,
    store: new InMemoryAccountsStore(),
    subject: "tsub_owner",
  });
  expect(response?.status).toBe(200);
  expect(await response?.json()).toEqual({
    kind: "takosumi.account-workspace-inventory@v1",
    workspaces: [],
    total: 0,
    returned: 0,
    limit: 100,
    truncated: false,
  });
});

test("account Workspace inventory rejects unknown query keys and malformed cursors", async () => {
  let pageCalls = 0;
  const operations = {
    workspaces: {
      listWorkspacesForAccountPage: async () => {
        pageCalls += 1;
        return { items: [], total: 0 };
      },
    },
  } as unknown as ControlPlaneOperations;
  for (const path of [
    "/api/v1/views/workspaces.v1?includeArchived=true",
    "/api/v1/views/workspaces.v1?cursor=malformed-cursor",
  ]) {
    const request = new Request(`https://app.example.test${path}`);
    const response = await handleAccountWorkspaceViews(
      {
        request,
        url: new URL(request.url),
        operations,
        store: new InMemoryAccountsStore(),
        session: { subject: "tsub_owner" },
      },
      ["views", "workspaces.v1"],
      "GET",
    );
    expect(response?.status).toBe(400);
    expect(await response?.json()).toMatchObject({
      error: { code: "invalid_request" },
    });
  }
  expect(pageCalls).toBe(0);
});

test("Workspace-scoped account Workspace inventory is forbidden before any store or operation read", async () => {
  let pageCalls = 0;
  const operations = {
    workspaces: {
      listWorkspacesForAccountPage: async () => {
        pageCalls += 1;
        return { items: [], total: 0 };
      },
    },
  } as unknown as ControlPlaneOperations;
  const store = new Proxy(new InMemoryAccountsStore(), {
    get() {
      throw new Error("workspace-scoped inventory must not read the store");
    },
  }) as unknown as InMemoryAccountsStore;
  const request = new Request(
    "https://app.example.test/api/v1/views/workspaces.v1",
  );
  // The public auth entry point necessarily reads the credential store first;
  // this authenticated composition seam isolates the route's own scope check.
  const direct = await handleAuthenticatedControlRoute({
    request,
    url: new URL(request.url),
    operations,
    store,
    subject: "tsub_owner",
    workspaceId: "ws_scoped",
  });
  expect(direct?.status).toBe(403);
  expect(pageCalls).toBe(0);
});

test("dispatcher fences Workspace-scoped inventory before lazy Control initialization", async () => {
  let resolverCalls = 0;
  let storeReads = 0;
  const store = new Proxy({} as AccountsStore, {
    get() {
      storeReads += 1;
      throw new Error("workspace-scoped inventory must not touch the store");
    },
  });
  for (const path of [
    "/api/v1/views/workspaces.v1",
    "/api/v1/views/workspaces.v1/",
    "/api/v1//views/workspaces.v1",
  ]) {
    const request = new Request(`https://app.example.test${path}`);
    const response = await handleAuthenticatedControlRoute({
      request,
      url: new URL(request.url),
      store,
      subject: "tsub_owner",
      workspaceId: "ws_scoped",
      resolveOperations: async () => {
        resolverCalls += 1;
        throw new Error(
          "workspace-scoped inventory must not initialize Control",
        );
      },
    });
    expect(response?.status).toBe(403);
    expect(await response?.json()).toMatchObject({
      error: { code: "forbidden" },
    });
  }
  expect(resolverCalls).toBe(0);
  expect(storeReads).toBe(0);
});

test("unscoped inventory aliases use the normalized public projection route", async () => {
  let resolverCalls = 0;
  let pageCalls = 0;
  const operations = {
    workspaces: {
      listWorkspacesForAccountPage: async () => {
        pageCalls += 1;
        return { items: [], total: 0 };
      },
    },
  } as unknown as ControlPlaneOperations;
  const store = {} as AccountsStore;
  for (const path of [
    "/api/v1/views/workspaces.v1",
    "/api/v1/views/workspaces.v1/",
    "/api/v1//views/workspaces.v1",
  ]) {
    const request = new Request(`https://app.example.test${path}`);
    const response = await handleAuthenticatedControlRoute({
      request,
      url: new URL(request.url),
      store,
      subject: "tsub_owner",
      resolveOperations: async () => {
        resolverCalls += 1;
        return operations;
      },
    });
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({
      kind: "takosumi.account-workspace-inventory@v1",
      workspaces: [],
      total: 0,
    });
  }
  expect(resolverCalls).toBe(3);
  expect(pageCalls).toBe(3);
});

test("public Workspace-scoped PAT inventory rejects before lazy Control initialization", async () => {
  const pat = "pat_workspace_inventory_scope";
  const store = new InMemoryAccountsStore();
  let bearerResolutions = 0;
  store.resolveAccountsBearerCandidates = async (token) => {
    bearerResolutions += 1;
    expect(token).toBe(pat);
    return {
      personalAccessToken: {
        tokenId: "pat_workspace_inventory_scope",
        tokenPrefix: "pat_workspace_inventory",
        subject: "tsub_owner",
        name: "Workspace inventory",
        scopes: ["read"],
        workspaceId: "ws_scoped",
        createdAt: Date.now(),
      },
    };
  };
  let resolverCalls = 0;
  let operationCalls = 0;
  const operations = {
    workspaces: {
      listWorkspacesForAccountPage: async () => {
        operationCalls += 1;
        throw new Error("workspace-scoped inventory must not read Operations");
      },
    },
  } as unknown as ControlPlaneOperations;
  const request = new Request(
    "https://app.example.test/api/v1/views/workspaces.v1",
    { headers: { authorization: `Bearer ${pat}` } },
  );
  const response = await handleControlRoute({
    request,
    url: new URL(request.url),
    store,
    resolveOperations: async () => {
      resolverCalls += 1;
      return operations;
    },
  });
  expect(response?.status).toBe(403);
  expect(await response?.json()).toMatchObject({
    error: { code: "forbidden" },
  });
  expect(bearerResolutions).toBe(1);
  expect(resolverCalls).toBe(0);
  expect(operationCalls).toBe(0);
  expect(response?.headers.get("server-timing")).toMatch(
    /tk_control_auth;dur=/u,
  );
  expect(response?.headers.get("server-timing")).not.toContain(
    "tk_control_init",
  );
});

test("shared Control initialization removes timed-out waiters and coalesces its warning", async () => {
  let starts = 0;
  let resolveUnderlying: ((value: string) => void) | undefined;
  const warnings: unknown[] = [];
  const underlying = new Promise<string>((resolve) => {
    resolveUnderlying = resolve;
  });
  const attempt = createControlOperationsSharedAttempt(
    async () => {
      starts += 1;
      return await underlying;
    },
    {
      onFailure: (error) => warnings.push(error),
    },
  );
  const waits = Array.from({ length: 12 }, () =>
    attempt.wait(1).catch(() => undefined),
  );
  await Promise.all(waits);

  expect(starts).toBe(1);
  expect(attempt.waiterCount).toBe(0);
  expect(warnings).toHaveLength(1);

  resolveUnderlying!("ready");
  await expect(attempt.wait(20)).resolves.toBe("ready");
  expect(attempt.waiterCount).toBe(0);
  expect(warnings).toHaveLength(1);
});

test("shared Control initialization exposes one rejection for eviction", async () => {
  let rejected = 0;
  const attempt = createControlOperationsSharedAttempt(
    async () => {
      throw new Error("bootstrap failed");
    },
    { onRejected: () => rejected += 1 },
  );

  await expect(attempt.wait(20)).rejects.toThrow("bootstrap failed");
  expect(rejected).toBe(1);
  expect(attempt.waiterCount).toBe(0);
});

test("request floods coalesce one Control initialization warning", async () => {
  const never = new Promise<ControlPlaneOperations>(() => undefined);
  let starts = 0;
  const resolveOperations = async () => {
    starts += 1;
    return await never;
  };
  const warnings: string[] = [];
  const originalWarn = console.warn;
  const originalSetTimeout = globalThis.setTimeout;
  console.warn = (line?: unknown) => warnings.push(String(line));
  globalThis.setTimeout = ((
    callback: TimerHandler,
    _timeout?: number,
    ...args: unknown[]
  ) => originalSetTimeout(callback, 0, ...args)) as typeof globalThis.setTimeout;
  try {
    const responses = await Promise.all(
      Array.from({ length: 20 }, () => {
        const request = new Request(
          "https://app.example.test/api/v1/views/workspaces.v1",
        );
        return handleAuthenticatedControlRoute({
          request,
          url: new URL(request.url),
          store: {} as AccountsStore,
          subject: "tsub_owner",
          resolveOperations,
        });
      }),
    );
    expect(responses.every((response) => response?.status === 503)).toBe(true);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    console.warn = originalWarn;
  }
  expect(starts).toBe(1);
  expect(warnings).toHaveLength(1);
});

test("authenticated Source POST returns a bounded generic 503 when Control initialization never resolves", async () => {
  const marker = "source-body-must-not-be-read";
  const request = new Request("https://app.example.test/api/v1/sources", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ marker }),
  });
  const storeReads = { count: 0 };
  const store = new Proxy({} as AccountsStore, {
    get() {
      storeReads.count += 1;
      throw new Error("Control initialization timeout must not read the store");
    },
  });
  let resolverCalls = 0;
  const never = new Promise<ControlPlaneOperations>(() => undefined);

  // Keep this test fast while asserting that production schedules the fixed
  // five-second request deadline. The resolver itself remains pending, so the
  // route can only complete through the deadline path.
  const originalSetTimeout = globalThis.setTimeout;
  const scheduledDelays: number[] = [];
  globalThis.setTimeout = ((
    callback: TimerHandler,
    timeout?: number,
    ...args: unknown[]
  ) => {
    scheduledDelays.push(Number(timeout));
    return originalSetTimeout(callback, 0, ...args);
  }) as typeof globalThis.setTimeout;
  let response: Response | undefined;
  try {
    response = await handleAuthenticatedControlRoute({
      request,
      url: new URL(request.url),
      store,
      subject: "tsub_owner",
      resolveOperations: async () => {
        resolverCalls += 1;
        return await never;
      },
    });
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }

  expect(response?.status).toBe(503);
  expect(request.bodyUsed).toBe(false);
  const body = await response?.text();
  expect(body).toMatch(/feature_unavailable/u);
  expect(body).not.toContain(marker);
  expect(response?.headers.get("server-timing")).toMatch(
    /tk_control_init;dur=/u,
  );
  expect(response?.headers.get("server-timing")).not.toContain(
    "tk_control_dispatch",
  );
  expect(resolverCalls).toBe(1);
  expect(storeReads.count).toBe(0);
  expect(scheduledDelays).toContain(5_000);
});

test("Control initialization rejection returns the same generic 503 without dispatch", async () => {
  const marker = "resolver-secret-marker";
  const request = new Request("https://app.example.test/api/v1/sources", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ marker }),
  });
  const storeReads = { count: 0 };
  const store = new Proxy({} as AccountsStore, {
    get() {
      storeReads.count += 1;
      throw new Error("Control initialization rejection must not read the store");
    },
  });
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (line?: unknown) => warnings.push(String(line));
  let response: Response | undefined;
  try {
    response = await handleAuthenticatedControlRoute({
      request,
      url: new URL(request.url),
      store,
      subject: "tsub_owner",
      resolveOperations: async () => {
        throw new Error(marker);
      },
    });
  } finally {
    console.warn = originalWarn;
  }

  expect(response?.status).toBe(503);
  const body = await response?.text();
  expect(body).toMatch(/feature_unavailable/u);
  expect(body).not.toContain(marker);
  expect(response?.headers.get("server-timing")).toMatch(
    /tk_control_init;dur=/u,
  );
  expect(response?.headers.get("server-timing")).not.toContain(
    "tk_control_dispatch",
  );
  expect(storeReads.count).toBe(0);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).not.toContain(marker);
  expect(warnings[0]).toContain('"stage":"resolve_operations"');
});

test("credential OAuth callback initialization rejection is also generic and bounded", async () => {
  const marker = "oauth-query-secret";
  const request = new Request(
    `https://app.example.test/api/v1/connections/oauth/helper/callback?code=${marker}&state=state-1`,
  );
  const storeReads = { count: 0 };
  const store = new Proxy({} as AccountsStore, {
    get() {
      storeReads.count += 1;
      throw new Error("OAuth initialization rejection must not read the store");
    },
  });
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (line?: unknown) => warnings.push(String(line));
  let response: Response | undefined;
  try {
    response = await handleControlRoute({
      request,
      url: new URL(request.url),
      store,
      resolveOperations: async () => {
        throw new Error(marker);
      },
    });
  } finally {
    console.warn = originalWarn;
  }

  expect(response?.status).toBe(503);
  const body = await response?.text();
  expect(body).toMatch(/feature_unavailable/u);
  expect(body).not.toContain(marker);
  expect(response?.headers.get("server-timing")).toMatch(
    /tk_control_init;dur=/u,
  );
  expect(response?.headers.get("server-timing")).not.toContain(
    "tk_control_dispatch",
  );
  expect(storeReads.count).toBe(0);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).not.toContain(marker);
  expect(warnings[0]).toContain('"thresholdMs":5000');
});

test("credential OAuth callback timeout does not cancel its shared initializer", async () => {
  const request = new Request(
    "https://app.example.test/api/v1/connections/oauth/helper/callback?code=code-1&state=state-1",
  );
  const store = {} as AccountsStore;
  const never = new Promise<ControlPlaneOperations>(() => undefined);
  let resolverCalls = 0;
  const originalSetTimeout = globalThis.setTimeout;
  const scheduledDelays: number[] = [];
  globalThis.setTimeout = ((
    callback: TimerHandler,
    timeout?: number,
    ...args: unknown[]
  ) => {
    scheduledDelays.push(Number(timeout));
    return originalSetTimeout(callback, 0, ...args);
  }) as typeof globalThis.setTimeout;
  let response: Response | undefined;
  try {
    response = await handleControlRoute({
      request,
      url: new URL(request.url),
      store,
      resolveOperations: async () => {
        resolverCalls += 1;
        return await never;
      },
    });
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }

  expect(response?.status).toBe(503);
  expect(response?.headers.get("server-timing")).toMatch(
    /tk_control_init;dur=/u,
  );
  expect(response?.headers.get("server-timing")).not.toContain(
    "tk_control_dispatch",
  );
  expect(resolverCalls).toBe(1);
  expect(scheduledDelays).toContain(5_000);
});

test("credential OAuth callback success preserves tk_control_init timing", async () => {
  const operations = {
    connectionOAuth: {
      helper: {
        complete: async () => ({
          request: { workspaceId: workspace.id },
          subject: workspace.ownerUserId,
        }),
      },
    },
    workspaces: {
      getWorkspace: async () => workspace,
    },
    createConnection: async () => ({ connection: { id: "conn_oauth" } }),
    testConnection: async () => ({ status: "verified" }),
  } as unknown as ControlPlaneOperations;
  const request = new Request(
    "https://app.example.test/api/v1/connections/oauth/helper/callback?code=code-1&state=state-1",
  );
  const response = await handleControlRoute({
    request,
    url: new URL(request.url),
    store: new InMemoryAccountsStore(),
    resolveOperations: async () => operations,
  });

  expect(response?.status).toBe(303);
  expect(response?.headers.get("location")).toContain("connected=1");
  expect(response?.headers.get("server-timing")).toMatch(
    /tk_control_init;dur=/u,
  );
});

test("credential OAuth callback failure preserves tk_control_init timing", async () => {
  const operations = {
    connectionOAuth: {
      helper: {
        complete: async () => {
          throw new Error("upstream failure");
        },
      },
    },
  } as unknown as ControlPlaneOperations;
  const request = new Request(
    "https://app.example.test/api/v1/connections/oauth/helper/callback?code=code-1&state=state-1",
  );
  const response = await handleControlRoute({
    request,
    url: new URL(request.url),
    store: new InMemoryAccountsStore(),
    resolveOperations: async () => operations,
  });

  expect(response?.status).toBe(303);
  expect(response?.headers.get("location")).toContain(
    "connection_error=oauth_failed",
  );
  expect(response?.headers.get("server-timing")).toMatch(
    /tk_control_init;dur=/u,
  );
});

test("a timed-out caller can use the same initializer after it resolves", async () => {
  const request = new Request(
    "https://app.example.test/api/v1/views/workspaces.v1",
  );
  const operations = {
    workspaces: {
      listWorkspacesForAccountPage: async () => ({ items: [], total: 0 }),
    },
  } as unknown as ControlPlaneOperations;
  let resolveShared: ((value: ControlPlaneOperations) => void) | undefined;
  const shared = new Promise<ControlPlaneOperations>((resolve) => {
    resolveShared = resolve;
  });
  let resolverCalls = 0;
  const resolveOperations = async () => {
    resolverCalls += 1;
    return await shared;
  };

  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((
    callback: TimerHandler,
    _timeout?: number,
    ...args: unknown[]
  ) => originalSetTimeout(callback, 0, ...args)) as typeof globalThis.setTimeout;
  let timedOut: Response | undefined;
  try {
    timedOut = await handleAuthenticatedControlRoute({
      request,
      url: new URL(request.url),
      store: {} as AccountsStore,
      subject: "tsub_owner",
      resolveOperations,
    });
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
  expect(timedOut?.status).toBe(503);

  resolveShared!(operations);
  const served = await handleAuthenticatedControlRoute({
    request,
    url: new URL(request.url),
    store: {} as AccountsStore,
    subject: "tsub_owner",
    resolveOperations,
  });
  expect(served?.status).toBe(200);
  expect(await served?.json()).toMatchObject({
    kind: "takosumi.account-workspace-inventory@v1",
  });
  expect(resolverCalls).toBe(1);
});

test("a rejected Control initializer is evicted before the next request retries", async () => {
  const request = new Request(
    "https://app.example.test/api/v1/views/workspaces.v1",
  );
  const operations = {
    workspaces: {
      listWorkspacesForAccountPage: async () => ({ items: [], total: 0 }),
    },
  } as unknown as ControlPlaneOperations;
  let attempts = 0;
  const resolveOperations = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("first bootstrap failed");
    return operations;
  };

  const first = await handleAuthenticatedControlRoute({
    request,
    url: new URL(request.url),
    store: {} as AccountsStore,
    subject: "tsub_owner",
    resolveOperations,
  });
  const second = await handleAuthenticatedControlRoute({
    request,
    url: new URL(request.url),
    store: {} as AccountsStore,
    subject: "tsub_owner",
    resolveOperations,
  });

  expect(first?.status).toBe(503);
  expect(second?.status).toBe(200);
  expect(attempts).toBe(2);
});

test("authentication failures do not resolve the Control plane", async () => {
  let resolverCalls = 0;
  const request = new Request("https://app.example.test/api/v1/sources", {
    method: "POST",
    body: "must-not-be-parsed",
  });
  const response = await handleControlRoute({
    request,
    url: new URL(request.url),
    store: new InMemoryAccountsStore(),
    resolveOperations: async () => {
      resolverCalls += 1;
      throw new Error("authentication must run first");
    },
  });

  expect(response?.status).toBe(401);
  expect(resolverCalls).toBe(0);
  expect(response?.headers.get("server-timing")).not.toContain(
    "tk_control_init",
  );
});

test("account Workspace inventory fails closed when total is missing or inconsistent", async () => {
  for (const page of [
    { items: [workspace] },
    { items: [workspace], total: 0 },
    { items: [workspace], total: 1, nextCursor: "next" },
  ]) {
    const operations = {
      workspaces: {
        listWorkspacesForAccountPage: async () => page,
      },
    } as unknown as ControlPlaneOperations;
    const request = new Request(
      "https://app.example.test/api/v1/views/workspaces.v1",
    );
    const response = await handleAuthenticatedControlRoute({
      request,
      url: new URL(request.url),
      operations,
      store: new InMemoryAccountsStore(),
      subject: "tsub_owner",
    });
    expect(response?.status).toBe(500);
    expect(await response?.json()).toMatchObject({
      error: { code: "internal_error" },
    });
  }
});

test("Workspace list repairs an already-visible personal Workspace without refreshing", async () => {
  const fixture = operationsFixture();
  const controlStore = new InMemoryOpenTofuControlStore();
  let id = 0;
  let defaultProjectRepairs = 0;
  let pageCalls = 0;
  const service = new WorkspacesService({
    store: controlStore,
    newId: (prefix) => `${prefix}_visible_repair_${(id += 1)}`,
    now: () => new Date("2026-08-10T00:00:00.000Z"),
    ensureDefaultProject: async () => {
      defaultProjectRepairs += 1;
    },
  });
  const existing = await service.createWorkspace({
    handle: "visible-personal",
    displayName: "Visible personal",
    type: "personal",
    ownerUserId: "tsub_owner",
  });
  const member = await controlStore.getWorkspaceMember(
    existing.id,
    "tsub_owner",
  );
  await controlStore.putWorkspaceMember({
    ...member!,
    roles: ["member"],
    status: "active",
  });
  defaultProjectRepairs = 0;
  const operations = {
    ...fixture.operations,
    workspaces: {
      ...fixture.operations.workspaces,
      ensurePersonalWorkspace: service.ensurePersonalWorkspace.bind(service),
      listWorkspacesForAccountPage: async (...args: Parameters<
        typeof service.listWorkspacesForAccountPage
      >) => {
        pageCalls += 1;
        return await service.listWorkspacesForAccountPage(...args);
      },
      getWorkspaceForAccount: service.getWorkspaceForAccount.bind(service),
      listWorkspacesByOwner: async () => {
        throw new Error("visible repair must not use an owner scan");
      },
    },
  } as ControlPlaneOperations;
  const accountsStore = new InMemoryAccountsStore();
  accountsStore.saveAccount({
    subject: "tsub_owner",
    displayName: "Owner Presentation",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  const request = new Request("https://app.example.test/api/v1/workspaces");
  const response = await handleWorkspaces(
    {
      request,
      url: new URL(request.url),
      operations,
      store: accountsStore,
      session: { subject: "tsub_owner" },
    },
    ["workspaces"],
    "GET",
  );

  expect(response?.status).toBe(200);
  expect(await response?.json()).toMatchObject({ workspaces: [existing] });
  expect(
    await controlStore.getWorkspaceMember(existing.id, "tsub_owner"),
  ).toEqual(expect.objectContaining({ roles: ["owner"], status: "active" }));
  expect(defaultProjectRepairs).toBe(1);
  expect(pageCalls).toBe(1);
  expect(await controlStore.listWorkspaces()).toHaveLength(1);
});

test("Workspace list awaits the idempotent personal Workspace ensure", async () => {
  const fixture = operationsFixture();
  const store = new InMemoryAccountsStore();
  store.saveAccount({
    subject: "tsub_owner",
    displayName: "Owner",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  let releaseEnsure!: () => void;
  const ensureHeld = new Promise<void>((resolve) => {
    releaseEnsure = resolve;
  });
  let signalEnsureStarted!: () => void;
  const ensureStarted = new Promise<void>((resolve) => {
    signalEnsureStarted = resolve;
  });
  const ensureCalls: Array<{ ownerUserId: string; handle: string }> = [];
  let pageCalls = 0;
  const operations = {
    ...fixture.operations,
    workspaces: {
      ...fixture.operations.workspaces,
      listWorkspacesForAccountPage: async (
        accountId: string,
        params: Record<string, unknown>,
      ) => {
        pageCalls += 1;
        fixture.workspacePageCalls.push({ accountId, ...params });
        return pageCalls === 1 ? { items: [] } : { items: [workspace] };
      },
      ensurePersonalWorkspace: async (ownerUserId: string, handle: string) => {
        ensureCalls.push({ ownerUserId, handle });
        signalEnsureStarted();
        await ensureHeld;
        return workspace;
      },
    },
  };
  const request = new Request("https://app.example.test/api/v1/workspaces");
  const responsePromise = handleWorkspaces(
    {
      request,
      url: new URL(request.url),
      operations: operations as ControlPlaneOperations,
      store,
      session: { subject: "tsub_owner" },
    },
    ["workspaces"],
    "GET",
  );

  await ensureStarted;
  expect(ensureCalls).toEqual([{ ownerUserId: "tsub_owner", handle: "owner" }]);
  expect(fixture.workspacePageCalls).toHaveLength(1);
  releaseEnsure();
  const response = await responsePromise;
  expect(response?.status).toBe(200);
  expect(await response?.json()).toMatchObject({ workspaces: [workspace] });
  expect(fixture.workspacePageCalls).toHaveLength(2);
});

test("Workspace list adopts and repairs an existing personal Workspace missing from membership", async () => {
  const fixture = operationsFixture();
  const controlStore = new InMemoryOpenTofuControlStore();
  let id = 0;
  let defaultProjectRepairs = 0;
  const service = new WorkspacesService({
    store: controlStore,
    newId: (prefix) => `${prefix}_route_repair_${(id += 1)}`,
    now: () => new Date("2026-08-10T00:00:00.000Z"),
    ensureDefaultProject: async () => {
      defaultProjectRepairs += 1;
    },
  });
  const existing = await service.createWorkspace({
    handle: "existing-off-page",
    displayName: "Existing off page",
    type: "personal",
    ownerUserId: "tsub_owner",
  });
  const member = await controlStore.getWorkspaceMember(
    existing.id,
    "tsub_owner",
  );
  await controlStore.putWorkspaceMember({
    ...member!,
    roles: ["member"],
    status: "suspended",
  });
  defaultProjectRepairs = 0;
  const operations = {
    ...fixture.operations,
    workspaces: {
      ...fixture.operations.workspaces,
      ensurePersonalWorkspace: service.ensurePersonalWorkspace.bind(service),
      listWorkspacesForAccountPage:
        service.listWorkspacesForAccountPage.bind(service),
      getWorkspaceForAccount: service.getWorkspaceForAccount.bind(service),
      listWorkspacesByOwner: async () => {
        throw new Error("route repair must not use an owner scan");
      },
    },
  } as ControlPlaneOperations;
  const accountsStore = new InMemoryAccountsStore();
  accountsStore.saveAccount({
    subject: "tsub_owner",
    displayName: "Owner Presentation",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  const request = new Request("https://app.example.test/api/v1/workspaces");

  const response = await handleWorkspaces(
    {
      request,
      url: new URL(request.url),
      operations,
      store: accountsStore,
      session: { subject: "tsub_owner" },
    },
    ["workspaces"],
    "GET",
  );

  expect(response?.status).toBe(200);
  expect(await response?.json()).toMatchObject({ workspaces: [existing] });
  expect(
    await controlStore.getWorkspaceMember(existing.id, "tsub_owner"),
  ).toEqual(expect.objectContaining({ roles: ["owner"], status: "active" }));
  expect(defaultProjectRepairs).toBe(1);
  expect(await controlStore.listWorkspaces()).toHaveLength(1);
});

test("Workspace list keeps bootstrap outage best-effort without an owner scan", async () => {
  const fixture = operationsFixture();
  const pageWorkspace = {
    ...workspace,
    id: "ws_page_organization",
    handle: "page-organization",
    displayName: "Page Organization",
    type: "organization" as const,
    ownerUserId: "tsub_other",
  };
  let exactOwnerQueries = 0;
  let ensureCalls = 0;
  let pageCalls = 0;
  const operations = {
    ...fixture.operations,
    workspaces: {
      ...fixture.operations.workspaces,
      listWorkspacesForAccountPage: async () => {
        pageCalls += 1;
        return { items: [pageWorkspace] };
      },
      listWorkspacesByOwner: async (ownerUserId: string) => {
        exactOwnerQueries += 1;
        expect(ownerUserId).toBe("tsub_owner");
        throw new Error("the GET path must not scan owner Workspaces");
      },
      ensurePersonalWorkspace: async () => {
        ensureCalls += 1;
        throw new Error("control storage is temporarily unavailable");
      },
    },
  } as ControlPlaneOperations;
  const request = new Request("https://app.example.test/api/v1/workspaces");
  const response = await handleWorkspaces(
    {
      request,
      url: new URL(request.url),
      operations,
      store: new InMemoryAccountsStore(),
      session: { subject: "tsub_owner" },
    },
    ["workspaces"],
    "GET",
  );

  expect(response?.status).toBe(200);
  expect(await response?.json()).toMatchObject({
    workspaces: [pageWorkspace],
  });
  expect(exactOwnerQueries).toBe(0);
  expect(ensureCalls).toBe(1);
  expect(pageCalls).toBe(2);
});

test("Workspace list falls back to the initial page when bootstrap refresh fails", async () => {
  const fixture = operationsFixture();
  const initialWorkspace = {
    ...workspace,
    id: "ws_initial_organization",
    handle: "initial-organization",
    displayName: "Initial Organization",
    type: "organization" as const,
    ownerUserId: "tsub_other",
  };
  let ownerScans = 0;
  let ensureCalls = 0;
  let pageCalls = 0;
  const operations = {
    ...fixture.operations,
    workspaces: {
      ...fixture.operations.workspaces,
      listWorkspacesForAccountPage: async () => {
        pageCalls += 1;
        if (pageCalls === 1) return { items: [initialWorkspace] };
        throw new Error("refresh storage outage");
      },
      listWorkspacesByOwner: async () => {
        ownerScans += 1;
        throw new Error("the GET path must not scan owner Workspaces");
      },
      ensurePersonalWorkspace: async () => {
        ensureCalls += 1;
        return workspace;
      },
    },
  } as ControlPlaneOperations;
  const request = new Request("https://app.example.test/api/v1/workspaces");
  const response = await handleWorkspaces(
    {
      request,
      url: new URL(request.url),
      operations,
      store: new InMemoryAccountsStore(),
      session: { subject: "tsub_owner" },
    },
    ["workspaces"],
    "GET",
  );

  expect(response?.status).toBe(200);
  expect(await response?.json()).toMatchObject({
    workspaces: [initialWorkspace],
  });
  expect(ownerScans).toBe(0);
  expect(ensureCalls).toBe(1);
  expect(pageCalls).toBe(2);
});

test("Workspace-scoped list never bootstraps another personal Workspace", async () => {
  const fixture = operationsFixture();
  let workspaceEnsures = 0;
  const operations = {
    ...fixture.operations,
    workspaces: {
      ...fixture.operations.workspaces,
      ensurePersonalWorkspace: async () => {
        workspaceEnsures += 1;
        return workspace;
      },
    },
  } as ControlPlaneOperations;
  const request = new Request("https://app.example.test/api/v1/workspaces");
  const response = await handleWorkspaces(
    {
      request,
      url: new URL(request.url),
      operations,
      store: new InMemoryAccountsStore(),
      session: { subject: "tsub_owner", workspaceId: workspace.id },
    },
    ["workspaces"],
    "GET",
  );

  expect(response?.status).toBe(200);
  expect(workspaceEnsures).toBe(0);
});

test("Repeated Workspace lists always ensure but refresh only while personal is missing", async () => {
  const fixture = operationsFixture();
  const store = new InMemoryAccountsStore();
  store.saveAccount({
    subject: "tsub_owner",
    displayName: "Owner",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  const ensureCalls: Array<{ ownerUserId: string; handle: string }> = [];
  let createCalls = 0;
  let pageCalls = 0;
  const operations = {
    ...fixture.operations,
    workspaces: {
      ...fixture.operations.workspaces,
      listWorkspacesForAccountPage: async (
        accountId: string,
        params: Record<string, unknown>,
      ) => {
        pageCalls += 1;
        fixture.workspacePageCalls.push({ accountId, ...params });
        return pageCalls === 1 ? { items: [] } : { items: [workspace] };
      },
      ensurePersonalWorkspace: async (ownerUserId: string, handle: string) => {
        ensureCalls.push({ ownerUserId, handle });
        return workspace;
      },
      createWorkspace: async () => {
        createCalls += 1;
        throw new Error("Workspace bootstrap must use the canonical ensure");
      },
    },
  } as ControlPlaneOperations;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const request = new Request("https://app.example.test/api/v1/workspaces");
    const response = await handleWorkspaces(
      {
        request,
        url: new URL(request.url),
        operations,
        store,
        session: { subject: "tsub_owner" },
      },
      ["workspaces"],
      "GET",
    );
    expect(response?.status).toBe(200);
  }

  expect(ensureCalls).toEqual([
    { ownerUserId: "tsub_owner", handle: "owner" },
    { ownerUserId: "tsub_owner", handle: "owner" },
  ]);
  expect(createCalls).toBe(0);
  expect(fixture.workspacePageCalls).toHaveLength(3);
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
      session: { subject: "tsub_member" },
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

test("Dashboard overview shares one deadline across sequential optional projections", async () => {
  const fixture = operationsFixture();
  const capsule = {
    id: "cap_slow",
    workspaceId: workspace.id,
    projectId: "prj_default_ws_owner",
    name: "slow service",
    slug: "slow-service",
    sourceId: "src_git",
    installConfigId: "cfg_slow",
    environment: "production",
    currentStateGeneration: 1,
    currentStateVersionId: "sv_slow",
    status: "active" as const,
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
  };
  let referencedConfigLookups = 0;
  const operations = {
    ...fixture.operations,
    capsules: {
      ...fixture.operations.capsules,
      listCapsulesPage: async () => ({ items: [capsule] }),
      listInstallConfigUnionPage: async () => ({ items: [] }),
      getInstallConfigsByIds: async () => {
        referencedConfigLookups += 1;
        return await new Promise<never>(() => {
          // This sequential fallback must inherit the already-spent route
          // deadline instead of starting another 1.2 second wait.
        });
      },
    },
    activity: { list: async () => [] },
    listStateVersionsByIds: async () =>
      await new Promise<never>(() => {
        // First sequential optional projection consumes the shared deadline.
      }),
  } as unknown as ControlPlaneOperations;
  const request = new Request(
    `https://app.example.test/api/v1/dashboard/overview?workspaceId=${workspace.id}&includeWorkspaces=false`,
  );
  const startedAt = Date.now();
  const response = await handleDashboard(
    context(operations, request),
    ["dashboard", "overview"],
    "GET",
  );

  expect(response?.status).toBe(200);
  const body = await response?.json();
  expect(body.currentStateVersions).toEqual([]);
  expect(body.installConfigs).toEqual([]);
  expect(referencedConfigLookups).toBe(1);
  expect(Date.now() - startedAt).toBeLessThan(2_000);
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

test("Capsule create rejects the retired managed-hostname input", async () => {
  const fixture = operationsFixture();
  const request = new Request(
    `https://app.example.test/api/v1/workspaces/${workspace.id}/capsules`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "retired-hostname",
        environment: "prod",
        sourceId: "src_git",
        installConfigId: "cfg_default",
        managedPublicHostname: { mode: "vanity" },
      }),
    },
  );

  const response = await handleWorkspaces(
    context(fixture.operations, request),
    ["workspaces", workspace.id, "capsules"],
    "POST",
  );

  expect(response?.status).toBe(400);
  expect(await response?.json()).toMatchObject({
    error: {
      code: "invalid_request",
      message: "body contains unknown fields: managedPublicHostname",
    },
  });
  expect(fixture.capsuleCreates).toEqual([]);
});

test("Capsule ProviderBindings accept only the canonical route and payload", async () => {
  const fixture = operationsFixture();
  const bindings = [
    {
      provider: "registry.opentofu.org/hashicorp/aws",
      moduleLocalName: "primary",
      childAlias: "archive",
      rootAlias: "production",
      alias: "legacy",
      connectionId: "conn_1",
      region: "us-east-1",
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

  const read = await handleCapsules(
    context(
      fixture.operations,
      new Request(
        "https://app.example.test/api/v1/capsules/cap_1/provider-bindings",
      ),
    ),
    ["capsules", "cap_1", "provider-bindings"],
    "GET",
  );
  expect(read?.status).toBe(200);
  expect(await read?.json()).toMatchObject({
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

test("Capsule ProviderBindings project current release-owned run policy", async () => {
  const fixture = operationsFixture();
  const provider = "registry.terraform.io/tako0614/takoform";
  fixture.operations.connections.listProviderConnections = async () => [
    {
      id: "conn_release_takoform_policy",
      provider,
      providerSource: provider,
      kind: "generic",
      scope: "operator",
      status: "verified",
      materialization: "run-issued",
      envNames: ["TAKOFORM_ENDPOINT", "TAKOFORM_SPACE", "TAKOFORM_TOKEN"],
      runCredentialSettings: { requiredAvailableMinor: 2300 },
      credentialRecipe: {
        id: "takoserver-takoform-run-v1",
        authMode: "broker",
        runIssuance: {
          context: "capsule-run.v1",
          operatorConnection: "workspace-bindable",
          storedMaterial: "none",
          audience: "takosumi-hosted.takoform.v1",
          scopes: ["takoform.run"],
        },
      },
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
    },
  ];
  const request = new Request(
    "https://app.example.test/api/v1/capsules/cap_1/provider-bindings",
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bindings: [
          {
            provider,
            connectionId: "conn_release_takoform_policy",
            runCredentialSettings: { requiredAvailableMinor: 100 },
          },
        ],
      }),
    },
  );

  const response = await handleCapsules(
    context(fixture.operations, request),
    ["capsules", "cap_1", "provider-bindings"],
    "PUT",
  );

  expect(response?.status).toBe(200);
  expect(await response?.json()).toMatchObject({
    providerBindingSet: {
      bindings: [
        {
          provider,
          connectionId: "conn_release_takoform_policy",
          runCredentialSettings: { requiredAvailableMinor: 2300 },
        },
      ],
    },
  });
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
