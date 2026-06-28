import { expect, test } from "bun:test";

import { InMemoryRuntimeAgentRegistry } from "../../../core/agents/registry.ts";
import { OpenTofuControllerError } from "../../../core/domains/deploy-control/mod.ts";
import {
  driftCheckEnabled,
  evaluateProductionHardeningGates,
  handleOperatorBillingRequest,
  handlePlatformCloudExtensionRequest,
  handlePlatformCloudExtensionCatalogRequest,
  handlePlatformCloudExtensionRouteRequest,
  handlePlatformMetricsDashboardRequest,
  handlePlatformMetricsRequest,
  handlePlatformRuntimeCellDrillRequest,
  handleSourceWebhookRequest,
  isOperatorBillingPath,
  isOidcMetricPath,
  isPlatformCloudExtensionCatalogPath,
  matchPlatformCloudExtensionRoute,
  platformCloudExtensionCatalog,
  platformCloudExtensionRoutes,
  isPlatformMetricsDashboardPath,
  isPlatformMetricsPath,
  oidcMetricRoute,
  pollAutoSyncSources,
  summarizePrometheusMetrics,
  verifyPlatformCloudExtensionPersonalAccessToken,
  verifyPlatformCloudExtensionServiceAccessToken,
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
      meterIdPrefix: "cloudflare:queues:",
      kind: "gateway_compute",
      unit: "operation",
      chargeUsdMicrosPerUnit: 500,
      estimatedCostUsdMicrosPerUnit: 100,
      minimumChargeUsdMicros: 500,
    },
  ],
});

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
  expect(isOidcMetricPath("/api/v1/installations")).toBe(false);
  expect(oidcMetricRoute("/oauth/authorize")).toBe("/oauth/authorize");
  expect(oidcMetricRoute("/v1/auth/upstream/google/callback")).toBe(
    "/v1/auth/upstream/*",
  );
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
// (a JSON array of opaque `{ basePath, bindingName, requiredScopes? }`
// descriptors). When that env is unset, every extension path 404s; when it is
// set, a matching path verifies the platform session and proxies to the named
// service binding.

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
          basePath: "/gateway/ai/v1",
          bindingName: "TAKOSUMI_CLOUD_AI",
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
        { basePath: "/compat/x", bindingName: "TAKOSUMI_CLOUD_X" },
      ]),
    }),
  ).toEqual([
    {
      basePath: "/gateway/ai/v1",
      bindingName: "TAKOSUMI_CLOUD_AI",
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
    { basePath: "/compat/x", bindingName: "TAKOSUMI_CLOUD_X" },
  ]);
});

test("platformCloudExtensionRoutes rejects malformed descriptors", () => {
  expect(() =>
    platformCloudExtensionRoutes({ TAKOSUMI_CLOUD_EXTENSIONS: "{" }),
  ).toThrow("must be valid JSON");
  expect(() =>
    platformCloudExtensionRoutes({
      TAKOSUMI_CLOUD_EXTENSIONS: JSON.stringify([{ bindingName: "X" }]),
    }),
  ).toThrow("basePath");
  expect(() =>
    platformCloudExtensionRoutes({
      TAKOSUMI_CLOUD_EXTENSIONS: JSON.stringify([{ basePath: "/x" }]),
    }),
  ).toThrow("bindingName");
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

test("a configured cloud extension proxies to the named binding through worker.fetch", async () => {
  const worker = (await import("../../../deploy/platform/worker.ts")).default;
  const forwarded: { url: string; authorization: string | null }[] = [];
  const response = await worker.fetch(
    new Request("https://app.takosumi.com/gateway/ai/v1/models", {
      headers: { authorization: "Bearer runtime-token" },
    }),
    {
      TAKOSUMI_CLOUD_EXTENSIONS: JSON.stringify([
        { basePath: "/gateway/ai/v1", bindingName: "TAKOSUMI_CLOUD_AI" },
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
  // Raw credential material is never forwarded to the bound Cloud service.
  expect(forwarded).toEqual([
    {
      url: "https://app.takosumi.com/gateway/ai/v1/models",
      authorization: null,
    },
  ]);
});

test("a configured cloud extension 404s when its binding is absent", async () => {
  const worker = (await import("../../../deploy/platform/worker.ts")).default;
  const response = await worker.fetch(
    new Request("https://app.takosumi.com/gateway/ai/v1/models"),
    {
      TAKOSUMI_CLOUD_EXTENSIONS: JSON.stringify([
        { basePath: "/gateway/ai/v1", bindingName: "TAKOSUMI_CLOUD_AI" },
      ]),
    } as never,
  );
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: "not found" });
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
    { basePath: "/gateway/ai/v1", bindingName: "TAKOSUMI_CLOUD_AI" },
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
    { basePath: "/gateway/ai/v1", bindingName: "TAKOSUMI_CLOUD_AI" },
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

test("cloud extension requiredScopes gate token auth", async () => {
  const binding = {
    TAKOSUMI_CLOUD_AI: { fetch: async () => Response.json({ ok: true }) },
  } as never;
  const route = {
    basePath: "/gateway/ai/v1",
    bindingName: "TAKOSUMI_CLOUD_AI",
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
  // the bound Cloud service performs any finer authorization.
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
      bindingName: "TAKOSUMI_CLOUD_COMPAT",
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
      bindingName: "TAKOSUMI_CLOUD_COMPAT",
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
      bindingName: "TAKOSUMI_CLOUD_COMPAT",
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
      bindingName: "TAKOSUMI_CLOUD_COMPAT",
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
      bindingName: "TAKOSUMI_CLOUD_COMPAT",
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
      bindingName: "TAKOSUMI_CLOUD_COMPAT",
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
  );

  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({
    error: "cloud_extension_usage_metering_failed",
    reason: "usage_record_failed",
  });
});

test("cloud extension usage spend failure maps insufficient balance to payment required", async () => {
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
      bindingName: "TAKOSUMI_CLOUD_COMPAT",
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
  );

  expect(response.status).toBe(402);
  expect(await response.json()).toEqual({
    error: "cloud_extension_insufficient_credits",
    reason: "insufficient_credits",
  });
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
    { basePath: "/gateway/ai/v1", bindingName: "TAKOSUMI_CLOUD_AI" },
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
    { basePath: "/gateway/ai/v1", bindingName: "TAKOSUMI_CLOUD_AI" },
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
    bindingName: "TAKOSUMI_CLOUD_AI",
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
      { basePath: "/gateway/ai/v1", bindingName: "TAKOSUMI_CLOUD_AI" },
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
        basePath: "/gateway/ai/v1",
        bindingName: "TAKOSUMI_CLOUD_AI",
        requiredScopes: ["ai.chat"],
      },
      { basePath: "/compat/x", bindingName: "TAKOSUMI_CLOUD_X" },
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
      basePath: "/gateway/ai/v1",
      configured: true,
      requiredScopes: ["ai.chat"],
    },
    { basePath: "/compat/x", configured: false },
  ]);
  // The catalog never leaks the underlying service-binding names.
  expect(JSON.stringify(catalog)).not.toContain("TAKOSUMI_CLOUD_AI");
});

test("cloud extension catalog is a stable platform endpoint", async () => {
  expect(
    isPlatformCloudExtensionCatalogPath("/__takosumi/cloud/extensions"),
  ).toBe(true);
  const response = handlePlatformCloudExtensionCatalogRequest(
    new Request("https://app.takosumi.com/__takosumi/cloud/extensions"),
    new URL("https://app.takosumi.com/__takosumi/cloud/extensions"),
    {} as never,
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
