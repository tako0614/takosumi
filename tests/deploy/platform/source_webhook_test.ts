import { expect, test } from "bun:test";

import { InMemoryRuntimeAgentRegistry } from "../../../core/agents/registry.ts";
import {
  driftCheckEnabled,
  evaluateProductionHardeningGates,
  handleOperatorBillingRequest,
  handlePlatformCloudExtensionRequest,
  handlePlatformCloudExtensionCatalogRequest,
  handlePlatformCloudExtensionRouteRequest,
  handlePlatformCloudflareCompatRequest,
  handlePlatformAiGatewayRequest,
  handlePlatformMetricsDashboardRequest,
  handlePlatformMetricsRequest,
  handlePlatformRuntimeCellDrillRequest,
  handleSourceWebhookRequest,
  isOidcMetricPath,
  isPlatformCloudExtensionCatalogPath,
  matchPlatformCloudExtensionRoute,
  platformCloudExtensionCatalog,
  platformCloudExtensionRouteById,
  isPlatformMetricsDashboardPath,
  isPlatformMetricsPath,
  oidcMetricRoute,
  PLATFORM_CLOUD_EXTENSION_ROUTES,
  PLATFORM_CLOUD_EXTENSION_USAGE_METERS_HEADER,
  PLATFORM_CLOUD_EXTENSION_USAGE_PERIOD_END_HEADER,
  PLATFORM_CLOUD_EXTENSION_USAGE_PERIOD_START_HEADER,
  PLATFORM_CLOUD_EXTENSION_USAGE_SPACE_ID_HEADER,
  pollAutoSyncSources,
  summarizePrometheusMetrics,
  verifyPlatformCloudExtensionPersonalAccessToken,
  verifyPlatformCloudExtensionServiceAccessToken,
  type OperatorBillingOperations,
  type PlatformCloudExtensionUsageOperations,
  type SourcePollOperations,
  type SourceWebhookOperations,
} from "../../../deploy/platform/worker.ts";

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
    TAKOSUMI_PROVIDER_CATALOG_EVIDENCE_REF:
      "git+ssh://git@example.com/operator/proofs.git@0123456789abcdef0123456789abcdef01234567#providers.md",
    TAKOSUMI_PROVIDER_CATALOG_EVIDENCE_DIGEST:
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
    TAKOSUMI_PROVIDER_CATALOG_EVIDENCE_REF:
      "git+ssh://git@example.com/operator/proofs.git@0123456789abcdef0123456789abcdef01234567#providers.md",
    TAKOSUMI_PROVIDER_CATALOG_EVIDENCE_DIGEST:
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
} {
  const subscriptionCalls: {
    spaceId: string;
    billingSettings: unknown;
  }[] = [];
  return {
    ops: {
      getSpaceBilling: async (spaceId) => ({
        billing: {
          settings: { mode: "showback", provider: "manual" },
          balance: { spaceId, availableCredits: 0, reservedCredits: 0 },
        },
      }),
      changeSpaceSubscription: async (spaceId, input) => {
        subscriptionCalls.push({
          spaceId,
          billingSettings: input.billingSettings,
        });
        return { billing: { settings: input.billingSettings } };
      },
    },
    subscriptionCalls,
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
  const { ops, subscriptionCalls } = makeOperatorBillingOps();
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

test("AI Gateway route stays unmounted without the Cloud extension binding", async () => {
  const worker = (await import("../../../deploy/platform/worker.ts")).default;

  const response = await worker.fetch(
    new Request("https://app.takosumi.com/gateway/ai/v1/models"),
    {
      TAKOSUMI_AI_GATEWAY_PROFILES: JSON.stringify([
        {
          id: "deepseek",
          provider: "deepseek",
          baseUrl: "https://api.deepseek.example/v1",
          apiKeyEnv: "TAKOSUMI_AI_GATEWAY_DEEPSEEK_API_KEY",
          models: [
            {
              publicModel: "deepseek/chat",
              upstreamModel: "deepseek-chat",
              endpoints: ["chat.completions"],
              default: true,
            },
          ],
        },
      ]),
      TAKOSUMI_AI_GATEWAY_DEEPSEEK_API_KEY: "upstream-secret",
    } as never,
  );
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: "not found" });
});

