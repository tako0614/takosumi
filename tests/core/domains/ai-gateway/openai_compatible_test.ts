import { expect, test } from "bun:test";

import {
  createTakosumiAiGatewayConfigFromEnv,
  handleTakosumiAiGatewayRequest,
  type TakosumiAiGatewayAuthRequest,
} from "../../../../core/domains/ai-gateway/openai_compatible.ts";

function gatewayEnv() {
  return {
    TAKOSUMI_AI_GATEWAY_PROFILES: JSON.stringify([
      {
        id: "deepseek",
        provider: "deepseek",
        baseUrl: "https://api.deepseek.example/v1",
        apiKeyEnv: "DEEPSEEK_API_KEY",
        models: [
          {
            publicModel: "deepseek/chat",
            upstreamModel: "deepseek-chat",
            endpoints: ["chat.completions"],
            default: true,
            metadata: { tier: "fast" },
          },
        ],
      },
      {
        id: "zai",
        provider: "zai",
        baseUrl: "https://api.zai.example/v1",
        apiKeyEnv: "ZAI_API_KEY",
        apiKeyHeader: "x-api-key",
        headers: { "x-provider-mode": "openai-compatible" },
        models: [
          {
            publicModel: "zai/glm-embedding",
            upstreamModel: "embedding-3",
            endpoints: ["embeddings"],
          },
        ],
      },
    ]),
    DEEPSEEK_API_KEY: "deepseek-secret",
    ZAI_API_KEY: "zai-secret",
  };
}

function gatewayUrl(path: string): URL {
  return new URL(`https://app.takosumi.com${path}`);
}

test("AI Gateway lists public model aliases without exposing upstream keys", async () => {
  const config = createTakosumiAiGatewayConfigFromEnv(gatewayEnv());
  const authRequests: TakosumiAiGatewayAuthRequest[] = [];
  const url = gatewayUrl("/gateway/ai/v1/models");
  const response = await handleTakosumiAiGatewayRequest(
    new Request(url, { method: "GET" }),
    url,
    {
      config,
      authorize: async (_request, auth) => {
        authRequests.push(auth);
        return { ok: true };
      },
    },
  );

  expect(response.status).toBe(200);
  expect(authRequests).toEqual([
    { endpoint: "models", requiredScopes: ["ai.models.read"] },
  ]);
  const body = await response.json();
  expect(body.data.map((model: { id: string }) => model.id)).toEqual([
    "takosumi/default",
    "deepseek/chat",
    "zai/glm-embedding",
  ]);
  expect(body.data[0].metadata.aliasOf).toBe("deepseek/chat");
  expect(JSON.stringify(body)).not.toContain("deepseek-secret");
  expect(JSON.stringify(body)).not.toContain("zai-secret");
});

test("AI Gateway status reports configured upstreams without exposing keys", async () => {
  const config = createTakosumiAiGatewayConfigFromEnv(gatewayEnv());
  const authRequests: TakosumiAiGatewayAuthRequest[] = [];
  const url = gatewayUrl("/gateway/ai/v1/__takosumi/status");
  const response = await handleTakosumiAiGatewayRequest(
    new Request(url, { method: "GET" }),
    url,
    {
      config,
      authorize: async (_request, auth) => {
        authRequests.push(auth);
        return { ok: true };
      },
    },
  );

  expect(response.status).toBe(200);
  expect(authRequests).toEqual([
    { endpoint: "status", requiredScopes: ["ai.models.read"] },
  ]);
  const body = await response.json();
  expect(body).toMatchObject({
    kind: "takosumi.ai-gateway-status@v1",
    mode: "configured_upstreams",
    defaultModel: "deepseek/chat",
    summary: {
      profileCount: 2,
      publicModelCount: 2,
      providers: ["deepseek", "zai"],
    },
    workersAiFallback: {
      enabled: false,
      aiBindingConfigured: false,
    },
  });
  expect(body.endpoints).toEqual([
    "status",
    "models",
    "chat.completions",
    "embeddings",
  ]);
  expect(body.upstreamProfiles[0]).toMatchObject({
    id: "deepseek",
    provider: "deepseek",
    endpointOrigin: "https://api.deepseek.example",
    modelCount: 1,
  });
  expect(JSON.stringify(body)).not.toContain("deepseek-secret");
  expect(JSON.stringify(body)).not.toContain("zai-secret");
  expect(JSON.stringify(body)).not.toContain("apiKey");
});

