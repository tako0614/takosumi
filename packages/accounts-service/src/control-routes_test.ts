import { expect, test } from "bun:test";

import {
  type ControlPlaneOperations,
  handleControlRoute,
  isControlRoutePath,
} from "./control-routes.ts";
import {
  maybeEnsurePersonalSpaceForSession,
  personalSpaceHandle,
} from "./control-personal-space.ts";
import { ACCOUNT_SESSION_COOKIE_NAME } from "./account-session.ts";
import { InMemoryAccountsStore } from "./store.ts";

// --- Test harness ----------------------------------------------------------

const ORIGIN = "https://app.takosumi.test";

/** A live account + session in a fresh store. Returns the cookie header value. */
function seedSession(
  store: InMemoryAccountsStore,
  options: { subject?: string; email?: string; displayName?: string } = {},
): { sessionId: string; cookie: string; subject: string } {
  const subject = options.subject ?? "tsub_ctrl";
  const now = Date.now();
  store.saveAccount({
    subject,
    createdAt: now,
    updatedAt: now,
    ...(options.email ? { email: options.email } : {}),
    ...(options.displayName ? { displayName: options.displayName } : {}),
  });
  const sessionId = "sess_ctrl_ok";
  store.saveAccountSession({
    sessionId,
    subject,
    createdAt: now,
    expiresAt: now + 60_000,
  });
  return {
    sessionId,
    cookie: `${ACCOUNT_SESSION_COOKIE_NAME}=${sessionId}`,
    subject,
  };
}