test("AI Gateway route delegates only to the Cloud extension binding", async () => {
  const forwarded: { url: string; authorization: string | null }[] = [];
  const response = await handlePlatformAiGatewayRequest(
    new Request("https://app.takosumi.com/gateway/ai/v1/models", {
      headers: { authorization: "Bearer runtime-token" },
    }),
    {
      TAKOSUMI_CLOUD_AI_GATEWAY: {
        fetch: async (request: Request) => {
          forwarded.push({
            url: request.url,
            authorization: request.headers.get("authorization"),
          });
          return Response.json({
            object: "list",
            data: [{ id: "takosumi/default", object: "model" }],
          });
        },
      },
    } as never,
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    object: "list",
    data: [{ id: "takosumi/default", object: "model" }],
  });
  expect(forwarded).toEqual([
    {
      url: "https://app.takosumi.com/gateway/ai/v1/models",
      authorization: null,
    },
  ]);
});

test("AI Gateway HEAD delegates as GET and returns no body", async () => {
  const forwarded: { method: string; url: string }[] = [];
  const response = await handlePlatformCloudExtensionRouteRequest(
    new Request("https://app.takosumi.com/gateway/ai/v1/models", {
      method: "HEAD",
      headers: { cookie: "takosumi_session=sess_cookie" },
    }),
    {
      TAKOSUMI_CLOUD_AI_GATEWAY: {
        fetch: async (request: Request) => {
          forwarded.push({ method: request.method, url: request.url });
          return Response.json({ object: "list", data: [] });
        },
      },
    } as never,
    {
      id: "ai.openai_compatible.v1",
      kind: "ai_gateway",
      basePath: "/gateway/ai/v1",
      bindingName: "TAKOSUMI_CLOUD_AI_GATEWAY",
      protocol: "openai-compatible",
      capabilities: ["models"],
      smokeChecks: ["aiModelsAuth"],
    },
    async () => ({
      authenticated: true,
      authKind: "session",
      subject: "tsub_cloud_extension_head",
    }),
  );
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("");
  expect(forwarded).toEqual([
    {
      method: "GET",
      url: "https://app.takosumi.com/gateway/ai/v1/models",
    },
  ]);
});

test("AI Gateway route delegates through the platform worker fetch registry", async () => {
  const worker = (await import("../../../deploy/platform/worker.ts")).default;
  const forwarded: string[] = [];
  const response = await worker.fetch(
    new Request("https://app.takosumi.com/gateway/ai/v1/models"),
    {
      TAKOSUMI_CLOUD_AI_GATEWAY: {
        fetch: async (request: Request) => {
          forwarded.push(request.url);
          return Response.json({ object: "list", data: [] });
        },
      },
    } as never,
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ object: "list", data: [] });
  expect(forwarded).toEqual(["https://app.takosumi.com/gateway/ai/v1/models"]);
});

test("Cloud-only extension routes receive platform auth context without raw session material", async () => {
  const forwarded: {
    authorization: string | null;
    cookie: string | null;
    proxyAuthorization: string | null;
    xAuthEmail: string | null;
    xAuthKey: string | null;
    xAuthUserServiceKey: string | null;
    session: string | null;
    authenticated: string | null;
    authKind: string | null;
    scopes: string | null;
    subject: string | null;
    installationId: string | null;
    spaceId: string | null;
  }[] = [];
  const response = await handlePlatformCloudExtensionRouteRequest(
    new Request("https://app.takosumi.com/gateway/ai/v1/models", {
      headers: {
        authorization: "Bearer sess_secret",
        cookie: "takosumi_session=sess_cookie",
        "proxy-authorization": "Basic proxy_secret",
        "x-auth-email": "root@example.test",
        "x-auth-key": "global_api_key",
        "x-auth-user-service-key": "service_key",
        "x-takosumi-account-session": "sess_header",
        "x-takosumi-cloud-authenticated": "1",
        "x-takosumi-cloud-auth-kind": "spoofed",
        "x-takosumi-cloud-scopes": "admin",
        "x-takosumi-cloud-subject": "spoofed",
        "x-takosumi-cloud-installation-id": "spoofed",
        "x-takosumi-cloud-space-id": "spoofed",
      },
    }),
    {
      TAKOSUMI_CLOUD_AI_GATEWAY: {
        fetch: async (request: Request) => {
          forwarded.push({
            authorization: request.headers.get("authorization"),
            cookie: request.headers.get("cookie"),
            proxyAuthorization: request.headers.get("proxy-authorization"),
            xAuthEmail: request.headers.get("x-auth-email"),
            xAuthKey: request.headers.get("x-auth-key"),
            xAuthUserServiceKey: request.headers.get("x-auth-user-service-key"),
            session: request.headers.get("x-takosumi-account-session"),
            authenticated: request.headers.get(
              "x-takosumi-cloud-authenticated",
            ),
            authKind: request.headers.get("x-takosumi-cloud-auth-kind"),
            scopes: request.headers.get("x-takosumi-cloud-scopes"),
            subject: request.headers.get("x-takosumi-cloud-subject"),
            installationId: request.headers.get(
              "x-takosumi-cloud-installation-id",
            ),
            spaceId: request.headers.get("x-takosumi-cloud-space-id"),
          });
          return Response.json({ object: "list", data: [] });
        },
      },
    } as never,
    {
      id: "ai.openai_compatible.v1",
      kind: "ai_gateway",
      basePath: "/gateway/ai/v1",
      bindingName: "TAKOSUMI_CLOUD_AI_GATEWAY",
      protocol: "openai-compatible",
      capabilities: ["models"],
      smokeChecks: ["aiModelsAuth"],
    },
    async () => ({
      authenticated: true,
      authKind: "session",
      subject: "tsub_cloud_extension_smoke",
      installationId: "inst_cloud_extension_smoke",
      spaceId: "space_cloud_extension_smoke",
    }),
  );
  expect(response.status).toBe(200);
  expect(forwarded).toEqual([
    {
      authorization: null,
      cookie: null,
      proxyAuthorization: null,
      xAuthEmail: null,
      xAuthKey: null,
      xAuthUserServiceKey: null,
      session: null,
      authenticated: "1",
      authKind: "session",
      scopes: null,
      subject: "tsub_cloud_extension_smoke",
      installationId: "inst_cloud_extension_smoke",
      spaceId: "space_cloud_extension_smoke",
    },
  ]);
});

