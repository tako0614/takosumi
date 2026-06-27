import {
  TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_AI_GATEWAY,
  TAKOSUMI_ACCOUNTS_SERVICE_CAPABILITY_AI_MODEL,
} from "@takosjp/takosumi-accounts-contract";

export type PlatformCloudExtensionKind = "ai_gateway" | "provider_compat";

export interface PlatformCloudExtensionServiceAccessRule {
  readonly method: string;
  readonly path: `/${string}`;
  readonly scopes: readonly string[];
}

export interface PlatformCloudExtensionServiceAccess {
  readonly clientId: string;
  readonly rules: readonly PlatformCloudExtensionServiceAccessRule[];
}

export interface PlatformCloudExtensionRoute {
  readonly id: string;
  readonly kind: PlatformCloudExtensionKind;
  readonly basePath: `/${string}`;
  readonly bindingName: string;
  readonly provider?: string;
  readonly protocol: string;
  readonly capabilities: readonly string[];
  readonly smokeChecks: readonly string[];
  readonly serviceAccess?: PlatformCloudExtensionServiceAccess;
}

export const AI_GATEWAY_BASE_PATH = "/gateway/ai/v1" as const;
export const CLOUDFLARE_COMPAT_BASE_PATH =
  "/compat/cloudflare/client/v4" as const;

export const PLATFORM_CLOUD_EXTENSION_ROUTES: readonly PlatformCloudExtensionRoute[] =
  [
    {
      id: "ai.openai_compatible.v1",
      kind: "ai_gateway",
      basePath: AI_GATEWAY_BASE_PATH,
      bindingName: "TAKOSUMI_CLOUD_AI_GATEWAY",
      protocol: "openai-compatible",
      capabilities: ["models", "chat.completions", "embeddings"],
      smokeChecks: [
        "aiModelsAuth",
        "aiGatewayStatus",
        "aiChatAuth",
        "aiEmbeddingsAuth",
      ],
      serviceAccess: {
        clientId: `service-graph-service:${TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_AI_GATEWAY}`,
        rules: [
          {
            method: "GET",
            path: `${AI_GATEWAY_BASE_PATH}/models`,
            scopes: [
              TAKOSUMI_ACCOUNTS_SERVICE_CAPABILITY_AI_MODEL,
              "ai.models.read",
            ],
          },
          {
            method: "GET",
            path: `${AI_GATEWAY_BASE_PATH}/__takosumi/status`,
            scopes: [
              TAKOSUMI_ACCOUNTS_SERVICE_CAPABILITY_AI_MODEL,
              "ai.models.read",
            ],
          },
          {
            method: "POST",
            path: `${AI_GATEWAY_BASE_PATH}/chat/completions`,
            scopes: [TAKOSUMI_ACCOUNTS_SERVICE_CAPABILITY_AI_MODEL, "ai.chat"],
          },
          {
            method: "POST",
            path: `${AI_GATEWAY_BASE_PATH}/embeddings`,
            scopes: [
              TAKOSUMI_ACCOUNTS_SERVICE_CAPABILITY_AI_MODEL,
              "ai.embeddings",
            ],
          },
        ],
      },
    },
    {
      id: "provider.cloudflare.client_v4",
      kind: "provider_compat",
      provider: "cloudflare",
      basePath: CLOUDFLARE_COMPAT_BASE_PATH,
      bindingName: "TAKOSUMI_CLOUD_CLOUDFLARE_COMPAT",
      protocol: "cloudflare-v4",
      capabilities: [
        "user.tokens.verify",
        "accounts.list",
        "workers.scripts",
        "workers.routes",
        "kv.namespaces",
        "r2.buckets",
        "d1.databases",
        "workflows",
        "containers",
        "queues",
        "durable_objects",
      ],
      smokeChecks: [
        "cloudflareCompatVerifyAuth",
        "cloudflareCompatAccountsAuth",
        "cloudflareCompatScriptsListAuth",
        "cloudflareCompatScriptPutAuth",
        "cloudflareCompatProviderE2E",
      ],
    },
  ] as const;

export const PLATFORM_CLOUD_EXTENSION_CATALOG_PATH =
  "/__takosumi/cloud/extensions" as const;

export function platformCloudExtensionRouteById(
  id: string,
): PlatformCloudExtensionRoute | undefined {
  return PLATFORM_CLOUD_EXTENSION_ROUTES.find((route) => route.id === id);
}

export function matchPlatformCloudExtensionRoute(
  pathname: string,
): PlatformCloudExtensionRoute | undefined {
  return PLATFORM_CLOUD_EXTENSION_ROUTES.find((route) =>
    pathIsUnderBase(pathname, route.basePath),
  );
}

export function isPlatformCloudExtensionCatalogPath(pathname: string): boolean {
  return pathname === PLATFORM_CLOUD_EXTENSION_CATALOG_PATH;
}

export function platformCloudExtensionServiceTokenClientId(
  route: PlatformCloudExtensionRoute,
): string | undefined {
  return route.serviceAccess?.clientId;
}

export function platformCloudExtensionServiceTokenRequiredScopes(
  request: Request,
  route: PlatformCloudExtensionRoute,
): readonly string[] | undefined {
  const url = new URL(request.url);
  const method = platformCloudExtensionServiceAccessRuleMethod(request.method);
  return route.serviceAccess?.rules.find(
    (rule) => rule.method === method && rule.path === url.pathname,
  )?.scopes;
}

function platformCloudExtensionServiceAccessRuleMethod(method: string): string {
  const normalized = method.toUpperCase();
  return normalized === "HEAD" ? "GET" : normalized;
}

export function pathIsUnderBase(pathname: string, basePath: string): boolean {
  return pathname === basePath || pathname.startsWith(`${basePath}/`);
}
