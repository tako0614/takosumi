import { expect, test } from "bun:test";
import { SqliteFakeD1 } from "../../helpers/deploy-control/sqlite_fake_d1.ts";
import {
  CloudflareD1OpenTofuControlStore,
  ensureD1OpenTofuLedgerSchema,
} from "../../../worker/src/d1_opentofu_store.ts";

import {
  TAKOFORM_FORM_HOST_API_PATH,
  TAKOFORM_FORM_HOST_WELL_KNOWN_PATH,
} from "../../../contract/form-host-interoperability.ts";
import { TAKOSUMI_API_VERSION } from "../../../contract/capabilities.ts";
import {
  TAKOSUMI_PRODUCT_CAPABILITIES_PATH,
  TAKOSUMI_WELL_KNOWN_PATH,
} from "../../../contract/api-surface.ts";
import { TAKOSUMI_PLATFORM_HARDENING_GATE_EVIDENCE_KIND } from "../../../contract/platform-hardening.ts";
import { OSS_PLATFORM_HARDENING_CONTRIBUTION } from "../../../deploy/platform/production_hardening.ts";
import {
  driftCheckEnabled,
  evaluateProductionHardeningGates,
  handleOperatorBillingRequest,
  handlePlatformInternalEdgeRequest,
  handlePlatformExtensionRequest,
  handlePlatformExtensionCatalogRequest,
  handlePlatformExtensionContributionsRequest,
  handlePlatformExtensionRouteRequest,
  handlePlatformMetricsDashboardRequest,
  handlePlatformMetricsRequest,
  handlePlatformResourceShapeApiRequest,
  handlePlatformTakoformDiscoveryRequest,
  handlePlatformRunOwnerRequest,
  handleSourceWebhookRequest,
  isOperatorBillingPath,
  isOidcMetricPath,
  isPlatformExtensionCatalogPath,
  isPlatformExtensionContributionsPath,
  isPlatformResourceShapeApiPath,
  matchPlatformExtensionRoute,
  platformExtensionCatalog,
  platformExtensionContributionCatalog,
  platformExtensionRoutes,
  platformOperatorCapabilities,
  platformInternalEdgeIngressEnabled,
  platformExtensionSessionCanAccessCapsule,
  platformExtensionVerifiedWorkspaceSession,
  verifyPlatformExtensionSession,
  platformResourceShapeApiEnabled,
  isPlatformMetricsDashboardPath,
  isPlatformMetricsPath,
  oidcMetricRoute,
  autoPlanStaleCapsulesEnabled,
  pollAutoSyncSources,
  planStaleCapsuleUpdates,
  repairDirectResourceRuns,
  repairStaleOpenTofuRuns,
  resourceObservationEnabled,
  scheduledResourceObservationOptions,
  scheduledSourcePollBatch,
  schedulePlatformSideEffect,
  summarizePrometheusMetrics,
  verifyPlatformExtensionBearerToken,
  withPlatformAssetCacheHeaders,
  createPlatformCanonicalReadyResourceInventory,
  createPlatformCanonicalResourceReadAuthority,
  createPlatformCompatibilityAuthority,
  selectUniquePlatformCompatibilityInterface,
  type OperatorBillingOperations,
  type SourcePollOperations,
  type SourceWebhookOperations,
} from "../../../deploy/platform/worker.ts";
import { platformResourceInterfaceWorkspaceResolver } from "../../../worker/src/deploy_control_seam.ts";
import { createManagedProviderRunToken } from "../../../core/shared/managed_provider_tokens.ts";
import {
  createInMemoryResourceShapeStores,
  MapResourceShapeSchemaRegistry,
  StubResourceShapeAdapter,
  type ResourceShapeStores,
} from "../../../core/domains/resource-shape/mod.ts";
import { createD1ResourceShapeStores } from "../../../core/domains/resource-shape/d1_stores.ts";
import { createTakosumiService } from "../../../core/bootstrap.ts";
import type {
  ResolutionLockRecord,
  ResourceShapeRecord,
} from "../../../core/domains/resource-shape/records.ts";

test("platform internal edge ingress is explicit and disabled by default", () => {
  expect(platformInternalEdgeIngressEnabled({} as never)).toBe(false);
  expect(
    platformInternalEdgeIngressEnabled({
      LOCAL_SUBSTRATE_TEST_BED: "1",
    } as never),
  ).toBe(true);
  expect(
    platformInternalEdgeIngressEnabled({
      TAKOSUMI_EXPOSE_INTERNAL_EDGE: "1",
    } as never),
  ).toBe(true);
});

test("platform internal edge dispatch is local-only and never exposes coordination", async () => {
  const forwarded: string[] = [];
  const seamForEnv = () => ({
    fetch: async (request: Request) => {
      forwarded.push(`${request.method} ${request.url}`);
      return Response.json({ ok: true });
    },
  });
  const internalRequest = new Request(
    "https://service.takosumi.test/internal/v1/runner-profiles",
  );

  const disabled = await handlePlatformInternalEdgeRequest(
    internalRequest,
    {} as never,
    seamForEnv,
  );
  expect(disabled?.status).toBe(404);
  expect(forwarded).toEqual([]);

  const enabled = await handlePlatformInternalEdgeRequest(
    internalRequest,
    { LOCAL_SUBSTRATE_TEST_BED: "1" } as never,
    seamForEnv,
  );
  expect(enabled?.status).toBe(200);
  expect(forwarded).toEqual([
    "GET https://service.takosumi.test/internal/v1/runner-profiles",
  ]);

  const coordination = await handlePlatformInternalEdgeRequest(
    new Request(
      "https://service.takosumi.test/internal/v1/coordination/list-alarms",
    ),
    { TAKOSUMI_EXPOSE_INTERNAL_EDGE: "1" } as never,
    seamForEnv,
  );
  expect(coordination?.status).toBe(404);
  expect(forwarded).toHaveLength(1);

  expect(
    await handlePlatformInternalEdgeRequest(
      new Request("https://service.takosumi.test/api/v1/workspaces"),
      { LOCAL_SUBSTRATE_TEST_BED: "1" } as never,
      seamForEnv,
    ),
  ).toBeUndefined();
});

test("compatibility data authority selects one exact Resource-owned Interface", () => {
  const resourceId = "tkrn:workspace_1:ObjectBucket:assets";
  const candidate = (id: string, type = "storage.object") =>
    ({
      kind: "Interface",
      metadata: {
        id,
        workspaceId: "workspace_1",
        ownerRef: { kind: "Resource", id: resourceId },
      },
      spec: { type, version: "v1" },
      status: { phase: "Resolved" },
    }) as never;
  const selector = {
    workspaceId: "workspace_1",
    resourceId,
    selector: { type: "storage.object" },
  };

  expect(
    selectUniquePlatformCompatibilityInterface(
      [candidate("if_storage")],
      selector,
    )?.metadata.id,
  ).toBe("if_storage");
  expect(
    selectUniquePlatformCompatibilityInterface(
      [candidate("if_a"), candidate("if_b")],
      selector,
    ),
  ).toBeUndefined();
  expect(
    selectUniquePlatformCompatibilityInterface(
      [candidate("if_other", "storage.other")],
      selector,
    ),
  ).toBeUndefined();
});

test("platform Operator capabilities require both explicit config and live bindings", () => {
  const empty = platformOperatorCapabilities({} as never, true);
  expect(Object.values(empty).every((enabled) => !enabled)).toBe(true);

  const database = { prepare() {} };
  const configured = platformOperatorCapabilities(
    {
      TAKOSUMI_OPERATOR_CAPABILITIES: "all",
      TAKOSUMI_ACCOUNTS_DB: database,
      TAKOSUMI_CONTROL_DB: database,
      TAKOSUMI_DEPLOY_CONTROL_TOKEN: "control-token",
      RUNNER: { get() {} },
    } as never,
    true,
  );
  expect(configured).toEqual({
    multi_tenant_workspaces: true,
    workspace_members: true,
    runner_pools: true,
    operator_connections: true,
    managed_target_catalog: true,
    db_backed_configuration: true,
    cli_api_operations: true,
    usage_showback: true,
    audit_evidence: true,
  });

  const missingBindings = platformOperatorCapabilities(
    { TAKOSUMI_OPERATOR_CAPABILITIES: "all" } as never,
    true,
  );
  expect(Object.values(missingBindings).every((enabled) => !enabled)).toBe(
    true,
  );
});

test("platform extensions recognize only the exact deploy-control bearer as operator service authority", async () => {
  const env = {
    TAKOSUMI_DEPLOY_CONTROL_TOKEN: "operator-control-secret",
  } as never;

  await expect(
    verifyPlatformExtensionSession(
      new Request("https://app.takosumi.com/v1/cloud/operator/example", {
        headers: { authorization: "Bearer operator-control-secret" },
      }),
      env,
    ),
  ).resolves.toEqual({
    authenticated: true,
    authKind: "service-token",
    subject: "takosumi:deploy-control",
    scopes: ["admin"],
  });

  await expect(
    verifyPlatformExtensionSession(
      new Request("https://app.takosumi.com/v1/cloud/operator/example", {
        headers: {
          authorization: "Bearer operator-control-secret-wrong",
          "x-takosumi-platform-authenticated": "1",
          "x-takosumi-platform-auth-kind": "service-token",
          "x-takosumi-platform-scopes": "admin",
        },
      }),
      env,
    ),
  ).resolves.toEqual({ authenticated: false });
});

function runRecord(overrides: Record<string, unknown>): never {
  return {
    id: "run_1",
    workspaceId: "space_a",
    type: "plan",
    status: "queued",
    createdBy: "system",
    createdAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  } as never;
}

function makeWebhookOps(
  overrides: {
    valid?: boolean;
    throwOnVerify?: boolean;
  } = {},
): {
  ops: SourceWebhookOperations;
  syncCalls: { sourceId: string; dedupe?: boolean }[];
  verifyCalls: { sourceId: string; secret: string }[];
} {
  const syncCalls: { sourceId: string; dedupe?: boolean }[] = [];
  const verifyCalls: { sourceId: string; secret: string }[] = [];
  const ops: SourceWebhookOperations = {
    verifySourceHookSecret: (sourceId, secret) => {
      verifyCalls.push({ sourceId, secret });
      if (overrides.throwOnVerify) return Promise.reject(new Error("boom"));
      return Promise.resolve(overrides.valid ?? true);
    },
    createSourceSync: (sourceId, options) => {
      syncCalls.push({ sourceId, dedupe: options?.dedupe });
      return Promise.resolve({ run: { id: "ssr_1" } });
    },
  };
  return { ops, syncCalls, verifyCalls };
}

const SOURCE_ID = "src_route0000000001";

function webhookRequest(
  body: unknown,
  init: { method?: string; bearer?: string } = {},
): { request: Request; url: URL } {
  const url = new URL(`https://app.takosumi.com/hooks/sources/${SOURCE_ID}`);
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (init.bearer !== undefined)
    headers.authorization = `Bearer ${init.bearer}`;
  const request = new Request(url, {
    method: init.method ?? "POST",
    headers,
    body: JSON.stringify(body),
  });
  return { request, url };
}

test("webhook rejects a missing bearer (401)", async () => {
  const { ops, syncCalls } = makeWebhookOps();
  const { request, url } = webhookRequest({ junk: true });
  const response = await handleSourceWebhookRequest(request, url, ops);
  expect(response.status).toBe(401);
  expect(syncCalls).toHaveLength(0);
});

test("webhook rejects a wrong bearer (401) and does not trigger a sync", async () => {
  const { ops, syncCalls } = makeWebhookOps({ valid: false });
  const { request, url } = webhookRequest({}, { bearer: "wrong" });
  const response = await handleSourceWebhookRequest(request, url, ops);
  expect(response.status).toBe(401);
  expect(syncCalls).toHaveLength(0);
});

test("webhook with a verify error is treated as unauthenticated (401)", async () => {
  const { ops, syncCalls } = makeWebhookOps({ throwOnVerify: true });
  const { request, url } = webhookRequest({}, { bearer: "x" });
  const response = await handleSourceWebhookRequest(request, url, ops);
  expect(response.status).toBe(401);
  expect(syncCalls).toHaveLength(0);
});

test("webhook with a good bearer triggers a deduped sync and IGNORES the payload (202)", async () => {
  const { ops, syncCalls, verifyCalls } = makeWebhookOps({ valid: true });
  // An attacker-controlled payload claiming a different source must be ignored:
  // the effect is keyed off the URL source id, not the body.
  const { request, url } = webhookRequest(
    { sourceId: "src_attacker", ref: "evil" },
    { bearer: "good-secret" },
  );
  const response = await handleSourceWebhookRequest(request, url, ops);
  expect(response.status).toBe(202);
  expect((await response.json()).runId).toBe("ssr_1");
  expect(verifyCalls).toEqual([{ sourceId: SOURCE_ID, secret: "good-secret" }]);
  expect(syncCalls).toEqual([{ sourceId: SOURCE_ID, dedupe: true }]);
});

test("webhook rejects a non-POST method (405)", async () => {
  const { ops } = makeWebhookOps();
  const { request, url } = webhookRequest({}, { method: "GET", bearer: "x" });
  const response = await handleSourceWebhookRequest(request, url, ops);
  expect(response.status).toBe(405);
});

test("webhook rejects an unsupported source id shape (404)", async () => {
  const { ops } = makeWebhookOps();
  const url = new URL("https://app.takosumi.com/hooks/sources/not-a-source");
  const request = new Request(url, {
    method: "POST",
    headers: { authorization: "Bearer x" },
  });
  const response = await handleSourceWebhookRequest(request, url, ops);
  expect(response.status).toBe(404);
});

test("scheduled poll enqueues a deduped sync per autoSync source, capped", async () => {
  const syncCalls: string[] = [];
  const ops: SourcePollOperations = {
    verifySourceHookSecret: () => Promise.resolve(true),
    createSourceSync: (sourceId) => {
      syncCalls.push(sourceId);
      return Promise.resolve({ run: { id: `ssr_${sourceId}` } });
    },
    controller: {
      listAutoSyncSources: (limit) =>
        Promise.resolve([{ id: "src_a" }, { id: "src_b" }].slice(0, limit)),
    },
  };
  await pollAutoSyncSources(ops, 50);
  expect(syncCalls).toEqual(["src_a", "src_b"]);
});

test("scheduled source poll batch is operator configurable with a small default", () => {
  expect(scheduledSourcePollBatch({} as never)).toBe(5);
  expect(
    scheduledSourcePollBatch({
      TAKOSUMI_SCHEDULED_SOURCE_POLL_BATCH: "2",
    } as never),
  ).toBe(2);
  expect(
    scheduledSourcePollBatch({
      TAKOSUMI_SCHEDULED_SOURCE_POLL_BATCH: "0",
    } as never),
  ).toBe(5);
  expect(
    scheduledSourcePollBatch({
      TAKOSUMI_SCHEDULED_SOURCE_POLL_BATCH: "not-a-number",
    } as never),
  ).toBe(5);
});