test("Cloud-only extension routes strip raw credentials even when auth fails", async () => {
  const forwarded: {
    authorization: string | null;
    cookie: string | null;
    proxyAuthorization: string | null;
    xAuthEmail: string | null;
    xAuthKey: string | null;
    xAuthUserServiceKey: string | null;
    session: string | null;
    authenticated: string | null;
    authKind: string | null;
    scopes: string | null;
    subject: string | null;
    installationId: string | null;
    spaceId: string | null;
  }[] = [];
  const response = await handlePlatformCloudExtensionRouteRequest(
    new Request("https://app.takosumi.com/gateway/ai/v1/models", {
      headers: {
        authorization: "Bearer taksrv_bad_scope",
        cookie: "takosumi_session=sess_cookie",
        "proxy-authorization": "Basic proxy_secret",
        "x-auth-email": "root@example.test",
        "x-auth-key": "global_api_key",
        "x-auth-user-service-key": "service_key",
        "x-takosumi-account-session": "sess_header",
        "x-takosumi-cloud-authenticated": "1",
        "x-takosumi-cloud-auth-kind": "spoofed",
        "x-takosumi-cloud-scopes": "admin",
        "x-takosumi-cloud-subject": "spoofed",
        "x-takosumi-cloud-installation-id": "spoofed",
        "x-takosumi-cloud-space-id": "spoofed",
      },
    }),
    {
      TAKOSUMI_CLOUD_AI_GATEWAY: {
        fetch: async (request: Request) => {
          forwarded.push({
            authorization: request.headers.get("authorization"),
            cookie: request.headers.get("cookie"),
            proxyAuthorization: request.headers.get("proxy-authorization"),
            xAuthEmail: request.headers.get("x-auth-email"),
            xAuthKey: request.headers.get("x-auth-key"),
            xAuthUserServiceKey: request.headers.get("x-auth-user-service-key"),
            session: request.headers.get("x-takosumi-account-session"),
            authenticated: request.headers.get(
              "x-takosumi-cloud-authenticated",
            ),
            authKind: request.headers.get("x-takosumi-cloud-auth-kind"),
            scopes: request.headers.get("x-takosumi-cloud-scopes"),
            subject: request.headers.get("x-takosumi-cloud-subject"),
            installationId: request.headers.get(
              "x-takosumi-cloud-installation-id",
            ),
            spaceId: request.headers.get("x-takosumi-cloud-space-id"),
          });
          return Response.json(
            {
              error: {
                type: "unauthorized",
                code: "unauthorized",
              },
            },
            { status: 401 },
          );
        },
      },
    } as never,
    {
      id: "ai.openai_compatible.v1",
      kind: "ai_gateway",
      basePath: "/gateway/ai/v1",
      bindingName: "TAKOSUMI_CLOUD_AI_GATEWAY",
      protocol: "openai-compatible",
      capabilities: ["models"],
      smokeChecks: ["aiModelsAuth"],
    },
    async () => ({ authenticated: false }),
  );
  expect(response.status).toBe(401);
  expect(forwarded).toEqual([
    {
      authorization: null,
      cookie: null,
      proxyAuthorization: null,
      xAuthEmail: null,
      xAuthKey: null,
      xAuthUserServiceKey: null,
      session: null,
      authenticated: null,
      authKind: null,
      scopes: null,
      subject: null,
      installationId: null,
      spaceId: null,
    },
  ]);
});

