import { expect, test } from "bun:test";

import { createTakosumiService } from "../../../core/bootstrap.ts";
import type { InstallConfig } from "takosumi-contract/install-configs";

const TOKEN = "deploy-control-token";

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}`, ...extra };
}

async function service() {
  return await createTakosumiService({
    role: "takosumi-api",
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

test("model e2e: create Capsule -> list -> 409 on duplicate name+environment", async () => {
  const { app, operations } = await service();
  const workspaceId = await createWorkspace(app, "shop");
  const sourceId = await createSource(app, workspaceId);
  const installConfigId = await seedInstallConfig(operations, workspaceId);

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
      }),
    },
  );
  expect(createRes.status).toBe(201);
  const capsule = (await createRes.json()).capsule;
  expect(capsule.workspaceId).toBe(workspaceId);
  expect(capsule.name).toBe("web");
  expect(capsule.environment).toBe("production");
  expect(capsule.status).toBe("pending");
  const capsuleId = capsule.id as string;

  const listRes = await app.request(
    `/internal/v1/workspaces/${workspaceId}/capsules`,
    {
      headers: headers(),
    },
  );
  expect(listRes.status).toBe(200);
  const capsules = (await listRes.json()).capsules as Array<{
    id: string;
  }>;
  expect(capsules.some((i) => i.id === capsuleId)).toBe(true);

  // A different environment is allowed (UNIQUE is per workspace+name+environment).
  const previewRes = await app.request(
    `/internal/v1/workspaces/${workspaceId}/capsules`,
    {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify({
        name: "web",
        environment: "preview",
        sourceId,
        installConfigId,
      }),
    },
  );
  expect(previewRes.status).toBe(201);

  // Same name + environment is a 409 failed_precondition.
  const dupRes = await app.request(
    `/internal/v1/workspaces/${workspaceId}/capsules`,
    {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify({
        name: "web",
        environment: "production",
        sourceId,
        installConfigId,
      }),
    },
  );
  expect(dupRes.status).toBe(409);
  expect((await dupRes.json()).error.code).toBe("failed_precondition");
});

test("model e2e: create Capsule with vars clones a Workspace-scoped InstallConfig", async () => {
  const { app, operations } = await service();
  const workspaceId = await createWorkspace(app, "vars");
  const sourceId = await createSource(app, workspaceId);
  const installConfigId = await seedInstallConfig(operations, workspaceId);

  const createRes = await app.request(
    `/internal/v1/workspaces/${workspaceId}/capsules`,
    {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify({
        name: "takos",
        environment: "production",
        sourceId,
        installConfigId,
        vars: { project_name: "takos-vars", cloudflare: {} },
      }),
    },
  );
  const createBody = await createRes.json();
  expect({ status: createRes.status, body: createBody }).toMatchObject({
    status: 201,
  });
  const capsule = createBody.capsule as {
    installConfigId: string;
  };
  expect(capsule.installConfigId).not.toBe(installConfigId);

  const config = await operations.capsules.getInstallConfig(
    capsule.installConfigId,
  );
  expect(config.workspaceId).toBe(workspaceId);
  expect(config.internal).toEqual({ reason: "per_install_overrides" });
  expect(config.variableMapping).toEqual({
    project_name: "takos-vars",
    cloudflare: {},
  });
  expect(config.outputAllowlist).toEqual({});
});

test("model e2e: create Capsule stores explicit Interface blueprints in its scoped InstallConfig", async () => {
  const { app, operations } = await service();
  const workspaceId = await createWorkspace(app, "interface-blueprints");
  const sourceId = await createSource(app, workspaceId);
  const installConfigId = await seedInstallConfig(operations, workspaceId);
  const interfaceBlueprints = [
    {
      key: "takos.mcp",
      name: "app.storage.mcp",
      spec: {
        type: "mcp.server",
        version: "2025-11-25",
        document: { transport: "streamable-http" },
        inputs: {
          endpoint: {
            source: "capsule_output",
            outputName: "mcp_url",
          },
        },
        access: {
          visibility: "workspace",
          resourceUriInput: "endpoint",
        },
      },
      bindings: [
        {
          key: "installing-principal",
          subjectRef: { kind: "Principal", id: "principal_pairwise_1" },
          permissions: ["mcp.invoke"],
          delivery: { type: "none" },
        },
      ],
    },
  ];

  const createRes = await app.request(
    `/internal/v1/workspaces/${workspaceId}/capsules`,
    {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify({
        name: "storage",
        environment: "production",
        sourceId,
        installConfigId,
        interfaceBlueprints,
      }),
    },
  );

  const createBody = await createRes.json();
  expect({ status: createRes.status, body: createBody }).toMatchObject({
    status: 201,
  });
  const capsule = createBody.capsule as {
    installConfigId: string;
  };
  expect(capsule.installConfigId).not.toBe(installConfigId);
  const config = await operations.capsules.getInstallConfig(
    capsule.installConfigId,
  );
  expect(config.workspaceId).toBe(workspaceId);
  expect(config.internal).toEqual({ reason: "per_install_overrides" });
  expect(config.interfaceBlueprints).toEqual(interfaceBlueprints);
});

test("model e2e: a service-side installer binding is fixed to the authenticated Principal", async () => {
  const { app, operations } = await service();
  const workspaceId = await createWorkspace(app, "installer-binding");
  const sourceId = await createSource(app, workspaceId);
  const installConfigId = await seedInstallConfig(operations, workspaceId);
  const baseConfig =
    await operations.capsules.getInstallConfig(installConfigId);
  await operations.capsules.putInstallConfig({
    ...baseConfig,
    interfaceBlueprints: [
      {
        key: "launcher",
        name: "app.launcher",
        spec: {
          type: "interface.ui.surface",
          version: "1",
          document: { launcher: true },
          inputs: {
            url: { source: "capsule_output", outputName: "launch_url" },
          },
          access: { visibility: "workspace" },
        },
        bindings: [
          {
            key: "launcher.installer",
            subject: { source: "installing_principal" },
            permissions: ["ui.open"],
            delivery: { type: "none" },
          },
        ],
      },
    ],
  });

  const createRes = await app.request(
    `/internal/v1/workspaces/${workspaceId}/capsules`,
    {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify({
        name: "launcher",
        environment: "production",
        sourceId,
        installConfigId,
      }),
    },
  );
  const createBody = await createRes.json();
  expect({ status: createRes.status, body: createBody }).toMatchObject({
    status: 201,
  });
  const capsule = createBody.capsule as { installConfigId: string };
  expect(capsule.installConfigId).not.toBe(installConfigId);
  const scopedConfig = await operations.capsules.getInstallConfig(
    capsule.installConfigId,
  );
  expect(scopedConfig.interfaceBlueprints?.[0]?.bindings?.[0]).toEqual({
    key: "launcher.installer",
    subjectRef: { kind: "Principal", id: "deploy-control-bearer" },
    permissions: ["ui.open"],
    delivery: { type: "none" },
  });
});

test("model e2e: create Capsule stores the managed vanity-hostname choice in its scoped config", async () => {
  const { app, operations } = await service();
  const workspaceId = await createWorkspace(app, "vanity-host");
  const sourceId = await createSource(app, workspaceId);
  const installConfigId = await seedInstallConfig(operations, workspaceId);

  const createRes = await app.request(
    `/internal/v1/workspaces/${workspaceId}/capsules`,
    {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify({
        name: "takos",
        environment: "production",
        sourceId,
        installConfigId,
        managedPublicHostname: { mode: "vanity" },
      }),
    },
  );

  expect(createRes.status).toBe(201);
  const capsule = (await createRes.json()).capsule as {
    installConfigId: string;
  };
  expect(capsule.installConfigId).not.toBe(installConfigId);
  const config = await operations.capsules.getInstallConfig(
    capsule.installConfigId,
  );
  expect(config.managedPublicHostname).toEqual({ mode: "vanity" });
});

test("model e2e: create Capsule expands dotted vars into object inputs", async () => {
  const { app, operations } = await service();
  const workspaceId = await createWorkspace(app, "dotted-vars");
  const sourceId = await createSource(app, workspaceId);
  const installConfigId = await seedInstallConfig(operations, workspaceId);

  const createRes = await app.request(
    `/internal/v1/workspaces/${workspaceId}/capsules`,
    {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify({
        name: "takos",
        environment: "production",
        sourceId,
        installConfigId,
        vars: {
          project_name: "takos-vars",
          cloudflare: { zone_id: "zone_123" },
          "cloudflare.workers_subdomain": "shoutatomiyama0614",
        },
      }),
    },
  );
  expect(createRes.status).toBe(201);
  const capsule = (await createRes.json()).capsule as {
    installConfigId: string;
  };

  const config = await operations.capsules.getInstallConfig(
    capsule.installConfigId,
  );
  expect(config.variableMapping).toEqual({
    project_name: "takos-vars",
    cloudflare: {
      zone_id: "zone_123",
      workers_subdomain: "shoutatomiyama0614",
    },
  });
});

test("model e2e: create Capsule with runnerId and outputAllowlist stores a scoped InstallConfig", async () => {
  const { app, operations } = await service();
  const workspaceId = await createWorkspace(app, "runner-profile");
  const sourceId = await createSource(app, workspaceId);
  const installConfigId = await seedInstallConfig(operations, workspaceId);

  const createRes = await app.request(
    `/internal/v1/workspaces/${workspaceId}/capsules`,
    {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify({
        name: "generic",
        environment: "production",
        sourceId,
        installConfigId,
        runnerId: "opentofu-default",
        outputAllowlist: {
          url: {
            from: "url",
            type: "string",
            required: true,
          },
        },
      }),
    },
  );
  expect(createRes.status).toBe(201);
  const capsule = (await createRes.json()).capsule as {
    installConfigId: string;
    runnerId?: string;
  };
  expect(capsule.installConfigId).not.toBe(installConfigId);
  expect(capsule.runnerId).toBeUndefined();

  const config = await operations.capsules.getInstallConfig(
    capsule.installConfigId,
  );
  expect(config.workspaceId).toBe(workspaceId);
  expect(config.internal).toEqual({ reason: "per_install_overrides" });
  expect(config.runnerId).toBe("opentofu-default");
  expect(config.variableMapping).toEqual({});
  expect(config.outputAllowlist).toEqual({
    url: { from: "url", type: "string", required: true },
  });

  const listRes = await app.request(
    `/internal/v1/install-configs?workspaceId=${workspaceId}`,
    { headers: headers() },
  );
  expect(listRes.status).toBe(200);
  const listed = (await listRes.json()).installConfigs as Array<{
    id: string;
    internal?: unknown;
    runnerId?: string;
  }>;
  expect(listed.some((item) => item.id === config.id)).toBe(false);
  expect(listed.every((item) => item.internal === undefined)).toBe(true);
  expect(listed.every((item) => item.runnerId === undefined)).toBe(true);
});

test("model e2e: create Capsule with modulePath stores a scoped InstallConfig", async () => {
  const { app, operations } = await service();
  const workspaceId = await createWorkspace(app, "module-path");
  const sourceId = await createSource(app, workspaceId);
  const installConfigId = await seedInstallConfig(operations, workspaceId);

  const createRes = await app.request(
    `/internal/v1/workspaces/${workspaceId}/capsules`,
    {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify({
        name: "takos",
        environment: "staging",
        sourceId,
        installConfigId,
        modulePath: "deploy/opentofu",
      }),
    },
  );
  expect(createRes.status).toBe(201);
  const capsule = (await createRes.json()).capsule as {
    installConfigId: string;
  };
  expect(capsule.installConfigId).not.toBe(installConfigId);

  const config = await operations.capsules.getInstallConfig(
    capsule.installConfigId,
  );
  expect(config.workspaceId).toBe(workspaceId);
  expect(config.internal).toEqual({ reason: "per_install_overrides" });
  expect(config.modulePath).toBe("deploy/opentofu");
});

test("model e2e: create Capsule accepts repo-root modulePath", async () => {
  const { app, operations } = await service();
  const workspaceId = await createWorkspace(app, "module-root");
  const sourceId = await createSource(app, workspaceId);
  const installConfigId = await seedInstallConfig(operations, workspaceId);

  const createRes = await app.request(
    `/internal/v1/workspaces/${workspaceId}/capsules`,
    {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify({
        name: "yurucommu",
        environment: "staging",
        sourceId,
        installConfigId,
        modulePath: ".",
      }),
    },
  );
  expect(createRes.status).toBe(201);
  const capsule = (await createRes.json()).capsule as {
    installConfigId: string;
  };
  const config = await operations.capsules.getInstallConfig(
    capsule.installConfigId,
  );
  expect(config.internal).toEqual({ reason: "per_install_overrides" });
  expect(config.modulePath).toBeUndefined();
});

test("model e2e: create Capsule rejects non-object vars", async () => {
  const { app, operations } = await service();
  const workspaceId = await createWorkspace(app, "bad-vars");
  const sourceId = await createSource(app, workspaceId);
  const installConfigId = await seedInstallConfig(operations, workspaceId);

  const createRes = await app.request(
    `/internal/v1/workspaces/${workspaceId}/capsules`,
    {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify({
        name: "takos",
        environment: "production",
        sourceId,
        installConfigId,
        vars: "project_name=takos",
      }),
    },
  );
  expect(createRes.status).toBe(400);
  const body = await createRes.json();
  expect(body.error.message).toContain("vars must be an object");
});

test("model e2e: create Capsule rejects conflicting dotted vars", async () => {
  const { app, operations } = await service();
  const workspaceId = await createWorkspace(app, "bad-dotted-vars");
  const sourceId = await createSource(app, workspaceId);
  const installConfigId = await seedInstallConfig(operations, workspaceId);

  const createRes = await app.request(
    `/internal/v1/workspaces/${workspaceId}/capsules`,
    {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify({
        name: "takos",
        environment: "production",
        sourceId,
        installConfigId,
        vars: {
          cloudflare: "not-an-object",
          "cloudflare.workers_subdomain": "shoutatomiyama0614",
        },
      }),
    },
  );
  expect(createRes.status).toBe(400);
  const body = await createRes.json();
  expect(body.error.message).toContain("conflicts with another variable path");
});

test("model e2e: GET /internal/v1/capsules/{id} returns the new shape", async () => {
  const { app, operations } = await service();
  const workspaceId = await createWorkspace(app, "reader");
  const sourceId = await createSource(app, workspaceId);
  const installConfigId = await seedInstallConfig(operations, workspaceId);

  const createRes = await app.request(
    `/internal/v1/workspaces/${workspaceId}/capsules`,
    {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify({
        name: "api",
        environment: "production",
        sourceId,
        installConfigId,
      }),
    },
  );
  expect(createRes.status).toBe(201);
  const capsuleId = (await createRes.json()).capsule.id as string;

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

  const createRes = await app.request(
    `/internal/v1/workspaces/${workspaceId}/capsules`,
    {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify({
        name: "broken",
        environment: "production",
        sourceId,
        installConfigId,
      }),
    },
  );
  expect(createRes.status).toBe(201);
  const capsuleId = (await createRes.json()).capsule.id as string;

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

  const createRes = await app.request(
    `/internal/v1/workspaces/${workspaceId}/capsules`,
    {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify({
        name: "svc",
        environment: "production",
        sourceId,
        installConfigId,
      }),
    },
  );
  expect(createRes.status).toBe(201);
  const capsuleId = (await createRes.json()).capsule.id as string;

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
  app: { request: (path: string, init?: RequestInit) => Promise<Response> },
  workspaceId: string,
  sourceId: string,
  installConfigId: string,
  name: string,
): Promise<string> {
  const res = await app.request(
    `/internal/v1/workspaces/${workspaceId}/capsules`,
    {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify({
        name,
        environment: "production",
        sourceId,
        installConfigId,
      }),
    },
  );
  expect(res.status).toBe(201);
  return (await res.json()).capsule.id as string;
}

test("model e2e: dependency create -> list -> 409 on cycle -> delete", async () => {
  const { app, operations } = await service();
  const workspaceId = await createWorkspace(app, "deps");
  const sourceId = await createSource(app, workspaceId);
  const installConfigId = await seedInstallConfig(operations, workspaceId);
  const producer = await createCapsule(
    app,
    workspaceId,
    sourceId,
    installConfigId,
    "producer",
  );
  const consumer = await createCapsule(
    app,
    workspaceId,
    sourceId,
    installConfigId,
    "consumer",
  );

  // Create a producer -> consumer edge (consumer is the path capsule).
  const createRes = await app.request(
    `/internal/v1/capsules/${consumer}/dependencies`,
    {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify({
        producerCapsuleId: producer,
        mode: "variable_injection",
        visibility: "workspace",
        outputs: {
          base_domain: {
            from: "base_domain",
            to: "base_domain",
            required: true,
          },
        },
      }),
    },
  );
  expect(createRes.status).toBe(201);
  const dependency = (await createRes.json()).dependency;
  expect(dependency.producerCapsuleId).toBe(producer);
  expect(dependency.consumerCapsuleId).toBe(consumer);
  const dependencyId = dependency.id as string;

  // List from the consumer: it appears as a consumer-side edge.
  const listRes = await app.request(
    `/internal/v1/capsules/${consumer}/dependencies`,
    { headers: headers() },
  );
  expect(listRes.status).toBe(200);
  const list = await listRes.json();
  expect(list.asConsumer).toHaveLength(1);
  expect(list.asProducer).toHaveLength(0);

  // The reverse edge (producer depends on consumer) would close a cycle: 409.
  const cycleRes = await app.request(
    `/internal/v1/capsules/${producer}/dependencies`,
    {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify({
        producerCapsuleId: consumer,
        mode: "variable_injection",
        visibility: "workspace",
        outputs: {
          x: { from: "x", to: "x", required: true },
        },
      }),
    },
  );
  expect(cycleRes.status).toBe(409);
  expect((await cycleRes.json()).error.code).toBe("failed_precondition");

  // Delete the edge.
  const deleteRes = await app.request(
    `/internal/v1/dependencies/${dependencyId}`,
    {
      method: "DELETE",
      headers: headers(),
    },
  );
  expect(deleteRes.status).toBe(204);

  // After deletion the consumer has no edges.
  const afterRes = await app.request(
    `/internal/v1/capsules/${consumer}/dependencies`,
    { headers: headers() },
  );
  const after = await afterRes.json();
  expect(after.asConsumer).toHaveLength(0);
});

test("model e2e: a dependency to a producer in another workspace is rejected", async () => {
  const { app, operations } = await service();
  const workspaceA = await createWorkspace(app, "depsa");
  const sourceA = await createSource(app, workspaceA);
  const configA = await seedInstallConfig(operations, workspaceA);
  const consumer = await createCapsule(
    app,
    workspaceA,
    sourceA,
    configA,
    "consumer",
  );

  const workspaceB = await createWorkspace(app, "depsb");
  const sourceB = await createSource(app, workspaceB);
  // A second Workspace-scoped config under workspaceB (distinct id from configA).
  const nowIso = new Date(0).toISOString();
  await operations.capsules.putInstallConfig({
    id: "cfg_test00000002",
    workspaceId: workspaceB,
    name: "test-module-b",
    installType: "opentofu_module",
    variableMapping: {},
    outputAllowlist: {},
    policy: {},
    createdAt: nowIso,
    updatedAt: nowIso,
  });
  const foreignProducer = await createCapsule(
    app,
    workspaceB,
    sourceB,
    "cfg_test00000002",
    "producer",
  );

  // consumer is in workspaceA; producer is in workspaceB. The consumer-path
  // edge is gated by workspaceA, but the producer belongs to workspaceB.
  const res = await app.request(
    `/internal/v1/capsules/${consumer}/dependencies`,
    {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify({
        producerCapsuleId: foreignProducer,
        mode: "variable_injection",
        visibility: "workspace",
        outputs: {
          base_domain: {
            from: "base_domain",
            to: "base_domain",
            required: true,
          },
        },
      }),
    },
  );
  expect(res.status).toBe(409);
  expect((await res.json()).error.code).toBe("failed_precondition");
});

test("model e2e: unauthorized without the deploy-control bearer", async () => {
  const { app } = await service();
  const res = await app.request("/internal/v1/workspaces");
  expect(res.status).toBe(401);
});