test("stale Capsule auto-plan is opt-in", () => {
  const base = { TAKOSUMI_ACCOUNTS_DB: {} } as never;
  expect(autoPlanStaleCapsulesEnabled(base)).toBe(false);
  expect(
    autoPlanStaleCapsulesEnabled({
      ...base,
      TAKOSUMI_AUTO_PLAN_STALE_CAPSULES: "0",
    } as never),
  ).toBe(false);
  expect(
    autoPlanStaleCapsulesEnabled({
      ...base,
      TAKOSUMI_AUTO_PLAN_STALE_CAPSULES: "1",
    } as never),
  ).toBe(true);
});

test("stale Capsule auto-plan creates one pending update plan per stale Capsule", async () => {
  const planned: string[] = [];
  const result = await planStaleCapsuleUpdates(
    {
      workspaces: {
        listWorkspaces: () =>
          Promise.resolve([
            { id: "space_a" },
            { id: "space_archived", archivedAt: "2026-07-01T00:00:00.000Z" },
          ]),
      },
      capsules: {
        listCapsules: (workspaceId) =>
          Promise.resolve(
            workspaceId === "space_a"
              ? [
                  {
                    id: "inst_needs_plan",
                    workspaceId,
                    projectId: "prj_default",
                    sourceId: "src_default",
                    name: "needs-plan",
                    slug: "needs-plan",
                    installConfigId: "cfg",
                    environment: "production",
                    currentStateGeneration: 1,
                    status: "stale",
                    createdAt: "2026-07-01T00:00:00.000Z",
                    updatedAt: "2026-07-01T00:00:00.000Z",
                  },
                  {
                    id: "inst_has_plan",
                    workspaceId,
                    projectId: "prj_default",
                    sourceId: "src_default",
                    name: "has-plan",
                    slug: "has-plan",
                    installConfigId: "cfg",
                    environment: "production",
                    currentStateGeneration: 1,
                    status: "stale",
                    createdAt: "2026-07-01T00:00:00.000Z",
                    updatedAt: "2026-07-01T00:00:00.000Z",
                  },
                  {
                    id: "inst_active",
                    workspaceId,
                    projectId: "prj_default",
                    sourceId: "src_default",
                    name: "active",
                    slug: "active",
                    installConfigId: "cfg",
                    environment: "production",
                    currentStateGeneration: 1,
                    status: "active",
                    createdAt: "2026-07-01T00:00:00.000Z",
                    updatedAt: "2026-07-01T00:00:00.000Z",
                  },
                ]
              : [],
          ) as never,
      },
      controller: {
        listRuns: () =>
          Promise.resolve([
            runRecord({
              id: "plan_pending",
              type: "plan",
              status: "waiting_approval",
              capsuleId: "inst_has_plan",
            }),
          ]),
      },
      createCapsulePlan: (capsuleId) => {
        planned.push(capsuleId);
        return Promise.resolve({});
      },
    },
    { workspaceLimit: 10, runLookback: 50 },
  );

  expect(planned).toEqual(["inst_needs_plan"]);
  expect(result).toEqual({
    workspacesScanned: 1,
    staleCapsulesScanned: 2,
    plansCreated: 1,
  });
});

test("scheduled run repair reschedules only stale dispatchable OpenTofu runs", async () => {
  const now = Date.parse("2026-07-01T23:40:00.000Z");
  const recoveryQueries: unknown[] = [];
  const scheduled: unknown[] = [];
  const result = await repairStaleOpenTofuRuns(
    {
      workspaces: {
        listWorkspaces: () =>
          Promise.resolve([
            { id: "space_a" },
            { id: "space_archived", archivedAt: "2026-07-01T00:00:00.000Z" },
          ]),
      },
      controller: {
        listRecoverableOpenTofuRuns: (options) => {
          recoveryQueries.push(options);
          return Promise.resolve([
            runRecord({
              id: "apply_stale_destroy",
              type: "destroy_apply",
              status: "queued",
              createdAt: new Date(now - 10_000).toISOString(),
            }),
            runRecord({
              id: "plan_stale_running",
              type: "destroy_plan",
              status: "running",
              createdAt: new Date(now - 20_000).toISOString(),
              heartbeatAt: now - 10_000,
            }),
            runRecord({
              id: "sync_stale",
              type: "source_sync",
              status: "queued",
              sourceId: "src_abcdef0123456789",
              createdAt: new Date(now - 10_000).toISOString(),
            }),
            runRecord({
              id: "apply_fresh",
              type: "apply",
              status: "queued",
              createdAt: new Date(now - 100).toISOString(),
            }),
            // The store exposes a terminal ApplyRun here only when its durable
            // billing.capture.pending marker still needs idempotent repair.
            runRecord({
              id: "apply_billing_pending",
              type: "apply",
              status: "succeeded",
              createdAt: new Date(now - 20_000).toISOString(),
              finishedAt: new Date(now - 10_000).toISOString(),
            }),
            runRecord({
              id: "backup_stale_but_not_dispatchable",
              type: "backup",
              status: "queued",
              createdAt: new Date(now - 10_000).toISOString(),
            }),
            runRecord({
              id: "compat_stale_but_not_dispatchable",
              type: "compatibility_check",
              status: "queued",
              createdAt: new Date(now - 10_000).toISOString(),
            }),
            runRecord({
              id: "plan_terminal",
              type: "plan",
              status: "succeeded",
              createdAt: new Date(now - 10_000).toISOString(),
            }),
            runRecord({
              id: "archived_space_run",
              workspaceId: "space_archived",
              type: "apply",
              status: "queued",
              createdAt: new Date(now - 10_000).toISOString(),
            }),
          ]);
        },
      },
    },
    {
      schedule: (dispatch) => {
        scheduled.push(dispatch);
        return Promise.resolve();
      },
    },
    {
      now,
      queuedStaleMs: 1_000,
      runningStaleMs: 1_000,
    },
  );

  expect(recoveryQueries).toEqual([
    {
      staleQueuedBeforeMs: now - 1_000,
      staleRunningBeforeMs: now - 1_000,
      limit: 50,
    },
  ]);
  expect(scheduled).toEqual([
    {
      action: "apply",
      runId: "apply_stale_destroy",
      workspaceId: "space_a",
    },
    {
      action: "plan",
      runId: "plan_stale_running",
      workspaceId: "space_a",
    },
    {
      action: "source_sync",
      runId: "sync_stale",
      workspaceId: "space_a",
    },
    {
      action: "apply",
      runId: "apply_billing_pending",
      workspaceId: "space_a",
    },
  ]);
  expect(result).toEqual({
    workspacesScanned: 1,
    runsScanned: 9,
    rescheduled: 4,
  });
});

test("scheduled direct Resource Run repair is bounded and failure-isolated", async () => {
  const calls: unknown[] = [];
  const repaired = await repairDirectResourceRuns(
    {
      repair: (options) => {
        calls.push(options);
        return Promise.resolve({
          scanned: 4,
          completed: 2,
          auditsRepaired: 3,
          pending: 1,
        });
      },
    },
    { limit: 17 },
  );
  expect(calls).toEqual([{ limit: 17 }]);
  expect(repaired).toEqual({
    scanned: 4,
    completed: 2,
    auditsRepaired: 3,
    pending: 1,
    failures: 0,
  });

  expect(
    await repairDirectResourceRuns({
      repair: () => Promise.reject(new Error("ledger unavailable")),
    }),
  ).toEqual({
    scanned: 0,
    completed: 0,
    auditsRepaired: 0,
    pending: 0,
    failures: 1,
  });
});

test("drift sweep is OFF by default and only enabled by the =1 flag", () => {
  // Default OFF: the scheduled() handler skips the drift sweep unless the flag is
  // explicitly set to "1" (spec §28 / Phase 8 opt-in).
  const base = { TAKOSUMI_ACCOUNTS_DB: {} } as never;
  expect(driftCheckEnabled(base)).toBe(false);
  expect(
    driftCheckEnabled({ ...base, TAKOSUMI_DRIFT_CHECK_ENABLED: "0" } as never),
  ).toBe(false);
  expect(
    driftCheckEnabled({
      ...base,
      TAKOSUMI_DRIFT_CHECK_ENABLED: "true",
    } as never),
  ).toBe(false);
  expect(
    driftCheckEnabled({ ...base, TAKOSUMI_DRIFT_CHECK_ENABLED: "1" } as never),
  ).toBe(true);
});

test("Resource observation follows enabled shapes and has bounded operator knobs", () => {
  expect(resourceObservationEnabled({} as never)).toBe(false);
  expect(
    resourceObservationEnabled({
      TAKOSUMI_RESOURCE_SHAPES: "EdgeWorker",
    } as never),
  ).toBe(true);
  expect(
    resourceObservationEnabled({
      TAKOSUMI_RESOURCE_SHAPES: "EdgeWorker",
      TAKOSUMI_RESOURCE_OBSERVATION_ENABLED: "0",
    } as never),
  ).toBe(false);
  expect(
    resourceObservationEnabled({
      TAKOSUMI_RESOURCE_OBSERVATION_ENABLED: "1",
    } as never),
  ).toBe(true);
  expect(
    resourceObservationEnabled({
      TAKOSUMI_RESOURCE_SHAPES: "EdgeWorker",
      TAKOSUMI_RESOURCE_OBSERVATION_ENABLED: "true",
    } as never),
  ).toBe(false);

  expect(scheduledResourceObservationOptions({} as never)).toEqual({
    limit: 8,
    concurrency: 4,
    intervalMs: 60 * 60 * 1000,
    leaseMs: 15 * 60 * 1000,
  });
  expect(
    scheduledResourceObservationOptions({
      TAKOSUMI_RESOURCE_OBSERVATION_BATCH: "3",
      TAKOSUMI_RESOURCE_OBSERVATION_CONCURRENCY: "7",
      TAKOSUMI_RESOURCE_OBSERVATION_INTERVAL_SECONDS: "300",
      TAKOSUMI_RESOURCE_OBSERVATION_LEASE_SECONDS: "600",
    } as never),
  ).toEqual({
    limit: 3,
    concurrency: 3,
    intervalMs: 300_000,
    leaseMs: 600_000,
  });
  expect(
    scheduledResourceObservationOptions({
      TAKOSUMI_RESOURCE_OBSERVATION_BATCH: "0",
      TAKOSUMI_RESOURCE_OBSERVATION_CONCURRENCY: "99",
      TAKOSUMI_RESOURCE_OBSERVATION_INTERVAL_SECONDS: "1",
      TAKOSUMI_RESOURCE_OBSERVATION_LEASE_SECONDS: "1",
    } as never),
  ).toEqual({
    limit: 8,
    concurrency: 4,
    intervalMs: 60 * 60 * 1000,
    leaseMs: 15 * 60 * 1000,
  });
});

test("production hardening gates require platform opening evidence", () => {
  const missing = evaluateProductionHardeningGates({
    TAKOSUMI_PRODUCTION_HARDENING_GATE: "enforce",
  } as never);
  expect(missing.ok).toBe(false);
  expect(missing.enforced).toBe(true);
  expect(missing.contributions[0]?.id).toBe("takosumi-oss");
  expect(missing.contributions[0]?.checks[0]?.reason).toBe("missing_evidence");

  const bundle = {
    kind: TAKOSUMI_PLATFORM_HARDENING_GATE_EVIDENCE_KIND,
    contributions: [
      {
        id: OSS_PLATFORM_HARDENING_CONTRIBUTION.id,
        capability: OSS_PLATFORM_HARDENING_CONTRIBUTION.capability,
        checks: OSS_PLATFORM_HARDENING_CONTRIBUTION.checks.map(({ id }) => ({
          id,
          evidenceRef:
            "git+ssh://git@git.example.net/operator/proofs.git@0123456789abcdef0123456789abcdef01234567#evidence.md",
          evidenceDigest:
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        })),
      },
    ],
  };
  bundle.contributions[0]!.checks[0]!.evidenceDigest = "not-a-digest";
  const invalidDigest = evaluateProductionHardeningGates({
    TAKOSUMI_PLATFORM_HARDENING_EVIDENCE: JSON.stringify(bundle),
  } as never);
  expect(invalidDigest.ok).toBe(false);
  expect(invalidDigest.contributions[0]?.checks[0]?.reason).toBe(
    "evidence_digest_must_be_sha256",
  );

  bundle.contributions[0]!.checks[0]!.evidenceDigest =
    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  bundle.contributions[0]!.checks[0]!.evidenceRef =
    "git+ssh://git@git.example.net/operator/proofs.git#evidence.md";
  const mutableRef = evaluateProductionHardeningGates({
    TAKOSUMI_PLATFORM_HARDENING_EVIDENCE: JSON.stringify(bundle),
  } as never);
  expect(mutableRef.ok).toBe(false);
  expect(mutableRef.contributions[0]?.checks[0]?.reason).toBe(
    "evidence_ref_must_be_commit_pinned",
  );

  bundle.contributions[0]!.checks[0]!.evidenceRef =
    "git+ssh://git@git.example.net/operator/proofs.git@0123456789abcdef0123456789abcdef01234567#evidence.md";
  const ok = evaluateProductionHardeningGates({
    TAKOSUMI_PLATFORM_HARDENING_EVIDENCE: JSON.stringify(bundle),
  } as never);
  expect(ok.ok).toBe(true);
});

test("hardening gates route is operator bearer gated and returns 503 when enforced evidence is missing", async () => {
  const worker = (await import("../../../deploy/platform/worker.ts")).default;
  const env = {
    TAKOSUMI_DEPLOY_CONTROL_TOKEN: "operator-secret",
    TAKOSUMI_PRODUCTION_HARDENING_GATE: "enforce",
  } as never;

  expect(
    (
      await worker.fetch(
        new Request(
          "https://app.takosumi.com/internal/platform/hardening-gates",
        ),
        env,
      )
    ).status,
  ).toBe(401);

  const response = await worker.fetch(
    new Request("https://app.takosumi.com/internal/platform/hardening-gates", {
      headers: { authorization: "Bearer operator-secret" },
    }),
    env,
  );
  expect(response.status).toBe(503);
  expect((await response.json()).ok).toBe(false);
});

