import type { JsonObject } from "./types.ts";

export const TAKOSUMI_AI_GATEWAY_BASE_PATH = "/gateway/ai/v1";
export const TAKOSUMI_AI_GATEWAY_MODELS_PATH = `${TAKOSUMI_AI_GATEWAY_BASE_PATH}/models`;
export const TAKOSUMI_AI_GATEWAY_CHAT_COMPLETIONS_PATH = `${TAKOSUMI_AI_GATEWAY_BASE_PATH}/chat/completions`;
export const TAKOSUMI_AI_GATEWAY_EMBEDDINGS_PATH = `${TAKOSUMI_AI_GATEWAY_BASE_PATH}/embeddings`;

export const TAKOSUMI_AI_GATEWAY_DEFAULT_MODEL = "takosumi/default";

export const TAKOSUMI_AI_GATEWAY_SCOPES = [
  "ai.models.read",
  "ai.chat",
  "ai.embeddings",
] as const;

export type TakosumiAiGatewayScope =
  (typeof TAKOSUMI_AI_GATEWAY_SCOPES)[number];

export type TakosumiAiGatewayEndpoint =
  | "models"
  | "chat.completions"
  | "embeddings";

export type TakosumiAiGatewayProvider =
  | "openai"
  | "deepseek"
  | "zai"
  | "gemini"
  | "workers_ai"
  | "openai_compatible"
  | (string & {});

export interface TakosumiAiGatewayModelAlias {
  /**
   * Model id accepted by clients at /gateway/ai/v1. Examples:
   * `takosumi/default`, `deepseek/deepseek-v4-pro`, `zai/glm-5.1`.
   */
  readonly publicModel: string;
  /** Provider-native model id sent upstream. */
  readonly upstreamModel: string;
  readonly endpoints: readonly TakosumiAiGatewayEndpoint[];
  readonly default?: boolean;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly billingClass?: string;
  /**
   * Public model metadata returned from /gateway/ai/v1/models.
   * Must contain only display/protocol metadata, never secrets, bearer tokens,
   * API keys, credential URLs, or secret-shaped key names.
   */
  readonly metadata?: JsonObject;
}

export interface TakosumiAiGatewayUpstreamProfile {
  readonly id: string;
  readonly provider: TakosumiAiGatewayProvider;
  readonly baseUrl: string;
  /**
   * Name of the operator secret/env var that holds the upstream API key.
   * The key value itself must not be embedded in public config.
   */
  readonly apiKeyEnv: string;
  /**
   * Header used to send the key upstream. Defaults to `authorization`, where
   * the gateway sends `Authorization: Bearer <key>`. Non-standard compatible
   * providers can set `x-api-key` or similar without putting the key in config.
   */
  readonly apiKeyHeader?: string;
  readonly models: readonly TakosumiAiGatewayModelAlias[];
  readonly headers?: Readonly<Record<string, string>>;
}

export interface TakosumiAiGatewayModelListResponse {
  readonly object: "list";
  readonly data: readonly TakosumiAiGatewayModelListItem[];
}

export interface TakosumiAiGatewayModelListItem {
  readonly id: string;
  readonly object: "model";
  readonly created: number;
  readonly owned_by: string;
  /** Public display/protocol metadata only; never secret material. */
  readonly metadata?: JsonObject;
}

export interface TakosumiAiGatewayErrorResponse {
  readonly error: {
    readonly message: string;
    readonly type: string;
    readonly code?: string;
  };
}

export function takosumiAiGatewayPath(
  endpoint: TakosumiAiGatewayEndpoint,
): string {
  switch (endpoint) {
    case "models":
      return TAKOSUMI_AI_GATEWAY_MODELS_PATH;
    case "chat.completions":
      return TAKOSUMI_AI_GATEWAY_CHAT_COMPLETIONS_PATH;
    case "embeddings":
      return TAKOSUMI_AI_GATEWAY_EMBEDDINGS_PATH;
  }
}
