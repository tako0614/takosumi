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
      getManagedDefaultStatus: async () => {
        record("getManagedDefaultStatus");
        return { available: false, providers: [] };
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
    getRunCost: async (id) => {
      record("getRunCost", id);
      return {
        runId: id,
        billingMode: "enforce",
        estimatedCredits: 12,
        availableCredits: 5,
        reservationStatus: "insufficient_credits",
        creditShortfall: 7,
        blocked: true,
        reasons: [
          "credit reservation failed: 12 credits estimated but only 5 available",
        ],
      };
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

// --- /api/v1 edge surface ownership + session dispatcher -------------------

test("isControlRoutePath owns /api/v1 and its subtree only", () => {
  expect(isControlRoutePath("/api/v1")).toEqual(true);
  expect(isControlRoutePath("/api/v1/spaces")).toEqual(true);
  expect(isControlRoutePath("/api/v1/runs/plan_1/logs")).toEqual(true);
  expect(isControlRoutePath("/api/v1x")).toEqual(false);
  expect(isControlRoutePath("/v1/installations")).toEqual(false);
  expect(isControlRoutePath("/v1/account/session/me")).toEqual(false);
});

test("GET /api/v1/spaces serves the session control surface", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request("GET", "/api/v1/spaces", { cookie });
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

test("anonymous /api/v1 requests are 401", async () => {
  const store = new InMemoryAccountsStore();
  const operations = fakeOperations();
  const { request: req, url } = request("GET", "/api/v1/spaces");
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(401);
  await response?.body?.cancel();
  expect(operations.calls.listSpaces).toBeUndefined();
});

test("GET /api/v1/spaces/:id a session cannot access is 403", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store, { subject: "tsub_outsider" });
  // The Space is owned by a DIFFERENT subject; the outsider session is denied.
  const operations = fakeOperations();
  const { request: req, url } = request("GET", "/api/v1/spaces/space_other", {
    cookie,
  });
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(403);
  await response?.body?.cancel();
});

// --- Anonymous = 401 -------------------------------------------------------

test("anonymous control requests are 401 across the family", async () => {
  const store = new InMemoryAccountsStore();
  const operations = fakeOperations();
  const paths: Array<[string, string]> = [
    ["GET", "/api/v1/spaces"],
    ["POST", "/api/v1/spaces"],
    ["GET", "/api/v1/spaces/space_a/installations"],
    ["GET", "/api/v1/spaces/space_a/graph"],
    ["GET", "/api/v1/spaces/space_a/activity"],
    ["GET", "/api/v1/spaces/space_a/backups"],
    ["POST", "/api/v1/spaces/space_a/backups"],
    ["GET", "/api/v1/spaces/space_a/billing"],
    ["GET", "/api/v1/spaces/space_a/usage"],
    ["GET", "/api/v1/spaces/space_a/credit-reservations"],
    ["POST", "/api/v1/spaces/space_a/credits/top-up"],
    ["POST", "/api/v1/spaces/space_a/subscription/change"],
    ["POST", "/api/v1/spaces/space_a/plan-update"],
    ["GET", "/api/v1/installations/inst_1"],
    ["GET", "/api/v1/installations/inst_1/deployment-profile"],
    ["POST", "/api/v1/installations/inst_1/plan"],
    ["POST", "/api/v1/installations/inst_1/backups"],
    ["GET", "/api/v1/install-configs"],
    ["GET", "/api/v1/providers"],
    ["POST", "/api/v1/sources/src_x/compatibility-check"],
    ["POST", "/api/v1/plan-runs/plan_1/apply"],
    ["GET", "/api/v1/runs/plan_1"],
    ["GET", "/api/v1/runs/plan_1/cost"],
    ["GET", "/api/v1/run-groups/rg_1"],
    ["GET", "/api/v1/connections?spaceId=space_a"],
    ["GET", "/api/v1/operator-connection-defaults"],
    ["GET", "/api/v1/spaces/space_a/managed-defaults"],
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
  const { request: req, url } = request("GET", "/api/v1/spaces", {
    cookie,
  });
  const response = await handleControlRoute({ request: req, url, store });
  expect(response?.status).toEqual(503);
});

// --- Session happy paths ---------------------------------------------------

test("GET /api/v1/spaces returns spaces for a session", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request("GET", "/api/v1/spaces", {
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

test("GET /api/v1/spaces/:id/billing returns billing settings and balance", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request(
    "GET",
    "/api/v1/spaces/space_a/billing",
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

test("GET /api/v1/spaces/:id/usage returns usage events", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request(
    "GET",
    "/api/v1/spaces/space_a/usage",
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

test("GET /api/v1/spaces/:id/credit-reservations returns reservation history", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request(
    "GET",
    "/api/v1/spaces/space_a/credit-reservations",
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

test("GET /api/v1/spaces/:id/backups lists Space backups", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request(
    "GET",
    "/api/v1/spaces/space_a/backups",
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

test("POST /api/v1/spaces/:id/backups creates a Space backup", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request(
    "POST",
    "/api/v1/spaces/space_a/backups",
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

test("POST /api/v1/spaces/:id/credits/top-up forwards credit amount", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request(
    "POST",
    "/api/v1/spaces/space_a/credits/top-up",
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

test("POST /api/v1/spaces/:id/subscription/change forwards billing settings", async () => {
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
    "/api/v1/spaces/space_a/subscription/change",
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

test("GET /api/v1/spaces filters out spaces the session cannot access", async () => {
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
  const { request: req, url } = request("GET", "/api/v1/spaces", {
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

test("PATCH /api/v1/spaces/:id updates display name and policy after Space access", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request("PATCH", "/api/v1/spaces/space_a", {
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

test("PATCH /api/v1/spaces/:id rejects policy that is not a JSON object", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request("PATCH", "/api/v1/spaces/space_a", {
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
    "/api/v1/spaces/space_b/installations",
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

test("PATCH /api/v1/spaces/:id rejects a non-member session before dispatch", async () => {
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
  const { request: req, url } = request("PATCH", "/api/v1/spaces/space_b", {
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
    "/api/v1/installations/inst_other/plan",
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

test("POST /api/v1/spaces/:id/installations rejects a Source from another inaccessible Space", async () => {
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
    "/api/v1/spaces/space_a/installations",
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

test("POST /api/v1/sources rejects an authConnectionId from another inaccessible Space", async () => {
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
  const { request: req, url } = request("POST", "/api/v1/sources", {
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

test("POST /api/v1/output-shares rejects a producer from another inaccessible Space", async () => {
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
  const { request: req, url } = request("POST", "/api/v1/output-shares", {
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

test("GET /api/v1/operator-connection-defaults rejects an inaccessible Space before dispatch", async () => {
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
    "/api/v1/operator-connection-defaults?spaceId=space_b",
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

test("GET /api/v1/operator-connection-defaults never echoes a connection id (session surface)", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  // The session surface is reachable by ANY Space member, so it must project
  // OUT the operator-internal row `id` and the `connectionId` it points at
  // (those stay on the bearer-gated §30 surface). Feed the facade a default
  // carrying both and assert the wire body leaks neither, mirroring the
  // credential-free managed-defaults projection.
  const operations = fakeOperations({
    connections: {
      listOperatorConnectionDefaults: async () => [
        {
          id: "ocd_secret",
          provider: "cloudflare",
          connectionId: "conn_operator_secret",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-02T00:00:00Z",
        },
      ],
      getManagedDefaultStatus: async () => ({
        available: true,
        providers: ["cloudflare"],
      }),
    },
  });
  const { request: req, url } = request(
    "GET",
    "/api/v1/operator-connection-defaults?spaceId=space_a",
    { cookie },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(200);
  const raw = await response!.text();
  expect(raw.includes("conn_operator_secret")).toEqual(false);
  expect(raw.includes("connectionId")).toEqual(false);
  expect(raw.includes("ocd_secret")).toEqual(false);
  const body = JSON.parse(raw) as {
    operatorConnectionDefaults: readonly Record<string, unknown>[];
  };
  expect(body.operatorConnectionDefaults.length).toEqual(1);
  expect(Object.keys(body.operatorConnectionDefaults[0]!).sort()).toEqual([
    "createdAt",
    "provider",
    "updatedAt",
  ]);
});

// --- Managed-default status (operator key availability) --------------------

test("GET /api/v1/spaces/:id/managed-defaults reports available=true with covered providers", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations({
    connections: {
      listOperatorConnectionDefaults: async () => [],
      getManagedDefaultStatus: async () => ({
        available: true,
        providers: ["cloudflare"],
      }),
    },
  });
  const { request: req, url } = request(
    "GET",
    "/api/v1/spaces/space_a/managed-defaults",
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
    available: boolean;
    capabilities: string[];
  };
  expect(body.available).toEqual(true);
  expect(body.capabilities).toEqual(["cloudflare"]);
});

test("GET /api/v1/spaces/:id/managed-defaults reaches the managed-default facade", async () => {
  // The base fake records every facade call; with no `connections` override the
  // recording `getManagedDefaultStatus` is in place, so a successful dispatch
  // leaves its call recorded (and never touches the bearer-only
  // listOperatorConnectionDefaults path).
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request(
    "GET",
    "/api/v1/spaces/space_a/managed-defaults",
    { cookie },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(200);
  expect(operations.calls.getManagedDefaultStatus).toBeDefined();
  expect(operations.calls.listOperatorConnectionDefaults).toBeUndefined();
});

test("GET /api/v1/spaces/:id/managed-defaults reports available=false when no operator default", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations({
    connections: {
      listOperatorConnectionDefaults: async () => [],
      getManagedDefaultStatus: async () => ({
        available: false,
        providers: [],
      }),
    },
  });
  const { request: req, url } = request(
    "GET",
    "/api/v1/spaces/space_a/managed-defaults",
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
    available: boolean;
    capabilities: string[];
  };
  expect(body.available).toEqual(false);
  expect(body.capabilities).toEqual([]);
});

test("GET /api/v1/spaces/:id/managed-defaults never echoes a connection id or secret", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  // The facade is the only thing that can see the operator default's
  // connectionId; even if a buggy facade tried to leak one through the status
  // shape, the route re-projects to { available, capabilities } only. Assert the
  // wire body carries NEITHER a connection id NOR any secret-shaped field.
  const operations = fakeOperations({
    connections: {
      listOperatorConnectionDefaults: async () => [
        {
          id: "ocd_secret",
          provider: "cloudflare",
          connectionId: "conn_operator_secret",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ],
      getManagedDefaultStatus: async () => ({
        available: true,
        providers: ["cloudflare"],
      }),
    },
  });
  const { request: req, url } = request(
    "GET",
    "/api/v1/spaces/space_a/managed-defaults",
    { cookie },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(200);
  const raw = await response!.text();
  expect(raw.includes("conn_operator_secret")).toEqual(false);
  expect(raw.includes("connectionId")).toEqual(false);
  expect(raw.includes("ocd_secret")).toEqual(false);
  const body = JSON.parse(raw) as Record<string, unknown>;
  expect(Object.keys(body).sort()).toEqual(["available", "capabilities"]);
});

test("GET /api/v1/spaces/:id/managed-defaults rejects an inaccessible Space before dispatch", async () => {
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
    "/api/v1/spaces/space_b/managed-defaults",
    { cookie },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(403);
  expect(operations.calls.getManagedDefaultStatus).toBeUndefined();
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
    "/api/v1/spaces/space_ledger/installations",
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

test("POST /api/v1/spaces uses the session subject as ownerUserId", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie, subject } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request("POST", "/api/v1/spaces", {
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

test("GET /api/v1/spaces/:id/installations lists installations", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request(
    "GET",
    "/api/v1/spaces/space_a/installations",
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

test("POST /api/v1/spaces/:id/installations creates an installation", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request(
    "POST",
    "/api/v1/spaces/space_a/installations",
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

test("GET /api/v1/spaces/:id/graph projects nodes + edges", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request(
    "GET",
    "/api/v1/spaces/space_a/graph",
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

test("GET /api/v1/installations/:id reads one installation", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request(
    "GET",
    "/api/v1/installations/inst_1",
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

test("POST /api/v1/installations/:id/backups creates a backup for the Installation Space", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request(
    "POST",
    "/api/v1/installations/inst_1/backups",
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

test("GET /api/v1/installations/:id/deployment-profile reads bindings", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request(
    "GET",
    "/api/v1/installations/inst_1/deployment-profile",
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

test("PUT /api/v1/installations/:id/deployment-profile saves bindings", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request(
    "PUT",
    "/api/v1/installations/inst_1/deployment-profile",
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

test("POST /api/v1/installations/:id/plan returns 201", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request(
    "POST",
    "/api/v1/installations/inst_1/plan",
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

test("POST /api/v1/installations/:id/destroy-plan returns 201", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request(
    "POST",
    "/api/v1/installations/inst_1/destroy-plan",
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

test("POST /api/v1/installations/:id/dependencies derives spaceId from the consumer", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request(
    "POST",
    "/api/v1/installations/inst_2/dependencies",
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

test("DELETE /api/v1/dependencies/:id returns 204", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request(
    "DELETE",
    "/api/v1/dependencies/dep_1",
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

test("GET /api/v1/install-configs merges official + scoped", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request(
    "GET",
    "/api/v1/install-configs?spaceId=space_a",
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

  const missing = request("GET", "/api/v1/sources", { cookie });
  const missingResp = await handleControlRoute({
    request: missing.request,
    url: missing.url,
    store,
    operations,
  });
  expect(missingResp?.status).toEqual(400);

  const list = request("GET", "/api/v1/sources?spaceId=space_a", {
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

  const create = request("POST", "/api/v1/sources", {
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

  const sync = request("POST", "/api/v1/sources/src_x/sync", { cookie });
  const syncResp = await handleControlRoute({
    request: sync.request,
    url: sync.url,
    store,
    operations,
  });
  expect(syncResp?.status).toEqual(201);
  expect(operations.calls.createSourceSync?.[0]).toEqual("src_x");

  const snapshots = request("GET", "/api/v1/sources/src_x/snapshots", {
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
    "/api/v1/sources/src_x/compatibility-check",
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
    "/api/v1/sources/src_x/compatibility-check",
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

  const providers = request("GET", "/api/v1/providers", { cookie });
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

  const get = request("GET", "/api/v1/runs/plan_1", { cookie });
  const getResp = await handleControlRoute({
    request: get.request,
    url: get.url,
    store,
    operations,
  });
  expect(getResp?.status).toEqual(200);

  const approve = request("POST", "/api/v1/runs/plan_1/approve", {
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

  const logs = request("GET", "/api/v1/runs/plan_1/logs", { cookie });
  const logsResp = await handleControlRoute({
    request: logs.request,
    url: logs.url,
    store,
    operations,
  });
  expect(logsResp?.status).toEqual(200);
});

test("Runs: GET cost surfaces the public credit-shortfall projection (space-gated)", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();

  const cost = request("GET", "/api/v1/runs/plan_1/cost", { cookie });
  const costResp = await handleControlRoute({
    request: cost.request,
    url: cost.url,
    store,
    operations,
  });
  expect(costResp?.status).toEqual(200);
  // The Run was resolved (for the space gate) then its cost projected.
  expect(operations.calls.getRun?.[0]).toEqual("plan_1");
  expect(operations.calls.getRunCost?.[0]).toEqual("plan_1");
  const body = (await costResp?.json()) as {
    cost: {
      runId: string;
      billingMode: string;
      estimatedCredits: number;
      availableCredits?: number;
      reservationStatus?: string;
      creditShortfall?: number;
      blocked: boolean;
      reasons: readonly string[];
    };
  };
  expect(body.cost.runId).toEqual("plan_1");
  expect(body.cost.billingMode).toEqual("enforce");
  expect(body.cost.estimatedCredits).toEqual(12);
  expect(body.cost.availableCredits).toEqual(5);
  expect(body.cost.reservationStatus).toEqual("insufficient_credits");
  expect(body.cost.creditShortfall).toEqual(7);
  expect(body.cost.blocked).toEqual(true);
  expect(body.cost.reasons.length).toEqual(1);
});

test("Runs: GET cost is method-gated to GET", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();

  const post = request("POST", "/api/v1/runs/plan_1/cost", { cookie });
  const postResp = await handleControlRoute({
    request: post.request,
    url: post.url,
    store,
    operations,
  });
  expect(postResp?.status).toEqual(405);
  expect(operations.calls.getRunCost).toBeUndefined();
});

test("RunGroups: plan-update, get, approve", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();

  const update = request("POST", "/api/v1/spaces/space_a/plan-update", {
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

  const get = request("GET", "/api/v1/run-groups/rg_1", { cookie });
  const getResp = await handleControlRoute({
    request: get.request,
    url: get.url,
    store,
    operations,
  });
  expect(getResp?.status).toEqual(200);

  const approve = request("POST", "/api/v1/run-groups/rg_1/approve", {
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

  const missing = request("GET", "/api/v1/connections", { cookie });
  const missingResp = await handleControlRoute({
    request: missing.request,
    url: missing.url,
    store,
    operations,
  });
  expect(missingResp?.status).toEqual(400);

  const scoped = request("GET", "/api/v1/connections?spaceId=space_a", {
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
    "/api/v1/operator-connection-defaults",
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
    "/api/v1/operator-connection-defaults?spaceId=space_a",
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

  const create = request("POST", "/api/v1/connections", {
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

  const noSpace = request("POST", "/api/v1/connections", {
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

  const noValues = request("POST", "/api/v1/connections", {
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
  const create = request("POST", "/api/v1/connections", {
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
    "/api/v1/connections/cloudflare/oauth/start",
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
    "/api/v1/connections/cloudflare/oauth/callback?code=c&state=s",
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
    "/api/v1/connections/cloudflare/oauth/start",
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
    "/api/v1/connections/cloudflare/oauth/callback?code=cf-code&state=signed",
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
    "/api/v1/connections/cloudflare/oauth/callback?code=cf-code&state=signed",
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
    "/api/v1/connections/cloudflare/oauth/callback?code=cf-code&state=signed",
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
    "/api/v1/connections/cloudflare/oauth/callback?code=cf-code&state=signed",
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

  const list = request("GET", "/api/v1/output-shares?spaceId=space_a", {
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

  const create = request("POST", "/api/v1/output-shares", {
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
    "/api/v1/output-shares/oshare_1/approve",
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

  const revoke = request("POST", "/api/v1/output-shares/oshare_1/revoke", {
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
    "/api/v1/installations/inst_missing",
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
  const { request: req, url } = request("GET", "/api/v1/nope", { cookie });
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

// --- POST /api/v1/plan-runs/:planRunId/apply (§31 GUI deploy) -----------

test("POST /api/v1/plan-runs/:id/apply applies a succeeded plan for an owned Space", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request(
    "POST",
    "/api/v1/plan-runs/plan_1/apply",
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

test("POST /api/v1/plan-runs/:id/apply forwards confirmDestructive for a destructive plan", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const { request: req, url } = request(
    "POST",
    "/api/v1/plan-runs/plan_1/apply",
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

test("POST /api/v1/plan-runs/:id/apply rejects a plan from another inaccessible Space", async () => {
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
    "/api/v1/plan-runs/plan_other/apply",
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

test("POST /api/v1/plan-runs/:id/apply surfaces the controller failed_precondition for an unfinished plan", async () => {
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
    "/api/v1/plan-runs/plan_1/apply",
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

test("POST /api/v1/plan-runs/:id/apply surfaces failed_precondition when the plan was already applied", async () => {
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
    "/api/v1/plan-runs/plan_1/apply",
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

test("POST /api/v1/plan-runs/:id rejects a non-apply leaf and the wrong method", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = fakeOperations();
  const notApply = request("POST", "/api/v1/plan-runs/plan_1/bogus", {
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
  const wrongMethod = request("GET", "/api/v1/plan-runs/plan_1/apply", {
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

// --- Deployments / outputs / rollback (§30 GUI deploy) ---------------------

/**
 * A Deployment ledger row whose `outputsPublic` is the allowlist projection.
 * `outputSnapshotId` points at the raw (un-projected) encrypted OutputSnapshot
 * and MUST be projected out of every session-surface read.
 */
function deploymentRow(
  id: string,
  spaceId: string,
  installationId = "inst_1",
): Record<string, unknown> {
  return {
    id,
    spaceId,
    installationId,
    environment: "production",
    applyRunId: "apply_1",
    sourceSnapshotId: "snap_1",
    stateGeneration: 3,
    outputSnapshotId: "osnap_secret_1",
    outputsPublic: { launch_url: "https://app.example.test" },
    status: "active",
    createdAt: "2026-01-01T00:00:00Z",
  };
}

/**
 * `fakeOperations` does not carry the deployment methods in its base fixture, so
 * we attach recording implementations here. Each records into the same
 * `operations.calls` map the base uses, so the gate-ordering assertions can read
 * which facade method was reached.
 */
function deploymentOperations(
  spaceId: string,
  overrides: Parameters<typeof fakeOperations>[0] = {},
): ReturnType<typeof fakeOperations> {
  const operations = fakeOperations(overrides);
  const calls = operations.calls;
  operations.listDeployments = async (installationId: string) => {
    calls.listDeployments = [installationId];
    return {
      deployments: [deploymentRow("dep_1", spaceId, installationId)],
    } as unknown as Awaited<
      ReturnType<ControlPlaneOperations["listDeployments"]>
    >;
  };
  operations.getDeployment = async (id: string) => {
    calls.getDeployment = [id];
    return deploymentRow(id, spaceId) as unknown as Awaited<
      ReturnType<ControlPlaneOperations["getDeployment"]>
    >;
  };
  operations.createDeploymentRollbackPlan = async (deploymentId: string) => {
    calls.createDeploymentRollbackPlan = [deploymentId];
    return {
      planRun: {
        id: "plan_rollback",
        spaceId,
        status: "queued",
        operation: "update",
        installationId: "inst_1",
        rolledBackFromDeploymentId: deploymentId,
      },
    } as unknown as Awaited<
      ReturnType<ControlPlaneOperations["createDeploymentRollbackPlan"]>
    >;
  };
  return operations;
}

function otherSpaceSpaces(): NonNullable<
  Parameters<typeof fakeOperations>[0]
>["spaces"] {
  return {
    getSpace: async (id) => ({
      id,
      handle: "other",
      displayName: "Other",
      type: "personal" as const,
      ownerUserId: "tsub_other",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    }),
  };
}

test("GET /api/v1/installations/:id/deployments lists deployments for an owned Space", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = deploymentOperations("space_a");
  const { request: req, url } = request(
    "GET",
    "/api/v1/installations/inst_1/deployments",
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
    deployments: Array<Record<string, unknown>>;
  };
  expect(body.deployments.length).toEqual(1);
  // The Installation's Space was resolved server-side for the gate.
  expect(operations.calls.getInstallation).toEqual(["inst_1"]);
  expect(operations.calls.listDeployments).toEqual(["inst_1"]);
  // The raw OutputSnapshot pointer is projected out of every row.
  expect(body.deployments[0]!.outputSnapshotId).toBeUndefined();
  expect(body.deployments[0]!.outputsPublic).toEqual({
    launch_url: "https://app.example.test",
  });
});

test("GET /api/v1/installations/:id/deployments rejects a non-member session with 403", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  // The Installation belongs to space_b, owned by a different subject.
  const operations = deploymentOperations("space_b", {
    spaces: otherSpaceSpaces(),
    installations: {
      getInstallation: async (id) => ({
        id,
        spaceId: "space_b",
        name: "inst",
        environment: "production",
        sourceId: "src_1",
        installConfigId: "ic_1",
        status: "ready" as const,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      }),
    },
  });
  const { request: req, url } = request(
    "GET",
    "/api/v1/installations/inst_b/deployments",
    { cookie },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(403);
  // The gate rejects before any deployment listing.
  expect(operations.calls.listDeployments).toBeUndefined();
});

test("GET /api/v1/deployments/:id returns only the public outputs projection", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = deploymentOperations("space_a");
  const { request: req, url } = request(
    "GET",
    "/api/v1/deployments/dep_1",
    { cookie },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(200);
  // The Deployment was resolved server-side to learn its Space for the gate.
  expect(operations.calls.getDeployment).toEqual(["dep_1"]);
  const body = (await response!.json()) as {
    deployment: Record<string, unknown>;
  };
  // Public outputsPublic is present; the raw OutputSnapshot pointer is gone.
  expect(body.deployment.outputsPublic).toEqual({
    launch_url: "https://app.example.test",
  });
  expect(body.deployment.outputSnapshotId).toBeUndefined();
  // No raw OutputSnapshot handle leaks into the serialized response.
  expect(JSON.stringify(body)).not.toContain("osnap_secret_1");
});

test("GET /api/v1/deployments/:id rejects a deployment in another Space with 403", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  // The Deployment belongs to space_b, owned by a different subject.
  const operations = deploymentOperations("space_b", {
    spaces: otherSpaceSpaces(),
  });
  const { request: req, url } = request(
    "GET",
    "/api/v1/deployments/dep_other",
    { cookie },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(403);
  // The Deployment was resolved (to learn its Space) but the gate rejects; no
  // projection is returned, so nothing could leak.
  expect(operations.calls.getDeployment).toEqual(["dep_other"]);
});

test("POST /api/v1/deployments/:id/rollback-plan creates a rollback plan for an owned Space", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = deploymentOperations("space_a");
  const { request: req, url } = request(
    "POST",
    "/api/v1/deployments/dep_1/rollback-plan",
    { cookie },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(201);
  // The Deployment's Space was resolved server-side for the gate first.
  expect(operations.calls.getDeployment).toEqual(["dep_1"]);
  expect(operations.calls.createDeploymentRollbackPlan).toEqual(["dep_1"]);
  const body = (await response!.json()) as { planRun: { id: string } };
  // The response carries the plan run that flows through approve -> apply.
  expect(body.planRun.id).toEqual("plan_rollback");
});

test("POST /api/v1/deployments/:id/rollback-plan rejects a deployment in another Space with 403", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = deploymentOperations("space_b", {
    spaces: otherSpaceSpaces(),
  });
  const { request: req, url } = request(
    "POST",
    "/api/v1/deployments/dep_other/rollback-plan",
    { cookie },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(403);
  // The gate rejects before any rollback plan is created.
  expect(operations.calls.createDeploymentRollbackPlan).toBeUndefined();
});

test("deployments routes are 401 for anonymous sessions", async () => {
  const store = new InMemoryAccountsStore();
  const operations = deploymentOperations("space_a");
  const paths: Array<[string, string]> = [
    ["GET", "/api/v1/installations/inst_1/deployments"],
    ["GET", "/api/v1/deployments/dep_1"],
    ["POST", "/api/v1/deployments/dep_1/rollback-plan"],
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
  // No facade method was reached behind the auth gate.
  expect(operations.calls.getDeployment).toBeUndefined();
  expect(operations.calls.listDeployments).toBeUndefined();
  expect(operations.calls.createDeploymentRollbackPlan).toBeUndefined();
});

test("POST /api/v1/deployments/:id/rollback-plan rejects an unknown leaf and the wrong method", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = deploymentOperations("space_a");
  const bogus = request("POST", "/api/v1/deployments/dep_1/bogus", {
    cookie,
  });
  expect(
    (
      await handleControlRoute({
        request: bogus.request,
        url: bogus.url,
        store,
        operations,
      })
    )?.status,
  ).toEqual(404);
  const wrongMethod = request("DELETE", "/api/v1/deployments/dep_1", {
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

// --- Members (Space membership / roles) ------------------------------------

type MemberRow = {
  id: string;
  spaceId: string;
  accountId: string;
  roles: string[];
  status: "active" | "invited" | "suspended";
  createdAt: string;
  updatedAt: string;
};

/**
 * A `fakeOperations` whose `members` facade is backed by an in-memory roster.
 * `spaceOwner` controls the namespace gate (`requireSpaceAccess`): when it
 * equals the session subject the namespace gate passes, so a 403 there isolates
 * the membership ROLE gate. The roster seeds the per-account roles the route
 * reads to decide the role/last-owner gate.
 */
function memberOperations(options: {
  spaceId: string;
  spaceOwner: string;
  roster: MemberRow[];
}): ControlPlaneOperations & {
  calls: Record<string, unknown[]>;
  roster: MemberRow[];
} {
  const roster = options.roster;
  const base = fakeOperations({
    spaces: {
      getSpace: async (id) => ({
        id,
        handle: "team",
        displayName: "Team",
        type: "personal" as const,
        ownerUserId: options.spaceOwner,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      }),
    },
  });
  const members: NonNullable<ControlPlaneOperations["members"]> = {
    listMembers: async (spaceId) => {
      base.calls.listMembers = [spaceId];
      return roster.filter((member) => member.spaceId === spaceId);
    },
    upsertMember: async (input) => {
      base.calls.upsertMember = [input];
      const now = "2026-02-02T00:00:00Z";
      const existing = roster.find(
        (member) =>
          member.spaceId === input.spaceId &&
          member.accountId === input.accountId,
      );
      const next: MemberRow = {
        id: existing?.id ?? `mem_${input.accountId}`,
        spaceId: input.spaceId,
        accountId: input.accountId,
        roles: [...(input.roles ?? existing?.roles ?? ["member"])],
        status: input.status ?? existing?.status ?? "active",
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      if (existing) {
        roster[roster.indexOf(existing)] = next;
      } else {
        roster.push(next);
      }
      return next;
    },
  };
  return Object.assign(base, { members, roster });
}

function memberRow(
  accountId: string,
  roles: string[],
  status: "active" | "invited" | "suspended" = "active",
  spaceId = "space_a",
): MemberRow {
  return {
    id: `mem_${accountId}`,
    spaceId,
    accountId,
    roles,
    status,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

test("GET /api/v1/spaces/:id/members lists members for an active member", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  // The session subject is a plain MEMBER (not owner/admin); list is still
  // visible to any active member.
  const operations = memberOperations({
    spaceId: "space_a",
    spaceOwner: "tsub_ctrl",
    roster: [
      memberRow("tsub_owner", ["owner"]),
      memberRow("tsub_ctrl", ["member"]),
    ],
  });
  const { request: req, url } = request(
    "GET",
    "/api/v1/spaces/space_a/members",
    { cookie },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(200);
  const body = (await response!.json()) as { members: MemberRow[] };
  expect(body.members.length).toEqual(2);
  // The spaceId was resolved server-side for the membership read.
  expect(operations.calls.listMembers).toEqual(["space_a"]);
});

test("POST /api/v1/spaces/:id/members lets an owner add a member", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = memberOperations({
    spaceId: "space_a",
    spaceOwner: "tsub_ctrl",
    roster: [memberRow("tsub_ctrl", ["owner"])],
  });
  const { request: req, url } = request(
    "POST",
    "/api/v1/spaces/space_a/members",
    { cookie, body: { accountId: "tsub_new", role: "member" } },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(201);
  const body = (await response!.json()) as { member: MemberRow };
  expect(body.member.accountId).toEqual("tsub_new");
  expect(body.member.roles).toEqual(["member"]);
  expect(body.member.status).toEqual("active");
  // The spaceId in the upsert is the server-resolved path value, never client body.
  const upsertArg = (operations.calls.upsertMember as [Record<string, unknown>])[0];
  expect(upsertArg.spaceId).toEqual("space_a");
  expect(upsertArg.accountId).toEqual("tsub_new");
});

test("POST /api/v1/spaces/:id/members lets an admin add a member", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = memberOperations({
    spaceId: "space_a",
    spaceOwner: "tsub_ctrl",
    roster: [
      memberRow("tsub_owner", ["owner"]),
      memberRow("tsub_ctrl", ["admin"]),
    ],
  });
  const { request: req, url } = request(
    "POST",
    "/api/v1/spaces/space_a/members",
    { cookie, body: { accountId: "tsub_new", role: "viewer" } },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(201);
});

test("POST /api/v1/spaces/:id/members forbids a non-owner/admin member with 403", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  // Namespace gate passes (the session subject owns the namespace Space), so a
  // 403 here isolates the membership ROLE gate: a plain member cannot add.
  const operations = memberOperations({
    spaceId: "space_a",
    spaceOwner: "tsub_ctrl",
    roster: [
      memberRow("tsub_owner", ["owner"]),
      memberRow("tsub_ctrl", ["member"]),
    ],
  });
  const { request: req, url } = request(
    "POST",
    "/api/v1/spaces/space_a/members",
    { cookie, body: { accountId: "tsub_new", role: "member" } },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(403);
  // No member was upserted behind the role gate.
  expect(operations.calls.upsertMember).toBeUndefined();
});

test("POST /api/v1/spaces/:id/members forbids an admin granting owner with 403", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = memberOperations({
    spaceId: "space_a",
    spaceOwner: "tsub_ctrl",
    roster: [
      memberRow("tsub_owner", ["owner"]),
      memberRow("tsub_ctrl", ["admin"]),
    ],
  });
  const { request: req, url } = request(
    "POST",
    "/api/v1/spaces/space_a/members",
    { cookie, body: { accountId: "tsub_new", role: "owner" } },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(403);
  expect(operations.calls.upsertMember).toBeUndefined();
});

test("members routes reject a session in another Space with 403 (namespace gate)", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  // The namespace Space is owned by a DIFFERENT subject; the namespace gate
  // (requireSpaceAccess) rejects before any membership read.
  const operations = memberOperations({
    spaceId: "space_b",
    spaceOwner: "tsub_other",
    roster: [memberRow("tsub_other", ["owner"], "active", "space_b")],
  });
  for (const [method, body] of [
    ["GET", undefined],
    ["POST", { accountId: "tsub_x", role: "member" }],
  ] as const) {
    const { request: req, url } = request(
      method,
      "/api/v1/spaces/space_b/members",
      { cookie, ...(body ? { body } : {}) },
    );
    const response = await handleControlRoute({
      request: req,
      url,
      store,
      operations,
    });
    expect(response?.status, method).toEqual(403);
  }
  // The membership facade was never reached behind the namespace gate.
  expect(operations.calls.listMembers).toBeUndefined();
  expect(operations.calls.upsertMember).toBeUndefined();
});

test("members routes are 401 for an anonymous session", async () => {
  const store = new InMemoryAccountsStore();
  const operations = memberOperations({
    spaceId: "space_a",
    spaceOwner: "tsub_ctrl",
    roster: [memberRow("tsub_ctrl", ["owner"])],
  });
  const paths: Array<[string, string]> = [
    ["GET", "/api/v1/spaces/space_a/members"],
    ["POST", "/api/v1/spaces/space_a/members"],
    ["PATCH", "/api/v1/spaces/space_a/members/tsub_x"],
    ["DELETE", "/api/v1/spaces/space_a/members/tsub_x"],
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
  expect(operations.calls.listMembers).toBeUndefined();
  expect(operations.calls.upsertMember).toBeUndefined();
});

test("PATCH /api/v1/spaces/:id/members/:subject lets an owner change a role", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = memberOperations({
    spaceId: "space_a",
    spaceOwner: "tsub_ctrl",
    roster: [
      memberRow("tsub_ctrl", ["owner"]),
      memberRow("tsub_member", ["member"]),
    ],
  });
  const { request: req, url } = request(
    "PATCH",
    "/api/v1/spaces/space_a/members/tsub_member",
    { cookie, body: { roles: ["admin"] } },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(200);
  const body = (await response!.json()) as { member: MemberRow };
  expect(body.member.roles).toEqual(["admin"]);
  const upsertArg = (operations.calls.upsertMember as [Record<string, unknown>])[0];
  expect(upsertArg.accountId).toEqual("tsub_member");
});

test("PATCH /api/v1/spaces/:id/members/:subject forbids an admin (owner-only) with 403", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = memberOperations({
    spaceId: "space_a",
    spaceOwner: "tsub_ctrl",
    roster: [
      memberRow("tsub_owner", ["owner"]),
      memberRow("tsub_ctrl", ["admin"]),
      memberRow("tsub_member", ["member"]),
    ],
  });
  const { request: req, url } = request(
    "PATCH",
    "/api/v1/spaces/space_a/members/tsub_member",
    { cookie, body: { roles: ["admin"] } },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(403);
  expect(operations.calls.upsertMember).toBeUndefined();
});

test("PATCH /api/v1/spaces/:id/members/:subject refuses to demote the last owner", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  // The owner tries to demote themselves while they are the SOLE owner.
  const operations = memberOperations({
    spaceId: "space_a",
    spaceOwner: "tsub_ctrl",
    roster: [
      memberRow("tsub_ctrl", ["owner"]),
      memberRow("tsub_member", ["member"]),
    ],
  });
  const { request: req, url } = request(
    "PATCH",
    "/api/v1/spaces/space_a/members/tsub_ctrl",
    { cookie, body: { roles: ["member"] } },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(403);
  // The last-owner guard blocks before any upsert.
  expect(operations.calls.upsertMember).toBeUndefined();
});

test("PATCH /api/v1/spaces/:id/members/:subject can demote an owner when another owner remains", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = memberOperations({
    spaceId: "space_a",
    spaceOwner: "tsub_ctrl",
    roster: [
      memberRow("tsub_ctrl", ["owner"]),
      memberRow("tsub_owner2", ["owner"]),
    ],
  });
  const { request: req, url } = request(
    "PATCH",
    "/api/v1/spaces/space_a/members/tsub_owner2",
    { cookie, body: { roles: ["admin"] } },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(200);
  const body = (await response!.json()) as { member: MemberRow };
  expect(body.member.roles).toEqual(["admin"]);
});

test("DELETE /api/v1/spaces/:id/members/:subject lets an owner soft-remove a member", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = memberOperations({
    spaceId: "space_a",
    spaceOwner: "tsub_ctrl",
    roster: [
      memberRow("tsub_ctrl", ["owner"]),
      memberRow("tsub_member", ["member"]),
    ],
  });
  const { request: req, url } = request(
    "DELETE",
    "/api/v1/spaces/space_a/members/tsub_member",
    { cookie },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(200);
  const body = (await response!.json()) as { member: MemberRow };
  // Soft-remove: the membership is suspended (the store has no hard delete).
  expect(body.member.status).toEqual("suspended");
  const upsertArg = (operations.calls.upsertMember as [Record<string, unknown>])[0];
  expect(upsertArg.status).toEqual("suspended");
  expect(upsertArg.accountId).toEqual("tsub_member");
});

test("DELETE /api/v1/spaces/:id/members/:subject forbids a non-owner with 403", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = memberOperations({
    spaceId: "space_a",
    spaceOwner: "tsub_ctrl",
    roster: [
      memberRow("tsub_owner", ["owner"]),
      memberRow("tsub_ctrl", ["admin"]),
      memberRow("tsub_member", ["member"]),
    ],
  });
  const { request: req, url } = request(
    "DELETE",
    "/api/v1/spaces/space_a/members/tsub_member",
    { cookie },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(403);
  expect(operations.calls.upsertMember).toBeUndefined();
});

test("DELETE /api/v1/spaces/:id/members/:subject refuses to remove the last owner", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = memberOperations({
    spaceId: "space_a",
    spaceOwner: "tsub_ctrl",
    roster: [
      memberRow("tsub_ctrl", ["owner"]),
      memberRow("tsub_member", ["member"]),
    ],
  });
  const { request: req, url } = request(
    "DELETE",
    "/api/v1/spaces/space_a/members/tsub_ctrl",
    { cookie },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(403);
  expect(operations.calls.upsertMember).toBeUndefined();
});

test("members routes 503 when no membership facade is wired", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  // A facade WITHOUT the optional `members` field (the namespace gate still
  // passes because the session subject owns the namespace Space).
  const operations = fakeOperations();
  const { request: req, url } = request(
    "GET",
    "/api/v1/spaces/space_a/members",
    { cookie },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(503);
});

// --- ADD-path gate parity (privilege escalation / orphaning via POST) -------

test("POST /api/v1/spaces/:id/members forbids an admin from demoting an existing owner", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  // The caller is an ADMIN; the target is an existing active OWNER. A POST that
  // overwrites the owner's role to `member` must be rejected (owner-only), the
  // same way the PATCH path restricts it.
  const operations = memberOperations({
    spaceId: "space_a",
    spaceOwner: "tsub_ctrl",
    roster: [
      memberRow("tsub_owner", ["owner"]),
      memberRow("tsub_other_owner", ["owner"]),
      memberRow("tsub_ctrl", ["admin"]),
    ],
  });
  const { request: req, url } = request(
    "POST",
    "/api/v1/spaces/space_a/members",
    { cookie, body: { accountId: "tsub_owner", role: "member" } },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(403);
  // No demotion was persisted behind the owner-only gate.
  expect(operations.calls.upsertMember).toBeUndefined();
  expect(
    operations.roster.find((m) => m.accountId === "tsub_owner")?.roles,
  ).toEqual(["owner"]);
});

test("POST /api/v1/spaces/:id/members refuses to strip the last owner", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  // The caller is the SOLE owner and POSTs their own subject with a lower role.
  // The last-owner guard must block this on the ADD path too, otherwise the
  // Space is orphaned.
  const operations = memberOperations({
    spaceId: "space_a",
    spaceOwner: "tsub_ctrl",
    roster: [
      memberRow("tsub_ctrl", ["owner"]),
      memberRow("tsub_member", ["member"]),
    ],
  });
  const { request: req, url } = request(
    "POST",
    "/api/v1/spaces/space_a/members",
    { cookie, body: { accountId: "tsub_ctrl", role: "member" } },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(403);
  expect(operations.calls.upsertMember).toBeUndefined();
  expect(
    operations.roster.find((m) => m.accountId === "tsub_ctrl")?.roles,
  ).toEqual(["owner"]);
});

test("POST /api/v1/spaces/:id/members lets an owner re-add a co-owner with a lower role when another owner remains", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = memberOperations({
    spaceId: "space_a",
    spaceOwner: "tsub_ctrl",
    roster: [
      memberRow("tsub_ctrl", ["owner"]),
      memberRow("tsub_owner2", ["owner"]),
    ],
  });
  // Owner caller demotes a co-owner via POST; another owner remains, so the
  // last-owner guard does not fire and the owner-only gate is satisfied.
  const { request: req, url } = request(
    "POST",
    "/api/v1/spaces/space_a/members",
    { cookie, body: { accountId: "tsub_owner2", role: "admin" } },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(201);
  const body = (await response!.json()) as { member: MemberRow };
  expect(body.member.roles).toEqual(["admin"]);
});

// --- Namespace-owner bootstrap (empty ledger) ------------------------------

test("namespace owner can bootstrap the first member when the ledger is empty", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  // No membership rows exist yet (the spaces domain seeds none). The session
  // subject IS the namespace owner (`spaceOwner`), so the implicit owner row
  // lets them add the first real member.
  const operations = memberOperations({
    spaceId: "space_a",
    spaceOwner: "tsub_ctrl",
    roster: [],
  });
  const { request: req, url } = request(
    "POST",
    "/api/v1/spaces/space_a/members",
    { cookie, body: { accountId: "tsub_first", role: "member" } },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(201);
  const body = (await response!.json()) as { member: MemberRow };
  expect(body.member.accountId).toEqual("tsub_first");
  expect(body.member.roles).toEqual(["member"]);
});

test("namespace owner sees the implicit owner row when the ledger is empty", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  const operations = memberOperations({
    spaceId: "space_a",
    spaceOwner: "tsub_ctrl",
    roster: [],
  });
  const { request: req, url } = request(
    "GET",
    "/api/v1/spaces/space_a/members",
    { cookie },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(200);
  const body = (await response!.json()) as { members: MemberRow[] };
  const owner = body.members.find((m) => m.accountId === "tsub_ctrl");
  expect(owner?.roles).toEqual(["owner"]);
  expect(owner?.status).toEqual("active");
});

test("a non-owner namespace member cannot bootstrap members against an empty ledger", async () => {
  const store = new InMemoryAccountsStore();
  const { cookie } = seedSession(store);
  // The session subject is NOT the namespace owner; the namespace gate passes
  // only because the accounts-ledger owner matches. With an empty membership
  // ledger and no implicit row for THIS subject, the mutation gate forbids them.
  seedLedgerSpace(store, {
    subject: "tsub_ctrl",
    accountId: "acct_a",
    spaceId: "space_a",
  });
  const operations = memberOperations({
    spaceId: "space_a",
    spaceOwner: "tsub_namespace_owner",
    roster: [],
  });
  const { request: req, url } = request(
    "POST",
    "/api/v1/spaces/space_a/members",
    { cookie, body: { accountId: "tsub_first", role: "member" } },
  );
  const response = await handleControlRoute({
    request: req,
    url,
    store,
    operations,
  });
  expect(response?.status).toEqual(403);
  expect(operations.calls.upsertMember).toBeUndefined();
});
