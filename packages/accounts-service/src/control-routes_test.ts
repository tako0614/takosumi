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

function seedLedgerSpace(
  store: InMemoryAccountsStore,
  input: { subject: string; accountId: string; spaceId: string },
): void {
  const now = Date.now();
  store.saveLedgerAccount({
    accountId: input.accountId,
    legalOwnerSubject: input.subject,
    createdAt: now,
    updatedAt: now,
  });
  store.saveSpace({
    spaceId: input.spaceId,
    accountId: input.accountId,
    kind: "personal",
    createdAt: now,
    updatedAt: now,
  });
}

/** A spy-able fake facade. Records the last call args for assertions. */
type ControlPlaneOperationsOverride = Partial<
  Omit<ControlPlaneOperations, "spaces">
> & {
  readonly spaces?: Partial<ControlPlaneOperations["spaces"]>;
};

function fakeOperations(
  overrides: ControlPlaneOperationsOverride = {},
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
      updateSpace: async (id, patch) => {
        record("updateSpace", id, patch);
        return { ...space(id), ...patch, updatedAt: "2026-01-02T00:00:00Z" };
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
      putDeploymentProfile: async (profile) => {
        record("putDeploymentProfile", profile);
        return profile;
      },
      getDeploymentProfileByInstallation: async (
        installationId,
        environment,
      ) => {
        record(
          "getDeploymentProfileByInstallation",
          installationId,
          environment,
        );
        return {
          id: "dpf_1",
          spaceId: "space_a",
          installationId,
          environment,
          bindings: [
            { provider: "cloudflare", alias: "main", mode: "default" },
          ],
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        };
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
      return [
        {
          id: "dep_1",
          spaceId,
          producerInstallationId: "inst_1",
          consumerInstallationId: "inst_2",
          mode: "variable_injection",
          outputs: { db_url: { from: "url", to: "db_url", required: true } },
          visibility: "space",
          createdAt: "2026-01-01T00:00:00Z",
        },
      ];
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
    backups: {
      createBackup: async (input) => {
        record("createBackup", input);
        return {
          id: "bkp_1",
          spaceId: input.spaceId,
          objectKey: `spaces/${input.spaceId}/backups/bkp_1/control.json.zst.enc`,
          digest:
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          sizeBytes: 128,
          createdAt: "2026-01-01T00:00:00Z",
        };
      },
      listBackups: async (spaceId) => {
        record("listBackups", spaceId);
        return [
          {
            id: "bkp_1",
            spaceId,
            objectKey: `spaces/${spaceId}/backups/bkp_1/control.json.zst.enc`,
            digest:
              "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            sizeBytes: 128,
            createdAt: "2026-01-01T00:00:00Z",
          },
        ];
      },
    },
    getSpaceBilling: async (spaceId) => {
      record("getSpaceBilling", spaceId);
      return {
        billing: {
          settings: { mode: "showback", provider: "manual" },
          balance: {
            spaceId,
            availableCredits: 120,
            reservedCredits: 8,
            monthlyIncludedCredits: 100,
            purchasedCredits: 20,
            updatedAt: "2026-01-01T00:00:00Z",
          },
        },
      };
    },
    listSpaceUsage: async (spaceId) => {
      record("listSpaceUsage", spaceId);
      return {
        usageEvents: [
          {
            id: "use_1",
            spaceId,
            kind: "runner_minute",
            quantity: 2,
            credits: 3,
            source: "runner",
            idempotencyKey: "idem_1",
            createdAt: "2026-01-01T00:00:00Z",
          },
        ],
      };
    },
    listSpaceCreditReservations: async (spaceId) => {
      record("listSpaceCreditReservations", spaceId);
      return {
        creditReservations: [
          {
            id: "cres_1",
            spaceId,
            runId: "plan_1",
            estimatedCredits: 28,
            status: "reserved",
            mode: "enforce",
            createdAt: "2026-01-01T00:00:00Z",
            expiresAt: "2026-01-01T01:00:00Z",
          },
        ],
      };
    },
    topUpSpaceCredits: async (spaceId, input) => {
      record("topUpSpaceCredits", spaceId, input);
      return {
        balance: {
          spaceId,
          availableCredits: input.credits,
          reservedCredits: 0,
          monthlyIncludedCredits: 0,
          purchasedCredits: input.credits,
          updatedAt: "2026-01-01T00:00:00Z",
        },
      };
    },
    changeSpaceSubscription: async (spaceId, input) => {
      record("changeSpaceSubscription", spaceId, input);
      return { billing: { settings: input.billingSettings } };
    },
    reconcileStripeSpaceSubscription: async (spaceId, input) => {
      record("reconcileStripeSpaceSubscription", spaceId, input);
      return {};
    },
    connections: {
      listOperatorConnectionDefaults: async () => {
        record("listOperatorConnectionDefaults");
        return [];
      },
    },
    outputShares: {
      createShare: async (req) => {
        record("createOutputShare", req);
        return {
          id: "oshare_1",
          fromSpaceId: req.fromSpaceId,
          toSpaceId: req.toSpaceId,
          producerInstallationId: req.producerInstallationId,
          outputs: req.outputs.map((output) => ({
            name: output.name,
            ...(output.alias ? { alias: output.alias } : {}),
            sensitive: output.sensitive === true,
          })),
          status: "active",
          createdAt: "2026-01-01T00:00:00Z",
        };
      },
      listForSpace: async (spaceId) => {
        record("listOutputShares", spaceId);
        return [
          {
            id: "oshare_1",
            fromSpaceId: spaceId,
            toSpaceId: "space_b",
            producerInstallationId: "inst_1",
            outputs: [{ name: "domain", sensitive: false }],
            status: "active",
            createdAt: "2026-01-01T00:00:00Z",
          },
        ];
      },
      getShare: async (id) => {
        record("getOutputShare", id);
        return {
          id,
          fromSpaceId: "space_a",
          toSpaceId: "space_b",
          producerInstallationId: "inst_1",
          outputs: [{ name: "domain", sensitive: false }],
          status: "active",
          createdAt: "2026-01-01T00:00:00Z",
        };
      },
      approveShare: async (id) => {
        record("approveOutputShare", id);
        return {
          id,
          fromSpaceId: "space_a",
          toSpaceId: "space_b",
          producerInstallationId: "inst_1",
          outputs: [{ name: "domain", sensitive: false }],
          status: "active",
          createdAt: "2026-01-01T00:00:00Z",
        };
      },
      revokeShare: async (id) => {
        record("revokeOutputShare", id);
        return {
          id,
          fromSpaceId: "space_a",
          toSpaceId: "space_b",
          producerInstallationId: "inst_1",
          outputs: [{ name: "domain", sensitive: false }],
          status: "revoked",
          createdAt: "2026-01-01T00:00:00Z",
          revokedAt: "2026-01-01T00:01:00Z",
        };
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
        kind: "cloudflare_api_token",
        authMethod: "static_secret",
        scope: "space",
        status: "active",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      } as unknown as Awaited<
        ReturnType<ControlPlaneOperations["getConnection"]>
      >;
    },
    createConnection: async (request) => {
      record("createConnection", request);
      return {
        connection: {
          id: "conn_new",
          spaceId: request.spaceId ?? "space_a",
          provider: request.provider,
          kind: request.kind ?? "provider_env_set",
          authMethod: request.authMethod,
          scope: request.scope ?? "space",
          status: "pending",
          // The public projection NEVER carries secret `values`.
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      } as unknown as Awaited<
        ReturnType<ControlPlaneOperations["createConnection"]>
      >;
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
      return {
        id,
        spaceId: "space_a",
        status: "succeeded",
      } as unknown as Awaited<ReturnType<ControlPlaneOperations["getRun"]>>;
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
    getPlanRun: async (id) => {
      record("getPlanRun", id);
      return {
        planRun: {
          id,
          spaceId: "space_a",
          status: "succeeded",
          operation: "create",
          runnerProfileId: "rp_default",
          sourceDigest: `sha256:${"a".repeat(64)}`,
          variablesDigest: `sha256:${"b".repeat(64)}`,
          policyDecisionDigest: `sha256:${"c".repeat(64)}`,
          policy: { status: "passed" },
          planDigest: `sha256:${"d".repeat(64)}`,
          planArtifact: { kind: "object-storage", ref: "k", digest: "e" },
        },
      } as unknown as Awaited<ReturnType<ControlPlaneOperations["getPlanRun"]>>;
    },
    createApplyRun: async (req) => {
      record("createApplyRun", req);
      return {
        applyRun: {
          id: "apply_1",
          planRunId: req.planRunId,
          spaceId: "space_a",
          status: "queued",
        },
      } as unknown as Awaited<
        ReturnType<ControlPlaneOperations["createApplyRun"]>
      >;
    },
    createSource: async (req) => {
      record("createSource", req);
      return {
        source: { id: "src_new" },
        hookSecret: "hk_x",
      } as unknown as Awaited<
        ReturnType<ControlPlaneOperations["createSource"]>
      >;
    },
    getSource: async (id) => {
      record("getSource", id);
      return {
        id,
        spaceId: "space_a",
        name: "repo",
        url: "https://example.test/r.git",
        defaultRef: "main",
        defaultPath: ".",
        status: "active",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      };
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
    listSourceSnapshots: async (sourceId) => {
      record("listSourceSnapshots", sourceId);
      return {
        snapshots: [
          {
            id: "snap_1",
            sourceId,
            url: "https://example.test/r.git",
            ref: "main",
            resolvedCommit: "a".repeat(40),
            path: ".",
            archiveObjectKey:
              "spaces/space_a/sources/src_x/snapshots/snap_1/source.tar.zst",
            archiveDigest: `sha256:${"b".repeat(64)}`,
            archiveSizeBytes: 123,
            fetchedByRunId: "ssr_1",
            fetchedAt: "2026-01-01T00:00:00Z",
          },
        ],
      };
    },
    createSourceCompatibilityCheck: async (sourceId, request) => {
      record("createSourceCompatibilityCheck", sourceId, request);
      return {
        report: {
          id: "caprep_1",
          sourceId,
          sourceSnapshotId: request?.sourceSnapshotId ?? "snap_1",
          level: "ready",
          findings: [],
          providers: [],
          resources: [],
          dataSources: [],
          provisioners: [],
          createdAt: "2026-01-01T00:00:00Z",
        },
      };
    },
    listProviderTemplates: async () => {
      record("listProviderTemplates");
      return {
        providers: [
          {
            id: "cloudflare",
            providerSource: "registry.opentofu.org/cloudflare/cloudflare",
            displayName: "Cloudflare",
            recommendedEnvNames: ["CLOUDFLARE_API_TOKEN"],
            helpers: ["cloudflare_api_token"],
            credentialSources: ["takosumi_managed", "user_env_set"],
            takosumiManagedAvailable: true,
            allowedResources: ["cloudflare_workers_script"],
            allowedDataSources: [],
            policyPackId: "policy_cloudflare",
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
          },
        ],
      };
    },
    listRunnerProfiles: async () => {
      record("listRunnerProfiles");
      return { runnerProfiles: [] };
    },
  };
  return Object.assign({ calls }, base, overrides, {
    spaces: { ...base.spaces, ...overrides.spaces },
  }) as ControlPlaneOperations & {
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
    ["GET", "/v1/control/spaces/space_a/backups"],
    ["POST", "/v1/control/spaces/space_a/backups"],
    ["GET", "/v1/control/spaces/space_a/billing"],
    ["GET", "/v1/control/spaces/space_a/usage"],
    ["GET", "/v1/control/spaces/space_a/credit-reservations"],
    ["POST", "/v1/control/spaces/space_a/credits/top-up"],
    ["POST", "/v1/control/spaces/space_a/subscription/change"],
    ["POST", "/v1/control/spaces/space_a/plan-update"],
    ["GET", "/v1/control/installations/inst_1"],
    ["GET", "/v1/control/installations/inst_1/deployment-profile"],
    ["POST", "/v1/control/installations/inst_1/plan"],
    ["POST", "/v1/control/installations/inst_1/backups"],
    ["GET", "/v1/control/install-configs"],
    ["GET", "/v1/control/providers"],
    ["POST", "/v1/control/sources/src_x/compatibility-check"],
    ["POST", "/v1/control/plan-runs/plan_1/apply"],
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
  const { request: req, url } = request("GET", "/v1/control/spaces", {
    cookie,
  });
  const response = await handleControlRoute({ request: req, url, store });
  expect(response?.status).toEqual(503);
});

// --- Session happy paths ---------------------------------------------------

test("GET /v1/control/spaces returns spaces for a session", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request("GET", "/v1/control/spaces", {
    cookie,
  });
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(200);
  const body = (await response!.json()) as { spaces: unknown[] };
  expect(body.spaces.length).toEqual(1);
  expect(operations.calls.listSpaces).toBeDefined();
});

test("GET /v1/control/spaces/:id/billing returns billing settings and balance", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request(
    "GET",
    "/v1/control/spaces/space_a/billing",
    { cookie },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(200);
  const body = (await response!.json()) as {
    billing: {
      settings: { mode: string };
      balance: { availableCredits: number; reservedCredits: number };
    };
  };
  expect(body.billing.settings.mode).toEqual("showback");
  expect(body.billing.balance.availableCredits).toEqual(120);
  expect(body.billing.balance.reservedCredits).toEqual(8);
  expect(operations.calls.getSpaceBilling).toEqual(["space_a"]);
});

test("GET /v1/control/spaces/:id/usage returns usage events", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request(
    "GET",
    "/v1/control/spaces/space_a/usage",
    { cookie },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(200);
  const body = (await response!.json()) as { usageEvents: unknown[] };
  expect(body.usageEvents.length).toEqual(1);
  expect(operations.calls.listSpaceUsage).toEqual(["space_a"]);
});

test("GET /v1/control/spaces/:id/credit-reservations returns reservation history", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request(
    "GET",
    "/v1/control/spaces/space_a/credit-reservations",
    { cookie },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(200);
  const body = (await response!.json()) as { creditReservations: unknown[] };
  expect(body.creditReservations.length).toEqual(1);
  expect(operations.calls.listSpaceCreditReservations).toEqual(["space_a"]);
});

test("GET /v1/control/spaces/:id/backups lists Space backups", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request(
    "GET",
    "/v1/control/spaces/space_a/backups",
    { cookie },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(200);
  const body = (await response!.json()) as { backups: unknown[] };
  expect(body.backups.length).toEqual(1);
  expect(operations.calls.listBackups).toEqual(["space_a"]);
});

test("POST /v1/control/spaces/:id/backups creates a Space backup", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request(
    "POST",
    "/v1/control/spaces/space_a/backups",
    { cookie },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(201);
  const body = (await response!.json()) as { backup: { spaceId: string } };
  expect(body.backup.spaceId).toEqual("space_a");
  expect(operations.calls.createBackup).toEqual([{ spaceId: "space_a" }]);
});

test("POST /v1/control/spaces/:id/credits/top-up forwards credit amount", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request(
    "POST",
    "/v1/control/spaces/space_a/credits/top-up",
    { cookie, body: { credits: 50 } },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(200);
  const body = (await response!.json()) as {
    balance: { availableCredits: number };
  };
  expect(body.balance.availableCredits).toEqual(50);
  expect(operations.calls.topUpSpaceCredits).toEqual([
    "space_a",
    { credits: 50 },
  ]);
});

test("POST /v1/control/spaces/:id/subscription/change forwards billing settings", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const billingSettings = {
    mode: "enforce",
    provider: "manual",
    reservationRequired: true,
  };
  const { request: req, url } = request(
    "POST",
    "/v1/control/spaces/space_a/subscription/change",
    { cookie, body: { billingSettings } },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(200);
  const body = (await response!.json()) as {
    billing: { settings: typeof billingSettings };
  };
  expect(body.billing.settings).toEqual(billingSettings);
  expect(operations.calls.changeSpaceSubscription).toEqual([
    "space_a",
    { billingSettings },
  ]);
});

test("GET /v1/control/spaces filters out spaces the session cannot access", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const visible = {
    id: "space_a",
    handle: "mine",
    displayName: "Mine",
    type: "personal" as const,
    ownerUserId: "tsub_ctrl",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
  const hidden = {
    ...visible,
    id: "space_b",
    handle: "other",
    displayName: "Other",
    ownerUserId: "tsub_other",
  };
  const operations = fakeOperations({
    spaces: {
      listSpaces: async () => [visible, hidden],
      getSpace: async (id) => (id === "space_b" ? hidden : visible),
      createSpace: async (req) => ({
        ...visible,
        id: "space_new",
        handle: req.handle,
        displayName: req.displayName,
        type: req.type,
        ownerUserId: req.ownerUserId,
      }),
    },
  });
  const { request: req, url } = request("GET", "/v1/control/spaces", {
    cookie,
  });
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(200);
  const body = (await response!.json()) as { spaces: Array<{ id: string }> };
  expect(body.spaces.map((space) => space.id)).toEqual(["space_a"]);
});

test("PATCH /v1/control/spaces/:id updates display name and policy after Space access", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request("PATCH", "/v1/control/spaces/space_a", {
    cookie,
    body: {
      displayName: "Shota Lab",
      policy: {
        allowedProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
        quota: { "resources.total": 10 },
      },
    },
  });
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(200);
  const body = (await response!.json()) as { space: { displayName: string } };
  expect(body.space.displayName).toEqual("Shota Lab");
  expect(operations.calls.updateSpace).toEqual([
    "space_a",
    {
      displayName: "Shota Lab",
      policy: {
        allowedProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
        quota: { "resources.total": 10 },
      },
    },
  ]);
});

test("PATCH /v1/control/spaces/:id rejects policy that is not a JSON object", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request("PATCH", "/v1/control/spaces/space_a", {
    cookie,
    body: { policy: [] },
  });
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(400);
  expect(operations.calls.updateSpace).toBeUndefined();
});

test("space-scoped control route rejects a non-member session before dispatch", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations({
    spaces: {
      listSpaces: async () => [],
      getSpace: async (id) => ({
        id,
        handle: "other",
        displayName: "Other",
        type: "personal" as const,
        ownerUserId: "tsub_other",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      }),
      createSpace: async (req) => ({
        id: "space_new",
        handle: req.handle,
        displayName: req.displayName,
        type: req.type,
        ownerUserId: req.ownerUserId,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      }),
    },
  });
  const { request: req, url } = request(
    "GET",
    "/v1/control/spaces/space_b/installations",
    { cookie },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(403);
  expect(operations.calls.listInstallations).toBeUndefined();
});

test("PATCH /v1/control/spaces/:id rejects a non-member session before dispatch", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations({
    spaces: {
      getSpace: async (id) => ({
        id,
        handle: "other",
        displayName: "Other",
        type: "personal" as const,
        ownerUserId: "tsub_other",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      }),
    },
  });
  const { request: req, url } = request("PATCH", "/v1/control/spaces/space_b", {
    cookie,
    body: { displayName: "Nope" },
  });
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(403);
  expect(operations.calls.updateSpace).toBeUndefined();
});

