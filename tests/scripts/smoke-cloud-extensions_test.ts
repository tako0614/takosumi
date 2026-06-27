import { expect, test } from "bun:test";

import {
  CLOUD_EXTENSION_SMOKE_KIND,
  runCloudExtensionSmoke,
  type CloudExtensionSmokeOptions,
} from "../../scripts/smoke-cloud-extensions.ts";

const BASE_OPTIONS: CloudExtensionSmokeOptions = {
  url: "https://app.takosumi.test",
  sessionToken: "sess_test_secret_value",
  authTokenKind: "session",
  sessionTokenSource: "file",
  json: true,
  requireCompatMaterialization: false,
  requireProviderE2E: false,
  requireAiUpstreamProfile: false,
  requireAiCloudflareUnifiedBillingProfile: false,
  requireAiServiceGraphToken: false,
  requireAiUsageLedger: false,
  requireCloudflareCompatUsageLedger: false,
};

const PROVIDER_E2E_RESOURCES = [
  "cloudflare_r2_bucket",
  "cloudflare_workers_kv_namespace",
  "cloudflare_d1_database",
  "cloudflare_workers_script",
  "cloudflare_workers_route",
] as const;

test("cloud extension smoke records redacted pass with a materialization gap", async () => {
  const seenAuth: string[] = [];
  const result = await runCloudExtensionSmoke(
    BASE_OPTIONS,
    async (url, init) => {
      const auth = authorization(init);
      if (auth) seenAuth.push(auth);
      return responseFor(new URL(url).pathname, auth !== undefined);
    },
  );

  expect(result.kind).toBe(CLOUD_EXTENSION_SMOKE_KIND);
  expect(result.status).toBe("passed");
  expect(result.gaReady).toBe(false);
  expect(result.gaps).toEqual([
    "cloudflare_compat_materialization_not_enabled",
  ]);
  expect(
    result.checks.find((check) => check.name === "cloudExtensionCatalog")?.ok,
  ).toBe(true);
  expect(seenAuth.length).toBeGreaterThan(0);
  expect(JSON.stringify(result)).not.toContain(BASE_OPTIONS.sessionToken);
});

test("cloud extension smoke strict mode fails on compat materialization stub", async () => {
  const result = await runCloudExtensionSmoke(
    { ...BASE_OPTIONS, requireCompatMaterialization: true },
    async (url, init) =>
      responseFor(new URL(url).pathname, authorization(init) !== undefined),
  );

  expect(result.status).toBe("failed");
  expect(result.gaReady).toBe(false);
  expect(
    result.checks.find(
      (check) => check.name === "cloudflareCompatScriptPutAuth",
    )?.ok,
  ).toBe(false);
});

test("cloud extension smoke strict mode passes when compat lifecycle works", async () => {
  const result = await runCloudExtensionSmoke(
    {
      ...BASE_OPTIONS,
      requireCompatMaterialization: true,
      requireProviderE2E: true,
    },
    async (url, init) => {
      const parsed = new URL(url);
      return responseForImplementedCompat(
        parsed.pathname,
        init?.method ?? "GET",
        authorization(init) !== undefined,
        "configured_upstreams",
        requestBodyText(init),
        parsed.searchParams,
      );
    },
    async () => ({
      status: 200,
      ok: true,
      summary: {
        resources: successfulProviderResources(),
        completedResources: [...PROVIDER_E2E_RESOURCES],
        failedResources: [],
      },
    }),
  );

  expect(result.status).toBe("passed");
  expect(result.gaReady).toBe(true);
  expect(result.gaps).toEqual([]);
  expect(
    result.checks.find(
      (check) => check.name === "cloudflareCompatScriptPutAuth",
    )?.status,
  ).toBe(201);
  expect(JSON.stringify(result)).not.toContain(BASE_OPTIONS.sessionToken);
});

