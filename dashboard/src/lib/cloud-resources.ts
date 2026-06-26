export type CloudResourceResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: string };

export interface CloudExtensionCatalogItem {
  readonly id: string;
  readonly kind: "ai_gateway" | "provider_compat" | string;
  readonly provider?: string;
  readonly protocol: string;
  readonly basePath: `/${string}`;
  readonly configured: boolean;
  readonly capabilities: readonly string[];
  readonly smokeChecks: readonly string[];
}

export interface CloudExtensionCatalog {
  readonly kind: "takosumi.platform-cloud-extensions@v1";
  readonly generatedAt: string;
  readonly serviceUrl: string;
  readonly extensions: readonly CloudExtensionCatalogItem[];
  readonly summary: {
    readonly total: number;
    readonly configured: number;
    readonly missing: number;
  };
}

export interface AiGatewayStatus {
  readonly kind: "takosumi.ai-gateway-status@v1";
  readonly mode: string;
  readonly defaultModel?: string;
  readonly endpoints: readonly string[];
  readonly summary: {
    readonly profileCount: number;
    readonly publicModelCount: number;
    readonly providers: readonly string[];
  };
  readonly upstreamProfiles: readonly {
    readonly id: string;
    readonly provider: string;
    readonly type: string;
    readonly endpointOrigin: string;
    readonly modelCount: number;
    readonly publicModels: readonly {
      readonly publicModel: string;
      readonly endpoints: readonly string[];
      readonly default?: boolean;
      readonly billingClass?: string;
    }[];
  }[];
}

export interface OpenAiModelList {
  readonly object: "list";
  readonly data: readonly {
    readonly id: string;
    readonly object: "model";
    readonly created: number;
    readonly owned_by: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
  }[];
}

export interface CloudflareTokenVerify {
  readonly success: boolean;
  readonly errors: readonly unknown[];
  readonly messages: readonly unknown[];
  readonly result?: {
    readonly id?: string;
    readonly status?: string;
  };
}

export interface CloudResourcesSnapshot {
  readonly catalog: CloudExtensionCatalog;
  readonly aiRoute?: CloudExtensionCatalogItem;
  readonly compatRoute?: CloudExtensionCatalogItem;
  readonly aiStatus: CloudResourceResult<AiGatewayStatus>;
  readonly aiModels: CloudResourceResult<OpenAiModelList>;
  readonly compatToken: CloudResourceResult<CloudflareTokenVerify>;
}

export class CloudResourceError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "CloudResourceError";
  }
}

export async function getCloudResourcesSnapshot(): Promise<CloudResourcesSnapshot> {
  const catalog = await cloudFetch<CloudExtensionCatalog>(
    "/__takosumi/cloud/extensions",
  );
  const aiRoute = catalog.extensions.find(
    (extension) => extension.kind === "ai_gateway",
  );
  const compatRoute = catalog.extensions.find(
    (extension) =>
      extension.kind === "provider_compat" &&
      extension.provider === "cloudflare",
  );
  const [aiStatus, aiModels, compatToken] = await Promise.all([
    resultFor<AiGatewayStatus>(
      aiRoute ? `${aiRoute.basePath}/__takosumi/status` : undefined,
    ),
    resultFor<OpenAiModelList>(
      aiRoute ? `${aiRoute.basePath}/models` : undefined,
    ),
    resultFor<CloudflareTokenVerify>(
      compatRoute ? `${compatRoute.basePath}/user/tokens/verify` : undefined,
    ),
  ]);
  return {
    catalog,
    aiRoute,
    compatRoute,
    aiStatus,
    aiModels,
    compatToken,
  };
}

async function resultFor<T>(
  path: string | undefined,
): Promise<CloudResourceResult<T>> {
  if (!path) return { ok: false, error: "not configured" };
  try {
    return { ok: true, data: await cloudFetch<T>(path) };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

async function cloudFetch<T>(path: string): Promise<T> {
  const res = await fetch(path, {
    headers: { accept: "application/json" },
    credentials: "include",
  });
  if (res.status === 401 && typeof location !== "undefined") {
    const intended = location.pathname + location.search + location.hash;
    location.assign("/sign-in?return=" + encodeURIComponent(intended));
    throw new CloudResourceError(401, "session expired");
  }
  const ct = res.headers.get("content-type") ?? "";
  const body = ct.includes("application/json")
    ? await res.json().catch(() => undefined)
    : undefined;
  if (!res.ok) {
    throw new CloudResourceError(
      res.status,
      responseErrorMessage(body) ?? `${res.status} ${res.statusText}`,
    );
  }
  return body as T;
}

function responseErrorMessage(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return undefined;
  }
  const record = body as Record<string, unknown>;
  const error = record.error;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && !Array.isArray(error)) {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string") return message;
  }
  const description = record.error_description;
  return typeof description === "string" ? description : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