test("platform run owner route is operator bearer gated and reschedules from the run ledger", async () => {
  const ownerRequests: {
    id: unknown;
    url: string;
    method: string;
    body?: unknown;
  }[] = [];
  const env = {
    TAKOSUMI_DEPLOY_CONTROL_TOKEN: "operator-secret",
    RUN_OWNER: {
      idFromName: (name: string) => `id:${name}`,
      get: (id: unknown) => ({
        fetch: async (request: Request) => {
          const bodyText = await request.text();
          ownerRequests.push({
            id,
            url: request.url,
            method: request.method,
            body: bodyText ? JSON.parse(bodyText) : undefined,
          });
          return Response.json({
            record: {
              runId: "ssr_12345678",
              status: request.url.endsWith("/debug")
                ? "scheduled"
                : "succeeded",
            },
          });
        },
      }),
    },
  } as never;
  const operations = {
    getRun: async (id: string) => ({
      id,
      workspaceId: "space_123",
      sourceId: "src_123",
      type: "source_sync",
      status: "queued",
      createdBy: "system",
      createdAt: "2026-07-04T00:00:00.000Z",
    }),
  };
  const url = new URL(
    "https://app.takosumi.com/internal/platform/run-owner?runId=ssr_12345678",
  );

  const unauthenticated = await handlePlatformRunOwnerRequest(
    new Request(url),
    url,
    env,
  );
  expect(unauthenticated.status).toBe(401);

  const debug = await handlePlatformRunOwnerRequest(
    new Request(url, { headers: { authorization: "Bearer operator-secret" } }),
    url,
    env,
  );
  expect(debug.status).toBe(200);
  expect(await debug.json()).toEqual({
    runId: "ssr_12345678",
    operation: "debug",
    owner: { record: { runId: "ssr_12345678", status: "scheduled" } },
  });

  const drain = await handlePlatformRunOwnerRequest(
    new Request(url, {
      method: "POST",
      headers: { authorization: "Bearer operator-secret" },
    }),
    url,
    env,
    { operations, now: () => 123_456_789 },
  );
  expect(drain.status).toBe(200);
  expect(await drain.json()).toEqual({
    runId: "ssr_12345678",
    operation: "reschedule_drain",
    run: {
      type: "source_sync",
      status: "queued",
      workspaceId: "space_123",
    },
    start: { record: { runId: "ssr_12345678", status: "succeeded" } },
    drain: { record: { runId: "ssr_12345678", status: "succeeded" } },
  });
  expect(ownerRequests).toEqual([
    {
      id: "id:ssr_12345678",
      url: "https://opentofu-run-owner/debug",
      method: "GET",
      body: undefined,
    },
    {
      id: "id:ssr_12345678",
      url: "https://opentofu-run-owner/start",
      method: "POST",
      body: {
        kind: "takosumi.opentofu-run-owner.start@v1",
        action: "source_sync",
        runId: "ssr_12345678",
        workspaceId: "space_123",
        cause: "controller_retry",
        queueAttempt: 1,
        messageId: "operator-repair:ssr_12345678:21i3v9",
      },
    },
    {
      id: "id:ssr_12345678",
      url: "https://opentofu-run-owner/drain",
      method: "POST",
      body: undefined,
    },
  ]);
});

test("platform metrics route is forwarded to the deploy-control seam", async () => {
  const env = { TAKOSUMI_METRICS_SCRAPE_TOKEN: "scrape-token" } as never;
  const forwarded: { url: string; authorization: string | null }[] = [];
  const response = await handlePlatformMetricsRequest(
    new Request("https://app.takosumi.com/metrics", {
      headers: { authorization: "Bearer scrape-token" },
    }),
    env,
    () => ({
      fetch: async (input: RequestInfo | URL) => {
        const request = input instanceof Request ? input : new Request(input);
        forwarded.push({
          url: request.url,
          authorization: request.headers.get("authorization"),
        });
        return new Response("takosumi_metrics_scrape_info 1\n", {
          status: 200,
          headers: {
            "content-type": "text/plain; version=0.0.4; charset=utf-8",
          },
        });
      },
    }),
  );
  expect(response?.status).toBe(200);
  expect(response?.headers.get("content-type")).toContain("text/plain");
  expect(await response?.text()).toContain("takosumi_metrics_scrape_info");
  expect(forwarded).toEqual([
    {
      url: "https://app.takosumi.com/metrics",
      authorization: "Bearer scrape-token",
    },
  ]);
});

test("platform metrics dashboard renders protected live metric samples", async () => {
  const env = { TAKOSUMI_METRICS_SCRAPE_TOKEN: "scrape-token" } as never;
  const forwarded: { url: string; authorization: string | null }[] = [];
  const response = await handlePlatformMetricsDashboardRequest(
    new Request(
      "https://app.takosumi.com/internal/platform/metrics-dashboard",
      {
        headers: { authorization: "Bearer scrape-token" },
      },
    ),
    env,
    () => ({
      fetch: async (input: RequestInfo | URL) => {
        const request = input instanceof Request ? input : new Request(input);
        forwarded.push({
          url: request.url,
          authorization: request.headers.get("authorization"),
        });
        return new Response(
          [
            'takosumi_deploy_operation_count{environment="production",runner_profile_id="runner",workspace_id="workspace",capsule_id="cap",operation_kind="apply",status="succeeded"} 1',
            'takosumi_apply_duration_seconds_bucket{environment="production",runner_profile_id="runner",workspace_id="workspace",capsule_id="cap",operation_kind="apply",status="succeeded",le="1"} 1',
          ].join("\n"),
          {
            status: 200,
            headers: {
              "content-type": "text/plain; version=0.0.4; charset=utf-8",
            },
          },
        );
      },
    }),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/html");
  const html = await response.text();
  expect(html).toContain("Takosumi Platform Metrics");
  expect(html).toContain("deploy-overview-required-metrics");
  expect(html).toContain("takosumi_deploy_operation_count");
  expect(forwarded).toEqual([
    {
      url: "https://app.takosumi.com/metrics",
      authorization: "Bearer scrape-token",
    },
  ]);
});

test("platform metrics dashboard forwards auth failures from scrape endpoint", async () => {
  const response = await handlePlatformMetricsDashboardRequest(
    new Request("https://app.takosumi.com/internal/platform/metrics-dashboard"),
    {} as never,
    () => ({
      fetch: async () =>
        Response.json({ error: "unauthenticated" }, { status: 401 }),
    }),
  );
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: "unauthenticated" });
});

test("platform metrics route does not capture dashboard paths", async () => {
  expect(isPlatformMetricsPath("/metrics")).toBe(true);
  expect(isPlatformMetricsPath("/metrics/extra")).toBe(false);
  expect(
    isPlatformMetricsDashboardPath("/internal/platform/metrics-dashboard"),
  ).toBe(true);
  const response = await handlePlatformMetricsRequest(
    new Request("https://app.takosumi.com/metrics/extra"),
    {} as never,
    () => ({
      fetch: async () => {
        throw new Error("must not be called");
      },
    }),
  );
  expect(response).toBeUndefined();
});

test("platform metrics summary captures required metric and label coverage", () => {
  const summary = summarizePrometheusMetrics(
    [
      'takosumi_deploy_operation_count{environment="production",runner_profile_id="runner",workspace_id="workspace",capsule_id="cap",operation_kind="apply",status="succeeded"} 1',
      'custom_metric{environment="production"} 1',
    ].join("\n"),
  );
  expect(summary.metricCount).toBe(2);
  expect(
    summary.requiredMetrics.find(
      (metric) => metric.name === "takosumi_deploy_operation_count",
    )?.present,
  ).toBe(true);
  expect(summary.missingRequiredMetrics).toContain(
    "takosumi_apply_duration_seconds_bucket",
  );
  expect(summary.missingRequiredLabels).toEqual([]);
});

test("platform OIDC metric classifier covers issuer and upstream auth paths", () => {
  expect(isOidcMetricPath("/.well-known/openid-configuration")).toBe(true);
  expect(isOidcMetricPath("/oauth/authorize")).toBe(true);
  expect(isOidcMetricPath("/oauth/token")).toBe(true);
  expect(isOidcMetricPath("/v1/auth/upstream/google/start")).toBe(true);
  expect(isOidcMetricPath("/api/v1/capsules")).toBe(false);
  expect(oidcMetricRoute("/oauth/authorize")).toBe("/oauth/authorize");
  expect(oidcMetricRoute("/v1/auth/upstream/google/callback")).toBe(
    "/v1/auth/upstream/*",
  );
});

test("platform side effects leave the response path through waitUntil", async () => {
  let resolveTask!: () => void;
  const task = new Promise<void>((resolve) => {
    resolveTask = resolve;
  });
  let scheduled: Promise<unknown> | undefined;

  await schedulePlatformSideEffect(task, {
    waitUntil(promise) {
      scheduled = promise;
    },
  });

  expect(scheduled).toBe(task);
  resolveTask();
  await scheduled;
});

test("platform assets are served with immutable cache headers", async () => {
  const response = withPlatformAssetCacheHeaders(
    new Request("https://app.takosumi.com/assets/index-abc123.js"),
    new URL("https://app.takosumi.com/assets/index-abc123.js"),
    new Response("console.log('ok')", {
      headers: { "cache-control": "public, max-age=0, must-revalidate" },
    }),
  );

  expect(response.headers.get("cache-control")).toBe(
    "public, max-age=31536000, immutable",
  );
  expect(await response.text()).toBe("console.log('ok')");
});

test("platform provider mirror assets use mirror-aware cache headers", async () => {
  const indexResponse = withPlatformAssetCacheHeaders(
    new Request(
      "https://app.takosumi.com/opentofu/providers/registry.opentofu.org/hashicorp/random/index.json",
    ),
    new URL(
      "https://app.takosumi.com/opentofu/providers/registry.opentofu.org/hashicorp/random/index.json",
    ),
    new Response('{"versions":{}}', {
      headers: { "cache-control": "public, max-age=0, must-revalidate" },
    }),
  );
  expect(indexResponse.headers.get("cache-control")).toBe("no-cache");

  const archiveResponse = withPlatformAssetCacheHeaders(
    new Request(
      "https://app.takosumi.com/opentofu/providers/registry.opentofu.org/hashicorp/random/terraform-provider-random_3.7.2_linux_amd64.zip",
    ),
    new URL(
      "https://app.takosumi.com/opentofu/providers/registry.opentofu.org/hashicorp/random/terraform-provider-random_3.7.2_linux_amd64.zip",
    ),
    new Response("zip", {
      headers: { "cache-control": "public, max-age=0, must-revalidate" },
    }),
  );
  expect(archiveResponse.headers.get("cache-control")).toBe(
    "public, max-age=31536000, immutable",
  );
});

test("platform asset cache helper leaves non-assets untouched", () => {
  const response = new Response("ok", {
    headers: { "cache-control": "no-store" },
  });

  expect(
    withPlatformAssetCacheHeaders(
      new Request("https://app.takosumi.com/api/v1/workspaces"),
      new URL("https://app.takosumi.com/api/v1/workspaces"),
      response,
    ),
  ).toBe(response);
});

test("operator billing endpoint is read-only showback", async () => {
  const url = new URL(
    "https://app.takosumi.com/internal/platform/workspaces/ws_12345678/billing",
  );
  const operations: OperatorBillingOperations = {
    getWorkspaceBilling: async (workspaceId) => ({
      billing: {
        settings: { mode: workspaceId ? "showback" : "disabled" },
      },
    }),
  };
  const unauthorized = await handleOperatorBillingRequest(
    new Request(url),
    url,
    { TAKOSUMI_DEPLOY_CONTROL_TOKEN: "operator-secret" } as never,
    operations,
  );
  expect(unauthorized?.status).toBe(401);

  const response = await handleOperatorBillingRequest(
    new Request(url, {
      headers: { authorization: "Bearer operator-secret" },
    }),
    url,
    { TAKOSUMI_DEPLOY_CONTROL_TOKEN: "operator-secret" } as never,
    operations,
  );
  expect(response?.status).toBe(200);
  expect(await response?.json()).toMatchObject({
    billing: { settings: { mode: "showback" } },
  });
  expect(
    isOperatorBillingPath(
      "/internal/platform/workspaces/ws_12345678/credits/top-up",
    ),
  ).toBe(false);
  expect(
    isOperatorBillingPath(
      "/internal/platform/workspaces/ws_12345678/subscription/change",
    ),
  ).toBe(false);
});

// --- Generic, config-driven platform extension seam ------------------------
//
// The OSS platform worker names no Cloud feature. The extension seam is driven
// entirely by the operator/Cloud-supplied `TAKOSUMI_PLATFORM_EXTENSIONS` env var
// (a JSON array of opaque `{ basePath, handlerKey, requiredScopes? }`
// descriptors). When that env is unset, every extension path 404s; when it is
// set, a matching path verifies the platform session and dispatches to the
// named in-process handler.

test("platformExtensionRoutes is empty when the env is unset", () => {
  expect(platformExtensionRoutes({})).toEqual([]);
  expect(platformExtensionRoutes({ TAKOSUMI_PLATFORM_EXTENSIONS: "" })).toEqual(
    [],
  );
});

test("platformExtensionRoutes parses opaque descriptors", () => {
  expect(
    platformExtensionRoutes({
      TAKOSUMI_PLATFORM_EXTENSIONS: JSON.stringify([
        {
          id: "ai",
          basePath: "/gateway/ai/v1",
          handlerKey: "TEST_AI_EXTENSION",
          capabilities: ["openai.chat_completions", "openai.embeddings"],
          authMode: "platform",
          requiredScopes: ["ai.chat"],
        },
        { basePath: "/extensions/x", handlerKey: "TEST_X_EXTENSION" },
      ]),
    }),
  ).toEqual([
    {
      id: "ai",
      basePath: "/gateway/ai/v1",
      handlerKey: "TEST_AI_EXTENSION",
      capabilities: ["openai.chat_completions", "openai.embeddings"],
      authMode: "platform",
      requiredScopes: ["ai.chat"],
    },
    { basePath: "/extensions/x", handlerKey: "TEST_X_EXTENSION" },
  ]);
});

test("platformExtensionRoutes validates safe extension-owned contributions", () => {
  const [route] = platformExtensionRoutes({
    TAKOSUMI_PLATFORM_EXTENSIONS: JSON.stringify([
      {
        basePath: "/extensions/example",
        handlerKey: "TEST_EXTENSION",
        contributions: [
          {
            id: "example-settings",
            slot: "navigation.manage",
            href: "/extensions/example/settings",
            label: "Example settings",
            labels: { ja: "拡張設定" },
            order: 20,
          },
        ],
      },
    ]),
  });
  expect(route?.contributions?.[0]).toMatchObject({
    id: "example-settings",
    slot: "navigation.manage",
    href: "/extensions/example/settings",
  });
  expect(() =>
    platformExtensionRoutes({
      TAKOSUMI_PLATFORM_EXTENSIONS: JSON.stringify([
        {
          basePath: "/extensions/example",
          handlerKey: "TEST_EXTENSION",
          contributions: [
            {
              id: "escape",
              slot: "navigation.manage",
              href: "/admin",
              label: "Escape",
            },
          ],
        },
      ]),
    }),
  ).toThrow("must stay under /extensions/example");
});

