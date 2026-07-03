import { expect, test } from "bun:test";
import { SqliteFakeD1 } from "../../helpers/deploy-control/sqlite_fake_d1.ts";

import { TAKOSUMI_API_VERSION } from "../../../contract/capabilities.ts";
import {
  TAKOSUMI_PRODUCT_CAPABILITIES_PATH,
  TAKOSUMI_WELL_KNOWN_PATH,
} from "../../../contract/api-surface.ts";
import { InMemoryRuntimeAgentRegistry } from "../../../core/agents/registry.ts";
import { OpenTofuControllerError } from "../../../core/domains/deploy-control/mod.ts";
import {
  driftCheckEnabled,
  evaluateProductionHardeningGates,
  handleOperatorBillingRequest,
  handlePlatformCloudExtensionRequest,
  handlePlatformCloudExtensionCatalogRequest,
  handlePlatformCloudExtensionRouteRequest,
  handlePlatformCloudUsageRecordRequest,
  handlePlatformMetricsDashboardRequest,
  handlePlatformMetricsRequest,
  handlePlatformResourceShapeApiRequest,
  handlePlatformRuntimeCellDrillRequest,
  handleSourceWebhookRequest,
  isOperatorBillingPath,
  isOidcMetricPath,
  isPlatformCloudUsageRecordPath,
  isPlatformCloudExtensionCatalogPath,
  isPlatformResourceShapeApiPath,
  matchPlatformCloudExtensionRoute,
  platformCloudExtensionCatalog,
  platformCloudExtensionRoutes,
  platformCloudExtensionSessionCanAccessCapsuleProjection,
  platformResourceShapeApiEnabled,
  isPlatformMetricsDashboardPath,
  isPlatformMetricsPath,
  oidcMetricRoute,
  autoPlanStaleCapsulesEnabled,
  pollAutoSyncSources,
  planStaleCapsuleUpdates,
  repairStaleOpenTofuRuns,
  summarizePrometheusMetrics,
  verifyPlatformCloudExtensionPersonalAccessToken,
  verifyPlatformCloudExtensionServiceAccessToken,
  withPlatformAssetCacheHeaders,
  type OperatorBillingOperations,
  type SourcePollOperations,
  type SourceWebhookOperations,
} from "../../../deploy/platform/worker.ts";

const TEST_CLOUD_USAGE_PRICE_BOOK = JSON.stringify({
  minimumGrossMarginBps: 3_000,
  meters: [
    {
      meterIdPrefix: "ai:",
      kind: "ai_request",
      unit: "request",
      chargeUsdMicrosPerUnit: 1_000,
      estimatedCostUsdMicrosPerUnit: 0,
      minimumChargeUsdMicros: 1_000,
    },
    {
      meterIdPrefix: "ai:",
      kind: "ai_input_token",
      unit: "token",
      chargeUsdMicrosPerMillionUnits: 300_000,
      estimatedCostUsdMicrosPerMillionUnits: 150_000,
      minimumChargeUsdMicros: 2,
    },
    {
      meterIdPrefix: "cloudflare:workers_script:",
      kind: "gateway_compute",
      unit: "operation",
      chargeUsdMicrosPerUnit: 1_000,
      estimatedCostUsdMicrosPerUnit: 100,
      minimumChargeUsdMicros: 1_000,
    },
    {
      meterIdPrefix: "cloudflare:kv:",
      kind: "gateway_compute",
      unit: "operation",
      chargeUsdMicrosPerUnit: 500,
      estimatedCostUsdMicrosPerUnit: 100,
      minimumChargeUsdMicros: 500,
    },
    {
      meterIdPrefix: "cloudflare:kv:",
      kind: "gateway_storage_gb_hour",
      unit: "gb_hour",
      chargeUsdMicrosPerMillionUnits: 100_000,
      estimatedCostUsdMicrosPerMillionUnits: 50_000,
      minimumChargeUsdMicros: 2,
    },
    {
      meterIdPrefix: "cloudflare:r2:",
      kind: "gateway_compute",
      unit: "operation",
      chargeUsdMicrosPerUnit: 500,
      estimatedCostUsdMicrosPerUnit: 100,
      minimumChargeUsdMicros: 500,
    },
    {
      meterIdPrefix: "cloudflare:r2:",
      kind: "gateway_storage_gb_hour",
      unit: "gb_hour",
      chargeUsdMicrosPerMillionUnits: 100_000,
      estimatedCostUsdMicrosPerMillionUnits: 50_000,
      minimumChargeUsdMicros: 2,
    },
    {
      meterIdPrefix: "cloudflare:d1:",
      kind: "gateway_compute",
      unit: "operation",
      chargeUsdMicrosPerUnit: 500,
      estimatedCostUsdMicrosPerUnit: 100,
      minimumChargeUsdMicros: 500,
    },
    {
      meterIdPrefix: "cloudflare:workflows:",
      kind: "gateway_compute",
      unit: "operation",
      chargeUsdMicrosPerUnit: 1_000,
      estimatedCostUsdMicrosPerUnit: 100,
      minimumChargeUsdMicros: 1_000,
    },
    {
      meterIdPrefix: "cloudflare:containers:",
      kind: "gateway_compute",
      unit: "vcpu_second",
      chargeUsdMicrosPerMillionUnits: 1_000_000,
      estimatedCostUsdMicrosPerMillionUnits: 500_000,
      minimumChargeUsdMicros: 2,
    },
    {
      meterIdPrefix: "cloudflare:durable_objects:",
      kind: "gateway_compute",
      unit: "operation",
      chargeUsdMicrosPerUnit: 500,
      estimatedCostUsdMicrosPerUnit: 100,
      minimumChargeUsdMicros: 500,
    },
    {
      meterIdPrefix: "cloudflare:queues:",
      kind: "gateway_compute",
      unit: "operation",
      chargeUsdMicrosPerUnit: 500,
      estimatedCostUsdMicrosPerUnit: 100,
      minimumChargeUsdMicros: 500,
    },
  ],
});

