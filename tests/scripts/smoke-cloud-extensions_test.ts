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
    async (url, init) =>
      responseForImplementedCompat(
        new URL(url).pathname,
        init?.method ?? "GET",
        authorization(init) !== undefined,
        "configured_upstreams",
      ),
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

test("cloud extension smoke can require external AI upstream profiles", async () => {
  const result = await runCloudExtensionSmoke(
    {
      ...BASE_OPTIONS,
      requireCompatMaterialization: true,
      requireAiUpstreamProfile: true,
    },
    async (url, init) =>
      responseForImplementedCompat(
        new URL(url).pathname,
        init?.method ?? "GET",
        authorization(init) !== undefined,
        "workers_ai_fallback",
      ),
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
      );
    },
  );

  expect(result.status).toBe("failed");
  expect(result.gaReady).toBe(false);
  expect(result.gaps).toContain("cloud_extension_catalog_not_ready");
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
    async (url, init) =>
      responseForImplementedCompat(
        new URL(url).pathname,
        init?.method ?? "GET",
        authorization(init) !== undefined,
        "configured_upstreams",
      ),
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

test("cloud extension smoke reports provider workers script E2E as a GA gap", async () => {
  const result = await runCloudExtensionSmoke(
    {
      ...BASE_OPTIONS,
      requireCompatMaterialization: true,
      requireProviderE2E: true,
    },
    async (url, init) =>
      responseForImplementedCompat(
        new URL(url).pathname,
        init?.method ?? "GET",
        authorization(init) !== undefined,
        "configured_upstreams",
      ),
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
    options.embeddingModel ?? "workers-ai/bge-base-en-v1.5";
  return json({
    kind: "takosumi.ai-gateway-status@v1",
    mode,
    defaultModel: "takosumi/default",
    summary: {
      profileCount: mode === "configured_upstreams" ? 1 : 0,
      publicModelCount: mode === "configured_upstreams" ? 1 : 3,
      providers:
        mode === "configured_upstreams" ? ["deepseek"] : ["workers_ai"],
    },
    upstreamProfiles:
      mode === "configured_upstreams"
        ? [
            {
              id: "deepseek-main",
              provider: "deepseek",
              endpointOrigin: "https://api.deepseek.example",
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
): Response {
  if (pathname === "/gateway/ai/v1/__takosumi/status") {
    return aiGatewayStatus(aiMode);
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