test("platformExtensionRoutes merges duplicate capability descriptors", () => {
  expect(
    platformExtensionRoutes({
      TAKOSUMI_PLATFORM_EXTENSIONS: JSON.stringify([
        {
          basePath: "/compat/example/v1",
          handlerKey: "TEST_COMPAT_EXTENSION",
          compatibilityProfiles: [
            { profile: "compat.object-store.v1", planes: ["data"] },
          ],
        },
        {
          basePath: "/compat/example/v1",
          handlerKey: "TEST_COMPAT_EXTENSION",
          compatibilityProfiles: [
            { profile: "compat.kv.v1", planes: ["data"] },
          ],
        },
      ]),
    }),
  ).toEqual([
    {
      basePath: "/compat/example/v1",
      handlerKey: "TEST_COMPAT_EXTENSION",
      capabilities: ["compat.object-store.v1", "compat.kv.v1"],
      compatibilityProfiles: [
        { profile: "compat.object-store.v1", planes: ["data"] },
        { profile: "compat.kv.v1", planes: ["data"] },
      ],
    },
  ]);
});

test("platformExtensionRoutes rejects malformed descriptors", () => {
  expect(() =>
    platformExtensionRoutes({ TAKOSUMI_PLATFORM_EXTENSIONS: "{" }),
  ).toThrow("must be valid JSON");
  expect(() =>
    platformExtensionRoutes({
      TAKOSUMI_PLATFORM_EXTENSIONS: JSON.stringify([{ handlerKey: "X" }]),
    }),
  ).toThrow("basePath");
  expect(() =>
    platformExtensionRoutes({
      TAKOSUMI_PLATFORM_EXTENSIONS: JSON.stringify([{ basePath: "/x" }]),
    }),
  ).toThrow("handlerKey");
  expect(() =>
    platformExtensionRoutes({
      TAKOSUMI_PLATFORM_EXTENSIONS: JSON.stringify([
        { basePath: "/x", handlerKey: "X", capabilities: "ai" },
      ]),
    }),
  ).toThrow("capabilities");
  for (const basePath of [
    "/v1/form-availability",
    TAKOFORM_FORM_HOST_API_PATH,
  ]) {
    expect(() =>
      platformExtensionRoutes({
        TAKOSUMI_PLATFORM_EXTENSIONS: JSON.stringify([
          { basePath, handlerKey: "X" },
        ]),
      }),
    ).toThrow("overlaps a Takosumi core route prefix");
  }
});

test("the seam claims no extension path when TAKOSUMI_PLATFORM_EXTENSIONS is unset", async () => {
  // With no TAKOSUMI_PLATFORM_EXTENSIONS the seam matches nothing, so the request
  // is NOT claimed (returns undefined) and falls through to the accounts handler
  // — i.e. an OSS worker with no Cloud config exposes no extension paths.
  const result = await handlePlatformExtensionRequest(
    new Request("https://app.takosumi.com/gateway/ai/v1/models"),
    {
      // A binding object exists on env, but with no descriptors it is unreachable.
      TEST_AI_EXTENSION: { fetch: async () => Response.json({}) },
    } as never,
  );
  expect(result).toBeUndefined();
});

test("unmatched compatibility profiles fail closed before the accounts SPA", async () => {
  const worker = (await import("../../../deploy/platform/worker.ts")).default;
  const response = await worker.fetch(
    new Request("https://operator.example.test/compat/uninstalled/v1"),
    {} as never,
  );

  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: "not found" });
});

test("platform worker exposes product discovery before accounts handler", async () => {
  const worker = (await import("../../../deploy/platform/worker.ts")).default;

  const discovery = await worker.fetch(
    new Request(`https://app.takosumi.com${TAKOSUMI_WELL_KNOWN_PATH}`),
    {} as never,
  );
  const capabilities = await worker.fetch(
    new Request(
      `https://app.takosumi.com${TAKOSUMI_PRODUCT_CAPABILITIES_PATH}`,
    ),
    {} as never,
  );

  expect(discovery.status).toBe(200);
  const discoveryBody = await discovery.json();
  expect(discoveryBody.api_versions).toEqual([TAKOSUMI_API_VERSION]);
  expect(discoveryBody.endpoints.capabilities).toBe(
    `https://app.takosumi.com${TAKOSUMI_PRODUCT_CAPABILITIES_PATH}`,
  );

  expect(capabilities.status).toBe(200);
  const capabilitiesBody = await capabilities.json();
  expect(capabilitiesBody.apiVersion).toBe(TAKOSUMI_API_VERSION);
  expect(capabilitiesBody.resources.Stack).toBe(true);
  expect(capabilitiesBody.compat.framework).toBe(true);
  expect(capabilitiesBody.resources.ObjectBucket).toBe(false);
  expect(Object.keys(capabilitiesBody.resources).sort()).toEqual([
    "ContainerService",
    "DurableWorkflow",
    "EdgeWorker",
    "KVStore",
    "ObjectBucket",
    "Queue",
    "SQLDatabase",
    "Schedule",
    "Stack",
    "StatefulActorNamespace",
    "VectorIndex",
  ]);
  expect(capabilitiesBody.adapters.cloudflare).toBeUndefined();
  expect(capabilitiesBody.compat["compat.example.v1"]).toBeUndefined();
  expect(capabilitiesBody.operator.usage_showback).toBe(false);
  expect(capabilitiesBody).not.toHaveProperty("commercial");
});

test("platform discovery publishes commercial functions only as explicit extension tokens", async () => {
  const worker = (await import("../../../deploy/platform/worker.ts")).default;
  const database = { prepare() {} };
  const response = await worker.fetch(
    new Request(
      `https://operator.example${TAKOSUMI_PRODUCT_CAPABILITIES_PATH}`,
    ),
    {
      TAKOSUMI_ACCOUNTS_DB: database,
      TAKOSUMI_CONTROL_DB: database,
      TAKOSUMI_OPERATOR_CAPABILITIES:
        "multi_tenant_workspaces workspace_members usage_showback",
      TAKOSUMI_COMMERCIAL_BILLING_HANDLER: { fetch() {} },
      TAKOSUMI_PLATFORM_EXTENSIONS: JSON.stringify([
        {
          basePath: "/v1/billing",
          handlerKey: "TAKOSUMI_COMMERCIAL_BILLING_HANDLER",
          capabilities: ["billing.commercial.v1"],
        },
      ]),
    } as never,
  );

  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.operator.multi_tenant_workspaces).toBe(true);
  expect(body.operator.workspace_members).toBe(true);
  expect(body.operator.usage_showback).toBe(true);
  expect(body.extensions).toContain("billing.commercial.v1");
  expect(body).not.toHaveProperty("commercial");
});

test("platform worker product discovery exposes Cloud endpoint capabilities without claiming Resource Shape API", async () => {
  const worker = (await import("../../../deploy/platform/worker.ts")).default;

  const capabilities = await worker.fetch(
    new Request(
      `https://app.takosumi.com${TAKOSUMI_PRODUCT_CAPABILITIES_PATH}`,
    ),
    {
      TAKOSUMI_PLATFORM_EXTENSIONS: JSON.stringify([
        {
          basePath: "/gateway/ai/v1",
          handlerKey: "TEST_AI_EXTENSION",
          capabilities: ["ai.gateway"],
        },
        {
          basePath: "/compat/example/v1",
          handlerKey: "TEST_PROVIDER_EXTENSION",
          compatibilityProfiles: [
            {
              profile: "compat.example.v1",
              planes: ["control"],
            },
          ],
        },
        {
          basePath: "/compat/s3/v1",
          handlerKey: "TEST_STORAGE_EXTENSION",
          compatibilityProfiles: [
            { profile: "compat.s3.v1", planes: ["data"] },
          ],
        },
        {
          basePath: "/cloud/usage",
          handlerKey: "TEST_USAGE_EXTENSION",
          capabilities: ["cloud.usage"],
        },
      ]),
      TEST_AI_EXTENSION: { fetch: async () => Response.json({}) },
      TEST_PROVIDER_EXTENSION: {
        fetchCompatibility: async () => Response.json({}),
      },
      TEST_STORAGE_EXTENSION: {
        fetchCompatibility: async () => Response.json({}),
      },
      TEST_USAGE_EXTENSION: { fetch: async () => Response.json({}) },
    } as never,
  );

  expect(capabilities.status).toBe(200);
  const body = await capabilities.json();
  expect(body.resources.EdgeWorker).toBe(false);
  expect(body.resources.ObjectBucket).toBe(false);
  expect(body.resources.KVStore).toBe(false);
  expect(body.resources.Queue).toBe(false);
  expect(body.resources.SQLDatabase).toBe(false);
  expect(body.resources.ContainerService).toBe(false);
  expect(body.resources.VectorIndex).toBe(false);
  expect(body.resources.DurableWorkflow).toBe(false);
  expect(body.resources.StatefulActorNamespace).toBe(false);
  expect(body.resources.Schedule).toBe(false);
  expect(Object.keys(body.resources).sort()).toEqual([
    "ContainerService",
    "DurableWorkflow",
    "EdgeWorker",
    "KVStore",
    "ObjectBucket",
    "Queue",
    "SQLDatabase",
    "Schedule",
    "Stack",
    "StatefulActorNamespace",
    "VectorIndex",
  ]);
  expect(body.adapters.cloudflare).toBeUndefined();
  expect(body.adapters.takosumi_native).toBeUndefined();
  expect(body.compat["compat.example.v1"]).toBe(true);
  expect(body.compat["compat.s3.v1"]).toBe(true);
  const discovery = await worker.fetch(
    new Request(`https://app.takosumi.com${TAKOSUMI_WELL_KNOWN_PATH}`),
    {
      TAKOSUMI_PLATFORM_EXTENSIONS: JSON.stringify([
        {
          basePath: "/compat/s3/v1",
          handlerKey: "TEST_STORAGE_EXTENSION",
          compatibilityProfiles: [
            { profile: "compat.s3.v1", planes: ["data"] },
          ],
        },
      ]),
      TEST_STORAGE_EXTENSION: {
        fetchCompatibility: async () => Response.json({}),
      },
    } as never,
  );
  expect(discovery.status).toBe(200);
  const discoveryBody = await discovery.json();
  expect(discoveryBody.features.resource_shapes).toBe(false);
  expect(discoveryBody.features.compatibility_profiles).toEqual([
    "compat.s3.v1",
  ]);
  expect(discoveryBody.endpoints.extensions["compat.s3.v1"]).toBe(
    "https://app.takosumi.com/compat/s3/v1",
  );
});

test("platform Resource Shape API discovery is gated by deploy-control token and D1", async () => {
  const worker = (await import("../../../deploy/platform/worker.ts")).default;
  const schemaRegistry = new MapResourceShapeSchemaRegistry({
    CustomService: () => ({
      ok: true,
      value: { spec: {}, interfaces: [], connections: {} },
    }),
  });
  const env = {
    TAKOSUMI_CONTROL_DB: new SqliteFakeD1(),
    TAKOSUMI_DEPLOY_CONTROL_TOKEN: "resource-token",
    TAKOSUMI_DEV_MODE: "1",
    TAKOSUMI_RESOURCE_SHAPES:
      "EdgeWorker,ObjectBucket,KVStore,Queue,SQLDatabase,CustomService",
    TAKOSUMI_RESOURCE_SHAPE_SCHEMA_REGISTRY: schemaRegistry,
    TAKOSUMI_RESOURCE_ADAPTERS:
      "cloudflare,operator.edge-runtime,operator.container-runtime",
  } as never;

  expect(platformResourceShapeApiEnabled({} as never)).toBe(false);
  expect(platformResourceShapeApiEnabled(env)).toBe(true);

  const capabilities = await worker.fetch(
    new Request(
      `https://app.takosumi.com${TAKOSUMI_PRODUCT_CAPABILITIES_PATH}`,
    ),
    env,
  );

  expect(capabilities.status).toBe(200);
  const body = await capabilities.json();
  expect(body.resources.EdgeWorker).toBe(true);
  expect(body.resources.ObjectBucket).toBe(true);
  expect(body.resources.KVStore).toBe(true);
  expect(body.resources.Queue).toBe(true);
  expect(body.resources.SQLDatabase).toBe(true);
  expect(body.resources.ContainerService).toBe(false);
  expect(body.resources.VectorIndex).toBe(false);
  expect(body.resources.DurableWorkflow).toBe(false);
  expect(body.resources.StatefulActorNamespace).toBe(false);
  expect(body.resources.Schedule).toBe(false);
  expect(body.resources.CustomService).toBe(true);
  expect(body.adapters.cloudflare).toBe(true);
  expect(body.adapters.takosumi_native).toBeUndefined();
  expect(body.adapters["operator.edge-runtime"]).toBe(true);
  expect(body.adapters["operator.container-runtime"]).toBe(true);

  const disabledShape = await handlePlatformResourceShapeApiRequest(
    new Request("https://app.takosumi.com/v1/resources/ContainerService/api", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer resource-token",
      },
      body: JSON.stringify({
        metadata: { space: "space_1" },
        spec: {
          name: "api",
          image: "ghcr.io/example/api:1.0.0",
        },
      }),
    }),
    env,
  );
  expect(disabledShape.status).toBe(400);
  expect((await disabledShape.json()).error.message).toContain(
    "resource kind is not enabled: ContainerService",
  );

  const discovery = await worker.fetch(
    new Request(`https://app.takosumi.com${TAKOSUMI_WELL_KNOWN_PATH}`),
    env,
  );
  expect(discovery.status).toBe(200);
  expect((await discovery.json()).features.resource_shapes).toBe(true);
});

test("platform Resource Shape API does not advertise shapes without an operator list", async () => {
  const worker = (await import("../../../deploy/platform/worker.ts")).default;
  const env = {
    TAKOSUMI_CONTROL_DB: new SqliteFakeD1(),
    TAKOSUMI_DEPLOY_CONTROL_TOKEN: "resource-token",
  } as never;

  const capabilities = await worker.fetch(
    new Request(
      `https://app.takosumi.com${TAKOSUMI_PRODUCT_CAPABILITIES_PATH}`,
    ),
    env,
  );

  expect(capabilities.status).toBe(200);
  const body = await capabilities.json();
  expect(body.resources.EdgeWorker).toBe(false);
  expect(body.resources.ObjectBucket).toBe(false);
  expect(body.adapters.opentofu).toBe(true);
  expect(body.adapters.cloudflare).toBeUndefined();

  const discovery = await worker.fetch(
    new Request(`https://app.takosumi.com${TAKOSUMI_WELL_KNOWN_PATH}`),
    env,
  );
  expect(discovery.status).toBe(200);
  expect((await discovery.json()).features.resource_shapes).toBe(false);
});