test("Cloud-only extension routes authenticate personal access tokens through accounts introspection", async () => {
  const introspectionRequests: {
    url: string;
    body: string;
    contentType: string | null;
  }[] = [];
  const providerRoute = platformCloudExtensionRouteById(
    "provider.cloudflare.client_v4",
  );
  if (!providerRoute) throw new Error("Cloudflare extension route is missing");
  const context = await verifyPlatformCloudExtensionPersonalAccessToken(
    new Request(
      "https://app.takosumi.com/compat/cloudflare/client/v4/accounts",
      {
        headers: { authorization: "Bearer takpat_cloud_provider" },
      },
    ),
    {
      TAKOSUMI_ACCOUNTS_CLIENT_ID: "takosumi-cloud-extensions",
      TAKOSUMI_ACCOUNTS_CLIENT_SECRET: "client-secret",
    } as never,
    "takpat_cloud_provider",
    providerRoute,
    async (request: Request) => {
      introspectionRequests.push({
        url: request.url,
        body: await request.text(),
        contentType: request.headers.get("content-type"),
      });
      return Response.json({
        active: true,
        scope: "read write",
        sub: "tsub_provider_user",
      });
    },
  );

  expect(context).toEqual({
    authenticated: true,
    authKind: "personal-access-token",
    subject: "tsub_provider_user",
    scopes: ["read", "write"],
  });
  expect(introspectionRequests).toHaveLength(1);
  expect(introspectionRequests[0]?.url).toBe(
    "https://app.takosumi.com/oauth/introspect",
  );
  expect(introspectionRequests[0]?.contentType).toBe(
    "application/x-www-form-urlencoded",
  );
  expect(introspectionRequests[0]?.body).toContain(
    "client_id=takosumi-cloud-extensions",
  );
  expect(introspectionRequests[0]?.body).toContain(
    "token=takpat_cloud_provider",
  );
});

test("Cloud-only extension personal access token scopes are route and method aware", async () => {
  const aiRoute = platformCloudExtensionRouteById("ai.openai_compatible.v1");
  const providerRoute = platformCloudExtensionRouteById(
    "provider.cloudflare.client_v4",
  );
  if (!aiRoute || !providerRoute) {
    throw new Error("Cloud extension routes are missing");
  }
  const env = {
    TAKOSUMI_ACCOUNTS_CLIENT_ID: "takosumi-cloud-extensions",
    TAKOSUMI_ACCOUNTS_CLIENT_SECRET: "client-secret",
  } as never;
  const introspect = (scope: string) => async () =>
    Response.json({
      active: true,
      scope,
      sub: "tsub_provider_user",
    });

  const readModels = await verifyPlatformCloudExtensionPersonalAccessToken(
    new Request("https://app.takosumi.com/gateway/ai/v1/models"),
    env,
    "takpat_read",
    aiRoute,
    introspect("read"),
  );
  expect(readModels.authenticated).toBe(true);

  const readChat = await verifyPlatformCloudExtensionPersonalAccessToken(
    new Request("https://app.takosumi.com/gateway/ai/v1/chat/completions", {
      method: "POST",
    }),
    env,
    "takpat_read",
    aiRoute,
    introspect("read"),
  );
  expect(readChat).toEqual({ authenticated: false });

  const writeChat = await verifyPlatformCloudExtensionPersonalAccessToken(
    new Request("https://app.takosumi.com/gateway/ai/v1/chat/completions", {
      method: "POST",
    }),
    env,
    "takpat_write",
    aiRoute,
    introspect("write"),
  );
  expect(writeChat.authenticated).toBe(true);

  const readCloudflareMutation =
    await verifyPlatformCloudExtensionPersonalAccessToken(
      new Request(
        "https://app.takosumi.com/compat/cloudflare/client/v4/accounts/virtual/workers/scripts/api",
        { method: "PUT" },
      ),
      env,
      "takpat_read",
      providerRoute,
      introspect("read"),
    );
  expect(readCloudflareMutation).toEqual({ authenticated: false });

  const writeCloudflareMutation =
    await verifyPlatformCloudExtensionPersonalAccessToken(
      new Request(
        "https://app.takosumi.com/compat/cloudflare/client/v4/accounts/virtual/workers/scripts/api",
        { method: "PUT" },
      ),
      env,
      "takpat_write",
      providerRoute,
      introspect("write"),
    );
  expect(writeCloudflareMutation.authenticated).toBe(true);
});

