import {
  TAKOSUMI_ACCOUNTS_ACCOUNT_TOKENS_PATH,
  takosumiAccountsAccountTokenRevokePath,
  type TakosumiAccountsCreatePatResponse,
  type TakosumiAccountsListPatsResponse,
  type TakosumiAccountsPatMetadata,
  type TakosumiAccountsPatScope,
  type TakosumiAccountsRevokePatResponse,
} from "@takosjp/takosumi-accounts-contract";
import {
  getSpaceBilling,
  listSpaceUsage,
  type SpaceBilling,
  type UsageEvent,
} from "./control-api.ts";

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

export interface CloudflareCompatEnvelope<T> {
  readonly success: boolean;
  readonly errors?: readonly unknown[];
  readonly messages?: readonly unknown[];
  readonly result?: T;
  readonly result_info?: unknown;
}

export interface CloudflareCompatAccount {
  readonly id?: string;
  readonly name?: string;
}

export interface CloudflareCompatKvNamespace {
  readonly id?: string;
  readonly title?: string;
}

export interface CloudflareCompatD1Database {
  readonly uuid?: string;
  readonly id?: string;
  readonly name?: string;
}

export interface CloudflareCompatR2Bucket {
  readonly name?: string;
  readonly creation_date?: string;
  readonly created_at?: string;
}

export type CloudflareCompatWorkerScript = Readonly<Record<string, unknown>>;

export interface CloudflareCompatInventory {
  readonly accounts: CloudResourceResult<readonly CloudflareCompatAccount[]>;
  readonly selectedAccountId?: string;
  readonly kvNamespaces: CloudResourceResult<
    readonly CloudflareCompatKvNamespace[]
  >;
  readonly d1Databases: CloudResourceResult<
    readonly CloudflareCompatD1Database[]
  >;
  readonly r2Buckets: CloudResourceResult<readonly CloudflareCompatR2Bucket[]>;
  readonly workerScripts: CloudResourceResult<
    readonly CloudflareCompatWorkerScript[]
  >;
}

export interface CloudUsageSnapshot {
  readonly spaceId?: string;
  readonly billing: CloudResourceResult<SpaceBilling>;
  readonly usage: CloudResourceResult<readonly UsageEvent[]>;
}