test("platform Resource Shape API routes are routed before accounts and bearer-gated", async () => {
  expect(isPlatformResourceShapeApiPath("/v1/resources")).toBe(true);
  expect(isPlatformResourceShapeApiPath("/v1/form-availability")).toBe(true);
  expect(isPlatformResourceShapeApiPath(TAKOFORM_FORM_HOST_API_PATH)).toBe(
    true,
  );
  expect(
    isPlatformResourceShapeApiPath(
      `${TAKOFORM_FORM_HOST_API_PATH}/interfaces/mcp.server`,
    ),
  ).toBe(true);
  expect(isPlatformResourceShapeApiPath("/v1/interfaces")).toBe(true);
  expect(isPlatformResourceShapeApiPath("/v1/interfaces/if_1/bindings")).toBe(
    true,
  );
  expect(isPlatformResourceShapeApiPath("/v1/target-pools/default")).toBe(true);
  expect(isPlatformResourceShapeApiPath("/v1/space-policies/default")).toBe(
    true,
  );
  expect(isPlatformResourceShapeApiPath("/api/v1/workspaces")).toBe(false);

  const disabled = await handlePlatformResourceShapeApiRequest(
    new Request("https://app.takosumi.com/v1/target-pools/default"),
    {} as never,
  );
  expect(disabled.status).toBe(404);

  const env = {
    TAKOSUMI_CONTROL_DB: new SqliteFakeD1(),
    TAKOSUMI_ENVIRONMENT: "test",
    TAKOSUMI_DEV_MODE: "1",
    TAKOSUMI_DEPLOY_CONTROL_TOKEN: "resource-token",
  } as never;
  const unauthenticated = await handlePlatformResourceShapeApiRequest(
    new Request("https://app.takosumi.com/v1/target-pools/default", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        space: "space_1",
        spec: {
          targets: [
            {
              name: "cf-main",
              type: "cloudflare",
              ref: "account_test",
              priority: 100,
            },
          ],
        },
      }),
    }),
    env,
  );
  expect(unauthenticated.status).toBe(401);

  const authorized = await handlePlatformResourceShapeApiRequest(
    new Request("https://app.takosumi.com/v1/target-pools/default", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer resource-token",
      },
      body: JSON.stringify({
        space: "space_1",
        spec: {
          targets: [
            {
              name: "cf-main",
              type: "cloudflare",
              ref: "account_test",
              priority: 100,
            },
          ],
        },
      }),
    }),
    env,
  );
  expect(authorized.status).toBe(200);
});

test("platform exposes public Takoform discovery and fences portable reads to an existing Workspace", async () => {
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db);
  const workspaceId = "workspace_takoform";
  await new CloudflareD1OpenTofuControlStore(db).putWorkspace({
    id: workspaceId,
    handle: "takoform",
    displayName: "Takoform Workspace",
    type: "personal",
    ownerUserId: "user_takoform",
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z",
  });
  const env = {
    TAKOSUMI_CONTROL_DB: db,
    TAKOSUMI_ENVIRONMENT: "test",
    TAKOSUMI_DEV_MODE: "1",
    TAKOSUMI_DEPLOY_CONTROL_TOKEN: "resource-token",
  } as never;

  const resolveWorkspace = platformResourceInterfaceWorkspaceResolver(env);
  expect(
    await resolveWorkspace({
      resourceSpaceId: workspaceId,
      resourceId: `tkrn:${workspaceId}:ObjectBucket:assets`,
    }),
  ).toBe(workspaceId);
  expect(
    await resolveWorkspace({
      resourceSpaceId: "workspace_missing",
      resourceId: "tkrn:workspace_missing:ObjectBucket:assets",
    }),
  ).toBeUndefined();

  const worker = (await import("../../../deploy/platform/worker.ts")).default;
  const discovery = await worker.fetch(
    new Request(
      `https://app.takosumi.com${TAKOFORM_FORM_HOST_WELL_KNOWN_PATH}`,
      { headers: { authorization: "Bearer must-not-be-forwarded" } },
    ),
    env,
  );
  expect(discovery.status).toBe(200);
  expect(await discovery.json()).toMatchObject({
    features: { interface_declarations: true },
    endpoints: {
      api: `https://app.takosumi.com${TAKOFORM_FORM_HOST_API_PATH}`,
      interfaces: `https://app.takosumi.com${TAKOFORM_FORM_HOST_API_PATH}/interfaces`,
    },
  });

  const unauthenticated = await handlePlatformResourceShapeApiRequest(
    new Request(
      `https://app.takosumi.com${TAKOFORM_FORM_HOST_API_PATH}/interfaces?space=${workspaceId}`,
    ),
    env,
    async () => ({ authenticated: false }),
  );
  expect(unauthenticated.status).toBe(401);

  const verify = async () => ({
    authenticated: true as const,
    authKind: "personal-access-token" as const,
    subject: "user_takoform",
    scopes: ["read"],
  });
  const workspaceAccess = async (
    _request: Request,
    _env: unknown,
    requestedWorkspaceId: string,
  ) => requestedWorkspaceId === workspaceId;
  const interfaces = await handlePlatformResourceShapeApiRequest(
    new Request(
      `https://app.takosumi.com${TAKOFORM_FORM_HOST_API_PATH}/interfaces?space=${workspaceId}`,
    ),
    env,
    verify,
    workspaceAccess,
  );
  expect(interfaces.status).toBe(200);
  expect(await interfaces.json()).toEqual({ interfaces: [] });

  const availability = await handlePlatformResourceShapeApiRequest(
    new Request(
      `https://app.takosumi.com/v1/form-availability?space=${workspaceId}`,
    ),
    env,
    verify,
    workspaceAccess,
  );
  expect(availability.status).toBe(200);
  expect(await availability.json()).toEqual({ forms: [] });

  const crossWorkspace = await handlePlatformResourceShapeApiRequest(
    new Request(
      `https://app.takosumi.com${TAKOFORM_FORM_HOST_API_PATH}/interfaces?space=workspace_other`,
    ),
    env,
    async () => ({ ...(await verify()), workspaceId }),
  );
  expect(crossWorkspace.status).toBe(403);
  expect(await crossWorkspace.json()).toEqual({
    error: "access_denied",
    error_description: "workspace context is not authorized",
  });

  const disabledDiscovery = await handlePlatformTakoformDiscoveryRequest(
    new Request(
      `https://app.takosumi.com${TAKOFORM_FORM_HOST_WELL_KNOWN_PATH}`,
    ),
    {} as never,
  );
  expect(disabledDiscovery.status).toBe(404);
});

test("platform Resource Shape API accepts user tokens without applying hosted pricing in OSS", async () => {
  const env = {
    TAKOSUMI_CONTROL_DB: new SqliteFakeD1(),
    TAKOSUMI_ENVIRONMENT: "test",
    TAKOSUMI_DEV_MODE: "1",
    TAKOSUMI_DEPLOY_CONTROL_TOKEN: "resource-token",
    TAKOSUMI_RESOURCE_SHAPES: "EdgeWorker,ObjectBucket",
    TAKOSUMI_RESOURCE_ADAPTERS: "cloudflare",
  } as never;

  const response = await handlePlatformResourceShapeApiRequest(
    new Request("https://app.takosumi.com/v1/target-pools/default", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer takpat_cloud",
      },
      body: JSON.stringify({
        space: "space_cloud",
        spec: {
          targets: [
            {
              name: "cf-main",
              type: "cloudflare",
              ref: "account_test",
              priority: 100,
            },
          ],
        },
      }),
    }),
    env,
    async () => ({
      authenticated: true,
      authKind: "personal-access-token",
      subject: "tsub_cloud",
      workspaceId: "space_cloud",
      scopes: ["admin"],
    }),
  );

  expect(response.status).toBe(200);
});

test("platform Resource Shape session auth rejects a Space outside the verified Workspace", async () => {
  const env = {
    TAKOSUMI_CONTROL_DB: new SqliteFakeD1(),
    TAKOSUMI_ENVIRONMENT: "test",
    TAKOSUMI_DEV_MODE: "1",
    TAKOSUMI_DEPLOY_CONTROL_TOKEN: "resource-token",
    TAKOSUMI_RESOURCE_SHAPES: "ObjectBucket",
  } as never;
  const verify = async () => ({
    authenticated: true as const,
    authKind: "personal-access-token" as const,
    subject: "tsub_member",
    workspaceId: "space_allowed",
    scopes: ["admin"],
  });

  const bodyMismatch = await handlePlatformResourceShapeApiRequest(
    new Request("https://app.takosumi.com/v1/target-pools/default", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: "space_allowed",
        space: "space_victim",
        spec: { targets: [] },
      }),
    }),
    env,
    verify,
  );
  expect(bodyMismatch.status).toBe(403);
  expect(await bodyMismatch.json()).toEqual({
    error: "forbidden",
    error_description: "Resource Space must match the verified Workspace",
  });

  const queryMismatch = await handlePlatformResourceShapeApiRequest(
    new Request(
      "https://app.takosumi.com/v1/resources?workspaceId=space_allowed&space=space_victim",
    ),
    env,
    verify,
  );
  expect(queryMismatch.status).toBe(403);

  const conflictingSelectors = await handlePlatformResourceShapeApiRequest(
    new Request(
      "https://app.takosumi.com/v1/resources/ObjectBucket/private-assets",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspaceId: "space_allowed",
          space: "space_allowed",
          metadata: { space: "space_victim" },
          spec: { name: "private-assets" },
        }),
      },
    ),
    env,
    verify,
  );
  expect(conflictingSelectors.status).toBe(403);
});

test("platform public Resource ingress cannot spoof a compatibility managedBy identity", async () => {
  const response = await handlePlatformResourceShapeApiRequest(
    new Request("https://app.takosumi.com/v1/resources/preview", {
      method: "POST",
      headers: {
        authorization: "Bearer takpat_write",
        "content-type": "application/json",
        "x-takosumi-resource-managed-by": "compat.example.v1",
      },
      body: JSON.stringify({
        workspaceId: "workspace_a",
        kind: "ObjectBucket",
        metadata: {
          name: "assets",
          space: "workspace_a",
          managedBy: "compat.example.v1",
        },
        spec: { name: "assets" },
      }),
    }),
    {
      TAKOSUMI_CONTROL_DB: new SqliteFakeD1(),
      TAKOSUMI_ENVIRONMENT: "test",
      TAKOSUMI_DEV_MODE: "1",
      TAKOSUMI_DEPLOY_CONTROL_TOKEN: "resource-token",
      TAKOSUMI_RESOURCE_SHAPES: "ObjectBucket",
    } as never,
    async () => ({
      authenticated: true,
      authKind: "personal-access-token",
      subject: "account_a",
      workspaceId: "workspace_a",
      scopes: ["write"],
    }),
  );

  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({
    error: {
      code: "forbidden",
      message: expect.stringContaining("takosumi.resource-api.v1"),
    },
  });
});

test("platform bearer ingress preserves the provider's opentofu authoring surface", async () => {
  const env = {
    TAKOSUMI_CONTROL_DB: new SqliteFakeD1(),
    TAKOSUMI_ENVIRONMENT: "test",
    TAKOSUMI_DEV_MODE: "1",
    TAKOSUMI_DEPLOY_CONTROL_TOKEN: "resource-token",
    TAKOSUMI_RESOURCE_SHAPES: "ObjectBucket",
    TAKOSUMI_RESOURCE_ADAPTERS: "cloudflare",
  } as never;
  const verify = async () => ({
    authenticated: true as const,
    authKind: "personal-access-token" as const,
    subject: "provider-user",
    workspaceId: "workspace_provider",
    scopes: ["write"],
  });
  const pool = await handlePlatformResourceShapeApiRequest(
    new Request("https://app.takosumi.com/v1/target-pools/default", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: "workspace_provider",
        space: "workspace_provider",
        spec: {
          targets: [
            {
              name: "cf-main",
              type: "cloudflare",
              ref: "account_test",
              priority: 100,
            },
          ],
        },
      }),
    }),
    env,
    verify,
  );
  expect(pool.status).toBe(200);

  const preview = await handlePlatformResourceShapeApiRequest(
    new Request("https://app.takosumi.com/v1/resources/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: "workspace_provider",
        kind: "ObjectBucket",
        metadata: {
          name: "assets",
          space: "workspace_provider",
          managedBy: "opentofu",
        },
        spec: { name: "assets", interfaces: ["s3_api"] },
      }),
    }),
    env,
    verify,
  );
  // This minimal fixture has no SpacePolicy, so resolution may stop at its
  // normal review gate. The provider authoring identity itself must get past
  // ingress instead of being rejected as a managedBy spoof.
  expect(preview.status).not.toBe(403);
  expect(await preview.clone().text()).not.toContain("managedBy");

  const missingDelete = await handlePlatformResourceShapeApiRequest(
    new Request(
      "https://app.takosumi.com/v1/resources/ObjectBucket/missing?space=workspace_provider&managedBy=opentofu",
      { method: "DELETE" },
    ),
    env,
    verify,
  );
  expect(missingDelete.status).toBe(204);
});

test("platform Resource ingress enforces personal token read/write scopes", async () => {
  const response = await handlePlatformResourceShapeApiRequest(
    new Request("https://app.takosumi.com/v1/target-pools/default", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: "workspace_read_only",
        space: "workspace_read_only",
        spec: { targets: [] },
      }),
    }),
    {
      TAKOSUMI_CONTROL_DB: new SqliteFakeD1(),
      TAKOSUMI_ENVIRONMENT: "test",
      TAKOSUMI_DEV_MODE: "1",
      TAKOSUMI_DEPLOY_CONTROL_TOKEN: "resource-token",
    } as never,
    async () => ({
      authenticated: true,
      authKind: "personal-access-token",
      subject: "read-only-user",
      workspaceId: "workspace_read_only",
      scopes: ["read"],
    }),
  );
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({
    error: "insufficient_scope",
  });
});

