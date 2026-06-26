import { expect, test } from "bun:test";

import { createTakosumiService } from "../../../core/bootstrap.ts";
import type { InstallConfig } from "takosumi-contract/installations";

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
  const res = await app.request("/internal/v1/spaces", {
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

  const getRes = await app.request(`/internal/v1/spaces/${spaceId}`, {
    headers: headers(),
  });
  expect(getRes.status).toBe(200);
  expect((await getRes.json()).space.handle).toBe("acme");

  const listRes = await app.request("/internal/v1/spaces", {
    headers: headers(),
  });
  expect(listRes.status).toBe(200);
  const spaces = (await listRes.json()).spaces as Array<{ id: string }>;
  expect(spaces.some((s) => s.id === spaceId)).toBe(true);
});

test("model e2e: duplicate handle is a 409 failed_precondition", async () => {
  const { app } = await service();
  await createSpace(app, "dup");

  const res = await app.request("/internal/v1/spaces", {
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
    `/internal/v1/spaces/${spaceId}/installations`,
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
  const installation = (await createRes.json()).installation;
  expect(installation.spaceId).toBe(spaceId);
  expect(installation.name).toBe("web");
  expect(installation.environment).toBe("production");
  expect(installation.status).toBe("pending");
  const installationId = installation.id as string;

  const listRes = await app.request(
    `/internal/v1/spaces/${spaceId}/installations`,
    {
      headers: headers(),
    },
  );
  expect(listRes.status).toBe(200);
  const installations = (await listRes.json()).installations as Array<{
    id: string;
  }>;
  expect(installations.some((i) => i.id === installationId)).toBe(true);

  // A different environment is allowed (UNIQUE is per space+name+environment).
  const previewRes = await app.request(
    `/internal/v1/spaces/${spaceId}/installations`,
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
    `/internal/v1/spaces/${spaceId}/installations`,
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
    `/internal/v1/spaces/${spaceId}/installations`,
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
  const installation = (await createRes.json()).installation as {
    installConfigId: string;
  };
  expect(installation.installConfigId).not.toBe(installConfigId);

  const config = await operations.installations.getInstallConfig(
    installation.installConfigId,
  );
  expect(config.spaceId).toBe(spaceId);
  expect(config.internal).toEqual({ reason: "per_install_overrides" });
  expect(config.variableMapping).toEqual({
    project_name: "takos-vars",
    cloudflare: {},
  });
  expect(config.outputAllowlist).toEqual({
    url: { from: "url", type: "url" },
    worker_name: { from: "worker_name", type: "string" },
  });
});

test("model e2e: create Installation with runnerId and outputAllowlist stores a scoped InstallConfig", async () => {
  const { app, operations } = await service();
  const spaceId = await createSpace(app, "runner-profile");
  const sourceId = await createSource(app, spaceId);
  const installConfigId = await seedInstallConfig(operations, spaceId);

  const createRes = await app.request(
    `/internal/v1/spaces/${spaceId}/installations`,
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
          takos_app: { from: "takos_app", type: "json", required: true },
        },
      }),
    },
  );
  expect(createRes.status).toBe(201);
  const installation = (await createRes.json()).installation as {
    installConfigId: string;
    runnerId?: string;
  };
  expect(installation.installConfigId).not.toBe(installConfigId);
  expect(installation.runnerId).toBeUndefined();

  const config = await operations.installations.getInstallConfig(
    installation.installConfigId,
  );
  expect(config.spaceId).toBe(spaceId);
  expect(config.internal).toEqual({ reason: "per_install_overrides" });
  expect(config.runnerId).toBe("generic-opentofu-provider");
  expect(config.variableMapping).toEqual({});
  expect(config.outputAllowlist).toEqual({
    takos_app: { from: "takos_app", type: "json", required: true },
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
    `/internal/v1/spaces/${spaceId}/installations`,
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
  const installation = (await createRes.json()).installation as {
    installConfigId: string;
  };
  expect(installation.installConfigId).not.toBe(installConfigId);

  const config = await operations.installations.getInstallConfig(
    installation.installConfigId,
  );
  expect(config.spaceId).toBe(spaceId);
  expect(config.internal).toEqual({ reason: "per_install_overrides" });
  expect(config.modulePath).toBe("deploy/opentofu");
});

test("model e2e: create Installation rejects non-object vars", async () => {
  const { app, operations } = await service();
  const spaceId = await createSpace(app, "bad-vars");
  const sourceId = await createSource(app, spaceId);
  const installConfigId = await seedInstallConfig(operations, spaceId);

  const createRes = await app.request(
    `/internal/v1/spaces/${spaceId}/installations`,
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

test("model e2e: GET /internal/v1/installations/{id} returns the new shape", async () => {
  const { app, operations } = await service();
  const spaceId = await createSpace(app, "reader");
  const sourceId = await createSource(app, spaceId);
  const installConfigId = await seedInstallConfig(operations, spaceId);

  const createRes = await app.request(
    `/internal/v1/spaces/${spaceId}/installations`,
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
  const installationId = (await createRes.json()).installation.id as string;

  const getRes = await app.request(
    `/internal/v1/installations/${installationId}`,
    {
      headers: headers(),
    },
  );
  expect(getRes.status).toBe(200);
  const body = await getRes.json();
  expect(body.installation.id).toBe(installationId);
  expect(body.installation.spaceId).toBe(spaceId);
  expect(body.installation.currentStateGeneration).toBe(0);
  expect(body.installation.installType).toBeUndefined();
});

test("model e2e: install-configs lists the space's seeded config", async () => {
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
    `/internal/v1/spaces/${spaceId}/installations`,
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
  const installationId = (await createRes.json()).installation.id as string;

  const planRes = await app.request(
    `/internal/v1/installations/${installationId}/plan`,
    { method: "POST", headers: headers() },
  );
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
  const res = await app.request(
    `/internal/v1/spaces/${spaceId}/installations`,
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
  return (await res.json()).installation.id as string;
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
    `/internal/v1/installations/${consumer}/dependencies`,
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
    `/internal/v1/installations/${consumer}/dependencies`,
    { headers: headers() },
  );
  expect(listRes.status).toBe(200);
  const list = await listRes.json();
  expect(list.asConsumer).toHaveLength(1);
  expect(list.asProducer).toHaveLength(0);

  // The reverse edge (producer depends on consumer) would close a cycle: 409.
  const cycleRes = await app.request(
    `/internal/v1/installations/${producer}/dependencies`,
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
    `/internal/v1/installations/${consumer}/dependencies`,
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
    `/internal/v1/installations/${consumer}/dependencies`,
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
  const res = await app.request("/internal/v1/spaces");
  expect(res.status).toBe(401);
});