test("cloud extension smoke can require Cloudflare compat usage ledger evidence", async () => {
  let usageReads = 0;
  const result = await runCloudExtensionSmoke(
    {
      ...BASE_OPTIONS,
      requireCompatMaterialization: true,
      requireProviderE2E: true,
      requireCloudflareCompatUsageLedger: true,
      cloudflareCompatUsageWorkspaceId: "space_compat_runtime",
      cloudflareCompatUsageInstallationId: "inst_compat_runtime",
    },
    async (url, init) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/api/v1/workspaces/space_compat_runtime/usage") {
        usageReads += 1;
        return json({
          usageEvents:
            usageReads === 1
              ? []
              : [
                  {
                    id: "usage_compat_runtime_1",
                    spaceId: "space_compat_runtime",
                    installationId: "inst_compat_runtime",
                    meterId: "cloudflare:workers_script:deploy",
                    resourceFamily: "cloudflare.workers_script",
                    resourceId: "script:smoke",
                    operation: "deploy",
                    resourceMetadata: {
                      backend: "cloudflare.workers_for_platforms",
                    },
                    kind: "gateway_compute",
                    quantity: 1,
                    credits: 2,
                    source: "resource_meter",
                    idempotencyKey:
                      "provider-runtime:space_compat_runtime:compat",
                    createdAt: "2999-01-01T00:00:00.000Z",
                  },
                ],
        });
      }
      const parsedMethod = init?.method ?? "GET";
      return responseForImplementedCompat(
        parsed.pathname,
        parsedMethod,
        authorization(init) !== undefined,
        "configured_upstreams",
        requestBodyText(init),
        parsed.searchParams,
      );
    },
    async () => ({
      status: 200,
      ok: true,
      summary: {
        resources: successfulProviderResources(),
        completedResources: [...PROVIDER_E2E_RESOURCES],
        failedResources: [],
      },
    }),
  );

  expect(result.status).toBe("passed");
  expect(result.gaReady).toBe(true);
  expect(result.gaps).toEqual([]);
  expect(usageReads).toBeGreaterThanOrEqual(2);
  expect(
    result.checks.find((check) => check.name === "cloudflareCompatUsageLedger")
      ?.summary,
  ).toMatchObject({
    cloudflareCompatUsageWorkspaceId: "space_compat_runtime",
    cloudflareCompatUsageInstallationId: "inst_compat_runtime",
    usageLedgerChecked: true,
    cloudflareCompatUsageRecorded: true,
    usageEventsBefore: 0,
    usageEventsAfter: 1,
    matchingCloudflareCompatUsageEventsAfter: 1,
  });
  expect(JSON.stringify(result)).not.toContain(BASE_OPTIONS.sessionToken);
});

test("cloud extension smoke rejects Workers for Platforms as compat usage evidence", async () => {
  const result = await runCloudExtensionSmoke(
    {
      ...BASE_OPTIONS,
      requireCompatMaterialization: true,
      requireProviderE2E: true,
      requireCloudflareCompatUsageLedger: true,
      cloudflareCompatUsageWorkspaceId: "space_compat_runtime",
      cloudflareCompatUsageInstallationId: "inst_compat_runtime",
    },
    async (url, init) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/api/v1/workspaces/space_compat_runtime/usage") {
        return json({
          usageEvents: [
            {
              id: "usage_compat_runtime_wfp",
              spaceId: "space_compat_runtime",
              installationId: "inst_compat_runtime",
              meterId: "cloudflare:workers_script:deploy",
              resourceFamily: "cloudflare.workers_for_platforms",
              resourceId: "script:smoke",
              operation: "deploy",
              kind: "gateway_compute",
              quantity: 1,
              credits: 2,
              source: "resource_meter",
              createdAt: "2999-01-01T00:00:00.000Z",
            },
          ],
        });
      }
      return responseForImplementedCompat(
        parsed.pathname,
        init?.method ?? "GET",
        authorization(init) !== undefined,
        "configured_upstreams",
        requestBodyText(init),
        parsed.searchParams,
      );
    },
    async () => ({
      status: 200,
      ok: true,
      summary: {
        resources: successfulProviderResources(),
        completedResources: [...PROVIDER_E2E_RESOURCES],
        failedResources: [],
      },
    }),
  );

  expect(result.status).toBe("failed");
  expect(result.gaReady).toBe(false);
  expect(result.gaps).toContain("cloudflare_compat_usage_ledger_not_recorded");
  expect(
    result.checks.find((check) => check.name === "cloudflareCompatUsageLedger")
      ?.summary,
  ).toMatchObject({
    cloudflareCompatUsageRecorded: false,
    matchingCloudflareCompatUsageEventsAfter: 0,
  });
});

test("cloud extension smoke fails strict Cloudflare compat usage ledger mode without a workspace id", async () => {
  const result = await runCloudExtensionSmoke(
    {
      ...BASE_OPTIONS,
      requireCompatMaterialization: true,
      requireCloudflareCompatUsageLedger: true,
    },
    async (url, init) => {
      const parsed = new URL(url);
      return responseForImplementedCompat(
        parsed.pathname,
        init?.method ?? "GET",
        authorization(init) !== undefined,
        "configured_upstreams",
        requestBodyText(init),
        parsed.searchParams,
      );
    },
  );

  expect(result.status).toBe("failed");
  expect(result.gaReady).toBe(false);
  expect(result.gaps).toContain(
    "cloudflare_compat_usage_workspace_id_required",
  );
  expect(result.gaps).not.toContain(
    "cloudflare_compat_usage_ledger_not_recorded",
  );
});

test("cloud extension smoke fails readiness when AI Gateway only has Workers AI fallback", async () => {
  const result = await runCloudExtensionSmoke(
    {
      ...BASE_OPTIONS,
      requireCompatMaterialization: true,
    },
    async (url, init) => {
      const parsed = new URL(url);
      return responseForImplementedCompat(
        parsed.pathname,
        init?.method ?? "GET",
        authorization(init) !== undefined,
        "workers_ai_fallback",
        requestBodyText(init),
        parsed.searchParams,
      );
    },
  );

  expect(result.status).toBe("failed");
  expect(result.gaReady).toBe(false);
  expect(result.gaps).toContain("ai_gateway_status_not_ready");
  expect(
    result.checks.find((check) => check.name === "aiGatewayStatus")?.summary,
  ).toMatchObject({
    mode: "workers_ai_fallback",
    profileCount: 0,
    providers: ["workers_ai"],
  });
});