/** A spy-able fake facade. Records the last call args for assertions. */
function fakeOperations(
  overrides: Partial<ControlPlaneOperations> = {},
): ControlPlaneOperations & { calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = {};
  const record = (name: string, ...args: unknown[]) => {
    calls[name] = args;
  };
  const space = (id: string) => ({
    id,
    handle: "shota",
    displayName: "Shota",
    type: "personal" as const,
    ownerUserId: "tsub_ctrl",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  });
  const installation = (id: string, spaceId: string) => ({
    id,
    spaceId,
    name: "app",
    slug: "app",
    sourceId: "src_x",
    installType: "opentofu_module" as const,
    installConfigId: "cfg_x",
    environment: "prod",
    currentStateGeneration: 0,
    status: "ready" as const,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  });
  const base: ControlPlaneOperations = {
    spaces: {
      listSpaces: async () => {
        record("listSpaces");
        return [space("space_a")];
      },
      getSpace: async (id) => {
        record("getSpace", id);
        return space(id);
      },
      createSpace: async (req) => {
        record("createSpace", req);
        return { ...space("space_new"), handle: req.handle, type: req.type };
      },
    },
    installations: {
      getInstallation: async (id) => {
        record("getInstallation", id);
        return installation(id, "space_a");
      },
      listInstallations: async (spaceId) => {
        record("listInstallations", spaceId);
        return [installation("inst_1", spaceId)];
      },
      createInstallation: async (req) => {
        record("createInstallation", req);
        return installation("inst_new", req.spaceId);
      },
      listInstallConfigs: async (spaceId) => {
        record("listInstallConfigs", spaceId);
        return [];
      },
    },
    dependencies: {
      createDependency: async (req) => {
        record("createDependency", req);
        return {
          id: "dep_1",
          spaceId: req.spaceId,
          producerInstallationId: req.producerInstallationId,
          consumerInstallationId: req.consumerInstallationId,
          mode: req.mode,
          outputs: req.outputs,
          visibility: req.visibility,
          createdAt: "2026-01-01T00:00:00Z",
        };
      },
      getDependency: async (id) => {
        record("getDependency", id);
        return {
          id,
          spaceId: "space_a",
          producerInstallationId: "inst_1",
          consumerInstallationId: "inst_2",
          mode: "variable_injection",
          outputs: {},
          visibility: "space",
          createdAt: "2026-01-01T00:00:00Z",
        };
      },
      deleteDependency: async (id) => {
        record("deleteDependency", id);
        return true;
      },
    },
    listDependenciesBySpace: async (spaceId) => {
      record("listDependenciesBySpace", spaceId);
      return [{
        id: "dep_1",
        spaceId,
        producerInstallationId: "inst_1",
        consumerInstallationId: "inst_2",
        mode: "variable_injection",
        outputs: { db_url: { from: "url", to: "db_url", required: true } },
        visibility: "space",
        createdAt: "2026-01-01T00:00:00Z",
      }];
    },
    runGroups: {
      createSpaceUpdate: async (spaceId) => {
        record("createSpaceUpdate", spaceId);
        return { runGroup: { id: "rg_1", spaceId }, runs: [] };
      },
      getRunGroup: async (id) => {
        record("getRunGroup", id);
        return { runGroup: { id, spaceId: "space_a" }, runs: [] };
      },
      approveRunGroup: async (id) => {
        record("approveRunGroup", id);
        return { runGroup: { id, spaceId: "space_a" }, runs: [] };
      },
    },
    activity: {
      list: async (spaceId, limit) => {
        record("activityList", spaceId, limit);
        return [];
      },
    },
    connections: {
      listOperatorConnectionDefaults: async () => {
        record("listOperatorConnectionDefaults");
        return [];
      },
    },
    listConnections: async (spaceId) => {
      record("listConnections", spaceId);
      return { connections: [] };
    },
    listOperatorConnections: async () => {
      record("listOperatorConnections");
      return { connections: [] };
    },
    getConnection: async (connectionId) => {
      record("getConnection", connectionId);
      return {
        id: connectionId,
        spaceId: "space_a",
        provider: "cloudflare",
        kind: "provider",
        authMethod: "static_secret",
        scope: "space",
        status: "active",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      } as unknown as Awaited<ReturnType<ControlPlaneOperations["getConnection"]>>;
    },
    createInstallationPlan: async (installationId) => {
      record("createInstallationPlan", installationId);
      return { planRun: { id: "plan_1" } } as unknown as Awaited<
        ReturnType<ControlPlaneOperations["createInstallationPlan"]>
      >;
    },
    createInstallationDestroyPlan: async (installationId) => {
      record("createInstallationDestroyPlan", installationId);
      return { planRun: { id: "plan_destroy" } } as unknown as Awaited<
        ReturnType<ControlPlaneOperations["createInstallationDestroyPlan"]>
      >;
    },
    getRun: async (id) => {
      record("getRun", id);
      return { id, spaceId: "space_a", status: "succeeded" } as unknown as Awaited<
        ReturnType<ControlPlaneOperations["getRun"]>
      >;
    },
    approveRun: async (id, input) => {
      record("approveRun", id, input);
      return { id, spaceId: "space_a", status: "queued" } as unknown as Awaited<
        ReturnType<ControlPlaneOperations["approveRun"]>
      >;
    },
    getRunLogs: async (id) => {
      record("getRunLogs", id);
      return { diagnostics: [], auditEvents: [] };
    },
    createSource: async (req) => {
      record("createSource", req);
      return { source: { id: "src_new" }, hookSecret: "hk_x" } as unknown as Awaited<
        ReturnType<ControlPlaneOperations["createSource"]>
      >;
    },
    listSources: async (spaceId) => {
      record("listSources", spaceId);
      return { sources: [] } as unknown as Awaited<
        ReturnType<ControlPlaneOperations["listSources"]>
      >;
    },
    createSourceSync: async (sourceId, options) => {
      record("createSourceSync", sourceId, options);
      return { run: { id: "ssr_1" } };
    },
    listRunnerProfiles: async () => {
      record("listRunnerProfiles");
      return { runnerProfiles: [] };
    },
  };
  return Object.assign({ calls }, base, overrides) as ControlPlaneOperations & {
    calls: Record<string, unknown[]>;
  };
}

function request(
  method: string,
  path: string,
  init: { cookie?: string; body?: unknown } = {},
): { request: Request; url: URL } {
  const url = new URL(`${ORIGIN}${path}`);
  const headers: Record<string, string> = {};
  if (init.cookie) headers.cookie = init.cookie;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  return {
    request: new Request(url, {
      method,
      headers,
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    }),
    url,
  };
}