test("compatibility reads are profile-scoped while operator recovery reads every manager", async () => {
  const database = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(database);
  const stores = createD1ResourceShapeStores(database);
  const space = "workspace_manager_scope";
  const record = (
    name: string,
    managedBy: string,
    createdAt: string,
  ): ResourceShapeRecord => ({
    id: `tkrn:${space}:EdgeWorker:${name}`,
    spaceId: space,
    kind: "EdgeWorker",
    name,
    managedBy,
    spec: {
      name,
      source: {
        artifactRef: `cloud-edge-worker-artifact:v3:sha256:${name.padEnd(64, "a").slice(0, 64)}`,
        artifactSha256: `sha256:${name.padEnd(64, "a").slice(0, 64)}`,
      },
    },
    phase: "Ready",
    generation: 1,
    observedGeneration: 1,
    createdAt: createdAt as ResourceShapeRecord["createdAt"],
    updatedAt: createdAt as ResourceShapeRecord["updatedAt"],
  });
  await stores.resources.upsert(
    record(
      "public-api",
      "takosumi.resource-api.v1",
      "2026-07-15T00:00:00.000Z",
    ),
  );
  await stores.resources.upsert(
    record("compat-api", "compat.example.v1", "2026-07-15T00:00:01.000Z"),
  );
  const env = {
    TAKOSUMI_CONTROL_DB: database,
    TAKOSUMI_ENVIRONMENT: "test",
    TAKOSUMI_DEV_MODE: "1",
    TAKOSUMI_DEPLOY_CONTROL_TOKEN: "resource-token",
    TAKOSUMI_RESOURCE_SHAPES: "EdgeWorker",
  } as never;
  const route = {
    id: "example-compatibility",
    basePath: "/compat/example/v1",
    handlerKey: "TEST_PROVIDER_EXTENSION",
    authMode: "platform",
    compatibilityProfiles: [
      {
        profile: "compat.example.v1",
        planes: ["control"],
      },
    ],
  } as const;
  const compatibility = await createPlatformCompatibilityAuthority({
    request: new Request("https://operator.example.test/compat/example/v1"),
    env,
    route,
    session: {
      authenticated: true,
      authKind: "service-token",
      workspaceId: space,
      subject: "compat-handler",
      scopes: ["admin"],
    },
  });
  expect(compatibility.control).toBeDefined();

  const foreign = await compatibility.control!.resourceApi.fetch(
    new Request(
      `https://app.takosumi.com/v1/resources/EdgeWorker/public-api?space=${space}`,
    ),
  );
  expect(foreign.status).toBe(404);

  const firstPage = await compatibility.control!.resourceApi.fetch(
    new Request(`https://app.takosumi.com/v1/resources?space=${space}&limit=1`),
  );
  expect(firstPage.status).toBe(200);
  const firstBody = await firstPage.json();
  expect(firstBody.resources).toEqual([]);
  expect(firstBody.nextCursor).toBeString();
  const secondPage = await compatibility.control!.resourceApi.fetch(
    new Request(
      `https://app.takosumi.com/v1/resources?space=${space}&limit=1&cursor=${encodeURIComponent(firstBody.nextCursor)}`,
    ),
  );
  expect(secondPage.status).toBe(200);
  expect((await secondPage.json()).resources).toMatchObject([
    {
      metadata: {
        name: "compat-api",
        managedBy: "compat.example.v1",
      },
    },
  ]);

  const recovery = createPlatformCanonicalResourceReadAuthority(env);
  for (const name of ["public-api", "compat-api"]) {
    const response = await recovery.fetch(
      new Request(
        `https://artifact-recovery.invalid/v1/resources/EdgeWorker/${name}?space=${space}`,
      ),
      {
        workspaceId: space,
        subject: "takosumi-cloud:artifact-recovery",
        scopes: ["admin"],
      },
    );
    expect(response.status).toBe(200);
    expect((await response.json()).metadata.name).toBe(name);
  }
  expect(
    (
      await recovery.fetch(
        new Request(
          `https://artifact-recovery.invalid/v1/resources/EdgeWorker/public-api?space=other-space`,
        ),
        {
          workspaceId: space,
          subject: "takosumi-cloud:artifact-recovery",
          scopes: ["admin"],
        },
      )
    ).status,
  ).toBe(403);
});

test("canonical Ready Resource inventory is bounded, global, and lock-coherent", async () => {
  const database = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(database);
  const stores = createD1ResourceShapeStores(database);
  const resource = (
    space: string,
    name: string,
    createdAt: string,
  ): ResourceShapeRecord => ({
    id: `tkrn:${space}:EdgeWorker:${name}`,
    spaceId: space,
    kind: "EdgeWorker",
    name,
    managedBy: "takosumi.resource-api.v1",
    spec: { source: { artifactRef: `artifact:${name}` } },
    phase: "Ready",
    generation: 2,
    observedGeneration: 2,
    createdAt: createdAt as ResourceShapeRecord["createdAt"],
    updatedAt: createdAt as ResourceShapeRecord["updatedAt"],
  });
  const lock = (record: ResourceShapeRecord): ResolutionLockRecord => ({
    resourceId: record.id,
    selectedImplementation: "cloudflare_workers",
    target: "cloudflare-main",
    locked: true,
    reason: ["operator managed EdgeWorker"],
    nativeResources: [
      {
        type: "cloudflare_workers_script",
        id: `backend-${record.spaceId}-${record.name}`,
      },
    ],
    lockedAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
  const records = [
    resource("workspace_inventory_b", "site", "2026-07-15T00:00:00.000Z"),
    resource("workspace_inventory_a", "api", "2026-07-15T00:00:00.000Z"),
  ];
  for (const record of records) {
    await stores.resources.upsert(record);
    await stores.locks.put(lock(record));
  }
  const env = {
    TAKOSUMI_CONTROL_DB: database,
    TAKOSUMI_ENVIRONMENT: "test",
    TAKOSUMI_DEV_MODE: "1",
    TAKOSUMI_DEPLOY_CONTROL_TOKEN: "resource-token",
    TAKOSUMI_RESOURCE_SHAPES: "EdgeWorker",
  } as never;
  const inventory = createPlatformCanonicalReadyResourceInventory(env);

  const first = await inventory.list({ kind: "EdgeWorker", limit: 1 });
  expect(first.items).toHaveLength(1);
  expect(first.nextCursor).toBeString();
  const second = await inventory.list({
    kind: "EdgeWorker",
    limit: 1,
    cursor: first.nextCursor,
  });
  expect(second.items).toHaveLength(1);
  expect(second.nextCursor).toBeUndefined();
  expect([...first.items, ...second.items]).toMatchObject(
    records
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.id.localeCompare(right.id),
      )
      .map((record) => ({
        resourceId: record.id,
        resourceGeneration: 2,
        resource: {
          kind: "EdgeWorker",
          metadata: { space: record.spaceId, name: record.name },
          status: { phase: "Ready", observedGeneration: 2 },
        },
        nativeResources: lock(record).nativeResources,
      })),
  );

  const incoherent = resource(
    "workspace_inventory_c",
    "missing-lock",
    "2026-07-15T00:00:01.000Z",
  );
  await stores.resources.upsert(incoherent);
  await expect(
    inventory.list({ kind: "EdgeWorker", limit: 100 }),
  ).rejects.toThrow(
    `canonical Ready Resource inventory conflict for ${incoherent.id}`,
  );
});

test("canonical Ready inventory fails closed when ResolutionLock changes during projection", async () => {
  const stores = createInMemoryResourceShapeStores();
  const record: ResourceShapeRecord = {
    id: "tkrn:workspace_lock_race:EdgeWorker:api",
    spaceId: "workspace_lock_race",
    kind: "EdgeWorker",
    name: "api",
    managedBy: "takosumi.resource-api.v1",
    spec: {},
    phase: "Ready",
    generation: 1,
    observedGeneration: 1,
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
  };
  const stableLock: ResolutionLockRecord = {
    resourceId: record.id,
    selectedImplementation: "cloudflare_workers",
    target: "cloudflare-main",
    locked: true,
    reason: ["initial"],
    nativeResources: [
      { type: "cloudflare_workers_script", id: "backend-initial" },
    ],
    lockedAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
  await stores.resources.upsert(record);
  await stores.locks.put(stableLock);
  const originalLocks = stores.locks;
  let reads = 0;
  const racingStores: ResourceShapeStores = {
    ...stores,
    locks: {
      put: (lock) => originalLocks.put(lock),
      async get(resourceId) {
        const lock = await originalLocks.get(resourceId);
        reads += 1;
        return reads === 3 && lock
          ? {
              ...lock,
              updatedAt: "2026-07-15T00:00:01.000Z",
              nativeResources: [
                {
                  type: "cloudflare_workers_script",
                  id: "backend-raced",
                },
              ],
            }
          : lock;
      },
      delete: (resourceId) => originalLocks.delete(resourceId),
    },
  };
  const { operations } = await createTakosumiService({
    role: "takosumi-api",
    runtimeEnv: { TAKOSUMI_ENVIRONMENT: "test", TAKOSUMI_DEV_MODE: "1" },
    resourceShapeStores: racingStores,
    resourceShapeAdapter: new StubResourceShapeAdapter(),
  });
  await expect(
    operations.resourceCompatibility?.listReadyResourcesPage({
      kind: "EdgeWorker",
      limit: 1,
    }),
  ).rejects.toThrow(
    `canonical Ready Resource inventory conflict for ${record.id}`,
  );
  expect(reads).toBe(3);
});

test("a configured platform extension rejects an unverified bearer", async () => {
  const worker = (await import("../../../deploy/platform/worker.ts")).default;
  const forwarded: { url: string; authorization: string | null }[] = [];
  const response = await worker.fetch(
    new Request("https://app.takosumi.com/gateway/ai/v1/models", {
      headers: { authorization: "Bearer runtime-token" },
    }),
    {
      TAKOSUMI_PLATFORM_EXTENSIONS: JSON.stringify([
        { basePath: "/gateway/ai/v1", handlerKey: "TEST_AI_EXTENSION" },
      ]),
      TEST_AI_EXTENSION: {
        fetch: async (request: Request) => {
          forwarded.push({
            url: request.url,
            authorization: request.headers.get("authorization"),
          });
          return Response.json({ object: "list", data: [] });
        },
      },
    } as never,
  );
  expect(response.status).toBe(401);
  expect(forwarded).toEqual([]);
});

test("a configured platform extension 404s when its handler is absent", async () => {
  const worker = (await import("../../../deploy/platform/worker.ts")).default;
  const response = await worker.fetch(
    new Request("https://app.takosumi.com/gateway/ai/v1/models"),
    {
      TAKOSUMI_PLATFORM_EXTENSIONS: JSON.stringify([
        { basePath: "/gateway/ai/v1", handlerKey: "TEST_AI_EXTENSION" },
      ]),
    } as never,
  );
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: "not found" });
});

test("handler-auth platform extensions preserve signed protocol auth and strip spoofed context", async () => {
  const forwarded: {
    readonly authorization: string | null;
    readonly cookie: string | null;
    readonly rawCloudflareKey: string | null;
    readonly spoofedSpace: string | null;
    readonly billingSpace: string | null;
  }[] = [];
  const response = await handlePlatformExtensionRouteRequest(
    new Request("https://app.takosumi.com/compat/s3/v1/assets/object.txt", {
      method: "PUT",
      headers: {
        authorization:
          "AWS4-HMAC-SHA256 Credential=AKID/20260629/auto/s3/aws4_request, SignedHeaders=host;x-amz-date, Signature=abc",
        cookie: "takosumi_session=sess_cookie",
        "x-auth-key": "raw-cloudflare-key",
        "x-takosumi-platform-workspace-id": "space_attacker",
      },
      body: "hello",
    }),
    {
      TEST_STORAGE_EXTENSION: {
        fetchCompatibility: async (request: Request) => {
          forwarded.push({
            authorization: request.headers.get("authorization"),
            cookie: request.headers.get("cookie"),
            rawCloudflareKey: request.headers.get("x-auth-key"),
            spoofedSpace: request.headers.get(
              "x-takosumi-platform-workspace-id",
            ),
            billingSpace: request.headers.get(
              "x-takosumi-platform-workspace-id",
            ),
          });
          return Response.json({ ok: true });
        },
      },
    } as never,
    {
      basePath: "/compat/s3/v1",
      handlerKey: "TEST_STORAGE_EXTENSION",
      authMode: "handler",
      compatibilityProfiles: [{ profile: "compat.s3.v1", planes: ["data"] }],
    },
    async () => {
      throw new Error("handler-auth routes must not use platform session auth");
    },
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
  expect(forwarded).toEqual([
    {
      authorization:
        "AWS4-HMAC-SHA256 Credential=AKID/20260629/auto/s3/aws4_request, SignedHeaders=host;x-amz-date, Signature=abc",
      cookie: null,
      rawCloudflareKey: null,
      spoofedSpace: null,
      billingSpace: null,
    },
  ]);
});

test("platform extension route injects verified session context and strips raw credentials", async () => {
  const forwarded: {
    authorization: string | null;
    cookie: string | null;
    authenticated: string | null;
    subject: string | null;
    workspaceId: string | null;
    billingWorkspaceId: string | null;
  }[] = [];
  const response = await handlePlatformExtensionRouteRequest(
    new Request("https://app.takosumi.com/gateway/ai/v1/models", {
      headers: {
        authorization: "Bearer raw-token",
        cookie: "takosumi_session=sess_cookie",
        "x-takosumi-platform-authenticated": "1",
      },
    }),
    {
      TEST_AI_EXTENSION: {
        fetch: async (request: Request) => {
          forwarded.push({
            authorization: request.headers.get("authorization"),
            cookie: request.headers.get("cookie"),
            authenticated: request.headers.get(
              "x-takosumi-platform-authenticated",
            ),
            subject: request.headers.get("x-takosumi-platform-subject"),
            workspaceId: request.headers.get(
              "x-takosumi-platform-workspace-id",
            ),
            billingWorkspaceId: request.headers.get(
              "x-takosumi-platform-workspace-id",
            ),
          });
          return Response.json({ object: "list", data: [] });
        },
      },
    } as never,
    { basePath: "/gateway/ai/v1", handlerKey: "TEST_AI_EXTENSION" },
    async () => ({
      authenticated: true,
      authKind: "session",
      subject: "tsub_cloud",
      workspaceId: "space_cloud",
    }),
  );
  expect(response.status).toBe(200);
  expect(forwarded).toEqual([
    {
      authorization: null,
      cookie: null,
      authenticated: "1",
      subject: "tsub_cloud",
      workspaceId: "space_cloud",
      billingWorkspaceId: "space_cloud",
    },
  ]);
});

test("platform extension route replaces spoofed Workspace context", async () => {
  let forwarded = false;
  const response = await handlePlatformExtensionRouteRequest(
    new Request("https://app.takosumi.com/gateway/ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "x-takosumi-platform-workspace-id": "space_attacker",
      },
    }),
    {
      TEST_AI_EXTENSION: {
        fetch: async () => {
          forwarded = true;
          return Response.json({ ok: true });
        },
      },
    } as never,
    { basePath: "/gateway/ai/v1", handlerKey: "TEST_AI_EXTENSION" },
    async () => ({
      authenticated: true,
      authKind: "session",
      subject: "tsub_cloud",
      workspaceId: "space_cloud",
    }),
  );

  expect(response.status).toBe(200);
  expect(forwarded).toBe(true);
});