test("installation-scoped control route rejects when its Space is inaccessible", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations({
    spaces: {
      listSpaces: async () => [],
      getSpace: async (id) => ({
        id,
        handle: "other",
        displayName: "Other",
        type: "personal" as const,
        ownerUserId: "tsub_other",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      }),
      createSpace: async (req) => ({
        id: "space_new",
        handle: req.handle,
        displayName: req.displayName,
        type: req.type,
        ownerUserId: req.ownerUserId,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      }),
    },
    installations: {
      getInstallation: async (id) => ({
        id,
        spaceId: "space_b",
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
      }),
      listInstallations: async () => [],
      createInstallation: async () => {
        throw new Error("unexpected");
      },
      listInstallConfigs: async () => [],
      putDeploymentProfile: async (profile) => profile,
      getDeploymentProfileByInstallation: async () => undefined,
    },
  });
  const { request: req, url } = request(
    "POST",
    "/v1/control/installations/inst_other/plan",
    { cookie },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(403);
  expect(operations.calls.createInstallationPlan).toBeUndefined();
});

test("POST /v1/control/spaces/:id/installations rejects a Source from another inaccessible Space", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations({
    spaces: {
      listSpaces: async () => [],
      getSpace: async (id) => ({
        id,
        handle: id === "space_a" ? "mine" : "other",
        displayName: id === "space_a" ? "Mine" : "Other",
        type: "personal" as const,
        ownerUserId: id === "space_a" ? "tsub_ctrl" : "tsub_other",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      }),
      createSpace: async (req) => ({
        id: "space_new",
        handle: req.handle,
        displayName: req.displayName,
        type: req.type,
        ownerUserId: req.ownerUserId,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      }),
    },
    getSource: async (id) => ({
      id,
      spaceId: "space_b",
      name: "foreign",
      url: "https://example.test/foreign.git",
      defaultRef: "main",
      defaultPath: ".",
      status: "active",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    }),
  });
  const { request: req, url } = request(
    "POST",
    "/v1/control/spaces/space_a/installations",
    {
      cookie,
      body: {
        name: "app",
        environment: "prod",
        sourceId: "src_foreign",
        installConfigId: "cfg_x",
      },
    },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(403);
  expect(operations.calls.createInstallation).toBeUndefined();
});