// --- isControlRoutePath ----------------------------------------------------

test("isControlRoutePath owns /v1/control and its subtree only", () => {
  expect(isControlRoutePath("/v1/control")).toEqual(true);
  expect(isControlRoutePath("/v1/control/spaces")).toEqual(true);
  expect(isControlRoutePath("/v1/control/runs/plan_1/logs")).toEqual(true);
  expect(isControlRoutePath("/v1/controlx")).toEqual(false);
  expect(isControlRoutePath("/v1/installations")).toEqual(false);
});

// --- Anonymous = 401 -------------------------------------------------------

test("anonymous control requests are 401 across the family", async () => {
  const store = new InMemoryAccountsStore();
  const operations = fakeOperations();
  const paths: Array<[string, string]> = [
    ["GET", "/v1/control/spaces"],
    ["POST", "/v1/control/spaces"],
    ["GET", "/v1/control/spaces/space_a/installations"],
    ["GET", "/v1/control/spaces/space_a/graph"],
    ["GET", "/v1/control/spaces/space_a/activity"],
    ["POST", "/v1/control/spaces/space_a/plan-update"],
    ["GET", "/v1/control/installations/inst_1"],
    ["POST", "/v1/control/installations/inst_1/plan"],
    ["GET", "/v1/control/install-configs"],
    ["GET", "/v1/control/runs/plan_1"],
    ["GET", "/v1/control/run-groups/rg_1"],
    ["GET", "/v1/control/connections?spaceId=space_a"],
    ["GET", "/v1/control/operator-connection-defaults"],
  ];
  for (const [method, path] of paths) {
    const { request: req, url } = request(method, path);
    const response = await handleControlRoute({
      request: req,
      url,
      store,
      operations,
    });
    expect(response?.status, `${method} ${path}`).toEqual(401);
    await response?.body?.cancel();
  }
  // No facade method should have been reached behind the auth gate.
  expect(Object.keys(operations.calls).length).toEqual(0);
});

// --- 503 when the facade is absent (after the session gate) -----------------

test("control routes 503 when no operations facade is wired", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const { request: req, url } = request("GET", "/v1/control/spaces", { cookie });
  const response = await handleControlRoute({ request: req, url, store });
  expect(response?.status).toEqual(503);
});

// --- Session happy paths ---------------------------------------------------

test("GET /v1/control/spaces returns spaces for a session", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request("GET", "/v1/control/spaces", { cookie });
  const response = await handleControlRoute({ request: req, url, store, operations });
  expect(response?.status).toEqual(200);
  const body = await response!.json() as { spaces: unknown[] };
  expect(body.spaces.length).toEqual(1);
  expect(operations.calls.listSpaces).toBeDefined();
});

test("POST /v1/control/spaces uses the session subject as ownerUserId", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie, subject } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request("POST", "/v1/control/spaces", {
    cookie,
    body: { handle: "myspace", displayName: "My Space", type: "personal" },
  });
  const response = await handleControlRoute({ request: req, url, store, operations });
  expect(response?.status).toEqual(201);
  const createCall = operations.calls.createSpace?.[0] as {
    ownerUserId: string;
    handle: string;
  };
  expect(createCall.ownerUserId).toEqual(subject);
  expect(createCall.handle).toEqual("myspace");
});

test("GET /v1/control/spaces/:id/installations lists installations", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request(
    "GET",
    "/v1/control/spaces/space_a/installations",
    { cookie },
  );
  const response = await handleControlRoute({ request: req, url, store, operations });
  expect(response?.status).toEqual(200);
  const body = await response!.json() as { installations: unknown[] };
  expect(body.installations.length).toEqual(1);
  expect(operations.calls.listInstallations?.[0]).toEqual("space_a");
});

