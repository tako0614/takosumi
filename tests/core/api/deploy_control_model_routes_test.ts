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
    startWorkerDaemon: false,
  });
}

async function createSpace(
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
  return (await res.json()).space.id as string;
}

async function createSource(
  app: { request: (path: string, init?: RequestInit) => Promise<Response> },
  spaceId: string,
): Promise<string> {
  const res = await app.request("/internal/v1/sources", {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify({
      spaceId,
      name: "repo",
      url: "https://github.com/acme/repo.git",
    }),
  });
  expect(res.status).toBe(201);
  return (await res.json()).source.id as string;
}

/**
 * Seeds a deterministic space-scoped InstallConfig through the in-process
 * operations facade so the Installation-create tests exercise a Space-owned
 * config instead of the shared boot-seeded defaults.
 */
async function seedInstallConfig(
  operations: {
    installations: {
      putInstallConfig: (config: InstallConfig) => Promise<InstallConfig>;
    };
  },
  spaceId: string,
): Promise<string> {
  const nowIso = new Date(0).toISOString();
  const config: InstallConfig = {
    id: "cfg_test00000001",
    spaceId,
    name: "test-module",
    sourceKind: "generic_capsule",
    installType: "opentofu_module",
    trustLevel: "space",
    variableMapping: {},
    outputAllowlist: {},
    policy: {},
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  await operations.installations.putInstallConfig(config);
  return config.id;
}

test("model e2e: create Space -> read Space -> list Spaces", async () => {
  const { app } = await service();
  const spaceId = await createSpace(app, "acme");

  const getRes = await app.request(`/internal/v1/workspaces/${spaceId}`, {
    headers: headers(),
  });
  expect(getRes.status).toBe(200);
  expect((await getRes.json()).space.handle).toBe("acme");

  const listRes = await app.request("/internal/v1/workspaces", {
    headers: headers(),
  });
  expect(listRes.status).toBe(200);
  const spaces = (await listRes.json()).spaces as Array<{ id: string }>;
  expect(spaces.some((s) => s.id === spaceId)).toBe(true);
});

test("model e2e: duplicate handle is a 409 failed_precondition", async () => {
  const { app } = await service();
  await createSpace(app, "dup");

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

test("model e2e: create Installation -> list -> 409 on duplicate name+environment", async () => {
  const { app, operations } = await service();
  const spaceId = await createSpace(app, "shop");
  const sourceId = await createSource(app, spaceId);
  const installConfigId = await seedInstallConfig(operations, spaceId);

  const createRes = await app.request(
    `/internal/v1/workspaces/${spaceId}/capsules`,
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
  expect(capsule.spaceId).toBe(spaceId);
  expect(capsule.name).toBe("web");
  expect(capsule.environment).toBe("production");
  expect(capsule.status).toBe("pending");
  const capsuleId = capsule.id as string;

  const listRes = await app.request(
    `/internal/v1/workspaces/${spaceId}/capsules`,
    {
      headers: headers(),
    },
  );
  expect(listRes.status).toBe(200);
  const capsules = (await listRes.json()).capsules as Array<{
    id: string;
  }>;
  expect(capsules.some((i) => i.id === capsuleId)).toBe(true);

  // A different environment is allowed (UNIQUE is per space+name+environment).
  const previewRes = await app.request(
    `/internal/v1/workspaces/${spaceId}/capsules`,
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
    `/internal/v1/workspaces/${spaceId}/capsules`,
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

test("model e2e: create Installation with vars clones a Space-scoped InstallConfig", async () => {
  const { app, operations } = await service();
  const spaceId = await createSpace(app, "vars");
  const sourceId = await createSource(app, spaceId);
  const installConfigId = await seedInstallConfig(operations, spaceId);

  const createRes = await app.request(
    `/internal/v1/workspaces/${spaceId}/capsules`,
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
  expect(createRes.status).toBe(201);
  const capsule = (await createRes.json()).capsule as {
    installConfigId: string;
  };
  expect(capsule.installConfigId).not.toBe(installConfigId);

  const config = await operations.installations.getInstallConfig(
    capsule.installConfigId,
  );
  expect(config.spaceId).toBe(spaceId);
  expect(config.internal).toEqual({ reason: "per_install_overrides" });
  expect(config.variableMapping).toEqual({
    project_name: "takos-vars",
    cloudflare: {},
  });
  expect(config.outputAllowlist).toEqual({
    launch_url: { from: "launch_url", type: "url" },
    url: { from: "url", type: "url" },
    public_url: { from: "public_url", type: "url" },
    api_url: { from: "api_url", type: "url" },
    app_deployment: { from: "app_deployment", type: "json" },
    service_exports: { from: "service_exports", type: "json" },
    worker_name: { from: "worker_name", type: "string" },
  });
});

test("model e2e: create Capsule stores the managed vanity-hostname choice in its scoped config", async () => {
  const { app, operations } = await service();
  const spaceId = await createSpace(app, "vanity-host");
  const sourceId = await createSource(app, spaceId);
  const installConfigId = await seedInstallConfig(operations, spaceId);

  const createRes = await app.request(
    `/internal/v1/workspaces/${spaceId}/capsules`,
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
  const config = await operations.installations.getInstallConfig(
    capsule.installConfigId,
  );
  expect(config.managedPublicHostname).toEqual({ mode: "vanity" });
});

test("model e2e: create Installation expands dotted vars into object inputs", async () => {
  const { app, operations } = await service();
  const spaceId = await createSpace(app, "dotted-vars");
  const sourceId = await createSource(app, spaceId);
  const installConfigId = await seedInstallConfig(operations, spaceId);

  const createRes = await app.request(
    `/internal/v1/workspaces/${spaceId}/capsules`,
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

  const config = await operations.installations.getInstallConfig(
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

test("model e2e: create Installation with runnerId and outputAllowlist stores a scoped InstallConfig", async () => {
  const { app, operations } = await service();
  const spaceId = await createSpace(app, "runner-profile");
  const sourceId = await createSource(app, spaceId);
  const installConfigId = await seedInstallConfig(operations, spaceId);

  const createRes = await app.request(
    `/internal/v1/workspaces/${spaceId}/capsules`,
    {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify({
        name: "generic",
        environment: "production",
        sourceId,
        installConfigId,
        runnerId: "generic-opentofu-provider",
        outputAllowlist: {
          app_deployment: {
            from: "app_deployment",
            type: "json",
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

  const config = await operations.installations.getInstallConfig(
    capsule.installConfigId,
  );
  expect(config.spaceId).toBe(spaceId);
  expect(config.internal).toEqual({ reason: "per_install_overrides" });
  expect(config.runnerId).toBe("generic-opentofu-provider");
  expect(config.variableMapping).toEqual({});
  expect(config.outputAllowlist).toEqual({
    app_deployment: { from: "app_deployment", type: "json", required: true },
  });

  const listRes = await app.request(
    `/internal/v1/install-configs?spaceId=${spaceId}`,
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

test("model e2e: create Installation with modulePath stores a scoped InstallConfig", async () => {
  const { app, operations } = await service();
  const spaceId = await createSpace(app, "module-path");
  const sourceId = await createSource(app, spaceId);
  const installConfigId = await seedInstallConfig(operations, spaceId);

  const createRes = await app.request(
    `/internal/v1/workspaces/${spaceId}/capsules`,
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

  const config = await operations.installations.getInstallConfig(
    capsule.installConfigId,
  );
  expect(config.spaceId).toBe(spaceId);
  expect(config.internal).toEqual({ reason: "per_install_overrides" });
  expect(config.modulePath).toBe("deploy/opentofu");
});

test("model e2e: create Installation accepts repo-root modulePath", async () => {
  const { app, operations } = await service();
  const spaceId = await createSpace(app, "module-root");
  const sourceId = await createSource(app, spaceId);
  const installConfigId = await seedInstallConfig(operations, spaceId);

  const createRes = await app.request(
    `/internal/v1/workspaces/${spaceId}/capsules`,
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
  const config = await operations.installations.getInstallConfig(
    capsule.installConfigId,
  );
  expect(config.internal).toEqual({ reason: "per_install_overrides" });
  expect(config.modulePath).toBeUndefined();
});

test("model e2e: create Installation rejects non-object vars", async () => {
  const { app, operations } = await service();
  const spaceId = await createSpace(app, "bad-vars");
  const sourceId = await createSource(app, spaceId);
  const installConfigId = await seedInstallConfig(operations, spaceId);

  const createRes = await app.request(
    `/internal/v1/workspaces/${spaceId}/capsules`,
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

test("model e2e: create Installation rejects conflicting dotted vars", async () => {
  const { app, operations } = await service();
  const spaceId = await createSpace(app, "bad-dotted-vars");
  const sourceId = await createSource(app, spaceId);
  const installConfigId = await seedInstallConfig(operations, spaceId);

  const createRes = await app.request(
    `/internal/v1/workspaces/${spaceId}/capsules`,
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
  const spaceId = await createSpace(app, "reader");
  const sourceId = await createSource(app, spaceId);
  const installConfigId = await seedInstallConfig(operations, spaceId);

  const createRes = await app.request(
    `/internal/v1/workspaces/${spaceId}/capsules`,
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
  expect(body.capsule.spaceId).toBe(spaceId);
  expect(body.capsule.currentStateGeneration).toBe(0);
  expect(body.capsule.installType).toBeUndefined();
});

test("model e2e: DELETE abandons an unapplied Capsule without a destroy plan", async () => {
  const { app, operations } = await service();
  const spaceId = await createSpace(app, "abandon");
  const sourceId = await createSource(app, spaceId);
  const installConfigId = await seedInstallConfig(operations, spaceId);

  const createRes = await app.request(
    `/internal/v1/workspaces/${spaceId}/capsules`,
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
  expect((await operations.installations.getCapsule(capsuleId)).status).toBe(
    "destroyed",
  );
});

test("model e2e: install-configs lists the space's configured install config", async () => {
  const { app, operations } = await service();
  const spaceId = await createSpace(app, "configs");
  const installConfigId = await seedInstallConfig(operations, spaceId);

  const res = await app.request(
    `/internal/v1/install-configs?spaceId=${spaceId}`,
    { headers: headers() },
  );
  expect(res.status).toBe(200);
  const configs = (await res.json()).installConfigs as Array<{
    id: string;
    sourceKind?: string;
    installType?: string;
    templateBinding?: unknown;
  }>;
  expect(configs.some((cfg) => cfg.id === installConfigId)).toBe(true);
  const config = configs.find((cfg) => cfg.id === installConfigId);
  expect(config?.sourceKind).toBe("generic_capsule");
  expect(config?.installType).toBeUndefined();
  expect(config?.templateBinding).toBeUndefined();
});

test("model e2e: plan without a SourceSnapshot is a 409 source_sync_required", async () => {
  const { app, operations } = await service();
  const spaceId = await createSpace(app, "planner");
  const sourceId = await createSource(app, spaceId);
  const installConfigId = await seedInstallConfig(operations, spaceId);

  const createRes = await app.request(
    `/internal/v1/workspaces/${spaceId}/capsules`,
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
});

async function createInstallation(
  app: { request: (path: string, init?: RequestInit) => Promise<Response> },
  spaceId: string,
  sourceId: string,
  installConfigId: string,
  name: string,
): Promise<string> {
  const res = await app.request(`/internal/v1/workspaces/${spaceId}/capsules`, {
    method: "POST",
    headers: headers({ "content-type": "application/json" }),
    body: JSON.stringify({
      name,
      environment: "production",
      sourceId,
      installConfigId,
    }),
  });
  expect(res.status).toBe(201);
  return (await res.json()).capsule.id as string;
}

test("model e2e: dependency create -> list -> 409 on cycle -> delete", async () => {
  const { app, operations } = await service();
  const spaceId = await createSpace(app, "deps");
  const sourceId = await createSource(app, spaceId);
  const installConfigId = await seedInstallConfig(operations, spaceId);
  const producer = await createInstallation(
    app,
    spaceId,
    sourceId,
    installConfigId,
    "producer",
  );
  const consumer = await createInstallation(
    app,
    spaceId,
    sourceId,
    installConfigId,
    "consumer",
  );

  // Create a producer -> consumer edge (consumer is the path installation).
  const createRes = await app.request(
    `/internal/v1/capsules/${consumer}/dependencies`,
    {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify({
        producerInstallationId: producer,
        mode: "variable_injection",
        visibility: "space",
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
  expect(dependency.producerInstallationId).toBe(producer);
  expect(dependency.consumerInstallationId).toBe(consumer);
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
        producerInstallationId: consumer,
        mode: "variable_injection",
        visibility: "space",
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

test("model e2e: a dependency to a producer in another space is rejected", async () => {
  const { app, operations } = await service();
  const spaceA = await createSpace(app, "depsa");
  const sourceA = await createSource(app, spaceA);
  const configA = await seedInstallConfig(operations, spaceA);
  const consumer = await createInstallation(
    app,
    spaceA,
    sourceA,
    configA,
    "consumer",
  );

  const spaceB = await createSpace(app, "depsb");
  const sourceB = await createSource(app, spaceB);
  // A second space-scoped config under spaceB (distinct id from configA).
  const nowIso = new Date(0).toISOString();
  await operations.installations.putInstallConfig({
    id: "cfg_test00000002",
    spaceId: spaceB,
    name: "test-module-b",
    installType: "opentofu_module",
    trustLevel: "space",
    variableMapping: {},
    outputAllowlist: {},
    policy: {},
    createdAt: nowIso,
    updatedAt: nowIso,
  });
  const foreignProducer = await createInstallation(
    app,
    spaceB,
    sourceB,
    "cfg_test00000002",
    "producer",
  );

  // consumer is in spaceA; producer is in spaceB. The consumer-path edge is
  // gated by spaceA, but the producer belongs to spaceB -> failed_precondition.
  const res = await app.request(
    `/internal/v1/capsules/${consumer}/dependencies`,
    {
      method: "POST",
      headers: headers({ "content-type": "application/json" }),
      body: JSON.stringify({
        producerInstallationId: foreignProducer,
        mode: "variable_injection",
        visibility: "space",
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
