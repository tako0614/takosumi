import {
  TAKOSUMI_AI_GATEWAY_BASE_PATH,
  TAKOSUMI_AI_GATEWAY_DEFAULT_MODEL,
  TAKOSUMI_AI_GATEWAY_SCOPES,
  type TakosumiAiGatewayEndpoint,
  type TakosumiAiGatewayModelAlias,
  type TakosumiAiGatewayModelListResponse,
  type TakosumiOpenAiCompatibleProfile,
  type TakosumiAiGatewayProvider,
  type TakosumiAiGatewayRoute,
  type TakosumiAiGatewayScope,
  type TakosumiAiGatewayStatusResponse,
  type TakosumiWorkersAiGatewayOptions,
  type TakosumiWorkersAiBindingProfile,
} from "takosumi-contract/ai-gateway";
import type { JsonObject, JsonValue } from "takosumi-contract";
import {
  containsSecretLikeString,
  isSecretKey,
  redactString,
} from "../observability/redaction.ts";

export interface TakosumiAiGatewayConfig {
  readonly basePath: string;
  readonly defaultModel: string;
  readonly profiles: readonly ResolvedAiGatewayUpstreamProfile[];
}

export interface ResolvedOpenAiCompatibleProfile extends Omit<
  TakosumiOpenAiCompatibleProfile,
  "apiKeyEnv"
> {
  readonly type: "openai_compatible";
  readonly apiKey: string;
}

export interface ResolvedWorkersAiBindingProfile extends TakosumiWorkersAiBindingProfile {
  readonly type: "workers_ai_binding";
}

export type ResolvedAiGatewayUpstreamProfile =
  | ResolvedOpenAiCompatibleProfile
  | ResolvedWorkersAiBindingProfile;

export interface TakosumiWorkersAiBinding {
  run(
    model: string,
    input: unknown,
    options?: TakosumiWorkersAiRunOptions,
  ): Promise<unknown>;
  readonly aiGatewayLogId?: string;
}

export interface TakosumiWorkersAiRunOptions {
  readonly gateway?: TakosumiWorkersAiGatewayOptions;
}

export interface TakosumiAiGatewayAuthContext {
  readonly subject?: string;
  readonly installationId?: string;
  readonly spaceId?: string;
  readonly scopes?: readonly string[];
}

export interface TakosumiAiGatewayAuthRequest {
  readonly endpoint: TakosumiAiGatewayRoute;
  readonly requiredScopes: readonly TakosumiAiGatewayScope[];
}

export type TakosumiAiGatewayAuthorize = (
  request: Request,
  auth: TakosumiAiGatewayAuthRequest,
) => Promise<
  | { readonly ok: true; readonly context?: TakosumiAiGatewayAuthContext }
  | { readonly ok: false; readonly response: Response }
>;

export interface TakosumiAiGatewayHandlerOptions {
  readonly config: TakosumiAiGatewayConfig;
  readonly authorize: TakosumiAiGatewayAuthorize;
  readonly fetcher?: typeof fetch;
  readonly workersAi?: TakosumiWorkersAiBinding;
}

type JsonRecord = Record<string, JsonValue>;

const HOP_BY_HOP_RESPONSE_HEADERS = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "set-cookie",
  "transfer-encoding",
  "upgrade",
]);

const FORBIDDEN_STATIC_UPSTREAM_HEADERS = new Set([
  ...HOP_BY_HOP_RESPONSE_HEADERS,
  "authorization",
  "cookie",
  "host",
  "proxy-authorization",
  "set-cookie",
  "te",
  "trailer",
]);

const SECRET_BEARING_STATIC_UPSTREAM_HEADER_PATTERN =
  /(^|[-_])(api[-_]?key|access[-_]?token|auth[-_]?token|secret|credential)([-_]|$)/;

export function createTakosumiAiGatewayConfigFromEnv(
  env: Readonly<Record<string, unknown>>,
): TakosumiAiGatewayConfig {
  const configuredBasePath = stringEnv(env, "TAKOSUMI_AI_GATEWAY_BASE_PATH");
  if (
    configuredBasePath !== undefined &&
    configuredBasePath !== TAKOSUMI_AI_GATEWAY_BASE_PATH
  ) {
    throw new TypeError(
      "TAKOSUMI_AI_GATEWAY_BASE_PATH is fixed at /gateway/ai/v1",
    );
  }
  const profiles = profilesFromJsonEnv(env);
  if (profiles.length === 0) {
    throw new TypeError(
      "TAKOSUMI_AI_GATEWAY_PROFILES must define at least one upstream profile",
    );
  }
  const config = {
    basePath: TAKOSUMI_AI_GATEWAY_BASE_PATH,
    defaultModel:
      stringEnv(env, "TAKOSUMI_AI_GATEWAY_DEFAULT_MODEL") ??
      defaultModelFromProfiles(profiles),
    profiles,
  };
  if (
    profiles.length > 0 &&
    !allModels(config).some(
      ({ model }) => model.publicModel === config.defaultModel,
    )
  ) {
    throw new TypeError(
      "TAKOSUMI_AI_GATEWAY_DEFAULT_MODEL must reference a configured publicModel",
    );
  }
  return config;
}

