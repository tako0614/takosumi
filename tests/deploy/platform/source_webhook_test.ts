import { expect, test } from "bun:test";

import {
  driftCheckEnabled,
  evaluateProductionHardeningGates,
  handleOperatorBillingRequest,
  handlePlatformCloudExtensionRequest,
  handlePlatformCloudflareCompatRequest,
  handlePlatformAiGatewayRequest,
  handlePlatformMetricsDashboardRequest,
  handlePlatformMetricsRequest,
  handleSourceWebhookRequest,
  isOidcMetricPath,
  matchPlatformCloudExtensionRoute,
  isPlatformMetricsDashboardPath,
  isPlatformMetricsPath,
  oidcMetricRoute,
  pollAutoSyncSources,
  summarizePrometheusMetrics,
  type OperatorBillingOperations,
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
      authorization: "Bearer runtime-token",
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
      authorization: "Bearer cf-compat-token",
    },
  ]);
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
  expect(matchPlatformCloudExtensionRoute("/compat/aws/v1/sts")).toBe(
    undefined,
  );
  expect(
    await handlePlatformCloudExtensionRequest(
      new Request("https://app.takosumi.com/compat/aws/v1/sts"),
      {
        TAKOSUMI_CLOUD_AWS_COMPAT: {
          fetch: async () => Response.json({ delegated: true }),
        },
      } as never,
    ),
  ).toBe(undefined);
});

test("Cloud-only extension routes are registry driven for future provider gateways", async () => {
  const awsRoute = {
    id: "provider.aws.v1",
    kind: "provider_compat",
    provider: "aws",
    basePath: "/compat/aws/v1",
    bindingName: "TAKOSUMI_CLOUD_AWS_COMPAT",
  } as const;
  expect(
    matchPlatformCloudExtensionRoute("/compat/aws/v1/sts", [awsRoute]),
  ).toEqual(awsRoute);

  const missing = await handlePlatformCloudExtensionRequest(
    new Request("https://app.takosumi.com/compat/aws/v1/sts"),
    {} as never,
    [awsRoute],
  );
  expect(missing?.status).toBe(404);
  expect(await missing?.json()).toEqual({ error: "not found" });

  const forwarded: { url: string; authorization: string | null }[] = [];
  const response = await handlePlatformCloudExtensionRequest(
    new Request("https://app.takosumi.com/compat/aws/v1/sts", {
      headers: { authorization: "Bearer aws-compat-token" },
    }),
    {
      TAKOSUMI_CLOUD_AWS_COMPAT: {
        fetch: async (request: Request) => {
          forwarded.push({
            url: request.url,
            authorization: request.headers.get("authorization"),
          });
          return Response.json({
            kind: "aws-compat-test",
            delegated: true,
          });
        },
      },
    } as never,
    [awsRoute],
  );
  expect(response?.status).toBe(200);
  expect(await response?.json()).toEqual({
    kind: "aws-compat-test",
    delegated: true,
  });
  expect(forwarded).toEqual([
    {
      url: "https://app.takosumi.com/compat/aws/v1/sts",
      authorization: "Bearer aws-compat-token",
    },
  ]);
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