test("cloud extension smoke requires a non-Workers-AI upstream only when requested", async () => {
  const workersAiConfiguredStatus = json({
    kind: "takosumi.ai-gateway-status@v1",
    mode: "configured_upstreams",
    defaultModel: "workers-ai/llama-3.1-8b-instruct-fast",
    summary: {
      profileCount: 1,
      publicModelCount: 2,
      providers: ["workers_ai"],
    },
    upstreamProfiles: [
      {
        id: "workers-ai",
        provider: "workers_ai",
        type: "workers_ai_binding",
        endpointOrigin: "cloudflare:workers-ai-binding",
        modelCount: 2,
        publicModels: [
          {
            publicModel: "workers-ai/llama-3.1-8b-instruct-fast",
            endpoints: ["chat.completions"],
            default: true,
          },
          {
            publicModel: "workers-ai/bge-base-en-v1.5",
            endpoints: ["embeddings"],
          },
        ],
      },
    ],
  });
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    const parsed = new URL(url.toString());
    if (parsed.pathname === "/gateway/ai/v1/__takosumi/status") {
      return workersAiConfiguredStatus.clone();
    }
    return responseForImplementedCompat(
      parsed.pathname,
      init?.method ?? "GET",
      authorization(init) !== undefined,
      "configured_upstreams",
      requestBodyText(init),
      parsed.searchParams,
    );
  };

  const relaxed = await runCloudExtensionSmoke(
    {
      ...BASE_OPTIONS,
      requireCompatMaterialization: true,
      requireAiUpstreamProfile: false,
    },
    fetchImpl,
  );
  const strict = await runCloudExtensionSmoke(
    {
      ...BASE_OPTIONS,
      requireCompatMaterialization: true,
      requireAiUpstreamProfile: true,
    },
    fetchImpl,
  );

  expect(relaxed.status).toBe("passed");
  expect(relaxed.gaps).not.toContain(
    "ai_gateway_external_upstream_not_configured",
  );
  expect(strict.status).toBe("failed");
  expect(strict.gaps).toContain("ai_gateway_external_upstream_not_configured");
});

test("cloud extension smoke can require a Cloudflare Unified Billing AI profile", async () => {
  const directProviderStatus = json({
    kind: "takosumi.ai-gateway-status@v1",
    mode: "configured_upstreams",
    defaultModel: "takosumi/default",
    summary: {
      profileCount: 1,
      publicModelCount: 2,
      providers: ["deepseek"],
    },
    upstreamProfiles: [
      {
        id: "deepseek-main",
        provider: "deepseek",
        type: "openai_compatible",
        endpointOrigin: "https://api.deepseek.example",
        modelCount: 2,
        publicModels: [
          {
            publicModel: "takosumi/default",
            endpoints: ["chat.completions"],
            default: true,
          },
          {
            publicModel: "deepseek/text-embedding-v3",
            endpoints: ["embeddings"],
          },
        ],
      },
    ],
  });
  const directProviderFetch = async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    const parsed = new URL(url.toString());
    if (parsed.pathname === "/gateway/ai/v1/__takosumi/status") {
      return directProviderStatus.clone();
    }
    return responseForImplementedCompat(
      parsed.pathname,
      init?.method ?? "GET",
      authorization(init) !== undefined,
      "configured_upstreams",
      requestBodyText(init),
      parsed.searchParams,
    );
  };
  const direct = await runCloudExtensionSmoke(
    {
      ...BASE_OPTIONS,
      requireCompatMaterialization: true,
      requireAiUpstreamProfile: true,
      requireAiCloudflareUnifiedBillingProfile: true,
    },
    directProviderFetch,
  );
  const unified = await runCloudExtensionSmoke(
    {
      ...BASE_OPTIONS,
      requireCompatMaterialization: true,
      requireAiUpstreamProfile: true,
      requireAiCloudflareUnifiedBillingProfile: true,
    },
    async (url, init) => {
      const parsed = new URL(url);
      return responseForImplementedCompat(
        parsed.pathname,
        init?.method ?? "GET",
        authorization(init) !== undefined,
        "configured_upstreams",
        requestBodyText(init),
        parsed.searchParams,
      );
    },
  );

  expect(direct.status).toBe("failed");
  expect(direct.gaps).not.toContain(
    "ai_gateway_external_upstream_not_configured",
  );
  expect(direct.gaps).toContain(
    "ai_gateway_cloudflare_unified_billing_profile_not_configured",
  );
  expect(unified.status).toBe("passed");
  expect(unified.gaps).not.toContain(
    "ai_gateway_cloudflare_unified_billing_profile_not_configured",
  );
});