export async function handleTakosumiAiGatewayRequest(
  request: Request,
  url: URL,
  options: TakosumiAiGatewayHandlerOptions,
): Promise<Response> {
  const endpoint = endpointFromPath(url.pathname, options.config.basePath);
  if (!endpoint) {
    return withoutBodyForHead(
      request,
      aiGatewayError(404, "not_found", "not found"),
    );
  }
  if (request.method === "OPTIONS") return optionsResponse();

  const methodIssue = methodIssueForEndpoint(request.method, endpoint);
  if (methodIssue) return withoutBodyForHead(request, methodIssue);

  const auth = await options.authorize(request, {
    endpoint,
    requiredScopes: requiredScopesForEndpoint(endpoint),
  });
  if (!auth.ok) return withoutBodyForHead(request, auth.response);

  switch (endpoint) {
    case "status":
      return withoutBodyForHead(
        request,
        handleStatus(options.config, options.workersAi),
      );
    case "models":
      return withoutBodyForHead(request, handleModels(options.config));
    case "chat.completions":
      return await forwardModelRequest({
        request,
        endpoint,
        config: options.config,
        fetcher: options.fetcher ?? fetch,
        workersAi: options.workersAi,
      });
    case "embeddings":
      return await forwardModelRequest({
        request,
        endpoint,
        config: options.config,
        fetcher: options.fetcher ?? fetch,
        workersAi: options.workersAi,
      });
  }
}

