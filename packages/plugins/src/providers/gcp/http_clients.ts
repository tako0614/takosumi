import { storage } from "takosumi-contract";
import type {
  GcpKmsClient,
  GcpObjectStorageClient,
  GcpObservabilityClient,
  GcpProviderClient,
  GcpQueueClient,
  GcpRouterClient,
  GcpRuntimeAgentClient,
  GcpSecretsClient,
  GcpStorageClient,
} from "./clients.ts";
import {
  classifyGcpError,
  defaultGcpRuntimePolicy,
  type GcpRuntimePolicy,
  resolveRuntimeContext,
  withRetry,
} from "./_runtime.ts";

/**
 * OAuth2 access-token supplier injected by the operator. Implementations are
 * expected to return a short-lived bearer token suitable for `Authorization:
 * Bearer <token>` headers (e.g. Workload Identity, service account JWT, gcloud
 * application-default-credentials). Callers MUST keep the token cache outside
 * this gateway since it has no concept of refresh windows.
 */
export interface GcpAccessTokenProvider {
  getAccessToken(scope?: string): Promise<string>;
}

export interface GcpHttpGatewayClientOptions {
  readonly baseUrl: string | URL;
  /**
   * Static bearer token. Mutually exclusive with `accessTokenProvider`; if both
   * are supplied the dynamic provider wins. Operators are expected to use the
   * provider in production so tokens can refresh automatically.
   */
  readonly bearerToken?: string;
  readonly accessTokenProvider?: GcpAccessTokenProvider;
  /**
   * Default GCP project id propagated as an `x-goog-project-id` header so the
   * gateway can route the call. Each method may override per request.
   */
  readonly projectId?: string;
  readonly region?: string;
  readonly headers?: HeadersInit;
  readonly fetch?: typeof fetch;
  readonly retryPolicy?: GcpRuntimePolicy;
}