test("POST /v1/control/spaces/:id/installations creates an installation", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request(
    "POST",
    "/v1/control/spaces/space_a/installations",
    {
      cookie,
      body: {
        name: "app",
        environment: "prod",
        sourceId: "src_x",
        installConfigId: "cfg_x",
      },
    },
  );
  const response = await handleControlRoute({ request: req, url, store, operations });
  expect(response?.status).toEqual(201);
  const createCall = operations.calls.createInstallation?.[0] as {
    spaceId: string;
  };
  expect(createCall.spaceId).toEqual("space_a");
});

test("GET /v1/control/spaces/:id/graph projects nodes + edges", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request(
    "GET",
    "/v1/control/spaces/space_a/graph",
    { cookie },
  );
  const response = await handleControlRoute({ request: req, url, store, operations });
  expect(response?.status).toEqual(200);
  const body = await response!.json() as {
    nodes: Array<{ installationId: string; name: string; status: string }>;
    edges: Array<{ id: string; producerInstallationId: string; outputs: unknown }>;
  };
  expect(body.nodes[0]?.installationId).toEqual("inst_1");
  expect(body.nodes[0]?.name).toEqual("app");
  expect(body.edges[0]?.id).toEqual("dep_1");
  expect(body.edges[0]?.producerInstallationId).toEqual("inst_1");
});

test("GET /v1/control/installations/:id reads one installation", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request(
    "GET",
    "/v1/control/installations/inst_1",
    { cookie },
  );
  const response = await handleControlRoute({ request: req, url, store, operations });
  expect(response?.status).toEqual(200);
  expect(operations.calls.getInstallation?.[0]).toEqual("inst_1");
});

test("POST /v1/control/installations/:id/plan returns 201", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request(
    "POST",
    "/v1/control/installations/inst_1/plan",
    { cookie },
  );
  const response = await handleControlRoute({ request: req, url, store, operations });
  expect(response?.status).toEqual(201);
  expect(operations.calls.createInstallationPlan?.[0]).toEqual("inst_1");
});

test("POST /v1/control/installations/:id/destroy-plan returns 201", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request(
    "POST",
    "/v1/control/installations/inst_1/destroy-plan",
    { cookie },
  );
  const response = await handleControlRoute({ request: req, url, store, operations });
  expect(response?.status).toEqual(201);
  expect(operations.calls.createInstallationDestroyPlan?.[0]).toEqual("inst_1");
});

test("POST /v1/control/installations/:id/dependencies derives spaceId from the consumer", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request(
    "POST",
    "/v1/control/installations/inst_2/dependencies",
    {
      cookie,
      body: {
        producerInstallationId: "inst_1",
        outputs: { db: { from: "url", to: "db", required: true } },
      },
    },
  );
  const response = await handleControlRoute({ request: req, url, store, operations });
  expect(response?.status).toEqual(201);
  const dep = operations.calls.createDependency?.[0] as {
    consumerInstallationId: string;
    spaceId: string;
    mode: string;
    visibility: string;
  };
  expect(dep.consumerInstallationId).toEqual("inst_2");
  expect(dep.spaceId).toEqual("space_a");
  expect(dep.mode).toEqual("variable_injection");
  expect(dep.visibility).toEqual("space");
});

test("DELETE /v1/control/dependencies/:id returns 204", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request(
    "DELETE",
    "/v1/control/dependencies/dep_1",
    { cookie },
  );
  const response = await handleControlRoute({ request: req, url, store, operations });
  expect(response?.status).toEqual(204);
  expect(operations.calls.deleteDependency?.[0]).toEqual("dep_1");
});

test("GET /v1/control/install-configs merges official + scoped", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request(
    "GET",
    "/v1/control/install-configs?spaceId=space_a",
    { cookie },
  );
  const response = await handleControlRoute({ request: req, url, store, operations });
  expect(response?.status).toEqual(200);
  const body = await response!.json() as { installConfigs: unknown[] };
  expect(Array.isArray(body.installConfigs)).toEqual(true);
});