function runRecord(overrides: Record<string, unknown>): never {
  return {
    id: "run_1",
    workspaceId: "space_a",
    spaceId: "space_a",
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
      spaces: {
        listWorkspaces: () =>
          Promise.resolve([
            { id: "space_a" },
            { id: "space_archived", archivedAt: "2026-07-01T00:00:00.000Z" },
          ]),
      },
      installations: {
        listCapsules: (workspaceId) =>
          Promise.resolve(
            workspaceId === "space_a"
              ? [
                  {
                    id: "inst_needs_plan",
                    workspaceId,
                    spaceId: workspaceId,
                    name: "needs-plan",
                    slug: "needs-plan",
                    installType: "opentofu_module",
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
                    spaceId: workspaceId,
                    name: "has-plan",
                    slug: "has-plan",
                    installType: "opentofu_module",
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
                    spaceId: workspaceId,
                    name: "active",
                    slug: "active",
                    installType: "opentofu_module",
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
              installationId: "inst_has_plan",
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
      spaces: {
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
              spaceId: "space_archived",
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
    { action: "apply", runId: "apply_stale_destroy", spaceId: "space_a" },
    { action: "plan", runId: "plan_stale_running", spaceId: "space_a" },
    { action: "source_sync", runId: "sync_stale", spaceId: "space_a" },
  ]);
  expect(result).toEqual({
    workspacesScanned: 1,
    runsScanned: 8,
    rescheduled: 3,
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

test("production hardening gates require platform opening evidence", () => {
  const missing = evaluateProductionHardeningGates({
    TAKOSUMI_PRODUCTION_HARDENING_GATE: "enforce",
  } as never);
  expect(missing.ok).toBe(false);
  expect(missing.enforced).toBe(true);
  expect(missing.checks.containerSmoke.reason).toBe("missing_evidence_ref");
  expect(missing.checks.platformControlPlaneSmoke.reason).toBe(
    "missing_evidence_ref",
  );
  expect(missing.checks.egressEnforcement.reason).toBe("missing_evidence_ref");
  expect(missing.checks.restoreRehearsal.reason).toBe("missing_evidence_ref");
  expect(missing.checks.providerCatalog.reason).toBe("missing_evidence_ref");
  expect(missing.checks.costAttribution.reason).toBe("missing_evidence_ref");
  expect(missing.checks.secretBoundary.reason).toBe("missing_evidence_ref");

  const invalidDigest = evaluateProductionHardeningGates({
    TAKOSUMI_CLOUDFLARE_CONTAINER_SMOKE_EVIDENCE_REF:
      "git+ssh://git@example.com/operator/proofs.git@0123456789abcdef0123456789abcdef01234567#container.md",
    TAKOSUMI_CLOUDFLARE_CONTAINER_SMOKE_EVIDENCE_DIGEST: "not-a-digest",
    TAKOSUMI_PLATFORM_CONTROL_PLANE_SMOKE_EVIDENCE_REF:
      "git+ssh://git@example.com/operator/proofs.git@0123456789abcdef0123456789abcdef01234567#platform-control-plane-smoke.md",
    TAKOSUMI_PLATFORM_CONTROL_PLANE_SMOKE_EVIDENCE_DIGEST:
      "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    TAKOSUMI_EGRESS_ENFORCEMENT_EVIDENCE_REF:
      "git+ssh://git@example.com/operator/proofs.git@0123456789abcdef0123456789abcdef01234567#egress.md",
    TAKOSUMI_EGRESS_ENFORCEMENT_EVIDENCE_DIGEST:
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    TAKOSUMI_RESTORE_REHEARSAL_EVIDENCE_REF:
      "git+ssh://git@example.com/operator/proofs.git@0123456789abcdef0123456789abcdef01234567#restore.md",
    TAKOSUMI_RESTORE_REHEARSAL_EVIDENCE_DIGEST:
      "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    TAKOSUMI_PROVIDER_REGISTRY_EVIDENCE_REF:
      "git+ssh://git@example.com/operator/proofs.git@0123456789abcdef0123456789abcdef01234567#providers.md",
    TAKOSUMI_PROVIDER_REGISTRY_EVIDENCE_DIGEST:
      "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    TAKOSUMI_COST_ATTRIBUTION_EVIDENCE_REF:
      "git+ssh://git@example.com/operator/proofs.git@0123456789abcdef0123456789abcdef01234567#cost-attribution.md",
    TAKOSUMI_COST_ATTRIBUTION_EVIDENCE_DIGEST:
      "sha256:9999999999999999999999999999999999999999999999999999999999999999",
    TAKOSUMI_SECRET_BOUNDARY_EVIDENCE_REF:
      "git+ssh://git@example.com/operator/proofs.git@0123456789abcdef0123456789abcdef01234567#secrets.md",
    TAKOSUMI_SECRET_BOUNDARY_EVIDENCE_DIGEST:
      "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
  } as never);
  expect(invalidDigest.ok).toBe(false);
  expect(invalidDigest.checks.containerSmoke.reason).toBe(
    "evidence_digest_must_be_sha256",
  );

  const mutableRef = evaluateProductionHardeningGates({
    TAKOSUMI_CLOUDFLARE_CONTAINER_SMOKE_EVIDENCE_REF:
      "git+ssh://git@example.com/operator/proofs.git#container.md",
    TAKOSUMI_CLOUDFLARE_CONTAINER_SMOKE_EVIDENCE_DIGEST:
      "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  } as never);
  expect(mutableRef.ok).toBe(false);
  expect(mutableRef.checks.containerSmoke.reason).toBe(
    "evidence_ref_must_be_commit_pinned",
  );

  const ok = evaluateProductionHardeningGates({
    TAKOSUMI_CLOUDFLARE_CONTAINER_SMOKE_EVIDENCE_REF:
      "git+ssh://git@example.com/operator/proofs.git@0123456789abcdef0123456789abcdef01234567#container.md",
    TAKOSUMI_CLOUDFLARE_CONTAINER_SMOKE_EVIDENCE_DIGEST:
      "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    TAKOSUMI_PLATFORM_CONTROL_PLANE_SMOKE_EVIDENCE_REF:
      "git+ssh://git@example.com/operator/proofs.git@0123456789abcdef0123456789abcdef01234567#platform-control-plane-smoke.md",
    TAKOSUMI_PLATFORM_CONTROL_PLANE_SMOKE_EVIDENCE_DIGEST:
      "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    TAKOSUMI_EGRESS_ENFORCEMENT_EVIDENCE_REF:
      "git+ssh://git@example.com/operator/proofs.git@0123456789abcdef0123456789abcdef01234567#egress.md",
    TAKOSUMI_EGRESS_ENFORCEMENT_EVIDENCE_DIGEST:
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    TAKOSUMI_RESTORE_REHEARSAL_EVIDENCE_REF:
      "git+ssh://git@example.com/operator/proofs.git@0123456789abcdef0123456789abcdef01234567#restore.md",
    TAKOSUMI_RESTORE_REHEARSAL_EVIDENCE_DIGEST:
      "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    TAKOSUMI_PROVIDER_REGISTRY_EVIDENCE_REF:
      "git+ssh://git@example.com/operator/proofs.git@0123456789abcdef0123456789abcdef01234567#providers.md",
    TAKOSUMI_PROVIDER_REGISTRY_EVIDENCE_DIGEST:
      "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    TAKOSUMI_COST_ATTRIBUTION_EVIDENCE_REF:
      "git+ssh://git@example.com/operator/proofs.git@0123456789abcdef0123456789abcdef01234567#cost-attribution.md",
    TAKOSUMI_COST_ATTRIBUTION_EVIDENCE_DIGEST:
      "sha256:9999999999999999999999999999999999999999999999999999999999999999",
    TAKOSUMI_SECRET_BOUNDARY_EVIDENCE_REF:
      "git+ssh://git@example.com/operator/proofs.git@0123456789abcdef0123456789abcdef01234567#secrets.md",
    TAKOSUMI_SECRET_BOUNDARY_EVIDENCE_DIGEST:
      "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
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
            'takosumi_deploy_operation_count{environment="production",runtime_cell_id="cell",space_id="space",capsule_id="cap",operationKind="apply",status="succeeded"} 1',
            'takosumi_apply_duration_seconds_bucket{environment="production",runtime_cell_id="cell",space_id="space",capsule_id="cap",operationKind="apply",status="succeeded",le="1"} 1',
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
      'takosumi_deploy_operation_count{environment="production",runtime_cell_id="cell",space_id="space",capsule_id="cap",operationKind="apply",status="succeeded"} 1',
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
      "https://app.takosumi.com/opentofu/providers/registry.opentofu.org/takosjp/takosumi/index.json",
    ),
    new URL(
      "https://app.takosumi.com/opentofu/providers/registry.opentofu.org/takosjp/takosumi/index.json",
    ),
    new Response('{"versions":{}}', {
      headers: { "cache-control": "public, max-age=0, must-revalidate" },
    }),
  );
  expect(indexResponse.headers.get("cache-control")).toBe("no-cache");

  const archiveResponse = withPlatformAssetCacheHeaders(
    new Request(
      "https://app.takosumi.com/opentofu/providers/registry.opentofu.org/takosjp/takosumi/terraform-provider-takosumi_0.1.0_linux_amd64.zip",
    ),
    new URL(
      "https://app.takosumi.com/opentofu/providers/registry.opentofu.org/takosjp/takosumi/terraform-provider-takosumi_0.1.0_linux_amd64.zip",
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

function makeOperatorBillingOps(): {
  ops: OperatorBillingOperations;
  subscriptionCalls: {
    spaceId: string;
    billingSettings: unknown;
  }[];
  topUpCalls: {
    spaceId: string;
    input: { readonly usdMicros?: number; readonly credits?: number };
  }[];
} {
  const subscriptionCalls: {
    spaceId: string;
    billingSettings: unknown;
  }[] = [];
  const topUpCalls: {
    spaceId: string;
    input: { readonly usdMicros?: number; readonly credits?: number };
  }[] = [];
  return {
    ops: {
      getWorkspaceBilling: async (spaceId) => ({
        billing: {
          settings: { mode: "showback", provider: "manual" },
          balance: { spaceId, availableCredits: 0, reservedCredits: 0 },
        },
      }),
      changeWorkspaceSubscription: async (spaceId, input) => {
        subscriptionCalls.push({
          spaceId,
          billingSettings: input.billingSettings,
        });
        return { billing: { settings: input.billingSettings } };
      },
      topUpWorkspaceCredits: async (spaceId, input) => {
        topUpCalls.push({ spaceId, input });
        return {
          balance: {
            spaceId,
            availableUsdMicros: input.usdMicros ?? 0,
            availableCredits: input.credits ?? 0,
          },
        };
      },
    },
    subscriptionCalls,
    topUpCalls,
  };
}

test("operator billing route is deploy-control bearer gated", async () => {
  const { ops, subscriptionCalls } = makeOperatorBillingOps();
  const url = new URL(
    "https://app.takosumi.com/internal/platform/spaces/space_12345678/subscription/change",
  );
  const response = await handleOperatorBillingRequest(
    new Request(url, {
      method: "POST",
      body: JSON.stringify({
        billingSettings: { mode: "showback", provider: "manual" },
      }),
    }),
    url,
    { TAKOSUMI_DEPLOY_CONTROL_TOKEN: "operator-secret" } as never,
    ops,
  );
  expect(response?.status).toBe(401);
  expect(subscriptionCalls).toHaveLength(0);
});

test("operator billing route reads and changes Space billing settings", async () => {
  const { ops, subscriptionCalls, topUpCalls } = makeOperatorBillingOps();
  const env = { TAKOSUMI_DEPLOY_CONTROL_TOKEN: "operator-secret" } as never;
  const headers = {
    authorization: "Bearer operator-secret",
    "content-type": "application/json",
  };
  const readUrl = new URL(
    "https://app.takosumi.com/internal/platform/spaces/space_12345678/billing",
  );
  const read = await handleOperatorBillingRequest(
    new Request(readUrl, { headers }),
    readUrl,
    env,
    ops,
  );
  expect(read?.status).toBe(200);
  expect((await read?.json()).billing.settings).toEqual({
    mode: "showback",
    provider: "manual",
  });

  const changeUrl = new URL(
    "https://app.takosumi.com/internal/platform/spaces/space_12345678/subscription/change",
  );
  const changed = await handleOperatorBillingRequest(
    new Request(changeUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        billingSettings: { mode: "showback", provider: "manual" },
      }),
    }),
    changeUrl,
    env,
    ops,
  );
  expect(changed?.status).toBe(200);
  expect((await changed?.json()).billing.settings).toEqual({
    mode: "showback",
    provider: "manual",
  });
  expect(subscriptionCalls).toEqual([
    {
      spaceId: "space_12345678",
      billingSettings: { mode: "showback", provider: "manual" },
    },
  ]);

  const topUpUrl = new URL(
    "https://app.takosumi.com/internal/platform/spaces/space_12345678/credits/top-up",
  );
  const topUp = await handleOperatorBillingRequest(
    new Request(topUpUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ usdMicros: 5_000_000 }),
    }),
    topUpUrl,
    env,
    ops,
  );
  expect(topUp?.status).toBe(200);
  expect((await topUp?.json()).balance).toMatchObject({
    spaceId: "space_12345678",
    availableUsdMicros: 5_000_000,
  });
  expect(topUpCalls).toEqual([
    { spaceId: "space_12345678", input: { usdMicros: 5_000_000 } },
  ]);
});

test("operator billing path classifier includes top-up routes", () => {
  expect(
    isOperatorBillingPath(
      "/internal/platform/spaces/space_12345678/credits/top-up",
    ),
  ).toBe(true);
  expect(
    isOperatorBillingPath(
      "/internal/platform/spaces/not-a-space/credits/top-up",
    ),
  ).toBe(false);
});

test("platform Cloud usage record route prices and spends runtime usage", async () => {
  const recorded: {
    readonly spaceId: string;
    readonly input: unknown;
  }[] = [];
  const url = new URL("https://app.takosumi.com/internal/platform/cloud/usage");
  const response = await handlePlatformCloudUsageRecordRequest(
    new Request(url, {
      method: "POST",
      headers: {
        authorization: "Bearer usage-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        spaceId: "space_cloud",
        periodStart: "2026-06-28T10:00:00.000Z",
        periodEnd: "2026-06-28T10:00:01.000Z",
        meters: [
          {
            installationId: "inst_cloud",
            meterId: "cloudflare:workers_script:request",
            resourceFamily: "cloudflare.workers_script",
            resourceId: "script:api",
            operation: "request",
            kind: "gateway_compute",
            quantity: 1,
          },
        ],
      }),
    }),
    url,
    {
      TAKOSUMI_CLOUD_USAGE_PRICE_BOOK: TEST_CLOUD_USAGE_PRICE_BOOK,
      TAKOSUMI_CLOUD_USAGE_RECORD_TOKEN: "usage-secret",
    } as never,
    async (spaceId, input) => {
      recorded.push({ spaceId, input });
    },
  );

  expect(response?.status).toBe(202);
  expect(await response?.json()).toEqual({ ok: true, usageEvents: 1 });
  expect(recorded).toEqual([
    {
      spaceId: "space_cloud",
      input: expect.objectContaining({
        installationId: "inst_cloud",
        meterId: "cloudflare:workers_script:request",
        resourceFamily: "cloudflare.workers_script",
        resourceId: "script:api",
        operation: "request",
        kind: "gateway_compute",
        quantity: 1,
        usdMicros: 1_000,
        source: "resource_meter",
        spendRequired: true,
        createdAt: "2026-06-28T10:00:01.000Z",
      }),
    },
  ]);
});

test("platform Cloud usage record route maps insufficient balance to payment required", async () => {
  const url = new URL("https://app.takosumi.com/internal/platform/cloud/usage");
  const response = await handlePlatformCloudUsageRecordRequest(
    new Request(url, {
      method: "POST",
      headers: {
        authorization: "Bearer usage-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        spaceId: "space_cloud",
        periodStart: "2026-06-28T10:00:00.000Z",
        periodEnd: "2026-06-28T10:00:01.000Z",
        meters: [
          {
            meterId: "cloudflare:workers_script:request",
            resourceFamily: "cloudflare.workers_script",
            resourceId: "script:api",
            operation: "request",
            kind: "gateway_compute",
            quantity: 1,
          },
        ],
      }),
    }),
    url,
    {
      TAKOSUMI_CLOUD_USAGE_PRICE_BOOK: TEST_CLOUD_USAGE_PRICE_BOOK,
      TAKOSUMI_CLOUD_USAGE_RECORD_TOKEN: "usage-secret",
    } as never,
    async () => {
      throw new OpenTofuControllerError(
        "failed_precondition",
        "metered usage spend failed: insufficient USD balance",
        {
          reason: "insufficient_credits",
          workspaceId: "space_cloud",
          usdMicros: 1_000,
        },
      );
    },
  );

  expect(response?.status).toBe(402);
  expect(await response?.json()).toEqual({
    error: "cloud_extension_insufficient_credits",
    reason: "insufficient_credits",
  });
});

test("platform Cloud usage record path is a stable internal endpoint", async () => {
  expect(isPlatformCloudUsageRecordPath("/internal/platform/cloud/usage")).toBe(
    true,
  );
  expect(
    isPlatformCloudUsageRecordPath("/internal/platform/cloud/usage/"),
  ).toBe(false);
  const url = new URL("https://app.takosumi.com/internal/platform/cloud/usage");
  const response = await handlePlatformCloudUsageRecordRequest(
    new Request(url, {
      method: "POST",
      body: JSON.stringify({}),
    }),
    url,
    { TAKOSUMI_CLOUD_USAGE_RECORD_TOKEN: "usage-secret" } as never,
    async () => {
      throw new Error("must not record unauthenticated usage");
    },
  );
  expect(response?.status).toBe(401);
});

test("operator billing route validates settings before mutation", async () => {
  const { ops, subscriptionCalls } = makeOperatorBillingOps();
  const url = new URL(
    "https://app.takosumi.com/internal/platform/spaces/space_12345678/subscription/change",
  );
  const response = await handleOperatorBillingRequest(
    new Request(url, {
      method: "POST",
      headers: {
        authorization: "Bearer operator-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        billingSettings: { mode: "showback", provider: "bogus" },
      }),
    }),
    url,
    { TAKOSUMI_DEPLOY_CONTROL_TOKEN: "operator-secret" } as never,
    ops,
  );
  expect(response?.status).toBe(400);
  expect(subscriptionCalls).toHaveLength(0);
});

test("runtime-cell drill route is deploy-control bearer gated", async () => {
  const registry = new InMemoryRuntimeAgentRegistry();
  const url = new URL(
    "https://app.takosumi.com/internal/platform/runtime-cells/platform-production-primary/drill",
  );
  const response = await handlePlatformRuntimeCellDrillRequest(
    new Request(url, {
      method: "POST",
      body: JSON.stringify({ action: "drain" }),
    }),
    url,
    { TAKOSUMI_DEPLOY_CONTROL_TOKEN: "operator-secret" } as never,
    registry,
  );
  expect(response?.status).toBe(401);
  expect(await registry.listAgents()).toHaveLength(0);
  expect(await registry.listWork()).toHaveLength(0);
});

test("runtime-cell drill route records drain and evacuation events", async () => {
  const registry = new InMemoryRuntimeAgentRegistry();
  const env = { TAKOSUMI_DEPLOY_CONTROL_TOKEN: "operator-secret" } as never;
  const headers = {
    authorization: "Bearer operator-secret",
    "content-type": "application/json",
  };

  const drainUrl = new URL(
    "https://app.takosumi.com/internal/platform/runtime-cells/platform-production-primary/drill",
  );
  const drain = await handlePlatformRuntimeCellDrillRequest(
    new Request(drainUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "drain", reason: "test-drain" }),
    }),
    drainUrl,
    env,
    registry,
  );
  expect(drain?.status).toBe(200);
  const drainBody = await drain?.json();
  expect(drainBody.kind).toBe("takosumi.platform-runtime-cell-drill@v1");
  expect(drainBody.action).toBe("drain");
  expect(drainBody.runtimeCellId).toBe("platform-production-primary");
  expect(drainBody.eventId).toStartWith(
    "runtime_drain_platform-production-primary_",
  );
  expect(drainBody.status).toBe("completed");
  const drainAgent = await registry.getAgent(drainBody.agentId);
  expect(drainAgent?.status).toBe("draining");
  const drainWork = await registry.getWork(drainBody.workId);
  expect(drainWork?.status).toBe("completed");
  expect(drainWork?.metadata.runtimeCellId).toBe("platform-production-primary");

  const evacuation = await handlePlatformRuntimeCellDrillRequest(
    new Request(drainUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        action: "evacuation",
        reason: "test-evacuation",
      }),
    }),
    drainUrl,
    env,
    registry,
  );
  expect(evacuation?.status).toBe(200);
  const evacuationBody = await evacuation?.json();
  expect(evacuationBody.action).toBe("evacuation");
  expect(evacuationBody.evacuationRunId).toStartWith(
    "runtime_evac_platform-production-primary_",
  );
  expect(evacuationBody.status).toBe("completed");
  const evacuationWork = await registry.getWork(evacuationBody.workId);
  expect(evacuationWork?.status).toBe("completed");
  expect(evacuationWork?.result?.action).toBe("evacuation");
});