test("POST /v1/control/sources rejects an authConnectionId from another inaccessible Space", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations({
    spaces: {
      listSpaces: async () => [],
      getSpace: async (id) => ({
        id,
        handle: id === "space_a" ? "mine" : "other",
        displayName: id === "space_a" ? "Mine" : "Other",
        type: "personal" as const,
        ownerUserId: id === "space_a" ? "tsub_ctrl" : "tsub_other",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      }),
      createSpace: async (req) => ({
        id: "space_new",
        handle: req.handle,
        displayName: req.displayName,
        type: req.type,
        ownerUserId: req.ownerUserId,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      }),
    },
    getConnection: async (connectionId) => ({
      id: connectionId,
      spaceId: "space_b",
      provider: "git",
      kind: "source_git_https_token",
      authMethod: "static_secret",
      scope: "space",
      status: "active",
      envNames: [],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    }),
  });
  const { request: req, url } = request("POST", "/v1/control/sources", {
    cookie,
    body: {
      spaceId: "space_a",
      name: "repo",
      url: "https://example.test/repo.git",
      authConnectionId: "conn_foreign",
    },
  });
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(403);
  expect(operations.calls.createSource).toBeUndefined();
});

test("POST /v1/control/output-shares rejects a producer from another inaccessible Space", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations({
    spaces: {
      listSpaces: async () => [],
      getSpace: async (id) => ({
        id,
        handle: id === "space_a" ? "mine" : "other",
        displayName: id === "space_a" ? "Mine" : "Other",
        type: "personal" as const,
        ownerUserId: id === "space_a" ? "tsub_ctrl" : "tsub_other",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      }),
      createSpace: async (req) => ({
        id: "space_new",
        handle: req.handle,
        displayName: req.displayName,
        type: req.type,
        ownerUserId: req.ownerUserId,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      }),
    },
    installations: {
      getInstallation: async (id) => ({
        id,
        spaceId: "space_b",
        name: "foreign",
        slug: "foreign",
        sourceId: "src_foreign",
        installType: "opentofu_module" as const,
        installConfigId: "cfg_foreign",
        environment: "prod",
        currentStateGeneration: 0,
        status: "ready" as const,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      }),
      listInstallations: async () => [],
      createInstallation: async () => {
        throw new Error("unexpected");
      },
      listInstallConfigs: async () => [],
      putDeploymentProfile: async (profile) => profile,
      getDeploymentProfileByInstallation: async () => undefined,
    },
  });
  const { request: req, url } = request("POST", "/v1/control/output-shares", {
    cookie,
    body: {
      fromSpaceId: "space_a",
      toSpaceId: "space_b",
      producerInstallationId: "inst_foreign",
      outputs: [{ name: "domain" }],
    },
  });
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(403);
  expect(operations.calls.createOutputShare).toBeUndefined();
});