test("cloud extension smoke fails readiness when catalog bindings are missing", async () => {
  const result = await runCloudExtensionSmoke(
    { ...BASE_OPTIONS, requireCompatMaterialization: true },
    async (url, init) => {
      const pathname = new URL(url).pathname;
      if (pathname === "/__takosumi/cloud/extensions") {
        return cloudExtensionCatalog(false);
      }
      return responseForImplementedCompat(
        pathname,
        init?.method ?? "GET",
        authorization(init) !== undefined,
        "configured_upstreams",
        requestBodyText(init),
        new URL(url).searchParams,
      );
    },
  );

  expect(result.status).toBe("failed");
  expect(result.gaReady).toBe(false);
  expect(result.gaps).toContain("cloud_extension_catalog_not_ready");
});

test("cloud extension smoke cleanup uses the injected fetch implementation", async () => {
  const requests: { path: string; method: string }[] = [];
  const result = await runCloudExtensionSmoke(
    { ...BASE_OPTIONS, requireCompatMaterialization: true },
    async (url, init) => {
      const parsed = new URL(url);
      const method = init?.method ?? "GET";
      requests.push({ path: parsed.pathname, method });
      if (
        parsed.pathname ===
          "/compat/cloudflare/client/v4/accounts/ts_acc_takosumi_cloud/storage/kv/namespaces" &&
        method === "POST"
      ) {
        return cloudflare(true, { id: "kv_cleanup", title: "cleanup" }, 201);
      }
      if (
        parsed.pathname ===
          "/compat/cloudflare/client/v4/accounts/ts_acc_takosumi_cloud/storage/kv/namespaces/kv_cleanup" &&
        method === "GET"
      ) {
        return cloudflare(false, null, 500, [9999]);
      }
      if (
        parsed.pathname ===
          "/compat/cloudflare/client/v4/accounts/ts_acc_takosumi_cloud/storage/kv/namespaces" &&
        method === "GET" &&
        parsed.searchParams.has("title")
      ) {
        return cloudflare(true, [{ id: "kv_cleanup", title: "cleanup" }]);
      }
      if (
        parsed.pathname ===
          "/compat/cloudflare/client/v4/accounts/ts_acc_takosumi_cloud/storage/kv/namespaces/kv_cleanup" &&
        method === "DELETE"
      ) {
        return cloudflare(true, { id: "kv_cleanup", deleted: true });
      }
      return responseForImplementedCompat(
        parsed.pathname,
        method,
        authorization(init) !== undefined,
        "configured_upstreams",
        requestBodyText(init),
        parsed.searchParams,
      );
    },
  );

  const rest = result.checks.find(
    (check) => check.name === "cloudflareCompatRestLifecycle",
  );
  const resources = (rest?.summary.resources ?? []) as {
    resource: string;
    cleanup?: { deleted?: { id: string; ok: boolean }[] };
  }[];
  const kv = resources.find(
    (resource) => resource.resource === "cloudflare_workers_kv_namespace_rest",
  );

  expect(rest?.ok).toBe(false);
  expect(kv?.cleanup?.deleted?.[0]).toMatchObject({
    id: "kv_cleanup",
    ok: true,
  });
  expect(
    requests.some(
      (request) =>
        request.method === "DELETE" && request.path.endsWith("/kv_cleanup"),
    ),
  ).toBe(true);
});

test("cloud extension smoke supports PAT auth and provider E2E evidence", async () => {
  const patOptions: CloudExtensionSmokeOptions = {
    ...BASE_OPTIONS,
    sessionToken: "takpat_test_secret_value",
    authTokenKind: "pat",
    requireCompatMaterialization: true,
    requireProviderE2E: true,
  };
  const result = await runCloudExtensionSmoke(
    patOptions,
    async (url, init) => {
      const parsed = new URL(url);
      return responseForImplementedCompat(
        parsed.pathname,
        init?.method ?? "GET",
        authorization(init) !== undefined,
        "configured_upstreams",
        requestBodyText(init),
        parsed.searchParams,
      );
    },
    async (options) => ({
      status: 200,
      ok: true,
      summary: {
        resources: successfulProviderResources({
          cloudflare_r2_bucket: {
            tokenSeenByRunner: options.sessionToken.startsWith("takpat_"),
          },
        }),
        completedResources: [...PROVIDER_E2E_RESOURCES],
        failedResources: [],
        tokenSeenByRunner: options.sessionToken.startsWith("takpat_"),
      },
    }),
  );

  expect(result.status).toBe("passed");
  expect(result.gaReady).toBe(true);
  expect(result.authTokenKind).toBe("pat");
  expect(
    result.checks.find((check) => check.name === "cloudExtensionPatAuth")?.ok,
  ).toBe(true);
  expect(
    result.checks.find((check) => check.name === "cloudflareCompatProviderE2E")
      ?.summary,
  ).toMatchObject({
    completedResources: [...PROVIDER_E2E_RESOURCES],
    failedResources: [],
  });
  expect(JSON.stringify(result)).not.toContain(patOptions.sessionToken);
});