test("AI Gateway forwards chat completions with default alias and safe headers", async () => {
  const config = createTakosumiAiGatewayConfigFromEnv(gatewayEnv());
  let upstreamRequest: Request | undefined;
  const fetcher: typeof fetch = async (input, init) => {
    upstreamRequest = new Request(input, init);
    const body = await upstreamRequest.json();
    expect(body.model).toBe("deepseek-chat");
    expect(upstreamRequest.headers.get("authorization")).toBe(
      "Bearer deepseek-secret",
    );
    return new Response(
      JSON.stringify({
        id: "chatcmpl_1",
        object: "chat.completion",
        model: body.model,
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
          "set-cookie": "leak=1",
          "x-request-id": "upstream-request-1",
          "x-ratelimit-remaining": "12",
        },
      },
    );
  };
  const url = gatewayUrl("/gateway/ai/v1/chat/completions");
  const response = await handleTakosumiAiGatewayRequest(
    new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "takosumi/default",
        messages: [{ role: "user", content: "hello" }],
      }),
    }),
    url,
    {
      config,
      fetcher,
      authorize: async (_request, auth) => {
        expect(auth.requiredScopes).toEqual(["ai.chat"]);
        return { ok: true };
      },
    },
  );

  expect(response.status).toBe(200);
  expect(upstreamRequest?.url).toBe(
    "https://api.deepseek.example/v1/chat/completions",
  );
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(response.headers.get("x-upstream-request-id")).toBe(
    "upstream-request-1",
  );
  expect(response.headers.get("x-ratelimit-remaining")).toBe("12");
  expect(response.headers.get("x-takosumi-ai-gateway-provider")).toBe(
    "deepseek",
  );
  expect(response.headers.get("x-takosumi-ai-gateway-model")).toBe(
    "deepseek/chat",
  );
  expect(await response.text()).not.toContain("deepseek-secret");
});

test("AI Gateway normalizes upstream errors without passing provider diagnostics through", async () => {
  const config = createTakosumiAiGatewayConfigFromEnv(gatewayEnv());
  const url = gatewayUrl("/gateway/ai/v1/chat/completions");
  const response = await handleTakosumiAiGatewayRequest(
    new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "deepseek/chat",
        messages: [{ role: "user", content: "hello" }],
      }),
    }),
    url,
    {
      config,
      fetcher: async () =>
        new Response(
          "<html>provider diagnostic: upstream-secret-token</html>",
          {
            status: 429,
            headers: {
              "content-type": "text/html",
              "set-cookie": "provider_session=must-not-forward",
              "x-request-id": "upstream-request-err",
              "x-ratelimit-reset": "42",
            },
          },
        ),
      authorize: async () => ({ ok: true }),
    },
  );

  expect(response.status).toBe(429);
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(response.headers.get("x-upstream-request-id")).toBe(
    "upstream-request-err",
  );
  expect(response.headers.get("x-ratelimit-reset")).toBe("42");
  const text = await response.text();
  expect(text).toContain('"code":"upstream_error"');
  expect(text).not.toContain("provider diagnostic");
  expect(text).not.toContain("upstream-secret-token");
});

test("AI Gateway supports custom upstream key headers for compatible providers", async () => {
  const config = createTakosumiAiGatewayConfigFromEnv(gatewayEnv());
  const fetcher: typeof fetch = async (input, init) => {
    const upstreamRequest = new Request(input, init);
    expect(upstreamRequest.url).toBe("https://api.zai.example/v1/embeddings");
    expect(upstreamRequest.headers.get("authorization")).toBeNull();
    expect(upstreamRequest.headers.get("x-api-key")).toBe("zai-secret");
    expect(upstreamRequest.headers.get("x-provider-mode")).toBe(
      "openai-compatible",
    );
    const body = await upstreamRequest.json();
    expect(body.model).toBe("embedding-3");
    return Response.json({ object: "list", data: [] });
  };
  const url = gatewayUrl("/gateway/ai/v1/embeddings");
  const response = await handleTakosumiAiGatewayRequest(
    new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "zai/glm-embedding", input: "hello" }),
    }),
    url,
    {
      config,
      fetcher,
      authorize: async (_request, auth) => {
        expect(auth.requiredScopes).toEqual(["ai.embeddings"]);
        return { ok: true };
      },
    },
  );

  expect(response.status).toBe(200);
});

test("AI Gateway fails closed on missing scopes and unsupported models", async () => {
  const config = createTakosumiAiGatewayConfigFromEnv(gatewayEnv());
  const chatUrl = gatewayUrl("/gateway/ai/v1/chat/completions");
  const denied = await handleTakosumiAiGatewayRequest(
    new Request(chatUrl, {
      method: "POST",
      body: JSON.stringify({ model: "deepseek/chat", messages: [] }),
    }),
    chatUrl,
    {
      config,
      authorize: async () => ({
        ok: false,
        response: new Response("forbidden", { status: 403 }),
      }),
    },
  );
  expect(denied.status).toBe(403);

  const missing = await handleTakosumiAiGatewayRequest(
    new Request(chatUrl, {
      method: "POST",
      body: JSON.stringify({ model: "zai/glm-embedding", messages: [] }),
    }),
    chatUrl,
    {
      config,
      authorize: async () => ({ ok: true }),
      fetcher: async () => {
        throw new Error("must not dial upstream");
      },
    },
  );
  expect(missing.status).toBe(404);
  expect((await missing.json()).error.code).toBe("model_not_found");
});