test("Sources: GET requires spaceId, POST + sync return 201", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();

  const missing = request("GET", "/v1/control/sources", { cookie });
  const missingResp = await handleControlRoute({
    request: missing.request,
    url: missing.url,
    store,
    operations,
  });
  expect(missingResp?.status).toEqual(400);

  const list = request("GET", "/v1/control/sources?spaceId=space_a", { cookie });
  const listResp = await handleControlRoute({
    request: list.request,
    url: list.url,
    store,
    operations,
  });
  expect(listResp?.status).toEqual(200);
  expect(operations.calls.listSources?.[0]).toEqual("space_a");

  const create = request("POST", "/v1/control/sources", {
    cookie,
    body: { spaceId: "space_a", name: "repo", url: "https://example.test/r.git" },
  });
  const createResp = await handleControlRoute({
    request: create.request,
    url: create.url,
    store,
    operations,
  });
  expect(createResp?.status).toEqual(201);

  const sync = request("POST", "/v1/control/sources/src_x/sync", { cookie });
  const syncResp = await handleControlRoute({
    request: sync.request,
    url: sync.url,
    store,
    operations,
  });
  expect(syncResp?.status).toEqual(201);
  expect(operations.calls.createSourceSync?.[0]).toEqual("src_x");
});

test("Runs: GET run, approve (subject fallback), logs", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie, subject } = seedSession(store);
  const operations = fakeOperations();

  const get = request("GET", "/v1/control/runs/plan_1", { cookie });
  const getResp = await handleControlRoute({
    request: get.request,
    url: get.url,
    store,
    operations,
  });
  expect(getResp?.status).toEqual(200);

  const approve = request("POST", "/v1/control/runs/plan_1/approve", { cookie });
  const approveResp = await handleControlRoute({
    request: approve.request,
    url: approve.url,
    store,
    operations,
  });
  expect(approveResp?.status).toEqual(200);
  const approveCall = operations.calls.approveRun?.[1] as { approvedBy: string };
  expect(approveCall.approvedBy).toEqual(subject);

  const logs = request("GET", "/v1/control/runs/plan_1/logs", { cookie });
  const logsResp = await handleControlRoute({
    request: logs.request,
    url: logs.url,
    store,
    operations,
  });
  expect(logsResp?.status).toEqual(200);
});

test("RunGroups: plan-update, get, approve", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();

  const update = request("POST", "/v1/control/spaces/space_a/plan-update", {
    cookie,
  });
  const updateResp = await handleControlRoute({
    request: update.request,
    url: update.url,
    store,
    operations,
  });
  expect(updateResp?.status).toEqual(201);
  expect(operations.calls.createSpaceUpdate?.[0]).toEqual("space_a");

  const get = request("GET", "/v1/control/run-groups/rg_1", { cookie });
  const getResp = await handleControlRoute({
    request: get.request,
    url: get.url,
    store,
    operations,
  });
  expect(getResp?.status).toEqual(200);

  const approve = request("POST", "/v1/control/run-groups/rg_1/approve", {
    cookie,
  });
  const approveResp = await handleControlRoute({
    request: approve.request,
    url: approve.url,
    store,
    operations,
  });
  expect(approveResp?.status).toEqual(200);
});

test("Connections: requires spaceId; operator-connection-defaults returns 200", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();

  const missing = request("GET", "/v1/control/connections", { cookie });
  const missingResp = await handleControlRoute({
    request: missing.request,
    url: missing.url,
    store,
    operations,
  });
  expect(missingResp?.status).toEqual(400);

  const scoped = request("GET", "/v1/control/connections?spaceId=space_a", {
    cookie,
  });
  const scopedResp = await handleControlRoute({
    request: scoped.request,
    url: scoped.url,
    store,
    operations,
  });
  expect(scopedResp?.status).toEqual(200);
  expect(operations.calls.listConnections?.[0]).toEqual("space_a");

  const defaults = request("GET", "/v1/control/operator-connection-defaults", {
    cookie,
  });
  const defaultsResp = await handleControlRoute({
    request: defaults.request,
    url: defaults.url,
    store,
    operations,
  });
  expect(defaultsResp?.status).toEqual(200);
});