test("cloud extension smoke uses an embeddings model declared by AI Gateway status", async () => {
  const requestedModels: string[] = [];
  const result = await runCloudExtensionSmoke(
    { ...BASE_OPTIONS, requireCompatMaterialization: true },
    async (url, init) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/gateway/ai/v1/__takosumi/status") {
        return aiGatewayStatus("configured_upstreams", {
          embeddingModel: "deepseek/text-embedding-v3",
        });
      }
      if (parsed.pathname === "/gateway/ai/v1/embeddings") {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          readonly model?: string;
        };
        if (body.model) requestedModels.push(body.model);
        return json({ data: [{ embedding: [0] }], model: body.model });
      }
      return responseForImplementedCompat(
        parsed.pathname,
        init?.method ?? "GET",
        authorization(init) !== undefined,
        "configured_upstreams",
        requestBodyText(init),
        parsed.searchParams,
      );
    },
  );

  expect(result.status).toBe("passed");
  expect(result.gaReady).toBe(true);
  expect(requestedModels).toEqual(["deepseek/text-embedding-v3"]);
  expect(
    result.checks.find((check) => check.name === "aiEmbeddingsAuth")?.summary,
  ).toMatchObject({
    requestedModel: "deepseek/text-embedding-v3",
  });
});

test("cloud extension smoke proves AI Gateway Service Graph runtime token flow", async () => {
  const runtimeAuthHeaders: string[] = [];
  const ownerAuthHeaders: string[] = [];
  const rotateBodies: unknown[] = [];
  const runtimeToken = "taksrv_runtime_secret_value";
  const result = await runCloudExtensionSmoke(
    {
      ...BASE_OPTIONS,
      requireCompatMaterialization: true,
      requireAiServiceGraphToken: true,
      aiServiceInstallationId: "inst_ai_runtime",
    },
    async (url, init) => {
      const parsed = new URL(url);
      const auth = authorization(init);
      if (parsed.pathname.includes("/v1/installation-projections/")) {
        if (auth) ownerAuthHeaders.push(auth);
        if (parsed.pathname.endsWith("/services")) {
          return json({
            installation_id: "inst_ai_runtime",
            services: [
              {
                id: "takosumi.ai.gateway",
                status: "ready",
                endpoint: "https://app.takosumi.test/gateway/ai/v1",
                rotate_token_url:
                  "/v1/installation-projections/inst_ai_runtime/services/takosumi.ai.gateway/rotate-token",
              },
            ],
          });
        }
        if (parsed.pathname.endsWith("/takosumi.ai.gateway/rotate-token")) {
          rotateBodies.push(JSON.parse(requestBodyText(init) || "{}"));
          return json({
            token: runtimeToken,
            token_type: "Bearer",
            expires_at: "2026-06-24T00:15:00.000Z",
            service: { id: "takosumi.ai.gateway", status: "ready" },
          });
        }
      }
      if (auth === `Bearer ${runtimeToken}`) {
        runtimeAuthHeaders.push(auth);
        if (parsed.pathname === "/gateway/ai/v1/__takosumi/status") {
          return aiGatewayStatus("configured_upstreams", {
            embeddingModel: "deepseek/text-embedding-v3",
          });
        }
        if (parsed.pathname === "/gateway/ai/v1/models") {
          return json({
            object: "list",
            data: [{ id: "takosumi/default", object: "model" }],
          });
        }
        if (parsed.pathname === "/gateway/ai/v1/chat/completions") {
          return json({ choices: [{ index: 0 }] });
        }
        if (parsed.pathname === "/gateway/ai/v1/embeddings") {
          return json({ data: [{ embedding: [0] }] });
        }
      }
      return responseForImplementedCompat(
        parsed.pathname,
        init?.method ?? "GET",
        auth !== undefined,
        "configured_upstreams",
        requestBodyText(init),
        parsed.searchParams,
      );
    },
  );

  expect(result.status).toBe("passed");
  expect(result.gaReady).toBe(true);
  expect(result.gaps).toEqual([]);
  expect(ownerAuthHeaders).toContain(`Bearer ${BASE_OPTIONS.sessionToken}`);
  expect(runtimeAuthHeaders.length).toBeGreaterThanOrEqual(4);
  expect(rotateBodies).toEqual([
    {
      scopes: ["ai.models.read", "ai.chat", "ai.embeddings"],
      ttlSeconds: 900,
    },
  ]);
  expect(
    result.checks.find((check) => check.name === "aiServiceGraphToken")
      ?.summary,
  ).toMatchObject({
    installationId: "inst_ai_runtime",
    tokenMinted: true,
    serviceStatus: "ready",
    modelIds: ["takosumi/default"],
    chatChoiceCount: 1,
    embeddingCount: 1,
    requestedEmbeddingsModel: "deepseek/text-embedding-v3",
  });
  expect(JSON.stringify(result)).not.toContain(runtimeToken);
  expect(JSON.stringify(result)).not.toContain(BASE_OPTIONS.sessionToken);
});