test("GET /v1/control/operator-connection-defaults rejects an inaccessible Space before dispatch", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations({
    spaces: {
      listSpaces: async () => [],
      getSpace: async (id) => ({
        id,
        handle: "other",
        displayName: "Other",
        type: "personal" as const,
        ownerUserId: "tsub_other",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      }),
      createSpace: async (req) => ({
        id: "space_new",
        handle: req.handle,
        displayName: req.displayName,
        type: req.type,
        ownerUserId: req.ownerUserId,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      }),
    },
  });
  const { request: req, url } = request(
    "GET",
    "/v1/control/operator-connection-defaults?spaceId=space_b",
    { cookie },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(403);
  expect(operations.calls.listOperatorConnectionDefaults).toBeUndefined();
});

test("accounts-ledger Space owner can access a Space even when ownerUserId is not the session subject", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie, subject } = seedSession(store);
  seedLedgerSpace(store, {
    subject,
    accountId: "acct_ctrl",
    spaceId: "space_ledger",
  });
  const operations = fakeOperations({
    spaces: {
      listSpaces: async () => [],
      getSpace: async (id) => ({
        id,
        handle: "ledger",
        displayName: "Ledger",
        type: "personal" as const,
        ownerUserId: "tsub_imported_owner",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      }),
      createSpace: async (req) => ({
        id: "space_new",
        handle: req.handle,
        displayName: req.displayName,
        type: req.type,
        ownerUserId: req.ownerUserId,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      }),
    },
  });
  const { request: req, url } = request(
    "GET",
    "/v1/control/spaces/space_ledger/installations",
    { cookie },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(200);
  expect(operations.calls.listInstallations?.[0]).toEqual("space_ledger");
});

test("POST /v1/control/spaces uses the session subject as ownerUserId", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie, subject } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request("POST", "/v1/control/spaces", {
    cookie,
    body: { handle: "myspace", displayName: "My Space", type: "personal" },
  });
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
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
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(200);
  const body = (await response!.json()) as { installations: unknown[] };
  expect(body.installations.length).toEqual(1);
  expect((body.installations[0] as { installType?: string }).installType)
    .toBeUndefined();
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
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(201);
  const body = (await response!.json()) as {
    installation: { installType?: string };
  };
  expect(body.installation.installType).toBeUndefined();
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
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(200);
  const body = (await response!.json()) as {
    nodes: Array<{ installationId: string; name: string; status: string }>;
    edges: Array<{
      id: string;
      producerInstallationId: string;
      outputs: unknown;
    }>;
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
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(200);
  const body = (await response!.json()) as {
    installation: { installType?: string };
  };
  expect(body.installation.installType).toBeUndefined();
  expect(operations.calls.getInstallation?.[0]).toEqual("inst_1");
});