export class GcpHttpGatewayClient
  implements
    GcpStorageClient,
    GcpObjectStorageClient,
    GcpQueueClient,
    GcpKmsClient,
    GcpSecretsClient,
    GcpProviderClient,
    GcpRouterClient,
    GcpObservabilityClient,
    GcpRuntimeAgentClient {
  readonly statements = storage.storageStatementCatalog;
  readonly #gateway: JsonHttpGateway;

  constructor(options: GcpHttpGatewayClientOptions) {
    this.#gateway = new JsonHttpGateway("gcp", options);
  }

  runTransaction<T>(
    _fn: (transaction: storage.StorageTransaction) => T | Promise<T>,
  ): Promise<T> {
    throw new Error(
      "GcpHttpGatewayClient cannot run callback-based storage transactions over the JSON gateway; inject a storage driver separately.",
    );
  }

  uploadObject(
    input: Parameters<GcpObjectStorageClient["uploadObject"]>[0],
  ): ReturnType<GcpObjectStorageClient["uploadObject"]> {
    return this.#gateway.post("object-storage/upload-object", input);
  }

  async downloadObject(
    input: Parameters<GcpObjectStorageClient["downloadObject"]>[0],
  ): ReturnType<GcpObjectStorageClient["downloadObject"]> {
    return optional(
      await this.#gateway.post("object-storage/download-object", input),
    );
  }

  async statObject(
    input: Parameters<GcpObjectStorageClient["statObject"]>[0],
  ): ReturnType<GcpObjectStorageClient["statObject"]> {
    return optional(
      await this.#gateway.post("object-storage/stat-object", input),
    );
  }

  listObjects(
    input: Parameters<GcpObjectStorageClient["listObjects"]>[0],
  ): ReturnType<GcpObjectStorageClient["listObjects"]> {
    return this.#gateway.post("object-storage/list-objects", input);
  }

  deleteObject(
    input: Parameters<GcpObjectStorageClient["deleteObject"]>[0],
  ): ReturnType<GcpObjectStorageClient["deleteObject"]> {
    return this.#gateway.post("object-storage/delete-object", input);
  }

  publishMessage(
    input: Parameters<GcpQueueClient["publishMessage"]>[0],
  ): ReturnType<GcpQueueClient["publishMessage"]> {
    return this.#gateway.post("queue/publish-message", input);
  }

  async pullMessage(
    input: Parameters<GcpQueueClient["pullMessage"]>[0],
  ): ReturnType<GcpQueueClient["pullMessage"]> {
    return optional(await this.#gateway.post("queue/pull-message", input));
  }

  acknowledgeMessage(
    input: Parameters<GcpQueueClient["acknowledgeMessage"]>[0],
  ): ReturnType<GcpQueueClient["acknowledgeMessage"]> {
    return this.#gateway.post("queue/acknowledge-message", input);
  }

  modifyAckDeadline(
    input: Parameters<GcpQueueClient["modifyAckDeadline"]>[0],
  ): ReturnType<GcpQueueClient["modifyAckDeadline"]> {
    return this.#gateway.post("queue/modify-ack-deadline", input);
  }

  deadLetterMessage(
    input: Parameters<GcpQueueClient["deadLetterMessage"]>[0],
  ): ReturnType<GcpQueueClient["deadLetterMessage"]> {
    return this.#gateway.post("queue/dead-letter-message", input);
  }

  getPrimaryKeyVersion(): ReturnType<GcpKmsClient["getPrimaryKeyVersion"]> {
    return this.#gateway.post("kms/get-primary-key-version", {});
  }

  encryptEnvelope(
    input: Parameters<GcpKmsClient["encryptEnvelope"]>[0],
  ): ReturnType<GcpKmsClient["encryptEnvelope"]> {
    return this.#gateway.post("kms/encrypt-envelope", input);
  }

  decryptEnvelope(
    input: Parameters<GcpKmsClient["decryptEnvelope"]>[0],
  ): ReturnType<GcpKmsClient["decryptEnvelope"]> {
    return this.#gateway.post("kms/decrypt-envelope", input);
  }

  rotateEnvelope(
    input: Parameters<GcpKmsClient["rotateEnvelope"]>[0],
  ): ReturnType<GcpKmsClient["rotateEnvelope"]> {
    return this.#gateway.post("kms/rotate-envelope", input);
  }

  addSecretVersion(
    input: Parameters<GcpSecretsClient["addSecretVersion"]>[0],
  ): ReturnType<GcpSecretsClient["addSecretVersion"]> {
    return this.#gateway.post("secrets/add-secret-version", input);
  }

  async accessSecretVersion(
    input: Parameters<GcpSecretsClient["accessSecretVersion"]>[0],
  ): ReturnType<GcpSecretsClient["accessSecretVersion"]> {
    return optional(
      await this.#gateway.post("secrets/access-secret-version", input),
    );
  }

  async latestSecretVersion(
    secretId: Parameters<GcpSecretsClient["latestSecretVersion"]>[0],
  ): ReturnType<GcpSecretsClient["latestSecretVersion"]> {
    return optional(
      await this.#gateway.post("secrets/latest-secret-version", { secretId }),
    );
  }

  listSecretVersions(): ReturnType<GcpSecretsClient["listSecretVersions"]> {
    return this.#gateway.post("secrets/list-secret-versions", {});
  }

  destroySecretVersion(
    input: Parameters<GcpSecretsClient["destroySecretVersion"]>[0],
  ): ReturnType<GcpSecretsClient["destroySecretVersion"]> {
    return this.#gateway.post("secrets/destroy-secret-version", input);
  }

  reconcileDesiredState(
    desiredState: Parameters<GcpProviderClient["reconcileDesiredState"]>[0],
  ): ReturnType<GcpProviderClient["reconcileDesiredState"]> {
    return this.#gateway.post("provider/reconcile-desired-state", desiredState);
  }

  listOperations(): ReturnType<GcpProviderClient["listOperations"]> {
    return this.#gateway.post("provider/list-operations", {});
  }

  clearOperations(): ReturnType<GcpProviderClient["clearOperations"]> {
    return this.#gateway.post("provider/clear-operations", {});
  }

  applyRoutes(
    projection: Parameters<GcpRouterClient["applyRoutes"]>[0],
  ): ReturnType<GcpRouterClient["applyRoutes"]> {
    return this.#gateway.post("router/apply-routes", projection);
  }

  writeAuditLog(
    event: Parameters<GcpObservabilityClient["writeAuditLog"]>[0],
  ): ReturnType<GcpObservabilityClient["writeAuditLog"]> {
    return this.#gateway.post("observability/write-audit-log", event);
  }

  listAuditLogs(): ReturnType<GcpObservabilityClient["listAuditLogs"]> {
    return this.#gateway.post("observability/list-audit-logs", {});
  }

  verifyAuditLogs(): ReturnType<GcpObservabilityClient["verifyAuditLogs"]> {
    return this.#gateway.post("observability/verify-audit-logs", {});
  }

  writeMetric(
    event: Parameters<GcpObservabilityClient["writeMetric"]>[0],
  ): ReturnType<GcpObservabilityClient["writeMetric"]> {
    return this.#gateway.post("observability/write-metric", event);
  }

  listMetricEvents(
    query?: Parameters<GcpObservabilityClient["listMetricEvents"]>[0],
  ): ReturnType<GcpObservabilityClient["listMetricEvents"]> {
    return this.#gateway.post("observability/list-metric-events", query ?? {});
  }

  registerAgent(
    input: Parameters<GcpRuntimeAgentClient["registerAgent"]>[0],
  ): ReturnType<GcpRuntimeAgentClient["registerAgent"]> {
    return this.#gateway.post("runtime-agent/register-agent", input);
  }

  heartbeatAgent(
    input: Parameters<GcpRuntimeAgentClient["heartbeatAgent"]>[0],
  ): ReturnType<GcpRuntimeAgentClient["heartbeatAgent"]> {
    return this.#gateway.post("runtime-agent/heartbeat-agent", input);
  }

  async getAgent(
    agentId: Parameters<GcpRuntimeAgentClient["getAgent"]>[0],
  ): ReturnType<GcpRuntimeAgentClient["getAgent"]> {
    return optional(
      await this.#gateway.post("runtime-agent/get-agent", {
        agentId,
      }),
    );
  }

  listAgents(): ReturnType<GcpRuntimeAgentClient["listAgents"]> {
    return this.#gateway.post("runtime-agent/list-agents", {});
  }

  requestDrain(
    agentId: Parameters<GcpRuntimeAgentClient["requestDrain"]>[0],
    at?: Parameters<GcpRuntimeAgentClient["requestDrain"]>[1],
  ): ReturnType<GcpRuntimeAgentClient["requestDrain"]> {
    return this.#gateway.post("runtime-agent/request-drain", { agentId, at });
  }

  revokeAgent(
    agentId: Parameters<GcpRuntimeAgentClient["revokeAgent"]>[0],
    at?: Parameters<GcpRuntimeAgentClient["revokeAgent"]>[1],
  ): ReturnType<GcpRuntimeAgentClient["revokeAgent"]> {
    return this.#gateway.post("runtime-agent/revoke-agent", { agentId, at });
  }

  enqueueWork(
    input: Parameters<GcpRuntimeAgentClient["enqueueWork"]>[0],
  ): ReturnType<GcpRuntimeAgentClient["enqueueWork"]> {
    return this.#gateway.post("runtime-agent/enqueue-work", input);
  }

  async leaseWork(
    input: Parameters<GcpRuntimeAgentClient["leaseWork"]>[0],
  ): ReturnType<GcpRuntimeAgentClient["leaseWork"]> {
    return optional(
      await this.#gateway.post("runtime-agent/lease-work", input),
    );
  }

  completeWork(
    input: Parameters<GcpRuntimeAgentClient["completeWork"]>[0],
  ): ReturnType<GcpRuntimeAgentClient["completeWork"]> {
    return this.#gateway.post("runtime-agent/complete-work", input);
  }

  failWork(
    input: Parameters<GcpRuntimeAgentClient["failWork"]>[0],
  ): ReturnType<GcpRuntimeAgentClient["failWork"]> {
    return this.#gateway.post("runtime-agent/fail-work", input);
  }

  async getWork(
    workId: Parameters<GcpRuntimeAgentClient["getWork"]>[0],
  ): ReturnType<GcpRuntimeAgentClient["getWork"]> {
    return optional(
      await this.#gateway.post("runtime-agent/get-work", {
        workId,
      }),
    );
  }

  listWork(): ReturnType<GcpRuntimeAgentClient["listWork"]> {
    return this.#gateway.post("runtime-agent/list-work", {});
  }
}