test("cloud extension smoke can require AI Gateway usage ledger evidence", async () => {
  const runtimeToken = "taksrv_runtime_usage_secret_value";
  let usageReads = 0;
  const result = await runCloudExtensionSmoke(
    {
      ...BASE_OPTIONS,
      requireCompatMaterialization: true,
      requireAiServiceGraphToken: true,
      requireAiUsageLedger: true,
      aiServiceInstallationId: "inst_ai_runtime",
      aiUsageWorkspaceId: "space_ai_runtime",
    },
    async (url, init) => {
      const parsed = new URL(url);
      const auth = authorization(init);
      if (parsed.pathname === "/api/v1/workspaces/space_ai_runtime/usage") {
        usageReads += 1;
        return json({
          usageEvents:
            usageReads === 1
              ? []
              : [
                  {
                    id: "usage_ai_runtime_1",
                    spaceId: "space_ai_runtime",
                    installationId: "inst_ai_runtime",
                    kind: "ai_request",
                    quantity: 1,
                    credits: 1,
                    source: "resource_meter",
                    idempotencyKey: "provider-runtime:space_ai_runtime:ai",
                    createdAt: "2999-01-01T00:00:00.000Z",
                  },
                ],
        });
      }
      if (parsed.pathname.includes("/v1/installation-projections/")) {
        if (parsed.pathname.endsWith("/services")) {
          return json({
            installation_id: "inst_ai_runtime",
            services: [
              {
                id: "takosumi.ai.gateway",
                status: "ready",
                endpoint: "https://app.takosumi.test/gateway/ai/v1",
                rotate_token_url:
                  "/v1/installation-projections/inst_ai_runtime/services/takosumi.ai.gateway/rotate-token",
              },
            ],
          });
        }
        if (parsed.pathname.endsWith("/takosumi.ai.gateway/rotate-token")) {
          return json({
            token: runtimeToken,
            token_type: "Bearer",
            expires_at: "2026-06-24T00:15:00.000Z",
            service: { id: "takosumi.ai.gateway", status: "ready" },
          });
        }
      }
      if (auth === `Bearer ${runtimeToken}`) {
        if (parsed.pathname === "/gateway/ai/v1/__takosumi/status") {
          return aiGatewayStatus("configured_upstreams", {
            embeddingModel: "deepseek/text-embedding-v3",
          });
        }
        if (parsed.pathname === "/gateway/ai/v1/models") {
          return json({
            object: "list",
            data: [{ id: "takosumi/default", object: "model" }],
          });
        }
        if (parsed.pathname === "/gateway/ai/v1/chat/completions") {
          return json({ choices: [{ index: 0 }] });
        }
        if (parsed.pathname === "/gateway/ai/v1/embeddings") {
          return json({ data: [{ embedding: [0] }] });
        }
      }
      return responseForImplementedCompat(
        parsed.pathname,
        init?.method ?? "GET",
        auth !== undefined,
        "configured_upstreams",
        requestBodyText(init),
        parsed.searchParams,
      );
    },
  );

  expect(result.status).toBe("passed");
  expect(result.gaReady).toBe(true);
  expect(result.gaps).toEqual([]);
  expect(usageReads).toBeGreaterThanOrEqual(2);
  expect(
    result.checks.find((check) => check.name === "aiServiceGraphToken")
      ?.summary,
  ).toMatchObject({
    installationId: "inst_ai_runtime",
    usageLedgerChecked: true,
    aiUsageRecorded: true,
    aiUsageWorkspaceId: "space_ai_runtime",
    usageEventsBefore: 0,
    usageEventsAfter: 1,
    matchingAiUsageEventsAfter: 1,
  });
  expect(JSON.stringify(result)).not.toContain(runtimeToken);
  expect(JSON.stringify(result)).not.toContain(BASE_OPTIONS.sessionToken);
});

test("cloud extension smoke fails strict AI usage ledger mode without a workspace id", async () => {
  const result = await runCloudExtensionSmoke(
    {
      ...BASE_OPTIONS,
      requireCompatMaterialization: true,
      requireAiServiceGraphToken: true,
      requireAiUsageLedger: true,
      aiServiceInstallationId: "inst_ai_runtime",
    },
    async (url, init) => {
      const parsed = new URL(url);
      return responseForImplementedCompat(
        parsed.pathname,
        init?.method ?? "GET",
        authorization(init) !== undefined,
        "configured_upstreams",
        requestBodyText(init),
        parsed.searchParams,
      );
    },
  );

  expect(result.status).toBe("failed");
  expect(result.gaReady).toBe(false);
  expect(result.gaps).toContain("ai_gateway_usage_workspace_id_required");
  expect(result.gaps).not.toContain("ai_gateway_service_graph_token_not_ready");
});

test("cloud extension smoke reports missing AI Service Graph installation id as a GA gap", async () => {
  const result = await runCloudExtensionSmoke(
    {
      ...BASE_OPTIONS,
      requireCompatMaterialization: true,
      requireAiServiceGraphToken: true,
    },
    async (url, init) => {
      const parsed = new URL(url);
      return responseForImplementedCompat(
        parsed.pathname,
        init?.method ?? "GET",
        authorization(init) !== undefined,
        "configured_upstreams",
        requestBodyText(init),
        parsed.searchParams,
      );
    },
  );

  expect(result.status).toBe("failed");
  expect(result.gaReady).toBe(false);
  expect(result.gaps).toContain(
    "ai_gateway_service_graph_installation_id_required",
  );
});