export interface CloudResourcesSnapshot {
  readonly catalog: CloudExtensionCatalog;
  readonly aiRoute?: CloudExtensionCatalogItem;
  readonly compatRoute?: CloudExtensionCatalogItem;
  readonly aiStatus: CloudResourceResult<AiGatewayStatus>;
  readonly aiModels: CloudResourceResult<OpenAiModelList>;
  readonly compatToken: CloudResourceResult<CloudflareTokenVerify>;
  readonly compatInventory: CloudflareCompatInventory;
  readonly accountTokens: CloudResourceResult<
    readonly TakosumiAccountsPatMetadata[]
  >;
  readonly usage: CloudUsageSnapshot;
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

export interface CloudResourcesSnapshotInput {
  readonly spaceId?: string;
}

export async function getCloudResourcesSnapshot(
  input?: CloudResourcesSnapshotInput,
): Promise<CloudResourcesSnapshot> {
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
  const [
    aiStatus,
    aiModels,
    compatToken,
    compatInventory,
    accountTokens,
    usage,
  ] = await Promise.all([
    resultFor<AiGatewayStatus>(
      aiRoute ? `${aiRoute.basePath}/__takosumi/status` : undefined,
    ),
    resultFor<OpenAiModelList>(
      aiRoute ? `${aiRoute.basePath}/models` : undefined,
    ),
    resultFor<CloudflareTokenVerify>(
      compatRoute ? `${compatRoute.basePath}/user/tokens/verify` : undefined,
    ),
    getCloudflareCompatInventory(compatRoute),
    getAccountTokens(),
    getCloudUsage(input?.spaceId),
  ]);
  return {
    catalog,
    aiRoute,
    compatRoute,
    aiStatus,
    aiModels,
    compatToken,
    compatInventory,
    accountTokens,
    usage,
  };
}

async function getCloudflareCompatInventory(
  route: CloudExtensionCatalogItem | undefined,
): Promise<CloudflareCompatInventory> {
  if (!route) {
    return emptyCloudflareCompatInventory("not configured");
  }
  const accounts = await cloudflareListResult<CloudflareCompatAccount>(
    `${route.basePath}/accounts`,
  );
  if (!accounts.ok) {
    return {
      accounts,
      kvNamespaces: { ok: false, error: accounts.error },
      d1Databases: { ok: false, error: accounts.error },
      r2Buckets: { ok: false, error: accounts.error },
      workerScripts: { ok: false, error: accounts.error },
    };
  }
  const selectedAccountId = firstString(
    accounts.data.map((account) => account.id),
  );
  if (!selectedAccountId) {
    return {
      accounts,
      selectedAccountId,
      kvNamespaces: { ok: true, data: [] },
      d1Databases: { ok: true, data: [] },
      r2Buckets: { ok: true, data: [] },
      workerScripts: { ok: true, data: [] },
    };
  }
  const accountPath = `${route.basePath}/accounts/${encodeURIComponent(
    selectedAccountId,
  )}`;
  const [kvNamespaces, d1Databases, r2Buckets, workerScripts] =
    await Promise.all([
      cloudflareListResult<CloudflareCompatKvNamespace>(
        `${accountPath}/storage/kv/namespaces`,
      ),
      cloudflareListResult<CloudflareCompatD1Database>(
        `${accountPath}/d1/database`,
      ),
      cloudflareListResult<CloudflareCompatR2Bucket>(
        `${accountPath}/r2/buckets`,
      ),
      cloudflareListResult<CloudflareCompatWorkerScript>(
        `${accountPath}/workers/scripts`,
      ),
    ]);
  return {
    accounts,
    selectedAccountId,
    kvNamespaces,
    d1Databases,
    r2Buckets,
    workerScripts,
  };
}

function emptyCloudflareCompatInventory(
  error: string,
): CloudflareCompatInventory {
  return {
    accounts: { ok: false, error },
    kvNamespaces: { ok: false, error },
    d1Databases: { ok: false, error },
    r2Buckets: { ok: false, error },
    workerScripts: { ok: false, error },
  };
}

export const CLOUD_API_KEY_SCOPES = [
  "read",
  "write",
] as const satisfies readonly TakosumiAccountsPatScope[];

export async function createCloudApiKey(input: {
  readonly name: string;
}): Promise<TakosumiAccountsCreatePatResponse> {
  return await cloudFetch<TakosumiAccountsCreatePatResponse>(
    TAKOSUMI_ACCOUNTS_ACCOUNT_TOKENS_PATH,
    {
      method: "POST",
      body: {
        name: input.name,
        scopes: CLOUD_API_KEY_SCOPES,
      },
    },
  );
}

export async function revokeCloudApiKey(
  tokenId: string,
): Promise<TakosumiAccountsRevokePatResponse> {
  return await cloudFetch<TakosumiAccountsRevokePatResponse>(
    takosumiAccountsAccountTokenRevokePath(tokenId),
    { method: "POST" },
  );
}

async function getAccountTokens(): Promise<
  CloudResourceResult<readonly TakosumiAccountsPatMetadata[]>
> {
  try {
    const tokens: TakosumiAccountsPatMetadata[] = [];
    let cursor: string | null | undefined;
    do {
      const url = new URL(
        TAKOSUMI_ACCOUNTS_ACCOUNT_TOKENS_PATH,
        typeof location !== "undefined"
          ? location.origin
          : "https://app.takosumi.com",
      );
      url.searchParams.set("limit", "200");
      if (cursor) url.searchParams.set("cursor", cursor);
      const page = await cloudFetch<TakosumiAccountsListPatsResponse>(
        url.pathname + url.search,
      );
      tokens.push(...page.tokens);
      cursor = page.next_cursor;
    } while (cursor);
    return { ok: true, data: tokens };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

async function getCloudUsage(
  spaceId: string | undefined,
): Promise<CloudUsageSnapshot> {
  if (!spaceId) {
    const noWorkspace = "no workspace selected";
    return {
      billing: { ok: false, error: noWorkspace },
      usage: { ok: false, error: noWorkspace },
    };
  }
  const [billing, usage] = await Promise.all([
    resultFrom(() => getSpaceBilling(spaceId)),
    resultFrom(() => listSpaceUsage(spaceId)),
  ]);
  return { spaceId, billing, usage };
}

async function cloudflareListResult<T>(
  path: string,
): Promise<CloudResourceResult<readonly T[]>> {
  const result = await resultFor<CloudflareCompatEnvelope<unknown>>(path);
  if (!result.ok) return result;
  try {
    return { ok: true, data: cloudflareResultArray<T>(result.data) };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

function cloudflareResultArray<T>(
  envelope: CloudflareCompatEnvelope<unknown>,
): readonly T[] {
  if (envelope.success !== true) {
    throw new Error(cloudflareEnvelopeError(envelope) ?? "request failed");
  }
  const result = envelope.result;
  if (Array.isArray(result)) return result as readonly T[];
  if (result && typeof result === "object") {
    const record = result as Record<string, unknown>;
    for (const key of ["items", "resources", "data"]) {
      const value = record[key];
      if (Array.isArray(value)) return value as readonly T[];
    }
  }
  return [];
}

function cloudflareEnvelopeError(
  envelope: CloudflareCompatEnvelope<unknown>,
): string | undefined {
  const first = envelope.errors?.[0];
  if (!first) return undefined;
  if (typeof first === "string") return first;
  if (typeof first === "object" && !Array.isArray(first)) {
    const message = (first as Record<string, unknown>).message;
    if (typeof message === "string") return message;
    const code = (first as Record<string, unknown>).code;
    if (typeof code === "string") return code;
    if (typeof code === "number") return String(code);
  }
  return undefined;
}

function firstString(values: readonly unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string");
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

async function resultFrom<T>(
  fn: () => Promise<T>,
): Promise<CloudResourceResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

interface CloudFetchOptions {
  readonly method?: string;
  readonly body?: unknown;
}

async function cloudFetch<T>(
  path: string,
  options: CloudFetchOptions = {},
): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  let requestBody: BodyInit | undefined;
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
    requestBody = JSON.stringify(options.body);
  }
  const res = await fetch(path, {
    method: options.method ?? "GET",
    headers,
    body: requestBody,
    credentials: "include",
  });
  if (res.status === 401 && typeof location !== "undefined") {
    const intended = location.pathname + location.search + location.hash;
    location.assign("/sign-in?return=" + encodeURIComponent(intended));
    throw new CloudResourceError(401, "session expired");
  }
  const ct = res.headers.get("content-type") ?? "";
  const responseBody = ct.includes("application/json")
    ? await res.json().catch(() => undefined)
    : undefined;
  if (!res.ok) {
    throw new CloudResourceError(
      res.status,
      responseErrorMessage(responseBody) ?? `${res.status} ${res.statusText}`,
    );
  }
  return responseBody as T;
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
