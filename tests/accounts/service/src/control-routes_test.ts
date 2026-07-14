import { expect, test } from "bun:test";
import type { ControlPlaneOperations } from "../../../../accounts/service/src/control-operations.ts";
import { isControlRoutePath } from "../../../../accounts/service/src/control-routes.ts";
import { handleProjects } from "../../../../accounts/service/src/control/projects.ts";
import { handleCapsules } from "../../../../accounts/service/src/control/capsules.ts";
import {
  controllerErrorResponse,
  publicDependency,
  publicOutputShare,
  type ControlDispatchContext,
} from "../../../../accounts/service/src/control/shared.ts";
import { handleWorkspaces } from "../../../../accounts/service/src/control/workspaces.ts";
import { InMemoryAccountsStore } from "../../../../accounts/service/src/store.ts";

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
      listWorkspacesForAccount: async () => [workspace],
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
  return { operations, projects, capsuleCreates };
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