test("cloud extension smoke reports provider workers script E2E as a GA gap", async () => {
  const result = await runCloudExtensionSmoke(
    {
      ...BASE_OPTIONS,
      requireCompatMaterialization: true,
      requireProviderE2E: true,
    },
    async (url, init) => {
      const parsed = new URL(url);
      return responseForImplementedCompat(
        parsed.pathname,
        init?.method ?? "GET",
        authorization(init) !== undefined,
        "configured_upstreams",
        requestBodyText(init),
        parsed.searchParams,
      );
    },
    async () => ({
      status: 500,
      ok: false,
      summary: {
        resources: [
          {
            resource: "cloudflare_r2_bucket",
            ok: true,
            completedSteps: ["init", "plan", "apply", "destroy"],
            summary: {},
          },
          {
            resource: "cloudflare_workers_script",
            ok: false,
            completedSteps: ["init", "plan", "apply"],
            summary: { scriptName: "takosumi-e2e-worker-test" },
            errorClass: "Error",
            message:
              "tofu destroy exited 1: 501 Cloudflare compatibility route is mounted, but this resource is not supported yet",
            cleanup: { attempted: true, ok: true, status: 200 },
          },
        ],
        completedResources: ["cloudflare_r2_bucket"],
        failedResources: ["cloudflare_workers_script"],
      },
    }),
  );

  expect(result.status).toBe("failed");
  expect(result.gaReady).toBe(false);
  expect(result.gaps).toContain("cloudflare_compat_provider_e2e_failed");
  expect(result.gaps).toContain(
    "cloudflare_compat_provider_workers_script_not_ready",
  );
});

function successfulProviderResources(
  summaries: Partial<
    Record<(typeof PROVIDER_E2E_RESOURCES)[number], object>
  > = {},
) {
  return PROVIDER_E2E_RESOURCES.map((resource) => ({
    resource,
    ok: true,
    completedSteps: ["init", "plan", "apply", "destroy"],
    summary: summaries[resource] ?? {},
  }));
}

function responseFor(pathname: string, authenticated: boolean): Response {
  if (pathname === "/v1/account/session/me") {
    return json({ subject: "tsub_test" });
  }
  if (pathname === "/__takosumi/cloud/extensions") {
    return cloudExtensionCatalog(true);
  }
  if (pathname === "/gateway/ai/v1/models" && !authenticated) {
    return openAiError(401);
  }
  if (pathname === "/gateway/ai/v1/models") {
    return json({
      object: "list",
      data: [{ id: "takosumi/default", object: "model" }],
    });
  }
  if (pathname === "/gateway/ai/v1/__takosumi/status") {
    return aiGatewayStatus("configured_upstreams");
  }
  if (pathname === "/gateway/ai/v1/chat/completions") {
    return json({ choices: [{ index: 0 }] });
  }
  if (pathname === "/gateway/ai/v1/embeddings") {
    return json({ data: [{ embedding: [0] }] });
  }
  if (
    pathname === "/compat/cloudflare/client/v4/user/tokens/verify" &&
    !authenticated
  ) {
    return cloudflare(false, null, 401, [10000]);
  }
  if (pathname === "/compat/cloudflare/client/v4/user/tokens/verify") {
    return cloudflare(true, { status: "active" });
  }
  if (pathname === "/compat/cloudflare/client/v4/accounts") {
    return cloudflare(true, [{ id: "ts_acc_takosumi_cloud" }]);
  }
  if (pathname.endsWith("/workers/scripts")) {
    return cloudflare(true, []);
  }
  return cloudflare(false, null, 501, [9001]);
}

function cloudExtensionCatalog(configured: boolean): Response {
  return json({
    kind: "takosumi.platform-cloud-extensions@v1",
    extensions: [
      { id: "ai.openai_compatible.v1", configured },
      { id: "provider.cloudflare.client_v4", configured },
    ],
  });
}

function aiGatewayStatus(
  mode: "configured_upstreams" | "workers_ai_fallback",
  options: { readonly embeddingModel?: string } = {},
): Response {
  const embeddingModel =
    options.embeddingModel ?? "openai/text-embedding-3-small";
  return json({
    kind: "takosumi.ai-gateway-status@v1",
    mode,
    defaultModel: "takosumi/default",
    summary: {
      profileCount: mode === "configured_upstreams" ? 1 : 0,
      publicModelCount: mode === "configured_upstreams" ? 1 : 3,
      providers:
        mode === "configured_upstreams"
          ? ["cloudflare_unified_billing"]
          : ["workers_ai"],
    },
    upstreamProfiles:
      mode === "configured_upstreams"
        ? [
            {
              id: "cloudflare-unified",
              provider: "cloudflare_unified_billing",
              endpointOrigin: "https://api.cloudflare.com",
              modelCount: 2,
              publicModels: [
                {
                  publicModel: "takosumi/default",
                  endpoints: ["chat.completions"],
                  default: true,
                },
                {
                  publicModel: embeddingModel,
                  endpoints: ["embeddings"],
                },
              ],
            },
          ]
        : [],
    workersAiFallback: {
      enabled: true,
      aiBindingConfigured: true,
      chatModel: "@cf/meta/llama-3.1-8b-instruct",
      embeddingModel,
    },
  });
}