class JsonHttpGateway {
  readonly #baseUrl: string;
  readonly #headers?: HeadersInit;
  readonly #bearerToken?: string;
  readonly #accessTokenProvider?: GcpAccessTokenProvider;
  readonly #projectId?: string;
  readonly #region?: string;
  readonly #fetch: typeof fetch;
  readonly #provider: string;
  readonly #policy: GcpRuntimePolicy;

  constructor(provider: string, options: GcpHttpGatewayClientOptions) {
    this.#provider = provider;
    this.#baseUrl = `${options.baseUrl}`;
    this.#headers = options.headers;
    this.#bearerToken = options.bearerToken;
    this.#accessTokenProvider = options.accessTokenProvider;
    this.#projectId = options.projectId;
    this.#region = options.region;
    this.#fetch = options.fetch ?? fetch;
    this.#policy = options.retryPolicy ?? defaultGcpRuntimePolicy;
  }

  async post<TResult>(path: string, input: unknown): Promise<TResult> {
    const ctx = resolveRuntimeContext({ policy: this.#policy });
    const outcome = await withRetry(ctx, async () => {
      const response = await this.#fetch(urlFor(this.#baseUrl, path), {
        method: "POST",
        headers: await this.#requestHeaders(),
        body: JSON.stringify(encodeJson(input)),
      });

      const text = await response.text();
      if (!response.ok) {
        const err = new Error(
          `${this.#provider} gateway ${path} failed: HTTP ${response.status} ${response.statusText}${
            text ? `: ${errorMessage(text)}` : ""
          }`,
        ) as Error & { httpStatus?: number };
        err.httpStatus = response.status;
        throw err;
      }

      if (!text || response.status === 204) return undefined;
      const value = decodeJson(JSON.parse(text));
      return unwrapResult(value);
    });

    if (outcome.error) {
      const err = outcome.error as Error;
      throw err;
    }
    return outcome.result as TResult;
  }

