import { InMemoryGitInstallPlanStore } from "../../../core/domains/install-plans/store.ts";
import { expect, test } from "bun:test";

import { createTakosumiService } from "../../../core/bootstrap.ts";
import type { InstallConfig } from "takosumi-contract/install-configs";
import { InMemoryOpenTofuControlStore } from "../../../core/domains/deploy-control/store.ts";
import type { CapsulesService } from "../../../core/domains/capsules/mod.ts";

const TOKEN = "deploy-control-token";

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}`, ...extra };
}

async function service(opentofuControlStore?: InMemoryOpenTofuControlStore) {
  return await createTakosumiService({
    role: "takosumi-api",
    workspaceMutationsFrozen: false,
    opentofuControlStore,
    runtimeEnv: {
      TAKOSUMI_DEV_MODE: "1",
      TAKOSUMI_DEPLOY_CONTROL_TOKEN: TOKEN,
    },
  });
}

async function createWorkspace(
  app: { request: (path: string, init?: RequestInit) => Promise<Response> },
  handle: string,
): Promise<string> {
  const res = await app.request("/internal/v1/workspaces", {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify({
      handle,
      displayName: handle,
      type: "personal",
      ownerUserId: "user_test00000001",
    }),
  });
  expect(res.status).toBe(201);
  return (await res.json()).workspace.id as string;
}

async function createSource(
  app: { request: (path: string, init?: RequestInit) => Promise<Response> },
  workspaceId: string,
): Promise<string> {
  const res = await app.request("/internal/v1/sources", {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify({
      workspaceId,
      name: "repo",
      url: "https://github.com/acme/repo.git",
    }),
  });
  expect(res.status).toBe(201);
  return (await res.json()).source.id as string;
}

/**
 * Seeds a deterministic Workspace-scoped InstallConfig through the in-process
 * operations facade so the Capsule-create tests exercise a Workspace-owned
 * config instead of the shared boot-seeded defaults.
 */
async function seedInstallConfig(
  operations: {
    capsules: {
      putInstallConfig: (config: InstallConfig) => Promise<InstallConfig>;
    };
  },
  workspaceId: string,
): Promise<string> {
  const nowIso = new Date(0).toISOString();
  const config: InstallConfig = {
    id: "cfg_test00000001",
    workspaceId,
    name: "test-module",
    variableMapping: {},
    outputAllowlist: {},
    policy: {},
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  await operations.capsules.putInstallConfig(config);
  return config.id;
}

test("model e2e: create Workspace -> read Workspace -> list Workspaces", async () => {
  const { app } = await service();
  const workspaceId = await createWorkspace(app, "acme");

  const getRes = await app.request(`/internal/v1/workspaces/${workspaceId}`, {
    headers: headers(),
  });
  expect(getRes.status).toBe(200);
  expect((await getRes.json()).workspace.handle).toBe("acme");

  const listRes = await app.request("/internal/v1/workspaces", {
    headers: headers(),
  });
  expect(listRes.status).toBe(200);
  const workspaces = (await listRes.json()).workspaces as Array<{ id: string }>;
  expect(workspaces.some((workspace) => workspace.id === workspaceId)).toBe(
    true,
  );
});

test("model e2e: duplicate handle is a 409 failed_precondition", async () => {
  const { app } = await service();
  await createWorkspace(app, "dup");

  const res = await app.request("/internal/v1/workspaces", {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify({
      handle: "dup",
      displayName: "dup",
      type: "personal",
      ownerUserId: "user_other0000001",
    }),
  });
  expect(res.status).toBe(409);
  expect((await res.json()).error.code).toBe("failed_precondition");
});

test("model e2e: Workspace Capsule POST is retired after authentication", async () => {
  const { app, operations } = await service();
  const workspaceId = await createWorkspace(app, "shop");
  const sourceId = await createSource(app, workspaceId);
  const installConfigId = await seedInstallConfig(operations, workspaceId);

  const beforeCapsules = await operations.capsules.listCapsules(workspaceId);
  const beforeConfigs = await operations.capsules.listInstallConfigs(
    workspaceId,
    { includeInternal: true },
  );
  const createRes = await app.request(
    `/internal/v1/workspaces/${workspaceId}/capsules`,
    {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify({
        name: "web",
        environment: "production",
        sourceId,
        installConfigId,
        vars: { secret: "must-not-be-stored" },
      }),
    },
  );
  expect(createRes.status).toBe(405);
  expect(createRes.headers.get("allow")).toBe("GET");
  expect(await operations.capsules.listCapsules(workspaceId)).toEqual(
    beforeCapsules,
  );
  expect(
    await operations.capsules.listInstallConfigs(workspaceId, {
      includeInternal: true,
    }),
  ).toEqual(beforeConfigs);

  const unauthorized = await app.request(
    `/internal/v1/workspaces/${workspaceId}/capsules`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "web",
        environment: "production",
        sourceId,
        installConfigId,
      }),
    },
  );
  expect(unauthorized.status).toBe(401);
  expect(unauthorized.headers.get("allow")).toBeNull();
});

test("model e2e: GET /internal/v1/capsules/{id} returns the new shape", async () => {
  const { app, operations } = await service();
  const workspaceId = await createWorkspace(app, "reader");
  const sourceId = await createSource(app, workspaceId);
  const installConfigId = await seedInstallConfig(operations, workspaceId);

  const capsuleId = await createCapsule(
    operations,
    workspaceId,
    sourceId,
    installConfigId,
    "api",
  );

  const getRes = await app.request(`/internal/v1/capsules/${capsuleId}`, {
    headers: headers(),
  });
  expect(getRes.status).toBe(200);
  const body = await getRes.json();
  expect(body.capsule.id).toBe(capsuleId);
  expect(body.capsule.workspaceId).toBe(workspaceId);
  expect(body.capsule.currentStateGeneration).toBe(0);
  expect(body.capsule.installType).toBeUndefined();
});

test("model e2e: DELETE abandons an unapplied Capsule without a destroy plan", async () => {
  const { app, operations } = await service();
  const workspaceId = await createWorkspace(app, "abandon");
  const sourceId = await createSource(app, workspaceId);
  const installConfigId = await seedInstallConfig(operations, workspaceId);

  const capsuleId = await createCapsule(
    operations,
    workspaceId,
    sourceId,
    installConfigId,
    "broken",
  );

  const deleteRes = await app.request(`/internal/v1/capsules/${capsuleId}`, {
    method: "DELETE",
    headers: headers(),
  });

  expect(deleteRes.status).toBe(202);
  const body = await deleteRes.json();
  expect(body.abandoned).toBe(true);
  expect(body.run).toBeUndefined();
  expect(body.capsule.status).toBe("destroyed");
  expect((await operations.capsules.getCapsule(capsuleId)).status).toBe(
    "destroyed",
  );
  const retryRes = await app.request(`/internal/v1/capsules/${capsuleId}`, {
    method: "DELETE",
    headers: headers(),
  });
  expect(retryRes.status).toBe(200);
  expect((await retryRes.json()).alreadyDeleted).toBe(true);
});

test("model e2e: install-configs lists the workspace's configured install config", async () => {
  const { app, operations } = await service();
  const workspaceId = await createWorkspace(app, "configs");
  const installConfigId = await seedInstallConfig(operations, workspaceId);

  const res = await app.request(
    `/internal/v1/install-configs?workspaceId=${workspaceId}`,
    { headers: headers() },
  );
  expect(res.status).toBe(200);
  const configs = (await res.json()).installConfigs as Array<{
    id: string;
  }>;
  expect(configs.some((cfg) => cfg.id === installConfigId)).toBe(true);
});

test("model e2e: plan without a SourceSnapshot is a 409 source_sync_required", async () => {
  const { app, operations } = await service();
  const workspaceId = await createWorkspace(app, "planner");
  const sourceId = await createSource(app, workspaceId);
  const installConfigId = await seedInstallConfig(operations, workspaceId);

  const capsuleId = await createCapsule(
    operations,
    workspaceId,
    sourceId,
    installConfigId,
    "svc",
  );

  const planRes = await app.request(`/internal/v1/capsules/${capsuleId}/plan`, {
    method: "POST",
    headers: headers(),
  });
  expect(planRes.status).toBe(409);
  const error = (await planRes.json()).error;
  expect(error.code).toBe("failed_precondition");
  expect(error.message).toContain("source_sync_required");
  expect(error.details).toEqual({ reason: "source_sync_required" });
});

async function createCapsule(
  operations: {
    capsules: Pick<
      CapsulesService,
      "createCapsuleInitialAuthority" | "getInstallConfig"
    >;
  },
  workspaceId: string,
  sourceId: string,
  installConfigId: string,
  name: string,
): Promise<string> {
  const baseConfig = await operations.capsules.getInstallConfig(
    installConfigId,
  );
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
  const now = new Date().toISOString();
  const initial = await operations.capsules.createCapsuleInitialAuthority({
    capsuleId: `cap_${suffix}`,
    providerBindingSetId: `pbs_${suffix}`,
    workspaceId,
    name,
    environment: "production",
    sourceId,
    installingPrincipalId: "deploy-control-bearer",
    installConfig: {
      ...baseConfig,
      id: `cfg_${suffix}`,
      workspaceId,
      createdAt: now,
      updatedAt: now,
    },
    providerBindings: [],
  });
  return initial.capsule.id;
}

test("model e2e: retired Dependency routes return 404 without mutating Capsules", async () => {
  const { app, operations } = await service();
  const workspaceId = await createWorkspace(app, "deps");
  const sourceId = await createSource(app, workspaceId);
  const consumerSourceId = await createSource(app, workspaceId);
  const installConfigId = await seedInstallConfig(operations, workspaceId);
  const producer = await createCapsule(
    operations,
    workspaceId,
    sourceId,
    installConfigId,
    "producer",
  );
  const consumer = await createCapsule(
    operations,
    workspaceId,
    consumerSourceId,
    installConfigId,
    "consumer",
  );

  const before = await operations.capsules.listCapsules(workspaceId);
  const retiredEndpoints: Array<{
    method: string;
    path: string;
    body?: string;
  }> = [
    {
      method: "POST",
      path: `/internal/v1/capsules/${consumer}/dependencies`,
      body: JSON.stringify({ producerCapsuleId: producer }),
    },
    {
      method: "GET",
      path: `/internal/v1/capsules/${consumer}/dependencies`,
    },
    {
      method: "POST",
      path: `/internal/v1/capsules/${producer}/dependencies`,
      body: JSON.stringify({ producerCapsuleId: consumer }),
    },
    { method: "DELETE", path: "/internal/v1/dependencies/dep_retired0001" },
  ];

  for (const endpoint of retiredEndpoints) {
    const response = await app.request(endpoint.path, {
      method: endpoint.method,
      headers: headers({ "content-type": "application/json" }),
      ...(endpoint.body ? { body: endpoint.body } : {}),
    });
    expect(response.status).toBe(404);
  }
  expect(await operations.capsules.listCapsules(workspaceId)).toEqual(before);
});

test("model e2e: unauthorized without the deploy-control bearer", async () => {
  const { app } = await service();
  const res = await app.request("/internal/v1/workspaces");
  expect(res.status).toBe(401);
});

for (const managementState of ["draining", "frozen"] as const) {
  test(`model e2e: destroyed DELETE retries link cleanup while ${managementState}`, async () => {
    const ledger = new InMemoryOpenTofuControlStore();
    const { app, operations } = await service(ledger);
    const workspaceId = await createWorkspace(app, "replay-cleanup");
    const sourceId = await createSource(app, workspaceId);
    const configId = await seedInstallConfig(operations, workspaceId);
    const capsuleId = await createCapsule(operations, workspaceId, sourceId, configId, "retired");
    await operations.capsules.abandonUnappliedCapsule(capsuleId, "test");
    const authority = await operations.workspaces.captureManagementAuthority(workspaceId);
    expect((await ledger.beginWorkspaceDraining(workspaceId, authority)).status).toBe("started");
    if (managementState === "frozen") {
      ledger.attachGitInstallPlanStore(new InMemoryGitInstallPlanStore(ledger));
      expect((await ledger.freezeWorkspaceManagementIfQuiescent({
        workspaceId, managementState: "draining", managementEpoch: authority.managementEpoch + 1,
      })).status).toBe("frozen");
    }
    let revocations = 0;
    operations.interfaces.revokeCapsuleInterfaceLinks = async (revokedWorkspaceId, revokedCapsuleId) => {
      expect(revokedWorkspaceId).toBe(workspaceId);
      expect(revokedCapsuleId).toBe(capsuleId);
      revocations += 1;
    };
    const response = await app.request(`/internal/v1/capsules/${capsuleId}`, { method: "DELETE", headers: headers() });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ alreadyDeleted: true, capsule: { status: "destroyed" } });
    expect(revocations).toBe(1);
    expect(await ledger.listRunsByWorkspace(workspaceId)).toHaveLength(0);
  });
}