test("AI Gateway config rejects embedded key values", () => {
  expect(() =>
    createTakosumiAiGatewayConfigFromEnv({
      TAKOSUMI_AI_GATEWAY_PROFILES: JSON.stringify([
        {
          id: "unsafe",
          provider: "openai_compatible",
          baseUrl: "https://api.example.test/v1",
          apiKeyEnv: "UNSAFE_KEY",
          apiKey: "must-not-be-here",
          models: [
            {
              publicModel: "unsafe/model",
              upstreamModel: "unsafe-model",
              endpoints: ["chat.completions"],
            },
          ],
        },
      ]),
      UNSAFE_KEY: "secret",
    }),
  ).toThrow("must not be embedded");
});

test("AI Gateway OpenAI-compatible handler rejects Workers AI binding profiles", () => {
  expect(() =>
    createTakosumiAiGatewayConfigFromEnv({
      TAKOSUMI_AI_GATEWAY_PROFILES: JSON.stringify([
        {
          type: "workers_ai_binding",
          id: "workers-ai",
          provider: "workers_ai",
          models: [
            {
              publicModel: "workers-ai/chat",
              upstreamModel: "@cf/meta/llama-3.1-8b-instruct-fast",
              endpoints: ["chat.completions"],
            },
          ],
        },
      ]),
    }),
  ).toThrow("not supported by the OpenAI-compatible handler");
});

test("AI Gateway config rejects secret-bearing static upstream headers", () => {
  expect(() =>
    createTakosumiAiGatewayConfigFromEnv({
      TAKOSUMI_AI_GATEWAY_PROFILES: JSON.stringify([
        {
          id: "unsafe-header",
          provider: "openai_compatible",
          baseUrl: "https://api.example.test/v1",
          apiKeyEnv: "UPSTREAM_KEY",
          headers: { "x-api-key": "must-not-be-here" },
          models: [
            {
              publicModel: "unsafe/model",
              upstreamModel: "unsafe-model",
              endpoints: ["chat.completions"],
            },
          ],
        },
      ]),
      UPSTREAM_KEY: "secret",
    }),
  ).toThrow("may carry secrets");

  expect(() =>
    createTakosumiAiGatewayConfigFromEnv({
      TAKOSUMI_AI_GATEWAY_PROFILES: JSON.stringify([
        {
          id: "unsafe",
          provider: "openai_compatible",
          baseUrl: "https://api.example.test/v1",
          apiKeyEnv: "UPSTREAM_KEY",
          headers: { "x-provider-metadata": "Authorization: Bearer static" },
          models: [
            {
              publicModel: "unsafe/chat",
              upstreamModel: "unsafe-chat",
              endpoints: ["chat.completions"],
            },
          ],
        },
      ]),
      UPSTREAM_KEY: "secret",
    }),
  ).toThrow("value may carry secrets");
});

test("AI Gateway config rejects secret-bearing public model metadata", () => {
  expect(() =>
    createTakosumiAiGatewayConfigFromEnv({
      TAKOSUMI_AI_GATEWAY_PROFILES: JSON.stringify([
        {
          id: "metadata-key",
          provider: "openai_compatible",
          baseUrl: "https://api.example.test/v1",
          apiKeyEnv: "UPSTREAM_KEY",
          models: [
            {
              publicModel: "unsafe/model",
              upstreamModel: "unsafe-model",
              endpoints: ["chat.completions"],
              metadata: { apiKey: "must-not-be-public" },
            },
          ],
        },
      ]),
      UPSTREAM_KEY: "secret",
    }),
  ).toThrow("may carry secrets");

  expect(() =>
    createTakosumiAiGatewayConfigFromEnv({
      TAKOSUMI_AI_GATEWAY_PROFILES: JSON.stringify([
        {
          id: "metadata-value",
          provider: "openai_compatible",
          baseUrl: "https://api.example.test/v1",
          apiKeyEnv: "UPSTREAM_KEY",
          models: [
            {
              publicModel: "unsafe/model",
              upstreamModel: "unsafe-model",
              endpoints: ["chat.completions"],
              metadata: {
                note: "upstream said Authorization: Bearer metadata-token",
              },
            },
          ],
        },
      ]),
      UPSTREAM_KEY: "secret",
    }),
  ).toThrow("may carry secrets");
});