test("POST /v1/control/installations/:id/backups creates a backup for the Installation Space", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request(
    "POST",
    "/v1/control/installations/inst_1/backups",
    { cookie },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(201);
  const body = (await response!.json()) as { backup: { spaceId: string } };
  expect(body.backup.spaceId).toEqual("space_a");
  expect(operations.calls.getInstallation?.[0]).toEqual("inst_1");
  expect(operations.calls.createBackup).toEqual([{ spaceId: "space_a" }]);
});

test("GET /v1/control/installations/:id/deployment-profile reads bindings", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request(
    "GET",
    "/v1/control/installations/inst_1/deployment-profile",
    { cookie },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(200);
  const body = (await response!.json()) as {
    deploymentProfile: { bindings: readonly { mode: string }[] };
  };
  expect(body.deploymentProfile.bindings[0]?.mode).toEqual("default");
  expect(operations.calls.getDeploymentProfileByInstallation).toEqual([
    "inst_1",
    "prod",
  ]);
});

test("PUT /v1/control/installations/:id/deployment-profile saves bindings", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request(
    "PUT",
    "/v1/control/installations/inst_1/deployment-profile",
    {
      cookie,
      body: {
        bindings: [
          {
            provider: "registry.opentofu.org/cloudflare/cloudflare",
            alias: "main",
            mode: "connection",
            connectionId: "conn_cf",
          },
          {
            provider: "registry.opentofu.org/hashicorp/aws",
            alias: "archive",
            mode: "manual",
            values: { bucket: "manual-bucket" },
          },
        ],
      },
    },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(200);
  const saved = operations.calls.putDeploymentProfile?.[0] as {
    bindings: readonly {
      provider: string;
      alias?: string;
      mode: string;
      connectionId?: string;
      values?: Record<string, unknown>;
    }[];
  };
  expect(saved.bindings[0]).toEqual({
    provider: "registry.opentofu.org/cloudflare/cloudflare",
    alias: "main",
    mode: "connection",
    connectionId: "conn_cf",
  });
  expect(saved.bindings[1]?.values?.bucket).toEqual("manual-bucket");
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
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
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
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
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
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
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
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
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
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(200);
  const body = (await response!.json()) as {
    installConfigs: Array<{
      installType?: string;
      templateBinding?: unknown;
    }>;
  };
  expect(Array.isArray(body.installConfigs)).toEqual(true);
  expect(body.installConfigs[0]?.installType).toBeUndefined();
  expect(body.installConfigs[0]?.templateBinding).toBeUndefined();
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

  const list = request("GET", "/v1/control/sources?spaceId=space_a", {
    cookie,
  });
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
    body: {
      spaceId: "space_a",
      name: "repo",
      url: "https://example.test/r.git",
      authConnectionId: "conn_git",
    },
  });
  const createResp = await handleControlRoute({
    request: create.request,
    url: create.url,
    store,
    operations,
  });
  expect(createResp?.status).toEqual(201);
  expect(
    (operations.calls.createSource?.[0] as { authConnectionId?: string })
      .authConnectionId,
  ).toEqual("conn_git");

  const sync = request("POST", "/v1/control/sources/src_x/sync", { cookie });
  const syncResp = await handleControlRoute({
    request: sync.request,
    url: sync.url,
    store,
    operations,
  });
  expect(syncResp?.status).toEqual(201);
  expect(operations.calls.createSourceSync?.[0]).toEqual("src_x");

  const snapshots = request("GET", "/v1/control/sources/src_x/snapshots", {
    cookie,
  });
  const snapshotsResp = await handleControlRoute({
    request: snapshots.request,
    url: snapshots.url,
    store,
    operations,
  });
  expect(snapshotsResp?.status).toEqual(200);
  expect(operations.calls.listSourceSnapshots?.[0]).toEqual("src_x");

  const compatibility = request(
    "POST",
    "/v1/control/sources/src_x/compatibility-check",
    {
      cookie,
      body: { sourceSnapshotId: "snap_1" },
    },
  );
  const compatibilityResp = await handleControlRoute({
    request: compatibility.request,
    url: compatibility.url,
    store,
    operations,
  });
  expect(compatibilityResp?.status).toEqual(201);
  expect(operations.calls.createSourceCompatibilityCheck?.[0]).toEqual("src_x");
  expect(operations.calls.createSourceCompatibilityCheck?.[1]).toEqual({
    sourceSnapshotId: "snap_1",
  });

  // Catalog deep-link path: a curated `installConfigId` in the body must be
  // threaded to the operations facade so a vetted first-party module is gated
  // against its own bounded allowlist (without widening the global default).
  const curated = request(
    "POST",
    "/v1/control/sources/src_x/compatibility-check",
    {
      cookie,
      body: { sourceSnapshotId: "snap_1", installConfigId: "cfg-official-talk" },
    },
  );
  const curatedResp = await handleControlRoute({
    request: curated.request,
    url: curated.url,
    store,
    operations,
  });
  expect(curatedResp?.status).toEqual(201);
  expect(operations.calls.createSourceCompatibilityCheck?.[1]).toEqual({
    sourceSnapshotId: "snap_1",
    installConfigId: "cfg-official-talk",
  });
});

test("Providers: templates are public to session", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();

  const providers = request("GET", "/v1/control/providers", { cookie });
  const providersResp = await handleControlRoute({
    request: providers.request,
    url: providers.url,
    store,
    operations,
  });
  expect(providersResp?.status).toEqual(200);
  expect(operations.calls.listProviderTemplates).toEqual([]);

});