test("platform workspace verification lets personal access tokens select an accessible Workspace", async () => {
  const checked: string[] = [];
  const verified = await platformExtensionVerifiedWorkspaceSession(
    new Request("https://operator.example.test/compat/example/v1", {
      headers: {
        authorization: "Bearer takpat_cloud",
        "x-takosumi-platform-workspace-id": "space_cloud",
      },
    }),
    {} as never,
    {
      authenticated: true,
      authKind: "personal-access-token",
      subject: "tsub_cloud",
      scopes: ["admin"],
    },
    "space_cloud",
    async (_request, _env, workspaceId) => {
      checked.push(workspaceId);
      return workspaceId === "space_cloud";
    },
  );

  expect(verified.ok).toBe(true);
  if (!verified.ok) throw new Error("expected verified workspace context");
  expect(checked).toEqual(["space_cloud"]);
  expect(verified.session).toEqual({
    authenticated: true,
    authKind: "personal-access-token",
    subject: "tsub_cloud",
    scopes: ["admin"],
    workspaceId: "space_cloud",
  });
});

test("platform workspace verification keeps service tokens bound to token metadata", async () => {
  let checked = false;
  const verified = await platformExtensionVerifiedWorkspaceSession(
    new Request("https://operator.example.test/compat/example/v1", {
      headers: {
        authorization: "Bearer taksrv_cloud",
        "x-takosumi-platform-workspace-id": "space_cloud",
      },
    }),
    {} as never,
    {
      authenticated: true,
      authKind: "service-token",
      subject: "svc",
      scopes: ["admin"],
    },
    "space_cloud",
    async () => {
      checked = true;
      return true;
    },
  );

  expect(verified.ok).toBe(false);
  if (verified.ok) throw new Error("expected workspace context rejection");
  expect(checked).toBe(false);
  expect(verified.response.status).toBe(403);
  expect(await verified.response.json()).toEqual({
    error: "access_denied",
    error_description: "workspace context is not authorized",
  });
});

test("platform extension authenticates managed provider run tokens with Workspace context", async () => {
  const issued = await createManagedProviderRunToken({
    secret: "managed-secret",
    audience: "compat.example.v1",
    workspaceId: "space_cc8dbfedfc6347d5",
    capsuleId: "capsule_ca4ebb681fb24044",
    connectionId: "conn_operator_managed_example",
    provider: "registry.example/operator/provider",
    phase: "apply",
    scopes: ["write"],
  });
  expect(issued.token).toMatch(/^takmpt_v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

  const session = await verifyPlatformExtensionSession(
    new Request(
      "https://operator.example.test/compat/example/v1/resources/widgets",
      {
        method: "POST",
        headers: { authorization: `Bearer ${issued.token}` },
      },
    ),
    { TAKOSUMI_MANAGED_PROVIDER_TOKEN_SECRET: "managed-secret" } as never,
    {
      basePath: "/compat/example/v1",
      handlerKey: "TEST_PROVIDER_COMPAT_EXTENSION",
      requiredScopes: ["write"],
      managedProviderProfile: "compat.example.v1",
      compatibilityProfiles: [
        {
          profile: "compat.example.v1",
          planes: ["control"],
        },
      ],
    },
  );

  expect(session).toEqual({
    authenticated: true,
    authKind: "service-token",
    subject: "provider-connection:conn_operator_managed_example",
    workspaceId: "space_cc8dbfedfc6347d5",
    capsuleId: "capsule_ca4ebb681fb24044",
    scopes: ["write"],
  });
});

test("platform extension rejects managed provider run tokens for another explicit profile", async () => {
  const issued = await createManagedProviderRunToken({
    secret: "managed-secret",
    audience: "compat.example.v1",
    workspaceId: "space_cc8dbfedfc6347d5",
    connectionId: "conn_managed",
    provider: "registry.example/operator/provider",
    phase: "apply",
    scopes: ["write"],
  });

  const session = await verifyPlatformExtensionSession(
    new Request("https://app.takosumi.com/gateway/ai/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${issued.token}` },
    }),
    { TAKOSUMI_MANAGED_PROVIDER_TOKEN_SECRET: "managed-secret" } as never,
    {
      basePath: "/gateway/ai/v1",
      handlerKey: "TEST_AI_EXTENSION",
      requiredScopes: ["write"],
      managedProviderProfile: "gateway.ai.v1",
    },
  );

  expect(session).toEqual({ authenticated: false });
});

test("platform extension without an explicit profile rejects managed provider run tokens", async () => {
  const issued = await createManagedProviderRunToken({
    secret: "managed-secret",
    audience: "operator.example.provider.v1",
    workspaceId: "space_cc8dbfedfc6347d5",
    connectionId: "conn_managed",
    provider: "registry.example/operator/provider",
    phase: "apply",
    scopes: ["write"],
  });

  const session = await verifyPlatformExtensionSession(
    new Request("https://provider.example.test/api/resources", {
      headers: { authorization: `Bearer ${issued.token}` },
    }),
    { TAKOSUMI_MANAGED_PROVIDER_TOKEN_SECRET: "managed-secret" } as never,
    {
      basePath: "/api",
      handlerKey: "TEST_PROVIDER_EXTENSION",
      requiredScopes: ["write"],
    },
  );

  expect(session).toEqual({ authenticated: false });
});

test("platform extension billing context reads the canonical Capsule", async () => {
  const seenPaths: string[] = [];
  const allowed = await platformExtensionSessionCanAccessCapsule(
    new Request("https://operator.example.test/compat/example/v1", {
      headers: {
        authorization: "Bearer session-token",
      },
    }),
    {} as never,
    "inst_projection",
    "space_cloud",
    async (request) => {
      seenPaths.push(new URL(request.url).pathname);
      return Response.json({
        capsule: {
          id: "inst_projection",
          workspaceId: "space_cloud",
        },
      });
    },
  );

  expect(allowed).toBe(true);
  expect(seenPaths).toEqual(["/api/v1/capsules/inst_projection"]);
});

test("platform extension requiredScopes gate token auth", async () => {
  const binding = {
    TEST_AI_EXTENSION: { fetch: async () => Response.json({ ok: true }) },
  } as never;
  const route = {
    basePath: "/gateway/ai/v1",
    handlerKey: "TEST_AI_EXTENSION",
    requiredScopes: ["ai.chat"],
  };

  const denied = await handlePlatformExtensionRouteRequest(
    new Request("https://app.takosumi.com/gateway/ai/v1/chat/completions", {
      method: "POST",
    }),
    binding,
    route,
    async () => ({
      authenticated: true,
      authKind: "personal-access-token",
      subject: "tsub",
      scopes: ["ai.models.read"],
    }),
  );
  expect(denied.status).toBe(401);

  const allowed = await handlePlatformExtensionRouteRequest(
    new Request("https://app.takosumi.com/gateway/ai/v1/chat/completions", {
      method: "POST",
    }),
    binding,
    route,
    async () => ({
      authenticated: true,
      authKind: "personal-access-token",
      subject: "tsub",
      scopes: ["ai.chat"],
    }),
  );
  expect(allowed.status).toBe(200);

  // A full human session is allowed through regardless of descriptor scopes;
  // the Cloud handler performs any finer authorization.
  const session = await handlePlatformExtensionRouteRequest(
    new Request("https://app.takosumi.com/gateway/ai/v1/chat/completions", {
      method: "POST",
    }),
    binding,
    route,
    async () => ({
      authenticated: true,
      authKind: "session",
      subject: "tsub",
    }),
  );
  expect(session.status).toBe(200);
});

test("platform extension derives personal access identity from introspection claims, not token prefixes", async () => {
  const introspectionRequests: { url: string; body: string }[] = [];
  const context = await verifyPlatformExtensionBearerToken(
    new Request("https://app.takosumi.com/gateway/ai/v1/models", {
      headers: { authorization: "Bearer opaque-personal-credential" },
    }),
    {
      TAKOSUMI_ACCOUNTS_CLIENT_ID: "takosumi-cloud-extensions",
      TAKOSUMI_ACCOUNTS_CLIENT_SECRET: "client-secret",
    } as never,
    "opaque-personal-credential",
    { basePath: "/gateway/ai/v1", handlerKey: "TEST_AI_EXTENSION" },
    async (request: Request) => {
      introspectionRequests.push({
        url: request.url,
        body: await request.text(),
      });
      return Response.json({
        active: true,
        token_use: "personal_access",
        scope: "ai.chat ai.models.read",
        sub: "tsub_pat_user",
        takosumi: { workspace_id: "space_pat_default" },
      });
    },
  );
  expect(context).toEqual({
    authenticated: true,
    authKind: "personal-access-token",
    subject: "tsub_pat_user",
    workspaceId: "space_pat_default",
    scopes: ["ai.chat", "ai.models.read"],
  });
  expect(introspectionRequests[0]?.url).toBe(
    "https://app.takosumi.com/oauth/introspect",
  );
  expect(introspectionRequests[0]?.body).toContain(
    "token=opaque-personal-credential",
  );
  expect(introspectionRequests[0]?.body).toContain(
    "resource=https%3A%2F%2Fapp.takosumi.com%2Fgateway%2Fai%2Fv1",
  );
});

test("platform extension authenticates delegated OAuth access claims without prefix routing", async () => {
  const context = await verifyPlatformExtensionBearerToken(
    new Request(
      "https://app.takosumi.com/v1/interfaces?workspaceId=space_oauth",
      {
        headers: { authorization: "Bearer opaque-delegated-credential" },
      },
    ),
    {
      TAKOSUMI_ACCOUNTS_CLIENT_ID: "takosumi-cloud-extensions",
      TAKOSUMI_ACCOUNTS_CLIENT_SECRET: "client-secret",
    } as never,
    "opaque-delegated-credential",
    undefined,
    async () =>
      Response.json({
        active: true,
        token_use: "oauth_access",
        scope: "openid capsules:read",
        sub: "tsub_runtime",
        takosumi: { workspace_id: "space_oauth" },
      }),
  );

  expect(context).toEqual({
    authenticated: true,
    authKind: "oauth-access-token",
    subject: "tsub_runtime",
    workspaceId: "space_oauth",
    scopes: ["openid", "capsules:read"],
  });
});

test("platform Interface API enforces delegated OAuth Capsule scopes", async () => {
  const env = {
    TAKOSUMI_CONTROL_DB: new SqliteFakeD1(),
    TAKOSUMI_ENVIRONMENT: "test",
    TAKOSUMI_DEV_MODE: "1",
    TAKOSUMI_DEPLOY_CONTROL_TOKEN: "resource-token",
  } as never;
  const request = () =>
    new Request(
      "https://app.takosumi.com/v1/interfaces?workspaceId=space_oauth&permission=mcp.invoke",
      { headers: { authorization: "Bearer takat_runtime" } },
    );

  const denied = await handlePlatformResourceShapeApiRequest(
    request(),
    env,
    async () => ({
      authenticated: true,
      authKind: "oauth-access-token",
      subject: "tsub_runtime",
      workspaceId: "space_oauth",
      scopes: ["openid", "profile"],
    }),
  );
  expect(denied.status).toBe(403);
  expect((await denied.json()).error).toBe("insufficient_scope");

  const allowed = await handlePlatformResourceShapeApiRequest(
    request(),
    env,
    async () => ({
      authenticated: true,
      authKind: "oauth-access-token",
      subject: "tsub_runtime",
      workspaceId: "space_oauth",
      scopes: ["openid", "capsules:read"],
    }),
  );
  expect(allowed.status).toBe(200);
  expect(await allowed.json()).toEqual({ interfaces: [] });

  const mutationDenied = await handlePlatformResourceShapeApiRequest(
    new Request("https://app.takosumi.com/v1/interfaces", {
      method: "POST",
      headers: {
        authorization: "Bearer takat_runtime",
        "content-type": "application/json",
      },
      body: "{}",
    }),
    env,
    async () => ({
      authenticated: true,
      authKind: "oauth-access-token",
      subject: "tsub_runtime",
      workspaceId: "space_oauth",
      scopes: ["openid", "capsules:write"],
    }),
  );
  expect(mutationDenied.status).toBe(403);
  expect((await mutationDenied.json()).error).toBe("insufficient_scope");

  const tokenIssueReachedRuntimeBoundary =
    await handlePlatformResourceShapeApiRequest(
      new Request("https://app.takosumi.com/v1/interfaces/if_missing/token", {
        method: "POST",
        headers: {
          authorization: "Bearer takat_runtime",
          "content-type": "application/json",
        },
        body: JSON.stringify({ permission: "mcp.invoke" }),
      }),
      env,
      async () => ({
        authenticated: true,
        authKind: "oauth-access-token",
        subject: "tsub_runtime",
        workspaceId: "space_oauth",
        scopes: ["openid", "capsules:read"],
      }),
    );
  // Token issuance is an invocation read, not a control mutation. The 404 is
  // Core's non-enumerating missing-Interface response, proving ingress did not
  // reject the POST as a write.
  expect(tokenIssueReachedRuntimeBoundary.status).toBe(404);
});

test("platform Interface ingress rejects oversized control bodies before JSON parsing", async () => {
  const env = {
    TAKOSUMI_CONTROL_DB: new SqliteFakeD1(),
    TAKOSUMI_ENVIRONMENT: "test",
    TAKOSUMI_DEV_MODE: "1",
    TAKOSUMI_DEPLOY_CONTROL_TOKEN: "resource-token",
  } as never;
  const response = await handlePlatformResourceShapeApiRequest(
    new Request("https://app.takosumi.com/v1/interfaces", {
      method: "POST",
      headers: {
        cookie: "takosumi_session=test",
        "content-type": "application/json",
      },
      body: `{"padding":"${"x".repeat(1_048_576)}"}`,
    }),
    env,
    async () => ({
      authenticated: true,
      authKind: "session",
      subject: "account_operator",
      workspaceId: "space_oauth",
    }),
  );
  expect(response.status).toBe(413);
  expect((await response.json()).error).toBe("request_too_large");
});