test("Cloud-only extension personal access token auth fails closed", async () => {
  const inactive = await verifyPlatformCloudExtensionPersonalAccessToken(
    new Request("https://app.takosumi.com/gateway/ai/v1/models"),
    {
      TAKOSUMI_ACCOUNTS_CLIENT_ID: "takosumi-cloud-extensions",
      TAKOSUMI_ACCOUNTS_CLIENT_SECRET: "client-secret",
    } as never,
    "takpat_inactive",
    async () => Response.json({ active: false }),
  );
  expect(inactive).toEqual({ authenticated: false });

  const insufficientScope =
    await verifyPlatformCloudExtensionPersonalAccessToken(
      new Request("https://app.takosumi.com/gateway/ai/v1/models"),
      {
        TAKOSUMI_ACCOUNTS_CLIENT_ID: "takosumi-cloud-extensions",
        TAKOSUMI_ACCOUNTS_CLIENT_SECRET: "client-secret",
      } as never,
      "takpat_insufficient",
      async () => Response.json({ active: true, scope: "profile" }),
    );
  expect(insufficientScope).toEqual({ authenticated: false });
});

test("Cloud-only AI Gateway accepts scoped Service Graph runtime tokens", async () => {
  const introspectionRequests: { body: string }[] = [];
  const aiRoute = platformCloudExtensionRouteById("ai.openai_compatible.v1");
  if (!aiRoute) throw new Error("AI Gateway extension route is missing");

  const context = await verifyPlatformCloudExtensionServiceAccessToken(
    new Request("https://app.takosumi.com/gateway/ai/v1/models", {
      headers: { authorization: "Bearer taksrv_runtime" },
    }),
    {
      TAKOSUMI_ACCOUNTS_CLIENT_ID: "takosumi-cloud-extensions",
      TAKOSUMI_ACCOUNTS_CLIENT_SECRET: "client-secret",
    } as never,
    "taksrv_runtime",
    aiRoute,
    async (request: Request) => {
      introspectionRequests.push({ body: await request.text() });
      return Response.json({
        active: true,
        client_id: "service-graph-service:takosumi.ai.gateway",
        scope: "ai.model ai.models.read",
        sub: "service-graph-service:inst_ai",
        takosumi: {
          installation_id: "inst_ai",
          space_id: "space_ai",
        },
      });
    },
  );

  expect(context).toEqual({
    authenticated: true,
    authKind: "service-token",
    subject: "service-graph-service:inst_ai",
    installationId: "inst_ai",
    spaceId: "space_ai",
    scopes: ["ai.model", "ai.models.read"],
  });
  expect(introspectionRequests[0]?.body).toContain("token=taksrv_runtime");

  const headContext = await verifyPlatformCloudExtensionServiceAccessToken(
    new Request("https://app.takosumi.com/gateway/ai/v1/models", {
      method: "HEAD",
      headers: { authorization: "Bearer taksrv_runtime" },
    }),
    {
      TAKOSUMI_ACCOUNTS_CLIENT_ID: "takosumi-cloud-extensions",
      TAKOSUMI_ACCOUNTS_CLIENT_SECRET: "client-secret",
    } as never,
    "taksrv_runtime",
    aiRoute,
    async () =>
      Response.json({
        active: true,
        client_id: "service-graph-service:takosumi.ai.gateway",
        scope: "ai.model ai.models.read",
        sub: "service-graph-service:inst_ai",
        takosumi: {
          installation_id: "inst_ai",
          space_id: "space_ai",
        },
      }),
  );
  expect(headContext).toMatchObject({
    authenticated: true,
    installationId: "inst_ai",
    spaceId: "space_ai",
  });

  const missingChatScope = await verifyPlatformCloudExtensionServiceAccessToken(
    new Request("https://app.takosumi.com/gateway/ai/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer taksrv_runtime" },
    }),
    {
      TAKOSUMI_ACCOUNTS_CLIENT_ID: "takosumi-cloud-extensions",
      TAKOSUMI_ACCOUNTS_CLIENT_SECRET: "client-secret",
    } as never,
    "taksrv_runtime",
    aiRoute,
    async () =>
      Response.json({
        active: true,
        client_id: "service-graph-service:takosumi.ai.gateway",
        scope: "ai.model ai.models.read",
      }),
  );
  expect(missingChatScope).toEqual({ authenticated: false });

  const providerRoute = {
    id: "provider.cloudflare.client_v4",
    kind: "provider_compat",
    provider: "cloudflare",
    basePath: "/compat/cloudflare/client/v4",
    bindingName: "TAKOSUMI_CLOUD_CLOUDFLARE_COMPAT",
    protocol: "cloudflare-v4",
    capabilities: ["accounts.list"],
    smokeChecks: ["cloudflareCompatAccountsAuth"],
  } as const;
  const providerContext = await verifyPlatformCloudExtensionServiceAccessToken(
    new Request(
      "https://app.takosumi.com/compat/cloudflare/client/v4/accounts",
      {
        headers: { authorization: "Bearer taksrv_runtime" },
      },
    ),
    {
      TAKOSUMI_ACCOUNTS_CLIENT_ID: "takosumi-cloud-extensions",
      TAKOSUMI_ACCOUNTS_CLIENT_SECRET: "client-secret",
    } as never,
    "taksrv_runtime",
    providerRoute,
    async () => {
      throw new Error("provider compat must not introspect service tokens");
    },
  );
  expect(providerContext).toEqual({ authenticated: false });
});