test("controller errors map to their HTTP status (not_found -> 404)", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations({
    installations: {
      getInstallation: async () => {
        throw Object.assign(new Error("nope"), { code: "not_found" });
      },
      listInstallations: async () => [],
      createInstallation: async () => {
        throw new Error("unused");
      },
      listInstallConfigs: async () => [],
    },
  });
  const { request: req, url } = request(
    "GET",
    "/v1/control/installations/inst_missing",
    { cookie },
  );
  const response = await handleControlRoute({ request: req, url, store, operations });
  expect(response?.status).toEqual(404);
  const body = await response!.json() as { error: string };
  expect(body.error).toEqual("not_found");
});

test("unknown control subpath is 404 after the session gate", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request("GET", "/v1/control/nope", { cookie });
  const response = await handleControlRoute({ request: req, url, store, operations });
  expect(response?.status).toEqual(404);
});

// --- personalSpaceHandle derivation ---------------------------------------

test("personalSpaceHandle prefers displayName, then email, then fallback", () => {
  expect(personalSpaceHandle({ subject: "tsub_x", displayName: "Shota Tomiyama" }))
    .toEqual("shota-tomiyama");
  expect(personalSpaceHandle({ subject: "tsub_x", email: "alice.dev@example.com" }))
    .toEqual("alice-dev");
  // Unusable displayName ("!") falls through to email.
  expect(
    personalSpaceHandle({ subject: "tsub_x", displayName: "!", email: "bob@x.io" }),
  ).toEqual("bob");
  // No usable candidate -> u-<short subject>.
  const fallback = personalSpaceHandle({ subject: "tsub_AbCdEf123" });
  expect(fallback.startsWith("u-")).toEqual(true);
  expect(/^[a-z0-9][a-z0-9-]{1,38}$/.test(fallback)).toEqual(true);
});

test("personalSpaceHandle clamps to the 39-char handle rule", () => {
  const long = "x".repeat(80);
  const handle = personalSpaceHandle({ subject: "tsub_x", displayName: long });
  expect(handle.length).toBeLessThanOrEqual(39);
  expect(/^[a-z0-9][a-z0-9-]{1,38}$/.test(handle)).toEqual(true);
});

// --- ensurePersonalSpace fire-and-forget hook -----------------------------

test("maybeEnsurePersonalSpaceForSession creates a space for a live session", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store, { displayName: "Shota" });
  const operations = fakeOperations();
  const { request: req } = request("GET", "/v1/account/session/me", { cookie });
  await maybeEnsurePersonalSpaceForSession({ request: req, store, operations });
  const createCall = operations.calls.createSpace?.[0] as {
    handle: string;
    type: string;
    ownerUserId: string;
  };
  expect(createCall.handle).toEqual("shota");
  expect(createCall.type).toEqual("personal");
  expect(createCall.ownerUserId).toEqual("tsub_ctrl");
});

test("maybeEnsurePersonalSpaceForSession swallows a handle-collision error", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store, { displayName: "Shota" });
  const operations = fakeOperations({
    spaces: {
      listSpaces: async () => [],
      getSpace: async () => {
        throw new Error("unused");
      },
      createSpace: async () => {
        throw Object.assign(new Error("taken"), { code: "failed_precondition" });
      },
    },
  });
  const { request: req } = request("GET", "/v1/account/session/me", { cookie });
  // Must NOT throw.
  await maybeEnsurePersonalSpaceForSession({ request: req, store, operations });
});

test("maybeEnsurePersonalSpaceForSession is a no-op without a session", async () => {
  const store = new InMemoryAccountsStore();
  const operations = fakeOperations();
  const { request: req } = request("GET", "/v1/account/session/me");
  await maybeEnsurePersonalSpaceForSession({ request: req, store, operations });
  expect(operations.calls.createSpace).toBeUndefined();
});

test("maybeEnsurePersonalSpaceForSession is a no-op without an operations facade", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const { request: req } = request("GET", "/v1/account/session/me", { cookie });
  // No operations -> returns quietly.
  await maybeEnsurePersonalSpaceForSession({ request: req, store });
});