  /** Drift / observation helper: mirrors the gateway POST but with a GET. */
  async get<TResult>(path: string): Promise<TResult> {
    const ctx = resolveRuntimeContext({ policy: this.#policy });
    const outcome = await withRetry(ctx, async () => {
      const response = await this.#fetch(urlFor(this.#baseUrl, path), {
        method: "GET",
        headers: await this.#requestHeaders(),
      });
      const text = await response.text();
      if (!response.ok) {
        const err = new Error(
          `${this.#provider} gateway GET ${path} failed: HTTP ${response.status} ${response.statusText}${
            text ? `: ${errorMessage(text)}` : ""
          }`,
        ) as Error & { httpStatus?: number };
        err.httpStatus = response.status;
        throw err;
      }
      if (!text || response.status === 204) return undefined;
      return unwrapResult(decodeJson(JSON.parse(text)));
    });
    if (outcome.error) throw outcome.error as Error;
    return outcome.result as TResult;
  }

  /**
   * Page through a paginated endpoint until `nextPageToken` is empty. The
   * gateway is generic; callers supply the request shape and read the response
   * `items` field.
   */
  async paginate<TItem>(
    path: string,
    input: Record<string, unknown> = {},
    options: { readonly itemsKey?: string } = {},
  ): Promise<readonly TItem[]> {
    const itemsKey = options.itemsKey ?? "items";
    const acc: TItem[] = [];
    let pageToken: string | undefined;
    let safety = 0;
    do {
      const page = await this.post<Record<string, unknown>>(path, {
        ...input,
        pageToken,
      });
      const items = (page?.[itemsKey] ?? []) as TItem[];
      acc.push(...items);
      pageToken = page?.nextPageToken as string | undefined;
      safety += 1;
      if (safety > 10_000) break;
    } while (pageToken);
    return acc;
  }

  /** Best-effort drift check: classify any error and surface as a condition. */
  async ping(path: string): Promise<{
    readonly ok: boolean;
    readonly status: ReturnType<typeof classifyGcpError>["status"];
    readonly message: string;
  }> {
    try {
      await this.get(path);
      return { ok: true, status: "ok", message: "ok" };
    } catch (error) {
      const condition = classifyGcpError(error);
      return {
        ok: false,
        status: condition.status,
        message: condition.message,
      };
    }
  }

  async #requestHeaders(): Promise<Headers> {
    const headers = new Headers(this.#headers);
    headers.set("accept", "application/json");
    headers.set("content-type", "application/json");
    if (this.#projectId) headers.set("x-goog-project-id", this.#projectId);
    if (this.#region) headers.set("x-goog-region", this.#region);
    const token = this.#accessTokenProvider
      ? await this.#accessTokenProvider.getAccessToken()
      : this.#bearerToken;
    if (token) headers.set("authorization", `Bearer ${token}`);
    return headers;
  }
}

function urlFor(baseUrl: string, path: string): URL {
  const normalized = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(path, normalized);
}

function optional<T>(value: T | null | undefined): T | undefined {
  return value ?? undefined;
}

function unwrapResult(value: unknown): unknown {
  if (
    isRecord(value) && Object.hasOwn(value, "result") &&
    Object.keys(value).length === 1
  ) {
    return value.result;
  }
  return value;
}

function errorMessage(text: string): string {
  try {
    const parsed = JSON.parse(text);
    if (isRecord(parsed)) {
      if (typeof parsed.message === "string") return parsed.message;
      if (typeof parsed.error === "string") return parsed.error;
    }
  } catch {
    // Use the raw response body below.
  }
  return text;
}

function encodeJson(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return { $type: "Uint8Array", base64: bytesToBase64(value) };
  }
  if (Array.isArray(value)) return value.map(encodeJson);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, encodeJson(entry)]),
    );
  }
  return value;
}

function decodeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeJson);
  if (isRecord(value)) {
    if (
      value.$type === "Uint8Array" && typeof value.base64 === "string"
    ) {
      return base64ToBytes(value.base64);
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, decodeJson(entry)]),
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