function responseForImplementedCompat(
  pathname: string,
  method: string,
  authenticated: boolean,
  aiMode:
    | "configured_upstreams"
    | "workers_ai_fallback" = "configured_upstreams",
  bodyText = "",
  searchParams: URLSearchParams = new URLSearchParams(),
): Response {
  if (pathname === "/gateway/ai/v1/__takosumi/status") {
    return aiGatewayStatus(aiMode);
  }
  if (pathname.includes("/accounts/not-ts_acc_takosumi_cloud/")) {
    return cloudflare(false, null, 404, [7003]);
  }
  if (pathname.includes("/storage/kv/namespaces")) {
    if (method === "POST" && bodyText.includes("{}")) {
      return cloudflare(false, null, 400, [1002]);
    }
    if (method === "POST") {
      return cloudflare(true, { id: "kv_test", title: "test" }, 201);
    }
    if (method === "DELETE") {
      return cloudflare(true, { id: "kv_test", deleted: true });
    }
    if (pathname.endsWith("/kv_test")) {
      return cloudflare(true, { id: "kv_test", title: "test" });
    }
    return cloudflare(true, [
      { id: "kv_test", title: searchParams.get("title") ?? "test" },
    ]);
  }
  if (pathname.includes("/d1/database")) {
    if (method === "POST" && bodyText.includes("{}")) {
      return cloudflare(false, null, 400, [1002]);
    }
    if (method === "POST") {
      return cloudflare(true, { uuid: "d1_test", name: "test" }, 201);
    }
    if (method === "DELETE") {
      return cloudflare(true, { uuid: "d1_test", deleted: true });
    }
    if (pathname.endsWith("/d1_test")) {
      return cloudflare(true, { uuid: "d1_test", name: "test" });
    }
    return cloudflare(true, [
      { uuid: "d1_test", name: searchParams.get("name") ?? "test" },
    ]);
  }
  if (pathname.includes("/r2/buckets")) {
    if (method === "POST" && bodyText.includes("{}")) {
      return cloudflare(false, null, 400, [1002]);
    }
    if (method === "POST") {
      return cloudflare(true, { name: "r2-test" }, 201);
    }
    if (method === "DELETE") {
      return cloudflare(true, { name: "r2-test", deleted: true });
    }
    if (!pathname.endsWith("/r2/buckets")) {
      return cloudflare(true, { name: searchParams.get("name") ?? "r2-test" });
    }
    return cloudflare(true, [{ name: searchParams.get("name") ?? "r2-test" }]);
  }
  if (pathname.includes("/workers/routes")) {
    if (method === "POST" && bodyText.includes("{}")) {
      return cloudflare(false, null, 400, [1002]);
    }
    if (method === "POST") {
      return cloudflare(true, { id: "route_test", pattern: "test/*" }, 201);
    }
    if (method === "DELETE") {
      return cloudflare(true, { id: "route_test", deleted: true });
    }
    if (pathname.endsWith("/route_test")) {
      return cloudflare(true, { id: "route_test", pattern: "test/*" });
    }
    return cloudflare(true, [
      { id: "route_test", pattern: searchParams.get("pattern") ?? "test/*" },
    ]);
  }
  if (pathname.includes("/workers/scripts/takosumi-rest-worker-")) {
    if (method === "PUT") {
      return cloudflare(true, { id: "takosumi-rest-worker-test" }, 201);
    }
    if (method === "GET") {
      return cloudflare(true, { id: "takosumi-rest-worker-test" });
    }
    if (method === "DELETE") {
      return cloudflare(true, {
        id: "takosumi-rest-worker-test",
        deleted: true,
      });
    }
  }
  if (!pathname.includes("/workers/scripts/takosumi-smoke")) {
    return responseFor(pathname, authenticated);
  }
  if (method === "PUT") {
    return cloudflare(true, { id: "takosumi-smoke" }, 201);
  }
  if (method === "GET") {
    return cloudflare(true, { id: "takosumi-smoke" });
  }
  if (method === "DELETE") {
    return cloudflare(true, { id: "takosumi-smoke", deleted: true });
  }
  return cloudflare(false, null, 405, [1001]);
}

function authorization(init: RequestInit | undefined): string | undefined {
  return typeof init?.headers === "object" && init.headers !== null
    ? (init.headers as Record<string, string>).authorization
    : undefined;
}

function requestBodyText(init: RequestInit | undefined): string {
  return typeof init?.body === "string" ? init.body : "";
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function openAiError(status: number): Response {
  return json({ error: { code: "unauthorized" } }, status);
}

function cloudflare(
  success: boolean,
  result: unknown,
  status = 200,
  errorCodes: readonly number[] = [],
): Response {
  return json(
    {
      success,
      result,
      errors: errorCodes.map((code) => ({ code, message: "redacted" })),
      messages: [],
    },
    status,
  );
}