test("Runs: GET run, approve (session subject actor), logs", async () => {
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

  const approve = request("POST", "/v1/control/runs/plan_1/approve", {
    cookie,
    body: { approvedBy: "spoofed_actor", reason: "reviewed plan" },
  });
  const approveResp = await handleControlRoute({
    request: approve.request,
    url: approve.url,
    store,
    operations,
  });
  expect(approveResp?.status).toEqual(200);
  const approveCall = operations.calls.approveRun?.[1] as {
    approvedBy: string;
    reason?: string;
  };
  expect(approveCall).toEqual({
    approvedBy: subject,
    reason: "reviewed plan",
  });

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

test("Connections: requires spaceId; operator-connection-defaults is Space-gated", async () => {
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

  const defaultsMissing = request(
    "GET",
    "/v1/control/operator-connection-defaults",
    {
      cookie,
    },
  );
  const defaultsMissingResp = await handleControlRoute({
    request: defaultsMissing.request,
    url: defaultsMissing.url,
    store,
    operations,
  });
  expect(defaultsMissingResp?.status).toEqual(400);

  const defaults = request(
    "GET",
    "/v1/control/operator-connection-defaults?spaceId=space_a",
    { cookie },
  );
  const defaultsResp = await handleControlRoute({
    request: defaults.request,
    url: defaults.url,
    store,
    operations,
  });
  expect(defaultsResp?.status).toEqual(200);
  expect(operations.calls.listOperatorConnectionDefaults).toBeDefined();
});

test("Connections create: registers a Space-owned connection; token never echoed", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();

  const create = request("POST", "/v1/control/connections", {
    cookie,
    body: {
      spaceId: "space_a",
      provider: "cloudflare",
      displayName: "本番 Cloudflare",
      // caller tries to widen to an operator default — must be ignored.
      scope: "operator",
      values: { CLOUDFLARE_API_TOKEN: "super-secret-token-value" },
    },
  });
  const response = await handleControlRoute({
    request: create.request,
    url: create.url,
    store,
    operations,
  });
  expect(response?.status).toEqual(201);

  // The facade was called with a Space-scoped cloudflare_api_token request.
  const passed = operations.calls.createConnection?.[0] as {
    spaceId?: string;
    provider?: string;
    kind?: string;
    scope?: string;
    values?: Record<string, string>;
  };
  expect(passed.spaceId).toEqual("space_a");
  expect(passed.provider).toEqual("cloudflare");
  expect(passed.kind).toEqual("cloudflare_api_token");
  // Forced Space scope regardless of the caller-supplied `scope: "operator"`.
  expect(passed.scope).toEqual("space");
  // The write-only token reaches the facade…
  expect(passed.values?.CLOUDFLARE_API_TOKEN).toEqual(
    "super-secret-token-value",
  );

  // …but is NEVER present in the HTTP response body.
  const text = await response!.text();
  expect(text).not.toContain("super-secret-token-value");
  expect(text).not.toContain("CLOUDFLARE_API_TOKEN");
});

test("Connections create: requires spaceId and values", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();

  const noSpace = request("POST", "/v1/control/connections", {
    cookie,
    body: { provider: "cloudflare", values: { CLOUDFLARE_API_TOKEN: "t" } },
  });
  const noSpaceResp = await handleControlRoute({
    request: noSpace.request,
    url: noSpace.url,
    store,
    operations,
  });
  expect(noSpaceResp?.status).toEqual(400);

  const noValues = request("POST", "/v1/control/connections", {
    cookie,
    body: { spaceId: "space_a", provider: "cloudflare", values: {} },
  });
  const noValuesResp = await handleControlRoute({
    request: noValues.request,
    url: noValues.url,
    store,
    operations,
  });
  expect(noValuesResp?.status).toEqual(400);
  // Neither malformed request reached the facade.
  expect(operations.calls.createConnection).toBeUndefined();
});

test("Connections create: another Space is forbidden (no connection minted)", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations({
    spaces: {
      getSpace: async (id) => ({
        id,
        handle: "other",
        displayName: "Other",
        type: "personal" as const,
        ownerUserId: "tsub_other",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      }),
    },
  });
  const create = request("POST", "/v1/control/connections", {
    cookie,
    body: {
      spaceId: "space_b",
      provider: "cloudflare",
      values: { CLOUDFLARE_API_TOKEN: "secret" },
    },
  });
  const response = await handleControlRoute({
    request: create.request,
    url: create.url,
    store,
    operations,
  });
  expect(response?.status).toEqual(403);
  // The space gate runs BEFORE any create — no secret ever reaches the facade.
  expect(operations.calls.createConnection).toBeUndefined();
});

test("Cloudflare OAuth: 501 when the operator has not wired the helper", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();

  const start = request(
    "POST",
    "/v1/control/connections/cloudflare/oauth/start",
    { cookie, body: { spaceId: "space_a" } },
  );
  const startResp = await handleControlRoute({
    request: start.request,
    url: start.url,
    store,
    operations,
  });
  expect(startResp?.status).toEqual(501);

  const callback = request(
    "GET",
    "/v1/control/connections/cloudflare/oauth/callback?code=c&state=s",
    { cookie },
  );
  const callbackResp = await handleControlRoute({
    request: callback.request,
    url: callback.url,
    store,
    operations,
  });
  expect(callbackResp?.status).toEqual(501);
});

test("Cloudflare OAuth: start authorizes and callback redirects to /connections, minting a Space-owned connection", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie, subject } = seedSession(store);
  // Record the subject the cookie-gated start signed into the state, then the
  // cross-site callback replays it back through `complete` (mirroring the real
  // HMAC-signed state, which carries the subject across the redirect).
  let signedSubject: string | undefined;
  const operations = fakeOperations({
    connectionOAuth: {
      cloudflare: {
        start: async (input) => {
          signedSubject = input.subject;
          return {
            authorizationUrl:
              "https://dash.cloudflare.com/oauth2/auth?client_id=cf&state=signed&space=" +
              encodeURIComponent(input.spaceId),
            state: "signed",
          };
        },
        complete: async () => ({
          request: {
            spaceId: "space_a",
            provider: "cloudflare",
            kind: "provider_env_set" as const,
            authMethod: "static_secret" as const,
            values: { CLOUDFLARE_API_TOKEN: "minted-oauth-token" },
          },
          subject: signedSubject,
        }),
      },
    },
  });

  const start = request(
    "POST",
    "/v1/control/connections/cloudflare/oauth/start",
    { cookie, body: { spaceId: "space_a" } },
  );
  const startResp = await handleControlRoute({
    request: start.request,
    url: start.url,
    store,
    operations,
  });
  expect(startResp?.status).toEqual(200);
  const startBody = (await startResp!.json()) as { authorizationUrl: string };
  expect(startBody.authorizationUrl).toContain("dash.cloudflare.com");
  // The authenticated subject is bound into the OAuth state at start time.
  expect(signedSubject).toEqual(subject);

  // The callback arrives via a top-level CROSS-SITE redirect: NO session cookie
  // (SameSite=Strict does not ride it) and NO Authorization header. The flow
  // must still complete by authorizing from the signed state's subject.
  const callback = request(
    "GET",
    "/v1/control/connections/cloudflare/oauth/callback?code=cf-code&state=signed",
  );
  const callbackResp = await handleControlRoute({
    request: callback.request,
    url: callback.url,
    store,
    operations,
  });
  // Backend route redirects to the dashboard /connections screen (no SPA route).
  expect(callbackResp?.status).toEqual(303);
  const location = callbackResp!.headers.get("location") ?? "";
  expect(location).toContain("/connections");
  expect(location).toContain("connected=1");
  // The minted token never rides the redirect query.
  expect(location).not.toContain("minted-oauth-token");

  // A Space-owned connection was created from the OAuth result.
  const passed = operations.calls.createConnection?.[0] as {
    spaceId?: string;
    scope?: string;
  };
  expect(passed.spaceId).toEqual("space_a");
  expect(passed.scope).toEqual("space");
});