test("Cloudflare Compatibility Gateway route stays unmounted without the Cloud extension binding", async () => {
  const worker = (await import("../../../deploy/platform/worker.ts")).default;
  const response = await worker.fetch(
    new Request(
      "https://app.takosumi.com/compat/cloudflare/client/v4/accounts/virtual/workers/scripts/api",
      { headers: { authorization: "Bearer runtime-token" } },
    ),
    {} as never,
  );
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: "not found" });
});

test("Cloudflare Compatibility Gateway route delegates only to the Cloud extension binding", async () => {
  const forwarded: { url: string; authorization: string | null }[] = [];
  const response = await handlePlatformCloudflareCompatRequest(
    new Request(
      "https://app.takosumi.com/compat/cloudflare/client/v4/accounts/virtual/workers/scripts/api",
      { headers: { authorization: "Bearer cf-compat-token" } },
    ),
    {
      TAKOSUMI_CLOUD_CLOUDFLARE_COMPAT: {
        fetch: async (request: Request) => {
          forwarded.push({
            url: request.url,
            authorization: request.headers.get("authorization"),
          });
          return Response.json({
            success: true,
            result: { id: "api", script_name: "api" },
            errors: [],
            messages: [],
          });
        },
      },
    } as never,
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    success: true,
    result: { id: "api", script_name: "api" },
    errors: [],
    messages: [],
  });
  expect(forwarded).toEqual([
    {
      url: "https://app.takosumi.com/compat/cloudflare/client/v4/accounts/virtual/workers/scripts/api",
      authorization: null,
    },
  ]);
});