test("AI Gateway config rejects local/private upstream URLs by default", () => {
  expect(() =>
    createTakosumiAiGatewayConfigFromEnv({
      TAKOSUMI_AI_GATEWAY_PROFILES: JSON.stringify([
        {
          id: "local",
          provider: "openai_compatible",
          baseUrl: "http://localhost:11434/v1",
          apiKeyEnv: "LOCAL_KEY",
          models: [
            {
              publicModel: "local/chat",
              upstreamModel: "local-chat",
              endpoints: ["chat.completions"],
            },
          ],
        },
      ]),
      LOCAL_KEY: "secret",
    }),
  ).toThrow("local http requires");

  expect(() =>
    createTakosumiAiGatewayConfigFromEnv({
      TAKOSUMI_AI_GATEWAY_PROFILES: JSON.stringify([
        {
          id: "metadata",
          provider: "openai_compatible",
          baseUrl: "https://169.254.169.254/v1",
          apiKeyEnv: "METADATA_KEY",
          models: [
            {
              publicModel: "metadata/chat",
              upstreamModel: "metadata-chat",
              endpoints: ["chat.completions"],
            },
          ],
        },
      ]),
      METADATA_KEY: "secret",
    }),
  ).toThrow("must not target local, private, link-local, or metadata hosts");

  expect(() =>
    createTakosumiAiGatewayConfigFromEnv({
      TAKOSUMI_AI_GATEWAY_PROFILES: JSON.stringify([
        {
          id: "internal-dns",
          provider: "openai_compatible",
          baseUrl: "https://models.internal/v1",
          apiKeyEnv: "INTERNAL_KEY",
          models: [
            {
              publicModel: "internal/chat",
              upstreamModel: "internal-chat",
              endpoints: ["chat.completions"],
            },
          ],
        },
      ]),
      INTERNAL_KEY: "secret",
    }),
  ).toThrow("must not target local, private, link-local, or metadata hosts");

  expect(() =>
    createTakosumiAiGatewayConfigFromEnv({
      TAKOSUMI_AI_GATEWAY_PROFILES: JSON.stringify([
        {
          id: "mapped-loopback",
          provider: "openai_compatible",
          baseUrl: "https://[::ffff:127.0.0.1]/v1",
          apiKeyEnv: "MAPPED_KEY",
          models: [
            {
              publicModel: "mapped/chat",
              upstreamModel: "mapped-chat",
              endpoints: ["chat.completions"],
            },
          ],
        },
      ]),
      MAPPED_KEY: "secret",
    }),
  ).toThrow("must not target local, private, link-local, or metadata hosts");
});

test("AI Gateway config rejects credentials embedded in upstream URLs", () => {
  expect(() =>
    createTakosumiAiGatewayConfigFromEnv({
      TAKOSUMI_AI_GATEWAY_PROFILES: JSON.stringify([
        {
          id: "credentialed",
          provider: "openai_compatible",
          baseUrl: "https://user:pass@api.example.test/v1",
          apiKeyEnv: "UPSTREAM_KEY",
          models: [
            {
              publicModel: "credentialed/chat",
              upstreamModel: "credentialed-chat",
              endpoints: ["chat.completions"],
            },
          ],
        },
      ]),
      UPSTREAM_KEY: "secret",
    }),
  ).toThrow("must not embed credentials");
});

test("AI Gateway config permits local http only with explicit test opt-in", () => {
  const config = createTakosumiAiGatewayConfigFromEnv({
    TAKOSUMI_AI_GATEWAY_ALLOW_LOCAL_HTTP: "1",
    TAKOSUMI_AI_GATEWAY_PROFILES: JSON.stringify([
      {
        id: "local",
        provider: "openai_compatible",
        baseUrl: "http://localhost:11434/v1",
        apiKeyEnv: "LOCAL_KEY",
        models: [
          {
            publicModel: "local/chat",
            upstreamModel: "local-chat",
            endpoints: ["chat.completions"],
          },
        ],
      },
    ]),
    LOCAL_KEY: "secret",
  });

  expect(config.profiles[0]?.baseUrl).toBe("http://localhost:11434/v1");
});

test("AI Gateway config rejects unknown default model aliases", () => {
  expect(() =>
    createTakosumiAiGatewayConfigFromEnv({
      ...gatewayEnv(),
      TAKOSUMI_AI_GATEWAY_DEFAULT_MODEL: "missing/model",
    }),
  ).toThrow("must reference a configured publicModel");
});

test("AI Gateway path is fixed to the Service Graph contract endpoint", () => {
  const config = createTakosumiAiGatewayConfigFromEnv({
    ...gatewayEnv(),
    TAKOSUMI_AI_GATEWAY_BASE_PATH: "/gateway/ai/v1",
  });
  expect(config.basePath).toBe("/gateway/ai/v1");
  expect(() =>
    createTakosumiAiGatewayConfigFromEnv({
      ...gatewayEnv(),
      TAKOSUMI_AI_GATEWAY_BASE_PATH: "/custom/ai/v1",
    }),
  ).toThrow("fixed at /gateway/ai/v1");
});