test("platform Interface API binds delegated OAuth requests to their Workspace", async () => {
  const db = new SqliteFakeD1();
  const env = {
    TAKOSUMI_CONTROL_DB: db,
    TAKOSUMI_ENVIRONMENT: "test",
    TAKOSUMI_DEV_MODE: "1",
    TAKOSUMI_DEPLOY_CONTROL_TOKEN: "resource-token",
  } as never;
  const controlSession = async () => ({
    authenticated: true as const,
    authKind: "personal-access-token" as const,
    subject: "account_a",
    workspaceId: "workspace_a",
    scopes: ["read", "write"],
  });
  const runtimeSession = async () => ({
    authenticated: true as const,
    authKind: "oauth-access-token" as const,
    subject: "principal_a",
    workspaceId: "workspace_a",
    scopes: ["openid", "capsules:read"],
  });
  const bodyFor = (workspaceId: string) => ({
    workspaceId,
    name: "external-mcp",
    ownerRef: { kind: "Workspace", id: workspaceId },
    spec: {
      type: "mcp.server",
      version: "2025-11-25",
      document: { transport: "streamable-http" },
      inputs: {
        endpoint: { source: "literal", value: "https://mcp.example.test" },
      },
      access: { visibility: "workspace" },
    },
  });

  const crossCreate = await handlePlatformResourceShapeApiRequest(
    new Request("https://app.takosumi.com/v1/interfaces", {
      method: "POST",
      headers: {
        authorization: "Bearer takat_runtime",
        "content-type": "application/json",
      },
      body: JSON.stringify(bodyFor("workspace_b")),
    }),
    env,
    controlSession,
  );
  expect(crossCreate.status).toBe(403);
  expect(await crossCreate.json()).toMatchObject({
    error: "access_denied",
    error_description: "workspace context is not authorized",
  });

  await new CloudflareD1OpenTofuControlStore(db).putWorkspace({
    id: "workspace_b",
    handle: "workspace-b",
    displayName: "Workspace B",
    type: "personal",
    ownerUserId: "owner_b",
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
  });

  const seeded = await handlePlatformResourceShapeApiRequest(
    new Request("https://app.takosumi.com/v1/interfaces", {
      method: "POST",
      headers: {
        authorization: "Bearer resource-token",
        "content-type": "application/json",
      },
      body: JSON.stringify(bodyFor("workspace_b")),
    }),
    env,
  );
  expect(seeded.status).toBe(201);
  const seededId = (await seeded.json()).metadata.id as string;

  const crossRead = await handlePlatformResourceShapeApiRequest(
    new Request(
      `https://app.takosumi.com/v1/interfaces/${seededId}?permission=mcp.invoke`,
      {
        headers: { authorization: "Bearer takat_runtime" },
      },
    ),
    env,
    runtimeSession,
  );
  // No matching Binding exists, so runtime reads stay non-enumerable even
  // before the cross-Workspace distinction could be disclosed.
  expect(crossRead.status).toBe(404);
});

test("platform Interface ingress separates control and runtime credentials", async () => {
  const env = {
    TAKOSUMI_CONTROL_DB: new SqliteFakeD1(),
    TAKOSUMI_ENVIRONMENT: "test",
    TAKOSUMI_DEV_MODE: "1",
    TAKOSUMI_DEPLOY_CONTROL_TOKEN: "resource-token",
  } as never;
  const url =
    "https://app.takosumi.com/v1/interfaces?workspaceId=workspace_auth";
  const readOnlyPatSession = async () => ({
    authenticated: true as const,
    authKind: "personal-access-token" as const,
    subject: "account_a",
    workspaceId: "workspace_auth",
    scopes: ["read"],
  });

  for (const mutation of [
    { method: "POST", path: "/v1/interfaces", body: "{}" },
    { method: "PATCH", path: "/v1/interfaces/if_auth", body: "{}" },
    { method: "DELETE", path: "/v1/interfaces/if_auth" },
    {
      method: "POST",
      path: "/v1/interfaces/if_auth/bindings",
      body: "{}",
    },
    {
      method: "DELETE",
      path: "/v1/interfaces/if_auth/bindings/binding_auth",
    },
  ]) {
    const readOnlyPatWrite = await handlePlatformResourceShapeApiRequest(
      new Request(`https://app.takosumi.com${mutation.path}`, {
        method: mutation.method,
        headers: {
          authorization: "Bearer takpat_read",
          ...(mutation.body ? { "content-type": "application/json" } : {}),
        },
        ...(mutation.body ? { body: mutation.body } : {}),
      }),
      env,
      readOnlyPatSession,
    );
    expect(readOnlyPatWrite.status, `${mutation.method} ${mutation.path}`).toBe(
      403,
    );
    expect((await readOnlyPatWrite.json()).error).toBe("insufficient_scope");
  }

  const readOnlyPatRead = await handlePlatformResourceShapeApiRequest(
    new Request(url, {
      headers: { authorization: "Bearer takpat_read" },
    }),
    env,
    readOnlyPatSession,
  );
  expect(readOnlyPatRead.status).toBe(200);
  expect(await readOnlyPatRead.json()).toEqual({ interfaces: [] });

  for (const method of ["GET", "POST"]) {
    const serviceToken = await handlePlatformResourceShapeApiRequest(
      new Request(url, {
        method,
        headers: {
          authorization: "Bearer taksrv_runtime",
          ...(method === "POST" ? { "content-type": "application/json" } : {}),
        },
        ...(method === "POST" ? { body: "{}" } : {}),
      }),
      env,
      async () => ({
        authenticated: true,
        authKind: "service-token",
        subject: "capsule_runtime",
        workspaceId: "workspace_auth",
        scopes: ["admin"],
      }),
    );
    expect(serviceToken.status).toBe(403);
    expect((await serviceToken.json()).error).toBe("access_denied");
  }
});

test("platform Interface ingress rejects signed managed-provider run tokens", async () => {
  const issued = await createManagedProviderRunToken({
    secret: "managed-secret",
    audience: "operator.example.provider.v1",
    workspaceId: "space_0123456789abcdef",
    connectionId: "conn_managed",
    provider: "cloudflare",
    phase: "apply",
    scopes: ["admin", "write"],
  });
  const response = await handlePlatformResourceShapeApiRequest(
    new Request("https://app.takosumi.com/v1/interfaces", {
      method: "POST",
      headers: {
        authorization: `Bearer ${issued.token}`,
        "content-type": "application/json",
      },
      body: "{}",
    }),
    {
      TAKOSUMI_CONTROL_DB: new SqliteFakeD1(),
      TAKOSUMI_ENVIRONMENT: "test",
      TAKOSUMI_DEV_MODE: "1",
      TAKOSUMI_DEPLOY_CONTROL_TOKEN: "resource-token",
      TAKOSUMI_MANAGED_PROVIDER_TOKEN_SECRET: "managed-secret",
    } as never,
  );

  expect(response.status).toBe(401);
  expect((await response.json()).error).toBe("unauthenticated");
});

test("platform extension accepts exact-audience Interface OAuth evidence as an account principal", async () => {
  const env = {
    TAKOSUMI_ACCOUNTS_CLIENT_ID: "takosumi-cloud-extensions",
    TAKOSUMI_ACCOUNTS_CLIENT_SECRET: "client-secret",
  } as never;
  const route = {
    basePath: "/gateway/ai/v1",
    handlerKey: "TEST_AI_EXTENSION",
    requiredScopes: ["ai.chat"],
  };
  const introspect =
    (scope: string, audience = "https://app.takosumi.com/gateway/ai/v1") =>
    async () =>
      Response.json({
        active: true,
        token_use: "interface_oauth",
        aud: audience,
        scope,
        sub: "principal_a",
        takosumi: {
          workspace_id: "workspace_a",
          capsule_id: "capsule_a",
          interface_id: "interface_ai",
          interface_binding_id: "binding_ai",
          interface_resolved_revision: 4,
        },
      });

  const denied = await verifyPlatformExtensionBearerToken(
    new Request("https://app.takosumi.com/gateway/ai/v1/chat/completions", {
      method: "POST",
    }),
    env,
    "opaque-interface-credential",
    route,
    introspect("ai.models.read"),
  );
  expect(denied).toEqual({ authenticated: false });

  const allowed = await verifyPlatformExtensionBearerToken(
    new Request("https://app.takosumi.com/gateway/ai/v1/chat/completions", {
      method: "POST",
    }),
    env,
    "opaque-interface-credential",
    route,
    introspect("ai.chat"),
  );
  expect(allowed.authenticated).toBe(true);
  expect(allowed).toMatchObject({
    authKind: "interface-oauth-token",
    subject: "principal_a",
    workspaceId: "workspace_a",
    capsuleId: "capsule_a",
    audience: "https://app.takosumi.com/gateway/ai/v1",
    interfaceId: "interface_ai",
    interfaceBindingId: "binding_ai",
    interfaceResolvedRevision: 4,
    scopes: ["ai.chat"],
  });

  const wrongAudience = await verifyPlatformExtensionBearerToken(
    new Request("https://app.takosumi.com/gateway/ai/v1/chat/completions"),
    env,
    "opaque-interface-credential",
    route,
    introspect("ai.chat", "https://other.example.test/ai"),
  );
  expect(wrongAudience).toEqual({ authenticated: false });

  const unknownTokenUse = await verifyPlatformExtensionBearerToken(
    new Request("https://app.takosumi.com/gateway/ai/v1/chat/completions"),
    env,
    "opaque-unknown-credential",
    route,
    async () =>
      Response.json({
        active: true,
        token_use: "future_credential_kind",
        scope: "ai.chat",
        sub: "principal_a",
      }),
  );
  expect(unknownTokenUse).toEqual({ authenticated: false });
});

test("platform extension route matcher rejects near-prefixes", () => {
  const routes = platformExtensionRoutes({
    TAKOSUMI_PLATFORM_EXTENSIONS: JSON.stringify([
      { basePath: "/gateway/ai/v1", handlerKey: "TEST_AI_EXTENSION" },
    ]),
  });
  expect(matchPlatformExtensionRoute("/gateway/ai/v1", routes)).toBeDefined();
  expect(
    matchPlatformExtensionRoute("/gateway/ai/v1/models", routes),
  ).toBeDefined();
  expect(
    matchPlatformExtensionRoute("/gateway/ai/v1-other", routes),
  ).toBeUndefined();
  expect(matchPlatformExtensionRoute("/gateway/ai", routes)).toBeUndefined();
});

test("platform extension catalog reports configured extensions without binding names", async () => {
  const env = {
    TAKOSUMI_PLATFORM_EXTENSIONS: JSON.stringify([
      {
        id: "ai",
        basePath: "/gateway/ai/v1",
        handlerKey: "TEST_AI_EXTENSION",
        capabilities: ["openai.chat_completions"],
        requiredScopes: ["ai.chat"],
      },
      { basePath: "/extensions/x", handlerKey: "TEST_X_EXTENSION" },
    ]),
    TEST_AI_EXTENSION: { fetch: async () => new Response("") },
  } as never;
  const catalog = platformExtensionCatalog(env, "https://app.takosumi.com");
  expect(catalog.kind).toBe("takosumi.platform-extensions@v1");
  expect(catalog.summary).toEqual({ total: 2, configured: 1, missing: 1 });
  expect(catalog.extensions).toEqual([
    {
      id: "ai",
      basePath: "/gateway/ai/v1",
      configured: true,
      capabilities: ["openai.chat_completions"],
      requiredScopes: ["ai.chat"],
    },
    { basePath: "/extensions/x", configured: false },
  ]);
  // The catalog never leaks the underlying handler keys.
  expect(JSON.stringify(catalog)).not.toContain("TEST_AI_EXTENSION");
});

test("public contribution catalog exposes only safe links with live handlers", async () => {
  const env = {
    TAKOSUMI_PLATFORM_EXTENSIONS: JSON.stringify([
      {
        basePath: "/extensions/live",
        handlerKey: "TEST_LIVE_EXTENSION",
        contributions: [
          {
            id: "live",
            slot: "navigation.manage",
            href: "/extensions/live/ui",
            label: "Live extension",
          },
        ],
      },
      {
        basePath: "/extensions/missing",
        handlerKey: "TEST_MISSING_EXTENSION",
        contributions: [
          {
            id: "missing",
            slot: "navigation.manage",
            href: "/extensions/missing/ui",
            label: "Missing extension",
          },
        ],
      },
    ]),
    TEST_LIVE_EXTENSION: { fetch: async () => new Response("") },
  } as never;
  expect(
    isPlatformExtensionContributionsPath("/__takosumi/platform/contributions"),
  ).toBe(true);
  expect(platformExtensionContributionCatalog(env).contributions).toEqual([
    {
      id: "live",
      slot: "navigation.manage",
      href: "/extensions/live/ui",
      label: "Live extension",
    },
  ]);
  const response = handlePlatformExtensionContributionsRequest(
    new Request("https://operator.example/__takosumi/platform/contributions"),
    new URL("https://operator.example/__takosumi/platform/contributions"),
    env,
  );
  expect(response.status).toBe(200);
  const body = await response.text();
  expect(body).toContain("Live extension");
  expect(body).not.toContain("TEST_LIVE_EXTENSION");
  expect(body).not.toContain("Missing extension");
});

test("platform extension catalog accepts dashboard sessions or operator bearer", async () => {
  expect(
    isPlatformExtensionCatalogPath("/__takosumi/platform/extensions"),
  ).toBe(true);

  const noSession = await handlePlatformExtensionCatalogRequest(
    new Request("https://app.takosumi.com/__takosumi/platform/extensions"),
    new URL("https://app.takosumi.com/__takosumi/platform/extensions"),
    {} as never,
    async () => ({ authenticated: false }),
  );
  expect(noSession.status).toBe(401);

  const wrongBearer = await handlePlatformExtensionCatalogRequest(
    new Request("https://app.takosumi.com/__takosumi/platform/extensions", {
      headers: { authorization: "Bearer wrong" },
    }),
    new URL("https://app.takosumi.com/__takosumi/platform/extensions"),
    { TAKOSUMI_DEPLOY_CONTROL_TOKEN: "operator-secret" } as never,
  );
  expect(wrongBearer.status).toBe(401);

  const sessionResponse = await handlePlatformExtensionCatalogRequest(
    new Request("https://app.takosumi.com/__takosumi/platform/extensions", {
      headers: { cookie: "takosumi_session=test" },
    }),
    new URL("https://app.takosumi.com/__takosumi/platform/extensions"),
    {} as never,
    async () => ({
      authenticated: true,
      authKind: "session",
      subject: "acct_1",
    }),
  );
  expect(sessionResponse.status).toBe(200);

  const response = await handlePlatformExtensionCatalogRequest(
    new Request("https://app.takosumi.com/__takosumi/platform/extensions", {
      headers: { authorization: "Bearer operator-secret" },
    }),
    new URL("https://app.takosumi.com/__takosumi/platform/extensions"),
    { TAKOSUMI_DEPLOY_CONTROL_TOKEN: "operator-secret" } as never,
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    kind: "takosumi.platform-extensions@v1",
    extensions: [],
  });
});

test("handlePlatformExtensionRequest returns undefined for unmatched paths", async () => {
  const result = await handlePlatformExtensionRequest(
    new Request("https://app.takosumi.com/api/v1/workspaces"),
    {} as never,
  );
  expect(result).toBeUndefined();
});

test("scheduled poll continues past a failing source", async () => {
  const syncCalls: string[] = [];
  const ops: SourcePollOperations = {
    verifySourceHookSecret: () => Promise.resolve(true),
    createSourceSync: (sourceId) => {
      syncCalls.push(sourceId);
      if (sourceId === "src_a") return Promise.reject(new Error("nope"));
      return Promise.resolve({ run: { id: "ssr" } });
    },
    controller: {
      listAutoSyncSources: () =>
        Promise.resolve([{ id: "src_a" }, { id: "src_b" }]),
    },
  };
  await pollAutoSyncSources(ops, 50);
  expect(syncCalls).toEqual(["src_a", "src_b"]);
});