test("Cloudflare OAuth callback without the session cookie still completes (cross-site redirect)", async () => {
  // Regression guard for the SameSite=Strict gap: a browser following the
  // dash.cloudflare.com -> worker redirect sends neither header nor cookie.
  // Before the fix the up-front requireAccountSession returned 401 JSON and the
  // user never reached /connections. The callback must authorize from the
  // signed state subject alone.
  const store = new InMemoryAccountsStore();
  // The owning account exists, but we deliberately present NO cookie.
  seedSession(store, { subject: "tsub_ctrl" });
  const operations = fakeOperations({
    connectionOAuth: {
      cloudflare: {
        start: async () => ({ authorizationUrl: "https://x", state: "signed" }),
        complete: async () => ({
          request: {
            spaceId: "space_a",
            provider: "cloudflare",
            kind: "provider_env_set" as const,
            authMethod: "static_secret" as const,
            values: { CLOUDFLARE_API_TOKEN: "minted" },
          },
          subject: "tsub_ctrl",
        }),
      },
    },
  });
  const callback = request(
    "GET",
    "/v1/control/connections/cloudflare/oauth/callback?code=cf-code&state=signed",
    // NO cookie header on purpose: this is the cross-site case.
  );
  const response = await handleControlRoute({
    request: callback.request,
    url: callback.url,
    store,
    operations,
  });
  // NOT a 401 JSON — a real 303 redirect back to the dashboard.
  expect(response?.status).toEqual(303);
  const location = response!.headers.get("location") ?? "";
  expect(location).toContain("/connections");
  expect(location).toContain("connected=1");
  const passed = operations.calls.createConnection?.[0] as { scope?: string };
  expect(passed.scope).toEqual("space");
});

test("Cloudflare OAuth callback: an unsigned state (no subject) is refused", async () => {
  // A forged/legacy callback whose state carries no signed subject must not be
  // trusted to mint a Connection, even though the spaceId looks owned.
  const store = new InMemoryAccountsStore();
  seedSession(store, { subject: "tsub_ctrl" });
  const operations = fakeOperations({
    connectionOAuth: {
      cloudflare: {
        start: async () => ({ authorizationUrl: "https://x", state: "signed" }),
        complete: async () => ({
          request: {
            spaceId: "space_a",
            provider: "cloudflare",
            kind: "provider_env_set" as const,
            authMethod: "static_secret" as const,
            values: { CLOUDFLARE_API_TOKEN: "minted" },
          },
          // subject intentionally absent (unsigned/legacy state).
        }),
      },
    },
  });
  const callback = request(
    "GET",
    "/v1/control/connections/cloudflare/oauth/callback?code=cf-code&state=signed",
  );
  const response = await handleControlRoute({
    request: callback.request,
    url: callback.url,
    store,
    operations,
  });
  expect(response?.status).toEqual(303);
  const location = response!.headers.get("location") ?? "";
  expect(location).toContain("connection_error=oauth_failed");
  expect(operations.calls.createConnection).toBeUndefined();
});

test("Cloudflare OAuth callback: a Space the signed subject does not own is not minted", async () => {
  const store = new InMemoryAccountsStore();
  // Present a cookie too, to prove the gate is the SIGNED subject, not the
  // cookie: the signed subject does not own the Space, so the mint is refused.
  const { cookie } = seedSession(store);
  const operations = fakeOperations({
    spaces: {
      getSpace: async (id) => ({
        id,
        handle: "other",
        displayName: "Other",
        type: "personal" as const,
        ownerUserId: "tsub_other",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      }),
    },
    connectionOAuth: {
      cloudflare: {
        start: async () => ({ authorizationUrl: "https://x", state: "s" }),
        complete: async () => ({
          request: {
            // The signed state resolves to a Space owned by someone else.
            spaceId: "space_b",
            provider: "cloudflare",
            kind: "provider_env_set" as const,
            authMethod: "static_secret" as const,
            values: { CLOUDFLARE_API_TOKEN: "minted" },
          },
          // The signed subject is the session subject, who does NOT own space_b.
          subject: "tsub_ctrl",
        }),
      },
    },
  });
  const callback = request(
    "GET",
    "/v1/control/connections/cloudflare/oauth/callback?code=cf-code&state=signed",
    { cookie },
  );
  const response = await handleControlRoute({
    request: callback.request,
    url: callback.url,
    store,
    operations,
  });
  // Redirect carries an opaque error; no connection is minted cross-tenant.
  expect(response?.status).toEqual(303);
  const location = response!.headers.get("location") ?? "";
  expect(location).toContain("connection_error=forbidden");
  expect(operations.calls.createConnection).toBeUndefined();
});

test("OutputShares: list, create, approve, and revoke are Space-gated", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie, subject } = seedSession(store);
  seedLedgerSpace(store, {
    subject,
    accountId: "acct_to",
    spaceId: "space_b",
  });
  const operations = fakeOperations();

  const list = request("GET", "/v1/control/output-shares?spaceId=space_a", {
    cookie,
  });
  const listResp = await handleControlRoute({
    request: list.request,
    url: list.url,
    store,
    operations,
  });
  expect(listResp?.status).toEqual(200);
  expect(operations.calls.listOutputShares?.[0]).toEqual("space_a");

  const create = request("POST", "/v1/control/output-shares", {
    cookie,
    body: {
      fromSpaceId: "space_a",
      toSpaceId: "space_b",
      producerInstallationId: "inst_1",
      outputs: [{ name: "domain", alias: "base_domain", sensitive: true }],
      sensitivePolicy: { allow: true, reason: "approved by both spaces" },
    },
  });
  const createResp = await handleControlRoute({
    request: create.request,
    url: create.url,
    store,
    operations,
  });
  expect(createResp?.status).toEqual(201);
  expect(
    (
      operations.calls.createOutputShare?.[0] as {
        outputs: Array<{ alias?: string; sensitive?: boolean }>;
        sensitivePolicy?: { allow: boolean; reason?: string };
      }
    ).outputs[0]?.alias,
  ).toEqual("base_domain");
  expect(
    (
      operations.calls.createOutputShare?.[0] as {
        outputs: Array<{ alias?: string; sensitive?: boolean }>;
        sensitivePolicy?: { allow: boolean; reason?: string };
      }
    ).outputs[0]?.sensitive,
  ).toBe(true);
  expect(
    (
      operations.calls.createOutputShare?.[0] as {
        outputs: Array<{ alias?: string; sensitive?: boolean }>;
        sensitivePolicy?: { allow: boolean; reason?: string };
      }
    ).sensitivePolicy,
  ).toEqual({ allow: true, reason: "approved by both spaces" });

  const approve = request(
    "POST",
    "/v1/control/output-shares/oshare_1/approve",
    {
      cookie,
    },
  );
  const approveResp = await handleControlRoute({
    request: approve.request,
    url: approve.url,
    store,
    operations,
  });
  expect(approveResp?.status).toEqual(200);
  expect(operations.calls.approveOutputShare?.[0]).toEqual("oshare_1");

  const revoke = request("POST", "/v1/control/output-shares/oshare_1/revoke", {
    cookie,
  });
  const revokeResp = await handleControlRoute({
    request: revoke.request,
    url: revoke.url,
    store,
    operations,
  });
  expect(revokeResp?.status).toEqual(200);
  expect(operations.calls.revokeOutputShare?.[0]).toEqual("oshare_1");
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
      putDeploymentProfile: async (profile) => profile,
      getDeploymentProfileByInstallation: async () => undefined,
    },
  });
  const { request: req, url } = request(
    "GET",
    "/v1/control/installations/inst_missing",
    { cookie },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(404);
  const body = (await response!.json()) as { error: string };
  expect(body.error).toEqual("not_found");
});