function withoutBodyForHead(request: Request, response: Response): Response {
  if (request.method !== "HEAD") return response;
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function endpointFromPath(
  pathname: string,
  basePath = TAKOSUMI_AI_GATEWAY_BASE_PATH,
): TakosumiAiGatewayRoute | undefined {
  const base = basePath.replace(/\/+$/, "");
  if (pathname === `${base}/__takosumi/status`) return "status";
  if (pathname === `${base}/models`) return "models";
  if (pathname === `${base}/chat/completions`) return "chat.completions";
  if (pathname === `${base}/embeddings`) return "embeddings";
  return undefined;
}

export function requiredScopesForEndpoint(
  endpoint: TakosumiAiGatewayRoute,
): readonly TakosumiAiGatewayScope[] {
  switch (endpoint) {
    case "status":
      return ["ai.models.read"];
    case "models":
      return ["ai.models.read"];
    case "chat.completions":
      return ["ai.chat"];
    case "embeddings":
      return ["ai.embeddings"];
  }
}

function handleStatus(
  config: TakosumiAiGatewayConfig,
  workersAi?: TakosumiWorkersAiBinding,
): Response {
  const models = allModels(config);
  const response: TakosumiAiGatewayStatusResponse = {
    kind: "takosumi.ai-gateway-status@v1",
    mode: "configured_upstreams",
    defaultModel: config.defaultModel,
    endpoints: ["status", "models", "chat.completions", "embeddings"],
    summary: {
      profileCount: config.profiles.length,
      publicModelCount: models.length,
      providers: [
        ...new Set(config.profiles.map((profile) => profile.provider)),
      ],
    },
    upstreamProfiles: config.profiles.map((profile) => ({
      id: profile.id,
      provider: profile.provider,
      type: profile.type,
      endpointOrigin: profileEndpointOrigin(profile),
      modelCount: profile.models.length,
      publicModels: profile.models.map((model) => ({
        publicModel: model.publicModel,
        endpoints: model.endpoints,
        default: model.default,
        contextWindow: model.contextWindow,
        maxOutputTokens: model.maxOutputTokens,
        billingClass: model.billingClass,
        metadata: model.metadata,
      })),
    })),
    workersAiFallback: {
      enabled: false,
      aiBindingConfigured: Boolean(workersAi),
      chatModel: "",
      embeddingModel: "",
    },
  };
  return jsonResponse(response);
}

function handleModels(config: TakosumiAiGatewayConfig): Response {
  const models = allModels(config);
  const defaultTarget = models.find(
    ({ model }) => model.publicModel === config.defaultModel,
  );
  const response: TakosumiAiGatewayModelListResponse = {
    object: "list",
    data: [
      ...(defaultTarget &&
      !models.some(
        ({ model }) => model.publicModel === TAKOSUMI_AI_GATEWAY_DEFAULT_MODEL,
      )
        ? [
            {
              id: TAKOSUMI_AI_GATEWAY_DEFAULT_MODEL,
              object: "model" as const,
              created: 0,
              owned_by: `takosumi/${defaultTarget.profile.provider}`,
              metadata: {
                aliasOf: defaultTarget.model.publicModel,
              },
            },
          ]
        : []),
      ...models.map(({ profile, model }) => ({
        id: model.publicModel,
        object: "model" as const,
        created: 0,
        owned_by: `takosumi/${profile.provider}`,
        metadata: model.metadata,
      })),
    ],
  };
  return jsonResponse(response);
}

async function forwardModelRequest(input: {
  readonly request: Request;
  readonly endpoint: "chat.completions" | "embeddings";
  readonly config: TakosumiAiGatewayConfig;
  readonly fetcher: typeof fetch;
  readonly workersAi?: TakosumiWorkersAiBinding;
}): Promise<Response> {
  const body = await readJsonRecord(input.request);
  if (!body) {
    return aiGatewayError(
      400,
      "invalid_json",
      "request body must be a JSON object",
    );
  }
  const requestedModel =
    typeof body.model === "string" && body.model.trim()
      ? body.model.trim()
      : input.config.defaultModel;
  const selected = selectModel(input.config, requestedModel, input.endpoint);
  if (!selected) {
    return aiGatewayError(
      404,
      "model_not_found",
      `model is not available for ${input.endpoint}`,
    );
  }

  if (selected.profile.type === "workers_ai_binding") {
    return await forwardWorkersAiBindingRequest({
      body,
      endpoint: input.endpoint,
      profile: selected.profile,
      model: selected.model,
      workersAi: input.workersAi,
    });
  }

  return await forwardOpenAiCompatibleRequest({
    request: input.request,
    body,
    endpoint: input.endpoint,
    profile: selected.profile,
    model: selected.model,
    fetcher: input.fetcher,
  });
}

async function forwardOpenAiCompatibleRequest(input: {
  readonly request: Request;
  readonly body: JsonRecord;
  readonly endpoint: "chat.completions" | "embeddings";
  readonly profile: ResolvedOpenAiCompatibleProfile;
  readonly model: TakosumiAiGatewayModelAlias;
  readonly fetcher: typeof fetch;
}): Promise<Response> {
  const upstreamBody = {
    ...input.body,
    model: input.model.upstreamModel,
  };
  const upstreamUrl = upstreamEndpointUrl(input.profile, input.endpoint);
  const upstreamHeaders = new Headers();
  upstreamHeaders.set("content-type", "application/json");
  const accept = input.request.headers.get("accept");
  if (accept) upstreamHeaders.set("accept", accept);
  for (const [name, value] of Object.entries(input.profile.headers ?? {})) {
    upstreamHeaders.set(name, value);
  }
  const apiKeyHeader = input.profile.apiKeyHeader ?? "authorization";
  if (apiKeyHeader.toLowerCase() === "authorization") {
    upstreamHeaders.set("authorization", `Bearer ${input.profile.apiKey}`);
  } else {
    upstreamHeaders.set(apiKeyHeader, input.profile.apiKey);
  }

  let upstreamResponse: Response;
  try {
    upstreamResponse = await input.fetcher(
      new Request(upstreamUrl, {
        method: "POST",
        headers: upstreamHeaders,
        body: JSON.stringify(upstreamBody),
      }),
    );
  } catch {
    return aiGatewayError(
      502,
      "upstream_unavailable",
      "upstream model provider is unavailable",
    );
  }

  if (!upstreamResponse.ok) {
    return upstreamErrorResponse(upstreamResponse, {
      provider: input.profile.provider,
      publicModel: input.model.publicModel,
    });
  }

  return upstreamPassthroughResponse(upstreamResponse, {
    provider: input.profile.provider,
    publicModel: input.model.publicModel,
  });
}

async function forwardWorkersAiBindingRequest(input: {
  readonly body: JsonRecord;
  readonly endpoint: "chat.completions" | "embeddings";
  readonly profile: ResolvedWorkersAiBindingProfile;
  readonly model: TakosumiAiGatewayModelAlias;
  readonly workersAi?: TakosumiWorkersAiBinding;
}): Promise<Response> {
  if (!input.workersAi) {
    return aiGatewayError(
      503,
      "workers_ai_unconfigured",
      "Workers AI binding is not configured",
    );
  }
  if (input.body.stream === true) {
    return aiGatewayError(
      400,
      "streaming_not_supported",
      "Workers AI binding profiles do not expose OpenAI-compatible streaming yet",
    );
  }
  const workersAiInput = workersAiInputForEndpoint(input.body, input.endpoint);
  let result: unknown;
  try {
    result = await input.workersAi.run(
      input.model.upstreamModel,
      workersAiInput,
      input.profile.gateway
        ? {
            gateway: input.profile.gateway,
          }
        : undefined,
    );
  } catch {
    return aiGatewayError(
      502,
      "upstream_unavailable",
      "upstream model provider is unavailable",
    );
  }
  const normalized =
    input.endpoint === "chat.completions"
      ? workersAiChatCompletionResponse(result, input.model.publicModel)
      : workersAiEmbeddingsResponse(result, input.model.publicModel);
  if (!normalized) {
    return aiGatewayError(
      502,
      "invalid_upstream_response",
      "upstream model provider returned an invalid response",
    );
  }
  return jsonResponse(normalized, {
    headers: aiGatewayProviderHeaders({
      provider: input.profile.provider,
      publicModel: input.model.publicModel,
    }),
  });
}

function selectModel(
  config: TakosumiAiGatewayConfig,
  requestedModel: string,
  endpoint: "chat.completions" | "embeddings",
):
  | {
      readonly profile: ResolvedAiGatewayUpstreamProfile;
      readonly model: TakosumiAiGatewayModelAlias;
    }
  | undefined {
  const resolvedModel =
    requestedModel === TAKOSUMI_AI_GATEWAY_DEFAULT_MODEL
      ? config.defaultModel
      : requestedModel;
  return allModels(config).find(
    ({ model }) =>
      model.publicModel === resolvedModel && model.endpoints.includes(endpoint),
  );
}

function allModels(config: TakosumiAiGatewayConfig): readonly {
  readonly profile: ResolvedAiGatewayUpstreamProfile;
  readonly model: TakosumiAiGatewayModelAlias;
}[] {
  return config.profiles.flatMap((profile) =>
    profile.models.map((model) => ({ profile, model })),
  );
}

function upstreamEndpointUrl(
  profile: ResolvedOpenAiCompatibleProfile,
  endpoint: "chat.completions" | "embeddings",
): string {
  const base = profile.baseUrl.replace(/\/+$/, "");
  switch (endpoint) {
    case "chat.completions":
      return `${base}/chat/completions`;
    case "embeddings":
      return `${base}/embeddings`;
  }
}

function profileEndpointOrigin(
  profile: ResolvedAiGatewayUpstreamProfile,
): string {
  return profile.type === "workers_ai_binding"
    ? "cloudflare:workers-ai"
    : new URL(profile.baseUrl).origin;
}

function workersAiInputForEndpoint(
  body: JsonRecord,
  endpoint: "chat.completions" | "embeddings",
): JsonRecord {
  if (endpoint === "embeddings") {
    const { model: _model, input, ...rest } = body;
    const output: JsonRecord = { ...rest };
    if (!("text" in output) && input !== undefined) {
      output.text = input;
    }
    return output;
  }
  const { model: _model, ...rest } = body;
  return rest;
}

function workersAiChatCompletionResponse(
  result: unknown,
  publicModel: string,
): unknown | undefined {
  if (!isPlainRecord(result)) return undefined;
  if (Array.isArray(result.choices)) {
    return {
      ...result,
      model: publicModel,
    };
  }
  const content =
    typeof result.response === "string"
      ? result.response
      : typeof result.text === "string"
        ? result.text
        : undefined;
  if (content === undefined) return undefined;
  return {
    id: `chatcmpl_workers_ai_${stableResponseSuffix(content)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: publicModel,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content,
        },
        finish_reason: "stop",
      },
    ],
  };
}

function workersAiEmbeddingsResponse(
  result: unknown,
  publicModel: string,
): unknown | undefined {
  if (!isPlainRecord(result)) return undefined;
  const data = result.data;
  const embeddings = isNumberArray(data)
    ? [data]
    : Array.isArray(data)
      ? data
          .map((entry) =>
            isNumberArray(entry)
              ? entry
              : isPlainRecord(entry) && isNumberArray(entry.embedding)
                ? entry.embedding
                : undefined,
          )
          .filter((entry): entry is number[] => entry !== undefined)
      : undefined;
  if (!embeddings || embeddings.length === 0) return undefined;
  return {
    object: "list",
    data: embeddings.map((embedding, index) => ({
      object: "embedding",
      embedding,
      index,
    })),
    model: publicModel,
  };
}

function isNumberArray(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => typeof entry === "number" && Number.isFinite(entry))
  );
}

function stableResponseSuffix(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function aiGatewayProviderHeaders(metadata: {
  readonly provider: TakosumiAiGatewayProvider;
  readonly publicModel: string;
}): Headers {
  const headers = new Headers();
  headers.set("x-takosumi-ai-gateway-provider", metadata.provider);
  headers.set("x-takosumi-ai-gateway-model", metadata.publicModel);
  return headers;
}

function upstreamPassthroughResponse(
  upstream: Response,
  metadata: {
    readonly provider: TakosumiAiGatewayProvider;
    readonly publicModel: string;
  },
): Response {
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: upstreamResponseHeaders(upstream, metadata),
  });
}

function upstreamErrorResponse(
  upstream: Response,
  metadata: {
    readonly provider: TakosumiAiGatewayProvider;
    readonly publicModel: string;
  },
): Response {
  return jsonResponse(
    {
      error: {
        message: "upstream model provider returned an error",
        type: upstream.status >= 500 ? "server_error" : "invalid_request_error",
        code: "upstream_error",
      },
    },
    {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: upstreamResponseHeaders(upstream, metadata, {
        contentType: "application/json; charset=utf-8",
      }),
    },
  );
}

function upstreamResponseHeaders(
  upstream: Response,
  metadata: {
    readonly provider: TakosumiAiGatewayProvider;
    readonly publicModel: string;
  },
  options: { readonly contentType?: string } = {},
): Headers {
  const headers = new Headers();
  const contentType =
    options.contentType ?? upstream.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  const cacheControl = upstream.headers.get("cache-control");
  if (cacheControl) headers.set("cache-control", cacheControl);
  const requestId = upstream.headers.get("x-request-id");
  if (requestId) headers.set("x-upstream-request-id", requestId);
  headers.set("x-takosumi-ai-gateway-provider", metadata.provider);
  headers.set("x-takosumi-ai-gateway-model", metadata.publicModel);
  for (const [name, value] of upstream.headers) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_RESPONSE_HEADERS.has(lower) || headers.has(name)) continue;
    if (lower.startsWith("x-ratelimit-")) headers.set(name, value);
  }
  return headers;
}

function methodIssueForEndpoint(
  method: string,
  endpoint: TakosumiAiGatewayRoute,
): Response | undefined {
  if (
    (endpoint === "models" || endpoint === "status") &&
    method !== "GET" &&
    method !== "HEAD"
  ) {
    return aiGatewayError(405, "method_not_allowed", "method not allowed");
  }
  if (
    (endpoint === "chat.completions" || endpoint === "embeddings") &&
    method !== "POST"
  ) {
    return aiGatewayError(405, "method_not_allowed", "method not allowed");
  }
  return undefined;
}

async function readJsonRecord(
  request: Request,
): Promise<JsonRecord | undefined> {
  try {
    const value = await request.json();
    return isJsonRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function profilesFromJsonEnv(
  env: Readonly<Record<string, unknown>>,
): readonly ResolvedAiGatewayUpstreamProfile[] {
  const raw = stringEnv(env, "TAKOSUMI_AI_GATEWAY_PROFILES");
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new TypeError("TAKOSUMI_AI_GATEWAY_PROFILES must be valid JSON");
  }
  if (!Array.isArray(parsed)) {
    throw new TypeError("TAKOSUMI_AI_GATEWAY_PROFILES must be a JSON array");
  }
  return parsed.map((entry, index) => parseProfile(entry, env, index));
}

function parseProfile(
  entry: unknown,
  env: Readonly<Record<string, unknown>>,
  index: number,
): ResolvedAiGatewayUpstreamProfile {
  if (!isPlainRecord(entry)) {
    throw new TypeError(`AI Gateway profile ${index} must be an object`);
  }
  const id = requiredString(entry.id, `AI Gateway profile ${index}.id`);
  const provider = requiredString(
    entry.provider,
    `AI Gateway profile ${index}.provider`,
  ) as TakosumiAiGatewayProvider;
  const profileType =
    entry.type === undefined ? "openai_compatible" : entry.type;
  if (profileType === "workers_ai_binding") {
    for (const field of ["baseUrl", "apiKeyEnv", "apiKeyHeader", "headers"]) {
      if (field in entry) {
        throw new TypeError(
          `AI Gateway profile ${id}.${field} is not valid for workers_ai_binding`,
        );
      }
    }
    const models = parseModels(entry.models, id);
    const gateway = parseWorkersAiGateway(entry.gateway, id);
    return {
      type: "workers_ai_binding",
      id,
      provider,
      models,
      gateway,
    };
  }
  if (profileType !== "openai_compatible") {
    throw new TypeError(
      `AI Gateway profile ${id}.type is not supported by the OpenAI-compatible handler`,
    );
  }
  const baseUrl = normalizeBaseUrl(
    requiredString(entry.baseUrl, `AI Gateway profile ${index}.baseUrl`),
    `AI Gateway profile ${index}.baseUrl`,
    {
      allowLocalHttp:
        stringEnv(env, "TAKOSUMI_AI_GATEWAY_ALLOW_LOCAL_HTTP") === "1",
      allowPrivateUpstreams:
        stringEnv(env, "TAKOSUMI_AI_GATEWAY_ALLOW_PRIVATE_UPSTREAMS") === "1",
    },
  );
  const apiKeyEnv = requiredString(
    entry.apiKeyEnv,
    `AI Gateway profile ${index}.apiKeyEnv`,
  );
  if ("apiKey" in entry) {
    throw new TypeError(
      `AI Gateway profile ${id}.apiKey must not be embedded; use apiKeyEnv`,
    );
  }
  const apiKey = stringEnv(env, apiKeyEnv);
  if (!apiKey) {
    throw new TypeError(
      `${apiKeyEnv} is required for AI Gateway profile ${id}`,
    );
  }
  const apiKeyHeader = optionalHeaderName(
    entry.apiKeyHeader,
    `AI Gateway profile ${id}.apiKeyHeader`,
  );
  const models = parseModels(entry.models, id);
  const headers = parseHeaders(entry.headers, id, apiKeyHeader);
  return {
    type: "openai_compatible",
    id,
    provider,
    baseUrl,
    apiKey,
    apiKeyHeader,
    models,
    headers,
  };
}

function parseModels(
  value: unknown,
  profileId: string,
): readonly TakosumiAiGatewayModelAlias[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`AI Gateway profile ${profileId} must define models`);
  }
  return value.map((entry, index) => {
    if (!isPlainRecord(entry)) {
      throw new TypeError(
        `AI Gateway profile ${profileId}.models[${index}] must be an object`,
      );
    }
    const publicModel = requiredString(
      entry.publicModel,
      `AI Gateway profile ${profileId}.models[${index}].publicModel`,
    );
    const upstreamModel = requiredString(
      entry.upstreamModel,
      `AI Gateway profile ${profileId}.models[${index}].upstreamModel`,
    );
    const endpoints = parseEndpoints(entry.endpoints, profileId, index);
    return {
      publicModel,
      upstreamModel,
      endpoints,
      default: entry.default === true,
      contextWindow: optionalPositiveInteger(entry.contextWindow),
      maxOutputTokens: optionalPositiveInteger(entry.maxOutputTokens),
      billingClass:
        typeof entry.billingClass === "string" ? entry.billingClass : undefined,
      metadata: parsePublicMetadata(
        entry.metadata,
        `AI Gateway profile ${profileId}.models[${index}].metadata`,
      ),
    };
  });
}

function parsePublicMetadata(
  value: unknown,
  label: string,
): JsonObject | undefined {
  if (value === undefined) return undefined;
  if (!isJsonObject(value)) {
    throw new TypeError(`${label} must be a JSON object`);
  }
  const issue = publicMetadataSecretIssue(value, label);
  if (issue) {
    throw new TypeError(`${issue} may carry secrets; use apiKeyEnv`);
  }
  return value;
}

function parseWorkersAiGateway(
  value: unknown,
  profileId: string,
): TakosumiWorkersAiGatewayOptions | undefined {
  if (value === undefined) return undefined;
  if (!isPlainRecord(value)) {
    throw new TypeError(
      `AI Gateway profile ${profileId}.gateway must be an object`,
    );
  }
  const id = requiredString(
    value.id,
    `AI Gateway profile ${profileId}.gateway.id`,
  );
  if (containsSecretLikeString(id) || redactString(id) !== id) {
    throw new TypeError(
      `AI Gateway profile ${profileId}.gateway.id may carry secrets`,
    );
  }
  const gateway: {
    id: string;
    skipCache?: boolean;
    cacheTtl?: number;
    cacheKey?: string;
    collectLog?: boolean;
    metadata?: JsonObject;
  } = { id };
  if (value.skipCache !== undefined) {
    if (typeof value.skipCache !== "boolean") {
      throw new TypeError(
        `AI Gateway profile ${profileId}.gateway.skipCache must be a boolean`,
      );
    }
    gateway.skipCache = value.skipCache;
  }
  if (value.cacheTtl !== undefined) {
    gateway.cacheTtl = optionalPositiveInteger(value.cacheTtl);
    if (gateway.cacheTtl === undefined) {
      throw new TypeError(
        `AI Gateway profile ${profileId}.gateway.cacheTtl must be a positive integer`,
      );
    }
  }
  if (value.cacheKey !== undefined) {
    gateway.cacheKey = requiredString(
      value.cacheKey,
      `AI Gateway profile ${profileId}.gateway.cacheKey`,
    );
    if (
      containsSecretLikeString(gateway.cacheKey) ||
      redactString(gateway.cacheKey) !== gateway.cacheKey
    ) {
      throw new TypeError(
        `AI Gateway profile ${profileId}.gateway.cacheKey may carry secrets`,
      );
    }
  }
  if (value.collectLog !== undefined) {
    if (typeof value.collectLog !== "boolean") {
      throw new TypeError(
        `AI Gateway profile ${profileId}.gateway.collectLog must be a boolean`,
      );
    }
    gateway.collectLog = value.collectLog;
  }
  gateway.metadata = parsePublicMetadata(
    value.metadata,
    `AI Gateway profile ${profileId}.gateway.metadata`,
  );
  return gateway;
}

function publicMetadataSecretIssue(
  value: JsonValue,
  path: string,
): string | undefined {
  if (typeof value === "string") {
    return containsSecretLikeString(value) || redactString(value) !== value
      ? path
      : undefined;
  }
  if (Array.isArray(value)) {
    for (const [index, child] of value.entries()) {
      const issue = publicMetadataSecretIssue(child, `${path}[${index}]`);
      if (issue) return issue;
    }
    return undefined;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      const childPath = `${path}.${key}`;
      if (isSecretKey(key)) return childPath;
      const issue = publicMetadataSecretIssue(child, childPath);
      if (issue) return issue;
    }
  }
  return undefined;
}

function parseEndpoints(
  value: unknown,
  profileId: string,
  modelIndex: number,
): readonly TakosumiAiGatewayEndpoint[] {
  const endpoints =
    value === undefined
      ? (["chat.completions"] as const)
      : Array.isArray(value)
        ? value
        : undefined;
  if (!endpoints) {
    throw new TypeError(
      `AI Gateway profile ${profileId}.models[${modelIndex}].endpoints must be an array`,
    );
  }
  const normalized: TakosumiAiGatewayEndpoint[] = [];
  for (const endpoint of endpoints) {
    if (
      endpoint !== "models" &&
      endpoint !== "chat.completions" &&
      endpoint !== "embeddings"
    ) {
      throw new TypeError(
        `AI Gateway profile ${profileId}.models[${modelIndex}] has unsupported endpoint ${String(endpoint)}`,
      );
    }
    if (endpoint !== "models" && !normalized.includes(endpoint)) {
      normalized.push(endpoint);
    }
  }
  return normalized;
}

function parseHeaders(
  value: unknown,
  profileId: string,
  apiKeyHeader: string | undefined,
): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  if (!isPlainRecord(value)) {
    throw new TypeError(
      `AI Gateway profile ${profileId}.headers must be an object`,
    );
  }
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(value)) {
    if (typeof headerValue !== "string") {
      throw new TypeError(
        `AI Gateway profile ${profileId}.headers.${name} must be a string`,
      );
    }
    if (
      containsSecretLikeString(headerValue) ||
      redactString(headerValue) !== headerValue
    ) {
      throw new TypeError(
        `AI Gateway profile ${profileId}.headers.${name} value may carry secrets; use apiKeyEnv and apiKeyHeader`,
      );
    }
    if (isForbiddenUpstreamHeader(name)) {
      throw new TypeError(
        `AI Gateway profile ${profileId}.headers.${name} is reserved`,
      );
    }
    if (apiKeyHeader && name.toLowerCase() === apiKeyHeader.toLowerCase()) {
      throw new TypeError(
        `AI Gateway profile ${profileId}.headers.${name} conflicts with apiKeyHeader`,
      );
    }
    if (isSecretBearingStaticUpstreamHeader(name)) {
      throw new TypeError(
        `AI Gateway profile ${profileId}.headers.${name} may carry secrets; use apiKeyEnv and apiKeyHeader`,
      );
    }
    headers[name] = headerValue;
  }
  return headers;
}

function optionalHeaderName(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  const name = requiredString(value, label).toLowerCase();
  if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name)) {
    throw new TypeError(`${label} must be a valid HTTP header name`);
  }
  if (isForbiddenUpstreamHeader(name) && name !== "authorization") {
    throw new TypeError(`${label} is reserved`);
  }
  return name;
}

function normalizeBaseUrl(
  value: string,
  label: string,
  options: {
    readonly allowLocalHttp: boolean;
    readonly allowPrivateUpstreams: boolean;
  },
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`${label} must be an absolute URL`);
  }
  if (url.username || url.password) {
    throw new TypeError(`${label} must not embed credentials`);
  }
  const hostname = normalizeHostname(url.hostname);
  const isLocalHttp = url.protocol === "http:" && isLocalHost(hostname);
  if (url.protocol !== "https:" && !(isLocalHttp && options.allowLocalHttp)) {
    throw new TypeError(
      `${label} must use https; local http requires TAKOSUMI_AI_GATEWAY_ALLOW_LOCAL_HTTP=1`,
    );
  }
  const privateHostAllowed =
    options.allowPrivateUpstreams || (isLocalHttp && options.allowLocalHttp);
  if (!privateHostAllowed && isPrivateOrLocalHost(hostname)) {
    throw new TypeError(
      `${label} must not target local, private, link-local, or metadata hosts`,
    );
  }
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/+$/, "");
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
}

function isLocalHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "127.0.0.1" ||
    hostname === "::1"
  );
}

function isPrivateOrLocalHost(hostname: string): boolean {
  if (isLocalHost(hostname)) return true;
  if (isReservedInternalDnsHost(hostname)) return true;
  const ipv4 = parseIpv4(hostname);
  if (ipv4) {
    const [a, b] = ipv4;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  const mappedIpv4 = parseIpv4MappedIpv6(hostname);
  if (mappedIpv4) {
    return isPrivateOrLocalHost(mappedIpv4.join("."));
  }
  if (!hostname.includes(":")) return false;
  return (
    hostname === "::" ||
    hostname === "::1" ||
    hostname.startsWith("fc") ||
    hostname.startsWith("fd") ||
    hostname.startsWith("fe80:") ||
    hostname.startsWith("ff")
  );
}

function isReservedInternalDnsHost(hostname: string): boolean {
  return (
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".home.arpa") ||
    hostname.endsWith(".lan")
  );
}

function parseIpv4(
  hostname: string,
): readonly [number, number, number, number] | undefined {
  const parts = hostname.split(".");
  if (parts.length !== 4) return undefined;
  const octets = parts.map((part) => {
    if (!/^[0-9]+$/.test(part)) return undefined;
    const value = Number(part);
    return Number.isInteger(value) && value >= 0 && value <= 255
      ? value
      : undefined;
  });
  if (octets.some((part) => part === undefined)) return undefined;
  return octets as [number, number, number, number];
}

function parseIpv4MappedIpv6(
  hostname: string,
): readonly [number, number, number, number] | undefined {
  const lower = hostname.toLowerCase();
  if (!lower.startsWith("::ffff:")) return undefined;
  const tail = lower.slice("::ffff:".length);
  const dotted = parseIpv4(tail);
  if (dotted) return dotted;
  const parts = tail.split(":");
  if (parts.length !== 2) return undefined;
  const words = parts.map((part) => {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return undefined;
    return Number.parseInt(part, 16);
  });
  if (words.some((word) => word === undefined)) return undefined;
  const [high, low] = words as [number, number];
  return [high >> 8, high & 0xff, low >> 8, low & 0xff];
}

function defaultModelFromProfiles(
  profiles: readonly ResolvedAiGatewayUpstreamProfile[],
): string {
  return (
    allModels({
      basePath: TAKOSUMI_AI_GATEWAY_BASE_PATH,
      defaultModel: TAKOSUMI_AI_GATEWAY_DEFAULT_MODEL,
      profiles,
    }).find(({ model }) => model.default)?.model.publicModel ??
    allModels({
      basePath: TAKOSUMI_AI_GATEWAY_BASE_PATH,
      defaultModel: TAKOSUMI_AI_GATEWAY_DEFAULT_MODEL,
      profiles,
    })[0]?.model.publicModel ??
    TAKOSUMI_AI_GATEWAY_DEFAULT_MODEL
  );
}

function optionsResponse(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "authorization, content-type",
      "access-control-max-age": "600",
    },
  });
}

export function aiGatewayUnauthorizedResponse(
  code = "invalid_token",
): Response {
  return aiGatewayError(401, code, "invalid AI Gateway bearer", {
    "www-authenticate": `Bearer error="${code}"`,
  });
}

export function aiGatewayInsufficientScopeResponse(scope: string): Response {
  return aiGatewayError(403, "insufficient_scope", "insufficient scope", {
    "www-authenticate": `Bearer error="insufficient_scope", scope="${scope}"`,
  });
}

function aiGatewayError(
  status: number,
  code: string,
  message: string,
  headers?: HeadersInit,
): Response {
  return jsonResponse(
    {
      error: {
        message,
        type: status >= 500 ? "server_error" : "invalid_request_error",
        code,
      },
    },
    { status, headers },
  );
}

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json; charset=utf-8");
  }
  return new Response(JSON.stringify(value), { ...init, headers });
}

function stringEnv(
  env: Readonly<Record<string, unknown>>,
  name: string,
): string | undefined {
  const value = env[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function optionalPositiveInteger(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return undefined;
  }
  return value;
}

function isForbiddenUpstreamHeader(name: string): boolean {
  return FORBIDDEN_STATIC_UPSTREAM_HEADERS.has(name.toLowerCase());
}

function isSecretBearingStaticUpstreamHeader(name: string): boolean {
  return SECRET_BEARING_STATIC_UPSTREAM_HEADER_PATTERN.test(name.toLowerCase());
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return isJsonObject(value) as boolean;
}

function isJsonObject(value: unknown): value is JsonObject {
  if (!isPlainRecord(value)) return false;
  return Object.values(value).every(isJsonValue);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isJsonObject(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function aiGatewayScopesInclude(
  actual: readonly string[] | undefined,
  required: readonly string[],
): boolean {
  if (!actual) return false;
  const scopeSet = new Set(actual.flatMap((scope) => scope.split(/\s+/)));
  return required.every((scope) => scopeSet.has(scope));
}

export const TAKOSUMI_AI_GATEWAY_DEFAULT_SCOPES = TAKOSUMI_AI_GATEWAY_SCOPES;