test("Cloud extension route records reported Workers and AI usage", async () => {
  const route = platformCloudExtensionRouteById("ai.openai_compatible.v1");
  if (!route) throw new Error("AI Gateway route missing");
  const usageCalls: {
    spaceId: string;
    input: Parameters<
      PlatformCloudExtensionUsageOperations["recordGatewayResourceUsage"]
    >[1];
  }[] = [];
  const usageOps: PlatformCloudExtensionUsageOperations = {
    recordGatewayResourceUsage: async (spaceId, input) => {
      usageCalls.push({ spaceId, input });
      return { usageEvents: [{ id: "usage_1" }] };
    },
  };
  const response = await handlePlatformCloudExtensionRouteRequest(
    new Request("https://app.takosumi.com/gateway/ai/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "takosumi/default", messages: [] }),
    }),
    {
      TAKOSUMI_CLOUD_AI_GATEWAY: {
        fetch: async () =>
          Response.json(
            { id: "chatcmpl_1", choices: [] },
            {
              headers: {
                [PLATFORM_CLOUD_EXTENSION_USAGE_SPACE_ID_HEADER]: "space_usage",
                [PLATFORM_CLOUD_EXTENSION_USAGE_PERIOD_START_HEADER]:
                  "2026-06-26T13:00:00.000Z",
                [PLATFORM_CLOUD_EXTENSION_USAGE_PERIOD_END_HEADER]:
                  "2026-06-26T13:01:00.000Z",
                [PLATFORM_CLOUD_EXTENSION_USAGE_METERS_HEADER]: JSON.stringify([
                  {
                    meterId: "ai:takosumi-default:request",
                    kind: "ai_request",
                    quantity: 1,
                    credits: 2,
                  },
                  {
                    meterId: "workers:compat:cpu",
                    installationId: "inst_worker",
                    kind: "gateway_compute",
                    quantity: 42,
                    credits: 3,
                  },
                ]),
              },
            },
          ),
      },
    } as never,
    route,
    async () => ({ authenticated: true, authKind: "personal-access-token" }),
    usageOps,
  );
  expect(response.status).toBe(200);
  expect(
    response.headers.get(PLATFORM_CLOUD_EXTENSION_USAGE_METERS_HEADER),
  ).toBe(null);
  expect(usageCalls).toEqual([
    {
      spaceId: "space_usage",
      input: {
        periodStart: "2026-06-26T13:00:00.000Z",
        periodEnd: "2026-06-26T13:01:00.000Z",
        meters: [
          {
            meterId: "ai:takosumi-default:request",
            kind: "ai_request",
            quantity: 1,
            credits: 2,
          },
          {
            meterId: "workers:compat:cpu",
            installationId: "inst_worker",
            kind: "gateway_compute",
            quantity: 42,
            credits: 3,
          },
        ],
      },
    },
  ]);
});

test("Cloud extension route fails closed when reported usage cannot be recorded", async () => {
  const route = platformCloudExtensionRouteById("ai.openai_compatible.v1");
  if (!route) throw new Error("AI Gateway route missing");
  const response = await handlePlatformCloudExtensionRouteRequest(
    new Request("https://app.takosumi.com/gateway/ai/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "takosumi/default", messages: [] }),
    }),
    {
      TAKOSUMI_CLOUD_AI_GATEWAY: {
        fetch: async () =>
          Response.json(
            { id: "chatcmpl_1", choices: [] },
            {
              headers: {
                [PLATFORM_CLOUD_EXTENSION_USAGE_SPACE_ID_HEADER]: "space_usage",
                [PLATFORM_CLOUD_EXTENSION_USAGE_PERIOD_START_HEADER]:
                  "2026-06-26T13:00:00.000Z",
                [PLATFORM_CLOUD_EXTENSION_USAGE_PERIOD_END_HEADER]:
                  "2026-06-26T13:01:00.000Z",
                [PLATFORM_CLOUD_EXTENSION_USAGE_METERS_HEADER]: JSON.stringify([
                  {
                    meterId: "ai:takosumi-default:request",
                    kind: "ai_request",
                    quantity: 1,
                    credits: 2,
                  },
                ]),
              },
            },
          ),
      },
    } as never,
    route,
    async () => ({ authenticated: true, authKind: "personal-access-token" }),
  );
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({
    error: "usage metering unavailable",
    error_description:
      "Cloud extension reported usage, but the platform usage ledger is not wired.",
  });
});

test("Cloudflare Compatibility Gateway route delegates through the platform worker fetch registry", async () => {
  const worker = (await import("../../../deploy/platform/worker.ts")).default;
  const forwarded: string[] = [];
  const response = await worker.fetch(
    new Request(
      "https://app.takosumi.com/compat/cloudflare/client/v4/accounts/virtual/workers/scripts/api",
    ),
    {
      TAKOSUMI_CLOUD_CLOUDFLARE_COMPAT: {
        fetch: async (request: Request) => {
          forwarded.push(request.url);
          return Response.json({ success: true, result: {}, errors: [] });
        },
      },
    } as never,
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    success: true,
    result: {},
    errors: [],
  });
  expect(forwarded).toEqual([
    "https://app.takosumi.com/compat/cloudflare/client/v4/accounts/virtual/workers/scripts/api",
  ]);
});