test("unknown control subpath is 404 after the session gate", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request("GET", "/v1/control/nope", { cookie });
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(404);
});

// --- personalSpaceHandle derivation ---------------------------------------

test("personalSpaceHandle prefers displayName, then email, then fallback", () => {
  expect(
    personalSpaceHandle({ subject: "tsub_x", displayName: "Shota Tomiyama" }),
  ).toEqual("shota-tomiyama");
  expect(
    personalSpaceHandle({ subject: "tsub_x", email: "alice.dev@example.com" }),
  ).toEqual("alice-dev");
  // Unusable displayName ("!") falls through to email.
  expect(
    personalSpaceHandle({
      subject: "tsub_x",
      displayName: "!",
      email: "bob@x.io",
    }),
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
        throw Object.assign(new Error("taken"), {
          code: "failed_precondition",
        });
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

// --- POST /v1/control/plan-runs/:planRunId/apply (§31 GUI deploy) -----------

test("POST /v1/control/plan-runs/:id/apply applies a succeeded plan for an owned Space", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request(
    "POST",
    "/v1/control/plan-runs/plan_1/apply",
    { cookie },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(201);
  // The plan run is resolved (for the space gate) before the apply is created.
  expect(operations.calls.getPlanRun).toEqual(["plan_1"]);
  const applyArg = operations.calls.createApplyRun?.[0] as {
    planRunId: string;
    confirmDestructive?: boolean;
    expected: { planRunId: string; planDigest: string };
  };
  expect(applyArg.planRunId).toEqual("plan_1");
  // A non-destructive apply does not send the confirmation flag.
  expect(applyArg.confirmDestructive).toBeUndefined();
  // The expected guard is rebuilt server-side from the reviewed plan.
  expect(applyArg.expected.planRunId).toEqual("plan_1");
  expect(applyArg.expected.planDigest).toEqual(`sha256:${"d".repeat(64)}`);
});

test("POST /v1/control/plan-runs/:id/apply forwards confirmDestructive for a destructive plan", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request(
    "POST",
    "/v1/control/plan-runs/plan_1/apply",
    { cookie, body: { confirmDestructive: true } },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(201);
  const applyArg = operations.calls.createApplyRun?.[0] as {
    confirmDestructive?: boolean;
  };
  expect(applyArg.confirmDestructive).toEqual(true);
});

test("POST /v1/control/plan-runs/:id/apply rejects a plan from another inaccessible Space", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations({
    spaces: {
      listSpaces: async () => [],
      // The plan's owning Space (space_b) is owned by a different subject.
      getSpace: async (id) => ({
        id,
        handle: "other",
        displayName: "Other",
        type: "personal" as const,
        ownerUserId: "tsub_other",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      }),
    },
    getPlanRun: async (id) =>
      ({
        planRun: {
          id,
          spaceId: "space_b",
          status: "succeeded",
          operation: "create",
          runnerProfileId: "rp_default",
          sourceDigest: `sha256:${"a".repeat(64)}`,
          variablesDigest: `sha256:${"b".repeat(64)}`,
          policyDecisionDigest: `sha256:${"c".repeat(64)}`,
          policy: { status: "passed" },
          planDigest: `sha256:${"d".repeat(64)}`,
          planArtifact: { kind: "object-storage", ref: "k", digest: "e" },
        },
      }) as unknown as Awaited<
        ReturnType<ControlPlaneOperations["getPlanRun"]>
      >,
  });
  const { request: req, url } = request(
    "POST",
    "/v1/control/plan-runs/plan_other/apply",
    { cookie },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(403);
  // The plan was resolved (to learn its Space, space_b) but the gate rejects
  // before any apply is created.
  expect(operations.calls.createApplyRun).toBeUndefined();
});

test("POST /v1/control/plan-runs/:id/apply surfaces the controller failed_precondition for an unfinished plan", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations({
    createApplyRun: async () => {
      throw Object.assign(
        new Error("plan run plan_1 is running; apply requires a succeeded plan"),
        { code: "failed_precondition" },
      );
    },
  });
  const { request: req, url } = request(
    "POST",
    "/v1/control/plan-runs/plan_1/apply",
    { cookie },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(409);
  const body = (await response?.json()) as { error?: string };
  expect(body.error).toEqual("failed_precondition");
});

test("POST /v1/control/plan-runs/:id/apply surfaces failed_precondition when the plan was already applied", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations({
    createApplyRun: async () => {
      throw Object.assign(
        new Error("plan run plan_1 has already been applied by apply run apply_1"),
        { code: "failed_precondition" },
      );
    },
  });
  const { request: req, url } = request(
    "POST",
    "/v1/control/plan-runs/plan_1/apply",
    { cookie },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(409);
});

test("POST /v1/control/plan-runs/:id rejects a non-apply leaf and the wrong method", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const notApply = request("POST", "/v1/control/plan-runs/plan_1/bogus", {
    cookie,
  });
  expect(
    (
      await handleControlRoute({
        request: notApply.request,
        url: notApply.url,
        store,
        operations,
      })
    )?.status,
  ).toEqual(404);
  const wrongMethod = request("GET", "/v1/control/plan-runs/plan_1/apply", {
    cookie,
  });
  expect(
    (
      await handleControlRoute({
        request: wrongMethod.request,
        url: wrongMethod.url,
        store,
        operations,
      })
    )?.status,
  ).toEqual(405);
});

test("maybeEnsurePersonalSpaceForSession is a no-op without an operations facade", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const { request: req } = request("GET", "/v1/account/session/me", { cookie });
  // No operations -> returns quietly.
  await maybeEnsurePersonalSpaceForSession({ request: req, store });
});