// --- Generic, config-driven Cloud extension seam (Seam A) ------------------
//
// The OSS platform worker names no Cloud feature. The extension seam is driven
// entirely by the operator/Cloud-supplied `TAKOSUMI_CLOUD_EXTENSIONS` env var
// (a JSON array of opaque `{ basePath, handlerKey, requiredScopes? }`
// descriptors). When that env is unset, every extension path 404s; when it is
// set, a matching path verifies the platform session and dispatches to the
// named in-process handler.

test("platformCloudExtensionRoutes is empty when the env is unset", () => {
  expect(platformCloudExtensionRoutes({})).toEqual([]);
  expect(
    platformCloudExtensionRoutes({ TAKOSUMI_CLOUD_EXTENSIONS: "" }),
  ).toEqual([]);
});

test("platformCloudExtensionRoutes parses opaque descriptors", () => {
  expect(
    platformCloudExtensionRoutes({
      TAKOSUMI_CLOUD_EXTENSIONS: JSON.stringify([
        {
          id: "ai",
          kind: "ai_gateway",
          protocol: "openai-compatible",
          basePath: "/gateway/ai/v1",
          handlerKey: "TAKOSUMI_CLOUD_AI",
          capabilities: ["openai.chat_completions", "openai.embeddings"],
          smokeChecks: ["models", "chat"],
          authMode: "platform",
          requiredScopes: ["ai.chat"],
          fallbackUsage: [
            {
              pathTemplate: "/chat/completions",
              methods: ["POST"],
              meterIdPrefix: "ai:",
              kind: "ai_request",
              quantity: 1,
              operationByMethod: { POST: "chat" },
            },
          ],
        },
        { basePath: "/compat/x", handlerKey: "TAKOSUMI_CLOUD_X" },
      ]),
    }),
  ).toEqual([
    {
      id: "ai",
      kind: "ai_gateway",
      protocol: "openai-compatible",
      basePath: "/gateway/ai/v1",
      handlerKey: "TAKOSUMI_CLOUD_AI",
      capabilities: ["openai.chat_completions", "openai.embeddings"],
      smokeChecks: ["models", "chat"],
      authMode: "platform",
      requiredScopes: ["ai.chat"],
      fallbackUsage: [
        {
          pathTemplate: "/chat/completions",
          methods: ["POST"],
          meterIdPrefix: "ai:",
          kind: "ai_request",
          quantity: 1,
          operationByMethod: { POST: "chat" },
        },
      ],
    },
    { basePath: "/compat/x", handlerKey: "TAKOSUMI_CLOUD_X" },
  ]);
});

test("platformCloudExtensionRoutes merges extra fallback usage descriptors", () => {
  expect(
    platformCloudExtensionRoutes({
      TAKOSUMI_CLOUD_EXTENSIONS: JSON.stringify([
        {
          basePath: "/compat/cloudflare/client/v4",
          handlerKey: "TAKOSUMI_CLOUD_COMPAT",
          fallbackUsage: [
            {
              pathTemplate: "/accounts/*/r2/buckets",
              methods: ["POST"],
              meterIdPrefix: "cloudflare:r2:",
              kind: "gateway_compute",
              quantity: 1,
            },
          ],
        },
      ]),
      TAKOSUMI_CLOUD_EXTENSIONS_EXTRA: JSON.stringify([
        {
          basePath: "/compat/cloudflare/client/v4",
          handlerKey: "TAKOSUMI_CLOUD_COMPAT",
          fallbackUsage: [
            {
              pathTemplate:
                "/accounts/*/storage/kv/namespaces/:resourceId/values/**",
              methods: ["PUT"],
              meterIdPrefix: "cloudflare:kv:",
              kind: "gateway_compute",
              quantity: 1,
              operationByMethod: { PUT: "value_write" },
            },
          ],
        },
      ]),
    }),
  ).toEqual([
    {
      basePath: "/compat/cloudflare/client/v4",
      handlerKey: "TAKOSUMI_CLOUD_COMPAT",
      fallbackUsage: [
        {
          pathTemplate: "/accounts/*/r2/buckets",
          methods: ["POST"],
          meterIdPrefix: "cloudflare:r2:",
          kind: "gateway_compute",
          quantity: 1,
        },
        {
          pathTemplate:
            "/accounts/*/storage/kv/namespaces/:resourceId/values/**",
          methods: ["PUT"],
          meterIdPrefix: "cloudflare:kv:",
          kind: "gateway_compute",
          quantity: 1,
          operationByMethod: { PUT: "value_write" },
        },
      ],
    },
  ]);
});