test("Cloud-only extension route matcher rejects near-prefixes and unregistered future gateways", async () => {
  expect(matchPlatformCloudExtensionRoute("/gateway/ai/v10/models")).toBe(
    undefined,
  );
  expect(
    matchPlatformCloudExtensionRoute(
      "/compat/cloudflare/client/v40/accounts/virtual",
    ),
  ).toBe(undefined);
  expect(matchPlatformCloudExtensionRoute("/compat/not-registered/v1")).toBe(
    undefined,
  );
  expect(
    await handlePlatformCloudExtensionRequest(
      new Request("https://app.takosumi.com/compat/not-registered/v1"),
      {
        TAKOSUMI_CLOUD_NOT_REGISTERED: {
          fetch: async () => Response.json({ delegated: true }),
        },
      } as never,
    ),
  ).toBe(undefined);
});

test("Cloud-only extension catalog reports configured public capabilities without binding names", async () => {
  const catalog = platformCloudExtensionCatalog(
    {
      TAKOSUMI_CLOUD_AI_GATEWAY: {
        fetch: async () => Response.json({ object: "list", data: [] }),
      },
      TAKOSUMI_CLOUD_CLOUDFLARE_COMPAT: {
        fetch: async () =>
          Response.json({ success: true, result: [], errors: [] }),
      },
    } as never,
    "https://app.takosumi.com",
  );

  expect(catalog.kind).toBe("takosumi.platform-cloud-extensions@v1");
  expect(catalog.serviceUrl).toBe("https://app.takosumi.com");
  expect(catalog.summary).toEqual({ total: 2, configured: 2, missing: 0 });
  expect(catalog.extensions.map((extension) => extension.id)).toEqual([
    "ai.openai_compatible.v1",
    "provider.cloudflare.client_v4",
  ]);
  expect(catalog.extensions.map((extension) => extension.configured)).toEqual([
    true,
    true,
  ]);
  expect(catalog.extensions[0]?.smokeChecks).toContain("aiGatewayStatus");
  const serialized = JSON.stringify(catalog);
  expect(serialized).not.toContain("TAKOSUMI_CLOUD_AI_GATEWAY");
  expect(serialized).not.toContain("TAKOSUMI_CLOUD_CLOUDFLARE_COMPAT");
});

test("Cloud-only extension catalog is a stable platform endpoint", async () => {
  const url = new URL("https://app.takosumi.com/__takosumi/cloud/extensions");
  expect(isPlatformCloudExtensionCatalogPath(url.pathname)).toBe(true);

  const response = handlePlatformCloudExtensionCatalogRequest(
    new Request(url),
    url,
    {} as never,
  );
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.summary).toEqual({ total: 2, configured: 0, missing: 2 });
  expect(JSON.stringify(body)).not.toContain("bindingName");
});

test("Cloud-only extension catalog HEAD returns headers without a body", async () => {
  const url = new URL("https://app.takosumi.com/__takosumi/cloud/extensions");
  const response = handlePlatformCloudExtensionCatalogRequest(
    new Request(url, { method: "HEAD" }),
    url,
    {} as never,
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.text()).toBe("");
});

test("Cloud-only extension registry is limited to AI Gateway and Cloudflare compatibility", async () => {
  expect(PLATFORM_CLOUD_EXTENSION_ROUTES.map((route) => route.id)).toEqual([
    "ai.openai_compatible.v1",
    "provider.cloudflare.client_v4",
  ]);
  expect(
    PLATFORM_CLOUD_EXTENSION_ROUTES.map((route) => route.basePath),
  ).toEqual(["/gateway/ai/v1", "/compat/cloudflare/client/v4"]);
  expect(
    PLATFORM_CLOUD_EXTENSION_ROUTES.filter(
      (route) => route.kind === "provider_compat",
    ).map((route) => route.provider),
  ).toEqual(["cloudflare"]);
  const aiRoute = platformCloudExtensionRouteById("ai.openai_compatible.v1");
  expect(aiRoute?.serviceAccess?.clientId).toBe(
    "service-graph-service:takosumi.ai.gateway",
  );
  expect(
    aiRoute?.serviceAccess?.rules.map((rule) => [
      rule.method,
      rule.path,
      rule.scopes,
    ]),
  ).toEqual([
    ["GET", "/gateway/ai/v1/models", ["ai.model", "ai.models.read"]],
    ["GET", "/gateway/ai/v1/__takosumi/status", ["ai.model", "ai.models.read"]],
    ["POST", "/gateway/ai/v1/chat/completions", ["ai.model", "ai.chat"]],
    ["POST", "/gateway/ai/v1/embeddings", ["ai.model", "ai.embeddings"]],
  ]);
  expect(
    platformCloudExtensionRouteById("provider.cloudflare.client_v4")
      ?.serviceAccess,
  ).toBeUndefined();
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