test("platformCloudExtensionRoutes rejects malformed descriptors", () => {
  expect(() =>
    platformCloudExtensionRoutes({ TAKOSUMI_CLOUD_EXTENSIONS: "{" }),
  ).toThrow("must be valid JSON");
  expect(() =>
    platformCloudExtensionRoutes({
      TAKOSUMI_CLOUD_EXTENSIONS: JSON.stringify([{ handlerKey: "X" }]),
    }),
  ).toThrow("basePath");
  expect(() =>
    platformCloudExtensionRoutes({
      TAKOSUMI_CLOUD_EXTENSIONS: JSON.stringify([{ basePath: "/x" }]),
    }),
  ).toThrow("handlerKey");
  expect(() =>
    platformCloudExtensionRoutes({
      TAKOSUMI_CLOUD_EXTENSIONS: JSON.stringify([
        { basePath: "/x", handlerKey: "X", capabilities: "ai" },
      ]),
    }),
  ).toThrow("capabilities");
});

test("the seam claims no extension path when TAKOSUMI_CLOUD_EXTENSIONS is unset", async () => {
  // With no TAKOSUMI_CLOUD_EXTENSIONS the seam matches nothing, so the request
  // is NOT claimed (returns undefined) and falls through to the accounts handler
  // — i.e. an OSS worker with no Cloud config exposes no extension paths.
  const result = await handlePlatformCloudExtensionRequest(
    new Request("https://app.takosumi.com/gateway/ai/v1/models"),
    {
      // A binding object exists on env, but with no descriptors it is unreachable.
      TAKOSUMI_CLOUD_AI: { fetch: async () => Response.json({}) },
    } as never,
  );
  expect(result).toBeUndefined();
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
  expect(discoveryBody.edition).toBeUndefined();
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
    "EdgeWorker",
    "KVStore",
    "ObjectBucket",
    "Queue",
    "SQLDatabase",
    "Stack",
  ]);
  expect(capabilitiesBody.adapters.cloudflare).toBe(false);
  expect(capabilitiesBody.compat.provider_cloudflare_workers).toBe(false);
});

test("platform worker product discovery exposes Cloud endpoint capabilities without claiming Resource Shape API", async () => {
  const worker = (await import("../../../deploy/platform/worker.ts")).default;

  const capabilities = await worker.fetch(
    new Request(
      `https://app.takosumi.com${TAKOSUMI_PRODUCT_CAPABILITIES_PATH}`,
    ),
    {
      TAKOSUMI_CLOUD_EXTENSIONS: JSON.stringify([
        {
          kind: "ai_gateway",
          protocol: "openai-compatible",
          basePath: "/gateway/ai/v1",
          handlerKey: "TAKOSUMI_CLOUD_AI",
          capabilities: ["ai.gateway"],
        },
        {
          kind: "provider_compat",
          provider: "cloudflare",
          basePath: "/compat/cloudflare/client/v4",
          handlerKey: "TAKOSUMI_CLOUD_CLOUDFLARE",
          capabilities: ["compat.cloudflare.workers.v1"],
        },
        {
          kind: "provider_compat",
          provider: "object-storage",
          protocol: "s3-compatible",
          basePath: "/compat/s3/v1",
          handlerKey: "TAKOSUMI_CLOUD_S3",
          capabilities: ["compat.s3.v1"],
        },
        {
          kind: "managed_usage",
          basePath: "/cloud/usage",
          handlerKey: "TAKOSUMI_CLOUD_USAGE",
          capabilities: ["cloud.usage"],
        },
      ]),
      TAKOSUMI_CLOUD_AI: { fetch: async () => Response.json({}) },
      TAKOSUMI_CLOUD_CLOUDFLARE: { fetch: async () => Response.json({}) },
      TAKOSUMI_CLOUD_S3: { fetch: async () => Response.json({}) },
      TAKOSUMI_CLOUD_USAGE: { fetch: async () => Response.json({}) },
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
  expect(Object.keys(body.resources).sort()).toEqual([
    "ContainerService",
    "EdgeWorker",
    "KVStore",
    "ObjectBucket",
    "Queue",
    "SQLDatabase",
    "Stack",
  ]);
  expect(body.adapters.cloudflare).toBe(false);
  expect(body.adapters.takosumi_native).toBe(false);
  expect(body.compat.provider_cloudflare_workers).toBe(true);
  expect(body.compat.s3).toBe(true);
  const discovery = await worker.fetch(
    new Request(`https://app.takosumi.com${TAKOSUMI_WELL_KNOWN_PATH}`),
    {
      TAKOSUMI_CLOUD_EXTENSIONS: JSON.stringify([
        {
          kind: "provider_compat",
          provider: "object-storage",
          protocol: "s3-compatible",
          basePath: "/compat/s3/v1",
          handlerKey: "TAKOSUMI_CLOUD_S3",
          capabilities: ["compat.s3.v1"],
        },
      ]),
      TAKOSUMI_CLOUD_S3: { fetch: async () => Response.json({}) },
    } as never,
  );
  expect(discovery.status).toBe(200);
  const discoveryBody = await discovery.json();
  expect(discoveryBody.features.resource_shapes).toBe(false);
  expect(discoveryBody.endpoints.s3).toBe(
    "https://app.takosumi.com/compat/s3/v1",
  );
});

test("platform Resource Shape API discovery is gated by deploy-control token and D1", async () => {
  const worker = (await import("../../../deploy/platform/worker.ts")).default;
  const env = {
    TAKOSUMI_CONTROL_DB: new SqliteFakeD1(),
    TAKOSUMI_DEPLOY_CONTROL_TOKEN: "resource-token",
    TAKOSUMI_DEV_MODE: "1",
    TAKOSUMI_RESOURCE_SHAPES:
      "EdgeWorker,ObjectBucket,KVStore,Queue,SQLDatabase",
    TAKOSUMI_RESOURCE_ADAPTERS: "cloudflare",
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
  expect(body.adapters.cloudflare).toBe(true);
  expect(body.adapters.takosumi_native).toBe(false);

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
  expect(body.adapters.opentofu).toBe(false);
  expect(body.adapters.cloudflare).toBe(false);

  const discovery = await worker.fetch(
    new Request(`https://app.takosumi.com${TAKOSUMI_WELL_KNOWN_PATH}`),
    env,
  );
  expect(discovery.status).toBe(200);
  expect((await discovery.json()).features.resource_shapes).toBe(false);
});

test("platform Resource Shape API routes are routed before accounts and bearer-gated", async () => {
  expect(isPlatformResourceShapeApiPath("/v1/resources")).toBe(true);
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

test("a configured cloud extension dispatches to the named handler through worker.fetch", async () => {
  const worker = (await import("../../../deploy/platform/worker.ts")).default;
  const forwarded: { url: string; authorization: string | null }[] = [];
  const response = await worker.fetch(
    new Request("https://app.takosumi.com/gateway/ai/v1/models", {
      headers: { authorization: "Bearer runtime-token" },
    }),
    {
      TAKOSUMI_CLOUD_EXTENSIONS: JSON.stringify([
        { basePath: "/gateway/ai/v1", handlerKey: "TAKOSUMI_CLOUD_AI" },
      ]),
      TAKOSUMI_CLOUD_AI: {
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
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ object: "list", data: [] });
  // Raw credential material is never forwarded to the Cloud handler.
  expect(forwarded).toEqual([
    {
      url: "https://app.takosumi.com/gateway/ai/v1/models",
      authorization: null,
    },
  ]);
});

test("a configured cloud extension 404s when its handler is absent", async () => {
  const worker = (await import("../../../deploy/platform/worker.ts")).default;
  const response = await worker.fetch(
    new Request("https://app.takosumi.com/gateway/ai/v1/models"),
    {
      TAKOSUMI_CLOUD_EXTENSIONS: JSON.stringify([
        { basePath: "/gateway/ai/v1", handlerKey: "TAKOSUMI_CLOUD_AI" },
      ]),
    } as never,
  );
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: "not found" });
});

test("handler-auth cloud extensions preserve signed protocol auth and strip spoofed context", async () => {
  const forwarded: {
    readonly authorization: string | null;
    readonly cookie: string | null;
    readonly rawCloudflareKey: string | null;
    readonly spoofedSpace: string | null;
    readonly billingSpace: string | null;
  }[] = [];
  const recorded: { readonly spaceId: string; readonly input: unknown }[] = [];
  const response = await handlePlatformCloudExtensionRouteRequest(
    new Request("https://app.takosumi.com/compat/s3/v1/assets/object.txt", {
      method: "PUT",
      headers: {
        authorization:
          "AWS4-HMAC-SHA256 Credential=AKID/20260629/auto/s3/aws4_request, SignedHeaders=host;x-amz-date, Signature=abc",
        cookie: "takosumi_session=sess_cookie",
        "x-auth-key": "raw-cloudflare-key",
        "x-takosumi-cloud-space-id": "space_attacker",
        "x-takosumi-cloud-billing-workspace-id": "space_attacker",
      },
      body: "hello",
    }),
    {
      TAKOSUMI_CLOUD_USAGE_PRICE_BOOK: TEST_CLOUD_USAGE_PRICE_BOOK,
      TAKOSUMI_CLOUD_S3: {
        fetch: async (request: Request) => {
          forwarded.push({
            authorization: request.headers.get("authorization"),
            cookie: request.headers.get("cookie"),
            rawCloudflareKey: request.headers.get("x-auth-key"),
            spoofedSpace: request.headers.get("x-takosumi-cloud-space-id"),
            billingSpace: request.headers.get(
              "x-takosumi-cloud-billing-workspace-id",
            ),
          });
          return Response.json(
            { ok: true },
            {
              headers: {
                "x-takosumi-cloud-usage-space-id": "space_storage",
                "x-takosumi-cloud-usage-period-start":
                  "2026-06-29T00:00:00.000Z",
                "x-takosumi-cloud-usage-period-end": "2026-06-29T00:00:01.000Z",
                "x-takosumi-cloud-usage-meters": JSON.stringify([
                  {
                    meterId: "cloudflare:r2:object_write",
                    resourceFamily: "cloudflare.r2",
                    resourceId: "bucket:assets",
                    operation: "object_write",
                    kind: "gateway_compute",
                    quantity: 1,
                  },
                ]),
              },
            },
          );
        },
      },
    } as never,
    {
      basePath: "/compat/s3/v1",
      handlerKey: "TAKOSUMI_CLOUD_S3",
      authMode: "handler",
    },
    async () => {
      throw new Error("handler-auth routes must not use platform session auth");
    },
    async (spaceId, input) => {
      recorded.push({ spaceId, input });
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
  expect(recorded).toEqual([
    {
      spaceId: "space_storage",
      input: expect.objectContaining({
        meterId: "cloudflare:r2:object_write",
        resourceFamily: "cloudflare.r2",
        resourceId: "bucket:assets",
        operation: "object_write",
        kind: "gateway_compute",
        quantity: 1,
        usdMicros: 500,
        spendRequired: true,
      }),
    },
  ]);
});

test("cloud extension route injects verified session context and strips raw credentials", async () => {
  const forwarded: {
    authorization: string | null;
    cookie: string | null;
    authenticated: string | null;
    subject: string | null;
    spaceId: string | null;
    billingWorkspaceId: string | null;
  }[] = [];
  const response = await handlePlatformCloudExtensionRouteRequest(
    new Request("https://app.takosumi.com/gateway/ai/v1/models", {
      headers: {
        authorization: "Bearer raw-token",
        cookie: "takosumi_session=sess_cookie",
        "x-takosumi-cloud-authenticated": "1",
      },
    }),
    {
      TAKOSUMI_CLOUD_AI: {
        fetch: async (request: Request) => {
          forwarded.push({
            authorization: request.headers.get("authorization"),
            cookie: request.headers.get("cookie"),
            authenticated: request.headers.get(
              "x-takosumi-cloud-authenticated",
            ),
            subject: request.headers.get("x-takosumi-cloud-subject"),
            spaceId: request.headers.get("x-takosumi-cloud-space-id"),
            billingWorkspaceId: request.headers.get(
              "x-takosumi-cloud-billing-workspace-id",
            ),
          });
          return Response.json({ object: "list", data: [] });
        },
      },
    } as never,
    { basePath: "/gateway/ai/v1", handlerKey: "TAKOSUMI_CLOUD_AI" },
    async () => ({
      authenticated: true,
      authKind: "session",
      subject: "tsub_cloud",
      spaceId: "space_cloud",
    }),
  );
  expect(response.status).toBe(200);
  expect(forwarded).toEqual([
    {
      authorization: null,
      cookie: null,
      authenticated: "1",
      subject: "tsub_cloud",
      spaceId: "space_cloud",
      billingWorkspaceId: "space_cloud",
    },
  ]);
});

test("cloud extension route rejects spoofed billing Workspace context", async () => {
  let forwarded = false;
  const response = await handlePlatformCloudExtensionRouteRequest(
    new Request("https://app.takosumi.com/gateway/ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "x-takosumi-cloud-billing-workspace-id": "space_attacker",
      },
    }),
    {
      TAKOSUMI_CLOUD_AI: {
        fetch: async () => {
          forwarded = true;
          return Response.json({ ok: true });
        },
      },
    } as never,
    { basePath: "/gateway/ai/v1", handlerKey: "TAKOSUMI_CLOUD_AI" },
    async () => ({
      authenticated: true,
      authKind: "session",
      subject: "tsub_cloud",
      spaceId: "space_cloud",
    }),
  );

  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({
    error: "cloud_extension_billing_context_mismatch",
    reason: "usage_workspace_id_mismatch",
  });
  expect(forwarded).toBe(false);
});

test("cloud extension billing context accepts Capsule projection ids", async () => {
  const seenPaths: string[] = [];
  const allowed = await platformCloudExtensionSessionCanAccessCapsuleProjection(
    new Request("https://app.takosumi.com/compat/cloudflare/client/v4", {
      headers: {
        authorization: "Bearer session-token",
      },
    }),
    {} as never,
    "inst_projection",
    "space_cloud",
    async (request) => {
      seenPaths.push(new URL(request.url).pathname);
      if (new URL(request.url).pathname.startsWith("/api/v1/capsules/")) {
        return Response.json({ error: "not_found" }, { status: 404 });
      }
      return Response.json({
        installation: {
          id: "inst_projection",
          space_id: "space_cloud",
        },
      });
    },
  );

  expect(allowed).toBe(true);
  expect(seenPaths).toEqual([
    "/api/v1/capsules/inst_projection",
    "/v1/capsule-projections/inst_projection",
  ]);
});

test("cloud extension requiredScopes gate token auth", async () => {
  const binding = {
    TAKOSUMI_CLOUD_AI: { fetch: async () => Response.json({ ok: true }) },
  } as never;
  const route = {
    basePath: "/gateway/ai/v1",
    handlerKey: "TAKOSUMI_CLOUD_AI",
    requiredScopes: ["ai.chat"],
  };

  const denied = await handlePlatformCloudExtensionRouteRequest(
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

  const allowed = await handlePlatformCloudExtensionRouteRequest(
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
  const session = await handlePlatformCloudExtensionRouteRequest(
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

test("cloud extension usage headers are priced, recorded, and stripped from client responses", async () => {
  const periodStart = "2026-06-28T10:00:00.000Z";
  const periodEnd = "2026-06-28T10:00:01.000Z";
  const recorded: {
    readonly spaceId: string;
    readonly input: unknown;
  }[] = [];
  const response = await handlePlatformCloudExtensionRouteRequest(
    new Request(
      "https://app.takosumi.com/compat/cloudflare/client/v4/accounts/ts_acc/workers/scripts/api",
    ),
    {
      TAKOSUMI_CLOUD_USAGE_PRICE_BOOK: TEST_CLOUD_USAGE_PRICE_BOOK,
      TAKOSUMI_CLOUD_COMPAT: {
        fetch: async () =>
          Response.json(
            { success: true },
            {
              headers: {
                "x-takosumi-cloud-usage-space-id": "space_cloud",
                "x-takosumi-cloud-usage-period-start": periodStart,
                "x-takosumi-cloud-usage-period-end": periodEnd,
                "x-takosumi-cloud-usage-meters": JSON.stringify([
                  {
                    installationId: "inst_cloud",
                    meterId: "cloudflare:workers_script:deploy",
                    resourceFamily: "cloudflare.workers_script",
                    resourceId: "script:api",
                    operation: "deploy",
                    kind: "gateway_compute",
                    quantity: 1,
                    usdMicros: 99_999_999,
                  },
                ]),
              },
            },
          ),
      },
    } as never,
    {
      basePath: "/compat/cloudflare/client/v4",
      handlerKey: "TAKOSUMI_CLOUD_COMPAT",
    },
    async () => ({
      authenticated: true,
      authKind: "service-token",
      subject: "svc",
      spaceId: "space_cloud",
      scopes: ["admin"],
    }),
    async (spaceId, input) => {
      recorded.push({ spaceId, input });
    },
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ success: true });
  expect(response.headers.get("x-takosumi-cloud-usage-space-id")).toBeNull();
  expect(response.headers.get("x-takosumi-cloud-usage-meters")).toBeNull();
  expect(recorded).toEqual([
    {
      spaceId: "space_cloud",
      input: expect.objectContaining({
        installationId: "inst_cloud",
        meterId: "cloudflare:workers_script:deploy",
        resourceFamily: "cloudflare.workers_script",
        resourceId: "script:api",
        operation: "deploy",
        kind: "gateway_compute",
        quantity: 1,
        usdMicros: 1_000,
        source: "resource_meter",
        spendRequired: true,
        createdAt: periodEnd,
      }),
    },
  ]);
});

test("cloud extension usage headers price Cloudflare Queue meters", async () => {
  const periodStart = "2026-06-28T10:00:00.000Z";
  const periodEnd = "2026-06-28T10:00:01.000Z";
  const recorded: {
    readonly spaceId: string;
    readonly input: unknown;
  }[] = [];
  const response = await handlePlatformCloudExtensionRouteRequest(
    new Request(
      "https://app.takosumi.com/compat/cloudflare/client/v4/accounts/ts_acc/queues",
      { method: "POST" },
    ),
    {
      TAKOSUMI_CLOUD_USAGE_PRICE_BOOK: TEST_CLOUD_USAGE_PRICE_BOOK,
      TAKOSUMI_CLOUD_COMPAT: {
        fetch: async () =>
          Response.json(
            { success: true },
            {
              status: 201,
              headers: {
                "x-takosumi-cloud-usage-space-id": "space_cloud",
                "x-takosumi-cloud-usage-period-start": periodStart,
                "x-takosumi-cloud-usage-period-end": periodEnd,
                "x-takosumi-cloud-usage-meters": JSON.stringify([
                  {
                    installationId: "inst_cloud",
                    meterId: "cloudflare:queues:create",
                    resourceFamily: "cloudflare.queues",
                    resourceId: "queues:jobs",
                    operation: "create",
                    kind: "gateway_compute",
                    quantity: 1,
                  },
                ]),
              },
            },
          ),
      },
    } as never,
    {
      basePath: "/compat/cloudflare/client/v4",
      handlerKey: "TAKOSUMI_CLOUD_COMPAT",
    },
    async () => ({
      authenticated: true,
      authKind: "session",
      subject: "tsub_cloud",
    }),
    async (spaceId, input) => {
      recorded.push({ spaceId, input });
    },
  );

  expect(response.status).toBe(201);
  expect(response.headers.has("x-takosumi-cloud-usage-meters")).toBe(false);
  expect(recorded).toEqual([
    {
      spaceId: "space_cloud",
      input: expect.objectContaining({
        installationId: "inst_cloud",
        meterId: "cloudflare:queues:create",
        resourceFamily: "cloudflare.queues",
        resourceId: "queues:jobs",
        operation: "create",
        kind: "gateway_compute",
        quantity: 1,
        usdMicros: 500,
        source: "resource_meter",
        spendRequired: true,
        createdAt: periodEnd,
      }),
    },
  ]);
});

test("cloud extension usage headers use token Workspace context when the extension omits a Workspace header", async () => {
  const periodStart = "2026-06-28T10:00:00.000Z";
  const periodEnd = "2026-06-28T10:00:01.000Z";
  const recorded: {
    readonly spaceId: string;
    readonly input: unknown;
  }[] = [];
  const response = await handlePlatformCloudExtensionRouteRequest(
    new Request(
      "https://app.takosumi.com/compat/cloudflare/client/v4/accounts/ts_acc/workers/scripts/api",
      { method: "PUT" },
    ),
    {
      TAKOSUMI_CLOUD_USAGE_PRICE_BOOK: TEST_CLOUD_USAGE_PRICE_BOOK,
      TAKOSUMI_CLOUD_COMPAT: {
        fetch: async () =>
          Response.json(
            { success: true },
            {
              status: 201,
              headers: {
                "x-takosumi-cloud-usage-period-start": periodStart,
                "x-takosumi-cloud-usage-period-end": periodEnd,
                "x-takosumi-cloud-usage-meters": JSON.stringify([
                  {
                    installationId: "inst_cloud",
                    meterId: "cloudflare:workers_script:deploy",
                    resourceFamily: "cloudflare.workers_script",
                    resourceId: "script:api",
                    operation: "deploy",
                    kind: "gateway_compute",
                    quantity: 1,
                  },
                ]),
              },
            },
          ),
      },
    } as never,
    {
      basePath: "/compat/cloudflare/client/v4",
      handlerKey: "TAKOSUMI_CLOUD_COMPAT",
    },
    async () => ({
      authenticated: true,
      authKind: "service-token",
      subject: "svc:takosumi-cloud:inst_cloud",
      spaceId: "space_from_token",
      installationId: "inst_cloud",
      scopes: ["admin"],
    }),
    async (spaceId, input) => {
      recorded.push({ spaceId, input });
    },
  );

  expect(response.status).toBe(201);
  expect(await response.json()).toEqual({ success: true });
  expect(response.headers.has("x-takosumi-cloud-usage-meters")).toBe(false);
  expect(recorded).toEqual([
    {
      spaceId: "space_from_token",
      input: expect.objectContaining({
        installationId: "inst_cloud",
        meterId: "cloudflare:workers_script:deploy",
        resourceFamily: "cloudflare.workers_script",
        resourceId: "script:api",
        operation: "deploy",
        kind: "gateway_compute",
        quantity: 1,
        usdMicros: 1_000,
        source: "resource_meter",
        spendRequired: true,
        createdAt: periodEnd,
      }),
    },
  ]);
});

test("cloud extension fallback usage records successful extension calls without upstream usage headers", async () => {
  const recorded: {
    readonly spaceId: string;
    readonly input: unknown;
  }[] = [];
  const response = await handlePlatformCloudExtensionRouteRequest(
    new Request(
      "https://app.takosumi.com/compat/cloudflare/client/v4/accounts/ts_acc/workers/scripts/api",
      { method: "PUT" },
    ),
    {
      TAKOSUMI_CLOUD_USAGE_PRICE_BOOK: TEST_CLOUD_USAGE_PRICE_BOOK,
      TAKOSUMI_CLOUD_COMPAT: {
        fetch: async () => Response.json({ success: true }, { status: 201 }),
      },
    } as never,
    {
      basePath: "/compat/cloudflare/client/v4",
      handlerKey: "TAKOSUMI_CLOUD_COMPAT",
      fallbackUsage: [
        {
          pathTemplate: "/accounts/*/workers/scripts/:resourceId",
          methods: ["PUT", "PATCH", "GET", "DELETE"],
          meterIdPrefix: "cloudflare:workers_script:",
          resourceFamily: "cloudflare.workers_script",
          resourceIdPrefix: "script:",
          resourceIdParam: "resourceId",
          kind: "gateway_compute",
          quantity: 1,
          operationByMethod: {
            PUT: "deploy",
            PATCH: "deploy",
            GET: "read",
            DELETE: "delete",
          },
        },
      ],
    },
    async () => ({
      authenticated: true,
      authKind: "session",
      subject: "tsub_cloud",
      spaceId: "space_cloud",
      installationId: "inst_cloud",
    }),
    async (spaceId, input) => {
      recorded.push({ spaceId, input });
    },
    async () => {},
  );

  expect(response.status).toBe(201);
  expect(await response.json()).toEqual({ success: true });
  expect(recorded).toEqual([
    {
      spaceId: "space_cloud",
      input: expect.objectContaining({
        installationId: "inst_cloud",
        meterId: "cloudflare:workers_script:deploy",
        resourceFamily: "cloudflare.workers_script",
        resourceId: "script:api",
        operation: "deploy",
        kind: "gateway_compute",
        quantity: 1,
        usdMicros: 1_000,
        source: "resource_meter",
        spendRequired: true,
      }),
    },
  ]);
});

test("cloud extension fallback usage can meter nested data-plane value keys", async () => {
  const recorded: {
    readonly spaceId: string;
    readonly input: unknown;
  }[] = [];
  let forwarded = false;
  const response = await handlePlatformCloudExtensionRouteRequest(
    new Request(
      "https://app.takosumi.com/compat/cloudflare/client/v4/accounts/ts_acc/storage/kv/namespaces/user-kv/values/folder/session",
      { method: "PUT" },
    ),
    {
      TAKOSUMI_CLOUD_USAGE_PRICE_BOOK: TEST_CLOUD_USAGE_PRICE_BOOK,
      TAKOSUMI_CLOUD_COMPAT: {
        fetch: async () => {
          forwarded = true;
          return Response.json({ success: true }, { status: 200 });
        },
      },
    } as never,
    {
      basePath: "/compat/cloudflare/client/v4",
      handlerKey: "TAKOSUMI_CLOUD_COMPAT",
      fallbackUsage: [
        {
          pathTemplate:
            "/accounts/*/storage/kv/namespaces/:resourceId/values/**",
          methods: ["PUT"],
          meterIdPrefix: "cloudflare:kv:",
          resourceFamily: "cloudflare.kv",
          resourceIdPrefix: "kv:",
          resourceIdParam: "resourceId",
          kind: "gateway_compute",
          quantity: 1,
          operationByMethod: { PUT: "value_write" },
        },
      ],
    },
    async () => ({
      authenticated: true,
      authKind: "session",
      subject: "tsub_cloud",
      spaceId: "space_cloud",
      installationId: "inst_cloud",
    }),
    async (spaceId, input) => {
      recorded.push({ spaceId, input });
    },
    async () => {},
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ success: true });
  expect(forwarded).toBe(true);
  expect(recorded).toEqual([
    {
      spaceId: "space_cloud",
      input: expect.objectContaining({
        installationId: "inst_cloud",
        meterId: "cloudflare:kv:value_write",
        resourceFamily: "cloudflare.kv",
        resourceId: "kv:user-kv",
        operation: "value_write",
        kind: "gateway_compute",
        quantity: 1,
        usdMicros: 500,
        source: "resource_meter",
        spendRequired: true,
      }),
    },
  ]);
});

test("cloud extension fallback usage can meter nested R2 object keys", async () => {
  const recorded: {
    readonly spaceId: string;
    readonly input: unknown;
  }[] = [];
  const response = await handlePlatformCloudExtensionRouteRequest(
    new Request(
      "https://app.takosumi.com/compat/cloudflare/client/v4/accounts/ts_acc/r2/buckets/assets/objects/images/logo.png",
      { method: "PUT" },
    ),
    {
      TAKOSUMI_CLOUD_USAGE_PRICE_BOOK: TEST_CLOUD_USAGE_PRICE_BOOK,
      TAKOSUMI_CLOUD_COMPAT: {
        fetch: async () => Response.json({ success: true }, { status: 200 }),
      },
    } as never,
    {
      basePath: "/compat/cloudflare/client/v4",
      handlerKey: "TAKOSUMI_CLOUD_COMPAT",
      fallbackUsage: [
        {
          pathTemplate: "/accounts/*/r2/buckets/:resourceId/objects/**",
          methods: ["GET", "HEAD", "PUT", "POST", "PATCH"],
          meterIdPrefix: "cloudflare:r2:",
          resourceFamily: "cloudflare.r2",
          resourceIdPrefix: "r2:",
          resourceIdParam: "resourceId",
          kind: "gateway_compute",
          quantity: 1,
          operationByMethod: {
            GET: "object_read",
            HEAD: "object_read",
            PUT: "object_write",
            POST: "object_write",
            PATCH: "object_write",
          },
        },
      ],
    },
    async () => ({
      authenticated: true,
      authKind: "session",
      subject: "tsub_cloud",
      spaceId: "space_cloud",
      installationId: "inst_cloud",
    }),
    async (spaceId, input) => {
      recorded.push({ spaceId, input });
    },
    async () => {},
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ success: true });
  expect(recorded).toEqual([
    {
      spaceId: "space_cloud",
      input: expect.objectContaining({
        installationId: "inst_cloud",
        meterId: "cloudflare:r2:object_write",
        resourceFamily: "cloudflare.r2",
        resourceId: "r2:assets",
        operation: "object_write",
        kind: "gateway_compute",
        quantity: 1,
        usdMicros: 500,
        source: "resource_meter",
        spendRequired: true,
      }),
    },
  ]);
});

test("cloud extension fallback usage requires billing Workspace context for billable writes", async () => {
  let forwarded = false;
  const response = await handlePlatformCloudExtensionRouteRequest(
    new Request(
      "https://app.takosumi.com/compat/cloudflare/client/v4/accounts/ts_acc/workers/scripts/api",
      { method: "PUT" },
    ),
    {
      TAKOSUMI_CLOUD_USAGE_PRICE_BOOK: TEST_CLOUD_USAGE_PRICE_BOOK,
      TAKOSUMI_CLOUD_COMPAT: {
        fetch: async () => {
          forwarded = true;
          return Response.json({ success: true }, { status: 201 });
        },
      },
    } as never,
    {
      basePath: "/compat/cloudflare/client/v4",
      handlerKey: "TAKOSUMI_CLOUD_COMPAT",
      fallbackUsage: [
        {
          pathTemplate: "/accounts/*/workers/scripts/:resourceId",
          methods: ["PUT"],
          meterIdPrefix: "cloudflare:workers_script:",
          resourceFamily: "cloudflare.workers_script",
          resourceIdPrefix: "script:",
          resourceIdParam: "resourceId",
          kind: "gateway_compute",
          quantity: 1,
          operationByMethod: { PUT: "deploy" },
        },
      ],
    },
    async () => ({
      authenticated: true,
      authKind: "session",
      subject: "tsub_cloud",
    }),
    async () => {
      throw new Error("must not record without workspace context");
    },
  );

  expect(response.status).toBe(402);
  expect(await response.json()).toEqual({
    error: "cloud_extension_billing_context_required",
    reason: "usage_workspace_id_missing",
  });
  expect(forwarded).toBe(false);
});

test("cloud extension usage spend failure fails closed", async () => {
  let forwarded = false;
  const response = await handlePlatformCloudExtensionRouteRequest(
    new Request(
      "https://app.takosumi.com/compat/cloudflare/client/v4/accounts/ts_acc/workers/scripts/api",
      { method: "PUT" },
    ),
    {
      TAKOSUMI_CLOUD_USAGE_PRICE_BOOK: TEST_CLOUD_USAGE_PRICE_BOOK,
      TAKOSUMI_CLOUD_COMPAT: {
        fetch: async () => {
          forwarded = true;
          return Response.json({ success: true }, { status: 201 });
        },
      },
    } as never,
    {
      basePath: "/compat/cloudflare/client/v4",
      handlerKey: "TAKOSUMI_CLOUD_COMPAT",
      fallbackUsage: [
        {
          pathTemplate: "/accounts/*/workers/scripts/:resourceId",
          methods: ["PUT"],
          meterIdPrefix: "cloudflare:workers_script:",
          resourceFamily: "cloudflare.workers_script",
          resourceIdPrefix: "script:",
          resourceIdParam: "resourceId",
          kind: "gateway_compute",
          quantity: 1,
          operationByMethod: { PUT: "deploy" },
        },
      ],
    },
    async () => ({
      authenticated: true,
      authKind: "session",
      subject: "tsub_cloud",
      spaceId: "space_cloud",
      installationId: "inst_cloud",
    }),
    async () => {
      throw new Error("insufficient credits");
    },
    async () => {},
  );

  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({
    error: "cloud_extension_usage_metering_failed",
    reason: "usage_record_failed",
  });
  expect(forwarded).toBe(false);
});

test("cloud extension usage spend failure maps insufficient balance to payment required", async () => {
  let forwarded = false;
  const response = await handlePlatformCloudExtensionRouteRequest(
    new Request(
      "https://app.takosumi.com/compat/cloudflare/client/v4/accounts/ts_acc/workers/scripts/api",
      { method: "PUT" },
    ),
    {
      TAKOSUMI_CLOUD_USAGE_PRICE_BOOK: TEST_CLOUD_USAGE_PRICE_BOOK,
      TAKOSUMI_CLOUD_COMPAT: {
        fetch: async () => {
          forwarded = true;
          return Response.json({ success: true }, { status: 201 });
        },
      },
    } as never,
    {
      basePath: "/compat/cloudflare/client/v4",
      handlerKey: "TAKOSUMI_CLOUD_COMPAT",
      fallbackUsage: [
        {
          pathTemplate: "/accounts/*/workers/scripts/:resourceId",
          methods: ["PUT"],
          meterIdPrefix: "cloudflare:workers_script:",
          resourceFamily: "cloudflare.workers_script",
          resourceIdPrefix: "script:",
          resourceIdParam: "resourceId",
          kind: "gateway_compute",
          quantity: 1,
          operationByMethod: { PUT: "deploy" },
        },
      ],
    },
    async () => ({
      authenticated: true,
      authKind: "session",
      subject: "tsub_cloud",
      spaceId: "space_cloud",
      installationId: "inst_cloud",
    }),
    async () => {
      throw new OpenTofuControllerError(
        "failed_precondition",
        "metered usage spend failed: insufficient USD balance",
        {
          reason: "insufficient_credits",
          workspaceId: "space_cloud",
          usdMicros: 1_000,
        },
      );
    },
    async () => {},
  );

  expect(response.status).toBe(402);
  expect(await response.json()).toEqual({
    error: "cloud_extension_insufficient_credits",
    reason: "insufficient_credits",
  });
  expect(forwarded).toBe(false);
});

test("cloud extension fallback usage precharges spend before forwarding billable calls", async () => {
  let forwarded = false;
  let recorded = false;
  const response = await handlePlatformCloudExtensionRouteRequest(
    new Request(
      "https://app.takosumi.com/compat/cloudflare/client/v4/accounts/ts_acc/workers/scripts/api",
      { method: "PUT" },
    ),
    {
      TAKOSUMI_CLOUD_USAGE_PRICE_BOOK: TEST_CLOUD_USAGE_PRICE_BOOK,
      TAKOSUMI_CLOUD_COMPAT: {
        fetch: async () => {
          forwarded = true;
          return Response.json({ success: true }, { status: 201 });
        },
      },
    } as never,
    {
      basePath: "/compat/cloudflare/client/v4",
      handlerKey: "TAKOSUMI_CLOUD_COMPAT",
      fallbackUsage: [
        {
          pathTemplate: "/accounts/*/workers/scripts/:resourceId",
          methods: ["PUT"],
          meterIdPrefix: "cloudflare:workers_script:",
          resourceFamily: "cloudflare.workers_script",
          resourceIdPrefix: "script:",
          resourceIdParam: "resourceId",
          kind: "gateway_compute",
          quantity: 1,
          operationByMethod: { PUT: "deploy" },
        },
      ],
    },
    async () => ({
      authenticated: true,
      authKind: "session",
      subject: "tsub_cloud",
      spaceId: "space_cloud",
      installationId: "inst_cloud",
    }),
    async () => {
      recorded = true;
    },
    async () => {
      throw new OpenTofuControllerError(
        "failed_precondition",
        "metered usage spend failed: insufficient USD balance",
        {
          reason: "insufficient_credits",
          workspaceId: "space_cloud",
          usdMicros: 1_000,
        },
      );
    },
  );

  expect(response.status).toBe(402);
  expect(await response.json()).toEqual({
    error: "cloud_extension_insufficient_credits",
    reason: "insufficient_credits",
  });
  expect(forwarded).toBe(false);
  expect(recorded).toBe(false);
});

test("cloud extension fallback usage does not block DELETE cleanup", async () => {
  let forwarded = false;
  const response = await handlePlatformCloudExtensionRouteRequest(
    new Request(
      "https://app.takosumi.com/compat/cloudflare/client/v4/accounts/ts_acc/workers/scripts/api",
      { method: "DELETE" },
    ),
    {
      TAKOSUMI_CLOUD_USAGE_PRICE_BOOK: TEST_CLOUD_USAGE_PRICE_BOOK,
      TAKOSUMI_CLOUD_COMPAT: {
        fetch: async () => {
          forwarded = true;
          return Response.json({ success: true }, { status: 200 });
        },
      },
    } as never,
    {
      basePath: "/compat/cloudflare/client/v4",
      handlerKey: "TAKOSUMI_CLOUD_COMPAT",
      fallbackUsage: [
        {
          pathTemplate: "/accounts/*/workers/scripts/:resourceId",
          methods: ["DELETE"],
          meterIdPrefix: "cloudflare:workers_script:",
          resourceFamily: "cloudflare.workers_script",
          resourceIdPrefix: "script:",
          resourceIdParam: "resourceId",
          kind: "gateway_compute",
          quantity: 1,
          operationByMethod: { DELETE: "delete" },
        },
      ],
    },
    async () => ({
      authenticated: true,
      authKind: "session",
      subject: "tsub_cloud",
      spaceId: "space_cloud",
      installationId: "inst_cloud",
    }),
    async () => {
      throw new Error("DELETE cleanup must not record priced usage");
    },
    async () => {
      throw new Error("DELETE cleanup must not precharge credits");
    },
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ success: true });
  expect(forwarded).toBe(true);
});

test("cloud extension fallback precharge skips duplicate response usage and records extra meters", async () => {
  const periodStart = "2026-06-28T10:00:00.000Z";
  const periodEnd = "2026-06-28T10:00:01.000Z";
  const recorded: {
    readonly spaceId: string;
    readonly input: Record<string, unknown>;
  }[] = [];
  const response = await handlePlatformCloudExtensionRouteRequest(
    new Request("https://app.takosumi.com/gateway/ai/v1/chat/completions", {
      method: "POST",
    }),
    {
      TAKOSUMI_CLOUD_USAGE_PRICE_BOOK: TEST_CLOUD_USAGE_PRICE_BOOK,
      TAKOSUMI_CLOUD_AI: {
        fetch: async () =>
          Response.json(
            { id: "chatcmpl" },
            {
              headers: {
                "x-takosumi-cloud-usage-space-id": "space_cloud",
                "x-takosumi-cloud-usage-period-start": periodStart,
                "x-takosumi-cloud-usage-period-end": periodEnd,
                "x-takosumi-cloud-usage-meters": JSON.stringify([
                  {
                    installationId: "inst_cloud",
                    meterId: "ai:takosumi-default:chat.completions:request",
                    resourceFamily: "takosumi.ai_gateway",
                    resourceId: "takosumi/default",
                    operation: "chat.completions",
                    kind: "ai_request",
                    quantity: 1,
                  },
                  {
                    installationId: "inst_cloud",
                    meterId: "ai:chat:input_token",
                    resourceFamily: "ai.chat",
                    operation: "chat.input_tokens",
                    kind: "ai_input_token",
                    quantity: 100,
                  },
                ]),
              },
            },
          ),
      },
    } as never,
    {
      basePath: "/gateway/ai/v1",
      handlerKey: "TAKOSUMI_CLOUD_AI",
      fallbackUsage: [
        {
          pathTemplate: "/chat/completions",
          methods: ["POST"],
          meterIdPrefix: "ai:",
          resourceFamily: "ai.chat",
          kind: "ai_request",
          quantity: 1,
          operationByMethod: { POST: "chat" },
        },
      ],
    },
    async () => ({
      authenticated: true,
      authKind: "session",
      subject: "tsub_cloud",
      spaceId: "space_cloud",
      installationId: "inst_cloud",
    }),
    async (spaceId, input) => {
      recorded.push({ spaceId, input: input as Record<string, unknown> });
    },
    async () => {},
  );

  expect(response.status).toBe(200);
  expect(recorded).toHaveLength(2);
  expect(recorded[0]).toEqual({
    spaceId: "space_cloud",
    input: expect.objectContaining({
      installationId: "inst_cloud",
      meterId: "ai:chat",
      resourceFamily: "ai.chat",
      operation: "chat",
      kind: "ai_request",
      quantity: 1,
      usdMicros: 1_000,
      spendRequired: true,
    }),
  });
  expect(recorded[1]).toEqual({
    spaceId: "space_cloud",
    input: expect.objectContaining({
      installationId: "inst_cloud",
      meterId: "ai:chat:input_token",
      resourceFamily: "ai.chat",
      operation: "chat.input_tokens",
      kind: "ai_input_token",
      quantity: 100,
      usdMicros: 30,
      spendRequired: true,
      createdAt: periodEnd,
    }),
  });
});

test("cloud usage extension records managed Containers and Durable Objects meters", async () => {
  const periodStart = "2026-06-29T00:00:00.000Z";
  const periodEnd = "2026-06-29T00:01:00.000Z";
  const recorded: {
    readonly spaceId: string;
    readonly input: Record<string, unknown>;
  }[] = [];
  const response = await handlePlatformCloudExtensionRouteRequest(
    new Request("https://app.takosumi.com/cloud/usage/resource-meters", {
      method: "POST",
    }),
    {
      TAKOSUMI_CLOUD_USAGE_PRICE_BOOK: TEST_CLOUD_USAGE_PRICE_BOOK,
      TAKOSUMI_CLOUD_USAGE: {
        fetch: async () =>
          Response.json(
            { ok: true, reports: 1, workspaceId: "space_cloud" },
            {
              headers: {
                "x-takosumi-cloud-usage-space-id": "space_cloud",
                "x-takosumi-cloud-usage-period-start": periodStart,
                "x-takosumi-cloud-usage-period-end": periodEnd,
                "x-takosumi-cloud-usage-meters": JSON.stringify([
                  {
                    installationId: "inst_cloud",
                    meterId: "cloudflare:containers:vcpu_second",
                    resourceFamily: "cloudflare.containers",
                    resourceId: "container:api",
                    operation: "vcpu_second",
                    kind: "gateway_compute",
                    quantity: 4,
                  },
                  {
                    installationId: "inst_cloud",
                    meterId: "cloudflare:durable_objects:operation",
                    resourceFamily: "cloudflare.durable_objects",
                    resourceId: "durable_object:session",
                    operation: "operation",
                    kind: "gateway_compute",
                    quantity: 2,
                  },
                ]),
              },
            },
          ),
      },
    } as never,
    { basePath: "/cloud/usage", handlerKey: "TAKOSUMI_CLOUD_USAGE" },
    async () => ({
      authenticated: true,
      authKind: "service-token",
      subject: "svc_cloud_usage",
      spaceId: "space_cloud",
      installationId: "inst_cloud",
      scopes: ["cloud.usage.write"],
    }),
    async (spaceId, input) => {
      recorded.push({ spaceId, input: input as Record<string, unknown> });
    },
  );

  expect(response.status).toBe(200);
  expect(recorded).toEqual([
    {
      spaceId: "space_cloud",
      input: expect.objectContaining({
        installationId: "inst_cloud",
        meterId: "cloudflare:containers:vcpu_second",
        resourceFamily: "cloudflare.containers",
        resourceId: "container:api",
        operation: "vcpu_second",
        kind: "gateway_compute",
        quantity: 4,
        usdMicros: 4,
        spendRequired: true,
        createdAt: periodEnd,
      }),
    },
    {
      spaceId: "space_cloud",
      input: expect.objectContaining({
        installationId: "inst_cloud",
        meterId: "cloudflare:durable_objects:operation",
        resourceFamily: "cloudflare.durable_objects",
        resourceId: "durable_object:session",
        operation: "operation",
        kind: "gateway_compute",
        quantity: 2,
        usdMicros: 1_000,
        spendRequired: true,
        createdAt: periodEnd,
      }),
    },
  ]);
});

test("cloud extension usage metering fails closed for unknown meters", async () => {
  const recorded: unknown[] = [];
  const response = await handlePlatformCloudExtensionRouteRequest(
    new Request("https://app.takosumi.com/gateway/ai/v1/chat/completions", {
      method: "POST",
    }),
    {
      TAKOSUMI_CLOUD_USAGE_PRICE_BOOK: TEST_CLOUD_USAGE_PRICE_BOOK,
      TAKOSUMI_CLOUD_AI: {
        fetch: async () =>
          Response.json(
            { id: "chatcmpl" },
            {
              headers: {
                "x-takosumi-cloud-usage-space-id": "space_cloud",
                "x-takosumi-cloud-usage-period-start":
                  "2026-06-28T10:00:00.000Z",
                "x-takosumi-cloud-usage-period-end": "2026-06-28T10:00:01.000Z",
                "x-takosumi-cloud-usage-meters": JSON.stringify([
                  {
                    meterId: "unknown:meter",
                    kind: "ai_request",
                    quantity: 1,
                  },
                ]),
              },
            },
          ),
      },
    } as never,
    { basePath: "/gateway/ai/v1", handlerKey: "TAKOSUMI_CLOUD_AI" },
    async () => ({
      authenticated: true,
      authKind: "service-token",
      subject: "svc",
      spaceId: "space_cloud",
      scopes: ["admin"],
    }),
    async (_spaceId, input) => {
      recorded.push(input);
    },
  );

  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({
    error: "cloud_extension_usage_metering_failed",
    reason: "usage_price_missing",
  });
  expect(recorded).toEqual([]);
});

test("cloud extension authenticates personal access tokens through accounts introspection", async () => {
  const introspectionRequests: { url: string; body: string }[] = [];
  const context = await verifyPlatformCloudExtensionPersonalAccessToken(
    new Request("https://app.takosumi.com/gateway/ai/v1/models", {
      headers: { authorization: "Bearer takpat_cloud" },
    }),
    {
      TAKOSUMI_ACCOUNTS_CLIENT_ID: "takosumi-cloud-extensions",
      TAKOSUMI_ACCOUNTS_CLIENT_SECRET: "client-secret",
    } as never,
    "takpat_cloud",
    { basePath: "/gateway/ai/v1", handlerKey: "TAKOSUMI_CLOUD_AI" },
    async (request: Request) => {
      introspectionRequests.push({
        url: request.url,
        body: await request.text(),
      });
      return Response.json({
        active: true,
        scope: "ai.chat ai.models.read",
        sub: "tsub_pat_user",
      });
    },
  );
  expect(context).toEqual({
    authenticated: true,
    authKind: "personal-access-token",
    subject: "tsub_pat_user",
    scopes: ["ai.chat", "ai.models.read"],
  });
  expect(introspectionRequests[0]?.url).toBe(
    "https://app.takosumi.com/oauth/introspect",
  );
  expect(introspectionRequests[0]?.body).toContain("token=takpat_cloud");
});

test("cloud extension service access token enforces descriptor scopes", async () => {
  const env = {
    TAKOSUMI_ACCOUNTS_CLIENT_ID: "takosumi-cloud-extensions",
    TAKOSUMI_ACCOUNTS_CLIENT_SECRET: "client-secret",
  } as never;
  const route = {
    basePath: "/gateway/ai/v1",
    handlerKey: "TAKOSUMI_CLOUD_AI",
    requiredScopes: ["ai.chat"],
  };
  const introspect = (scope: string) => async () =>
    Response.json({ active: true, scope, sub: "svc" });

  const denied = await verifyPlatformCloudExtensionServiceAccessToken(
    new Request("https://app.takosumi.com/gateway/ai/v1/chat/completions", {
      method: "POST",
    }),
    env,
    "taksrv_token",
    route,
    introspect("ai.models.read"),
  );
  expect(denied).toEqual({ authenticated: false });

  const allowed = await verifyPlatformCloudExtensionServiceAccessToken(
    new Request("https://app.takosumi.com/gateway/ai/v1/chat/completions", {
      method: "POST",
    }),
    env,
    "taksrv_token",
    route,
    introspect("ai.chat"),
  );
  expect(allowed.authenticated).toBe(true);
  expect(allowed.authKind).toBe("service-token");
});

test("cloud extension route matcher rejects near-prefixes", () => {
  const routes = platformCloudExtensionRoutes({
    TAKOSUMI_CLOUD_EXTENSIONS: JSON.stringify([
      { basePath: "/gateway/ai/v1", handlerKey: "TAKOSUMI_CLOUD_AI" },
    ]),
  });
  expect(
    matchPlatformCloudExtensionRoute("/gateway/ai/v1", routes),
  ).toBeDefined();
  expect(
    matchPlatformCloudExtensionRoute("/gateway/ai/v1/models", routes),
  ).toBeDefined();
  expect(
    matchPlatformCloudExtensionRoute("/gateway/ai/v1-other", routes),
  ).toBeUndefined();
  expect(
    matchPlatformCloudExtensionRoute("/gateway/ai", routes),
  ).toBeUndefined();
});

test("cloud extension catalog reports configured extensions without binding names", async () => {
  const env = {
    TAKOSUMI_CLOUD_EXTENSIONS: JSON.stringify([
      {
        id: "ai",
        kind: "ai_gateway",
        protocol: "openai-compatible",
        basePath: "/gateway/ai/v1",
        handlerKey: "TAKOSUMI_CLOUD_AI",
        capabilities: ["openai.chat_completions"],
        smokeChecks: ["models"],
        requiredScopes: ["ai.chat"],
      },
      { basePath: "/compat/x", handlerKey: "TAKOSUMI_CLOUD_X" },
    ]),
    TAKOSUMI_CLOUD_AI: { fetch: async () => new Response("") },
  } as never;
  const catalog = platformCloudExtensionCatalog(
    env,
    "https://app.takosumi.com",
  );
  expect(catalog.kind).toBe("takosumi.platform-cloud-extensions@v1");
  expect(catalog.summary).toEqual({ total: 2, configured: 1, missing: 1 });
  expect(catalog.extensions).toEqual([
    {
      id: "ai",
      kind: "ai_gateway",
      protocol: "openai-compatible",
      basePath: "/gateway/ai/v1",
      configured: true,
      capabilities: ["openai.chat_completions"],
      smokeChecks: ["models"],
      requiredScopes: ["ai.chat"],
    },
    { basePath: "/compat/x", configured: false },
  ]);
  // The catalog never leaks the underlying handler keys.
  expect(JSON.stringify(catalog)).not.toContain("TAKOSUMI_CLOUD_AI");
});

test("cloud extension catalog accepts dashboard sessions or operator bearer", async () => {
  expect(
    isPlatformCloudExtensionCatalogPath("/__takosumi/cloud/extensions"),
  ).toBe(true);

  const noSession = await handlePlatformCloudExtensionCatalogRequest(
    new Request("https://app.takosumi.com/__takosumi/cloud/extensions"),
    new URL("https://app.takosumi.com/__takosumi/cloud/extensions"),
    {} as never,
    async () => ({ authenticated: false }),
  );
  expect(noSession.status).toBe(401);

  const wrongBearer = await handlePlatformCloudExtensionCatalogRequest(
    new Request("https://app.takosumi.com/__takosumi/cloud/extensions", {
      headers: { authorization: "Bearer wrong" },
    }),
    new URL("https://app.takosumi.com/__takosumi/cloud/extensions"),
    { TAKOSUMI_DEPLOY_CONTROL_TOKEN: "operator-secret" } as never,
  );
  expect(wrongBearer.status).toBe(401);

  const sessionResponse = await handlePlatformCloudExtensionCatalogRequest(
    new Request("https://app.takosumi.com/__takosumi/cloud/extensions", {
      headers: { cookie: "takosumi_session=test" },
    }),
    new URL("https://app.takosumi.com/__takosumi/cloud/extensions"),
    {} as never,
    async () => ({
      authenticated: true,
      authKind: "session",
      subject: "acct_1",
    }),
  );
  expect(sessionResponse.status).toBe(200);

  const response = await handlePlatformCloudExtensionCatalogRequest(
    new Request("https://app.takosumi.com/__takosumi/cloud/extensions", {
      headers: { authorization: "Bearer operator-secret" },
    }),
    new URL("https://app.takosumi.com/__takosumi/cloud/extensions"),
    { TAKOSUMI_DEPLOY_CONTROL_TOKEN: "operator-secret" } as never,
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    kind: "takosumi.platform-cloud-extensions@v1",
    extensions: [],
  });
});

test("handlePlatformCloudExtensionRequest returns undefined for unmatched paths", async () => {
  const result = await handlePlatformCloudExtensionRequest(
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
