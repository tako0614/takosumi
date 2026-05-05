import { storage } from "takosumi-contract";
import type {
  AwsKmsClient,
  AwsObjectStorageClient,
  AwsObservabilityClient,
  AwsProviderClient,
  AwsQueueClient,
  AwsRouterClient,
  AwsRuntimeAgentClient,
  AwsSecretsClient,
  AwsStorageClient,
} from "./clients.ts";
import {
  type AwsRetryConfig,
  classifyAwsError,
  DEFAULT_AWS_RETRY,
  detectDrift,
  type DriftField,
  isRetryableCategory,
  withTimeout,
} from "./support.ts";

/**
 * Telemetry hook invoked by {@link AwsHttpGatewayClient} for every gateway
 * call. Operators can wire this into their own metric / log pipelines.
 *
 * AWS Signature v4 signing is performed by the operator — the gateway URL
 * the kernel calls already points at an operator-managed proxy that signs
 * requests using its own credentials. Region / endpoint / credentials never
 * cross the kernel boundary.
 */
export interface AwsGatewayTelemetry {
  readonly onAttempt?: (event: AwsGatewayAttemptEvent) => void;
  readonly onSuccess?: (event: AwsGatewayResultEvent) => void;
  readonly onFailure?: (event: AwsGatewayResultEvent) => void;
}

export interface AwsGatewayAttemptEvent {
  readonly path: string;
  readonly attempt: number;
  readonly startedAt: string;
}

export interface AwsGatewayResultEvent {
  readonly path: string;
  readonly attempt: number;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
  readonly status: "succeeded" | "failed";
  readonly httpStatus?: number;
  readonly errorCategory?: ReturnType<typeof classifyAwsError>;
}

export interface AwsHttpGatewayClientOptions {
  readonly baseUrl: string | URL;
  readonly bearerToken?: string;
  readonly headers?: HeadersInit;
  readonly fetch?: typeof fetch;
  readonly retry?: Partial<AwsRetryConfig>;
  readonly telemetry?: AwsGatewayTelemetry;
  readonly clock?: () => Date;
}

/** Response shape for the optional `provider/list-objects-page` endpoint. */
export interface AwsHttpGatewayPaginatedPage<T> {
  readonly items: readonly T[];
  readonly nextToken?: string;
}

/** Response shape for the optional `provider/detect-drift` endpoint. */
export interface AwsHttpGatewayDriftResponse {
  readonly drift: readonly DriftField[];
}

export class AwsHttpGatewayClient
  implements
    AwsStorageClient,
    AwsObjectStorageClient,
    AwsQueueClient,
    AwsKmsClient,
    AwsSecretsClient,
    AwsProviderClient,
    AwsRouterClient,
    AwsObservabilityClient,
    AwsRuntimeAgentClient {
  readonly statements = storage.storageStatementCatalog;
  readonly #gateway: JsonHttpGateway;

  constructor(options: AwsHttpGatewayClientOptions) {
    this.#gateway = new JsonHttpGateway("aws", options);
  }

  runTransaction<T>(
    _fn: (transaction: storage.StorageTransaction) => T | Promise<T>,
  ): Promise<T> {
    throw new Error(
      "AwsHttpGatewayClient cannot run callback-based storage transactions over the JSON gateway; inject a storage driver separately.",
    );
  }

  putObject(
    input: Parameters<AwsObjectStorageClient["putObject"]>[0],
  ): ReturnType<AwsObjectStorageClient["putObject"]> {
    return this.#gateway.post("object-storage/put-object", input);
  }

  async getObject(
    input: Parameters<AwsObjectStorageClient["getObject"]>[0],
  ): ReturnType<AwsObjectStorageClient["getObject"]> {
    return optional(
      await this.#gateway.post("object-storage/get-object", input),
    );
  }

  async headObject(
    input: Parameters<AwsObjectStorageClient["headObject"]>[0],
  ): ReturnType<AwsObjectStorageClient["headObject"]> {
    return optional(
      await this.#gateway.post("object-storage/head-object", input),
    );
  }

  listObjects(
    input: Parameters<AwsObjectStorageClient["listObjects"]>[0],
  ): ReturnType<AwsObjectStorageClient["listObjects"]> {
    return this.#gateway.post("object-storage/list-objects", input);
  }

  deleteObject(
    input: Parameters<AwsObjectStorageClient["deleteObject"]>[0],
  ): ReturnType<AwsObjectStorageClient["deleteObject"]> {
    return this.#gateway.post("object-storage/delete-object", input);
  }

  sendMessage(
    input: Parameters<AwsQueueClient["sendMessage"]>[0],
  ): ReturnType<AwsQueueClient["sendMessage"]> {
    return this.#gateway.post("queue/send-message", input);
  }

  async receiveMessage(
    input: Parameters<AwsQueueClient["receiveMessage"]>[0],
  ): ReturnType<AwsQueueClient["receiveMessage"]> {
    return optional(await this.#gateway.post("queue/receive-message", input));
  }

  deleteMessage(
    input: Parameters<AwsQueueClient["deleteMessage"]>[0],
  ): ReturnType<AwsQueueClient["deleteMessage"]> {
    return this.#gateway.post("queue/delete-message", input);
  }

  releaseMessage(
    input: Parameters<AwsQueueClient["releaseMessage"]>[0],
  ): ReturnType<AwsQueueClient["releaseMessage"]> {
    return this.#gateway.post("queue/release-message", input);
  }

  deadLetterMessage(
    input: Parameters<AwsQueueClient["deadLetterMessage"]>[0],
  ): ReturnType<AwsQueueClient["deadLetterMessage"]> {
    return this.#gateway.post("queue/dead-letter-message", input);
  }

  describeActiveKey(): ReturnType<AwsKmsClient["describeActiveKey"]> {
    return this.#gateway.post("kms/describe-active-key", {});
  }

  encryptEnvelope(
    input: Parameters<AwsKmsClient["encryptEnvelope"]>[0],
  ): ReturnType<AwsKmsClient["encryptEnvelope"]> {
    return this.#gateway.post("kms/encrypt-envelope", input);
  }

  decryptEnvelope(
    input: Parameters<AwsKmsClient["decryptEnvelope"]>[0],
  ): ReturnType<AwsKmsClient["decryptEnvelope"]> {
    return this.#gateway.post("kms/decrypt-envelope", input);
  }

  rotateEnvelope(
    input: Parameters<AwsKmsClient["rotateEnvelope"]>[0],
  ): ReturnType<AwsKmsClient["rotateEnvelope"]> {
    return this.#gateway.post("kms/rotate-envelope", input);
  }

  putSecretValue(
    input: Parameters<AwsSecretsClient["putSecretValue"]>[0],
  ): ReturnType<AwsSecretsClient["putSecretValue"]> {
    return this.#gateway.post("secrets/put-secret-value", input);
  }

  async getSecretValue(
    input: Parameters<AwsSecretsClient["getSecretValue"]>[0],
  ): ReturnType<AwsSecretsClient["getSecretValue"]> {
    return optional(
      await this.#gateway.post("secrets/get-secret-value", input),
    );
  }

  async getLatestSecret(
    secretName: Parameters<AwsSecretsClient["getLatestSecret"]>[0],
  ): ReturnType<AwsSecretsClient["getLatestSecret"]> {
    return optional(
      await this.#gateway.post("secrets/get-latest-secret", { secretName }),
    );
  }

  listSecretVersions(): ReturnType<AwsSecretsClient["listSecretVersions"]> {
    return this.#gateway.post("secrets/list-secret-versions", {});
  }

  deleteSecretVersion(
    input: Parameters<AwsSecretsClient["deleteSecretVersion"]>[0],
  ): ReturnType<AwsSecretsClient["deleteSecretVersion"]> {
    return this.#gateway.post("secrets/delete-secret-version", input);
  }

  materializeDesiredState(
    desiredState: Parameters<AwsProviderClient["materializeDesiredState"]>[0],
  ): ReturnType<AwsProviderClient["materializeDesiredState"]> {
    return this.#gateway.post(
      "provider/materialize-desired-state",
      desiredState,
    );
  }

  listOperations(): ReturnType<AwsProviderClient["listOperations"]> {
    return this.#gateway.post("provider/list-operations", {});
  }

  clearOperations(): ReturnType<AwsProviderClient["clearOperations"]> {
    return this.#gateway.post("provider/clear-operations", {});
  }

  applyRoutes(
    projection: Parameters<AwsRouterClient["applyRoutes"]>[0],
  ): ReturnType<AwsRouterClient["applyRoutes"]> {
    return this.#gateway.post("router/apply-routes", projection);
  }

  appendAuditEvent(
    event: Parameters<AwsObservabilityClient["appendAuditEvent"]>[0],
  ): ReturnType<AwsObservabilityClient["appendAuditEvent"]> {
    return this.#gateway.post("observability/append-audit-event", event);
  }

  listAuditEvents(): ReturnType<AwsObservabilityClient["listAuditEvents"]> {
    return this.#gateway.post("observability/list-audit-events", {});
  }

  verifyAuditEvents(): ReturnType<AwsObservabilityClient["verifyAuditEvents"]> {
    return this.#gateway.post("observability/verify-audit-events", {});
  }

  putMetric(
    event: Parameters<AwsObservabilityClient["putMetric"]>[0],
  ): ReturnType<AwsObservabilityClient["putMetric"]> {
    return this.#gateway.post("observability/put-metric", event);
  }

  listMetricEvents(
    query?: Parameters<AwsObservabilityClient["listMetricEvents"]>[0],
  ): ReturnType<AwsObservabilityClient["listMetricEvents"]> {
    return this.#gateway.post("observability/list-metric-events", query ?? {});
  }

  registerAgent(
    input: Parameters<AwsRuntimeAgentClient["registerAgent"]>[0],
  ): ReturnType<AwsRuntimeAgentClient["registerAgent"]> {
    return this.#gateway.post("runtime-agent/register-agent", input);
  }

  heartbeatAgent(
    input: Parameters<AwsRuntimeAgentClient["heartbeatAgent"]>[0],
  ): ReturnType<AwsRuntimeAgentClient["heartbeatAgent"]> {
    return this.#gateway.post("runtime-agent/heartbeat-agent", input);
  }

  async getAgent(
    agentId: Parameters<AwsRuntimeAgentClient["getAgent"]>[0],
  ): ReturnType<AwsRuntimeAgentClient["getAgent"]> {
    return optional(
      await this.#gateway.post("runtime-agent/get-agent", {
        agentId,
      }),
    );
  }

  listAgents(): ReturnType<AwsRuntimeAgentClient["listAgents"]> {
    return this.#gateway.post("runtime-agent/list-agents", {});
  }

  requestDrain(
    agentId: Parameters<AwsRuntimeAgentClient["requestDrain"]>[0],
    at?: Parameters<AwsRuntimeAgentClient["requestDrain"]>[1],
  ): ReturnType<AwsRuntimeAgentClient["requestDrain"]> {
    return this.#gateway.post("runtime-agent/request-drain", { agentId, at });
  }

  revokeAgent(
    agentId: Parameters<AwsRuntimeAgentClient["revokeAgent"]>[0],
    at?: Parameters<AwsRuntimeAgentClient["revokeAgent"]>[1],
  ): ReturnType<AwsRuntimeAgentClient["revokeAgent"]> {
    return this.#gateway.post("runtime-agent/revoke-agent", { agentId, at });
  }

  enqueueWork(
    input: Parameters<AwsRuntimeAgentClient["enqueueWork"]>[0],
  ): ReturnType<AwsRuntimeAgentClient["enqueueWork"]> {
    return this.#gateway.post("runtime-agent/enqueue-work", input);
  }

  async leaseWork(
    input: Parameters<AwsRuntimeAgentClient["leaseWork"]>[0],
  ): ReturnType<AwsRuntimeAgentClient["leaseWork"]> {
    return optional(
      await this.#gateway.post("runtime-agent/lease-work", input),
    );
  }

  completeWork(
    input: Parameters<AwsRuntimeAgentClient["completeWork"]>[0],
  ): ReturnType<AwsRuntimeAgentClient["completeWork"]> {
    return this.#gateway.post("runtime-agent/complete-work", input);
  }

  failWork(
    input: Parameters<AwsRuntimeAgentClient["failWork"]>[0],
  ): ReturnType<AwsRuntimeAgentClient["failWork"]> {
    return this.#gateway.post("runtime-agent/fail-work", input);
  }

  async getWork(
    workId: Parameters<AwsRuntimeAgentClient["getWork"]>[0],
  ): ReturnType<AwsRuntimeAgentClient["getWork"]> {
    return optional(
      await this.#gateway.post("runtime-agent/get-work", {
        workId,
      }),
    );
  }

  listWork(): ReturnType<AwsRuntimeAgentClient["listWork"]> {
    return this.#gateway.post("runtime-agent/list-work", {});
  }

  /**
   * Iterates a paginated gateway endpoint (operator-implemented, NextToken
   * convention). Each page is retried independently. Use for `listObjects`
   * style enumeration via the JSON gateway.
   */
  async *paginate<T>(
    path: string,
    initialInput: Record<string, unknown> = {},
  ): AsyncGenerator<T, void, unknown> {
    let token: string | undefined;
    do {
      const page: AwsHttpGatewayPaginatedPage<T> = await this.#gateway.post(
        path,
        token ? { ...initialInput, nextToken: token } : initialInput,
      );
      for (const item of page.items) yield item;
      token = page.nextToken;
    } while (token !== undefined);
  }

  /**
   * Calls an operator-provided `provider/detect-drift` endpoint. Returns the
   * array of drift fields. Operators without this endpoint can fall back to
   * client-side drift detection by providing the desired and observed snapshots
   * themselves.
   */
  async detectDrift(input: {
    readonly target: string;
    readonly desired: unknown;
    readonly observed: unknown;
    readonly ignorePaths?: readonly string[];
  }): Promise<readonly DriftField[]> {
    const response: AwsHttpGatewayDriftResponse = await this.#gateway.post(
      "provider/detect-drift",
      input,
    );
    return response.drift;
  }

  /**
   * Local drift detection — does not call the gateway. Useful when the
   * gateway returns full descriptors but the operator does not implement a
   * dedicated drift endpoint.
   */
  detectDriftLocal(
    desired: unknown,
    observed: unknown,
    ignorePaths: readonly string[] = [],
  ): readonly DriftField[] {
    return detectDrift(desired, observed, ignorePaths);
  }
}

class JsonHttpGateway {
  readonly #baseUrl: string;
  readonly #headers?: HeadersInit;
  readonly #bearerToken?: string;
  readonly #fetch: typeof fetch;
  readonly #provider: string;
  readonly #retry: AwsRetryConfig;
  readonly #telemetry?: AwsGatewayTelemetry;
  readonly #clock: () => Date;

  constructor(provider: string, options: AwsHttpGatewayClientOptions) {
    this.#provider = provider;
    this.#baseUrl = `${options.baseUrl}`;
    this.#headers = options.headers;
    this.#bearerToken = options.bearerToken;
    this.#fetch = options.fetch ?? fetch;
    this.#retry = { ...DEFAULT_AWS_RETRY, ...(options.retry ?? {}) };
    this.#telemetry = options.telemetry;
    this.#clock = options.clock ?? (() => new Date());
  }

  /**
   * POSTs `input` to `path` with retry / timeout / telemetry. Throws on
   * non-2xx responses; the caller decides whether the failure is
   * retryable or surface-as-condition.
   */
  async post<TResult>(path: string, input: unknown): Promise<TResult> {
    const sleep = this.#retry.sleep ??
      ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.#retry.maxAttempts; attempt += 1) {
      const startedAt = this.#clock().toISOString();
      const startTs = Date.now();
      this.#telemetry?.onAttempt?.({ path, attempt, startedAt });
      try {
        const result = await withTimeout(
          `${this.#provider}-gateway:${path}`,
          this.#retry.timeoutMs,
          () => this.#postOnce<TResult>(path, input),
        );
        const completedAt = this.#clock().toISOString();
        this.#telemetry?.onSuccess?.({
          path,
          attempt,
          startedAt,
          completedAt,
          durationMs: Date.now() - startTs,
          status: "succeeded",
        });
        return result;
      } catch (error) {
        lastError = error;
        const category = classifyAwsError(error);
        const completedAt = this.#clock().toISOString();
        const httpStatus = (error && typeof error === "object" &&
            "statusCode" in (error as Record<string, unknown>) &&
            typeof (error as Record<string, unknown>).statusCode === "number")
          ? (error as { statusCode: number }).statusCode
          : undefined;
        this.#telemetry?.onFailure?.({
          path,
          attempt,
          startedAt,
          completedAt,
          durationMs: Date.now() - startTs,
          status: "failed",
          errorCategory: category,
          httpStatus,
        });
        if (
          !isRetryableCategory(category) || attempt === this.#retry.maxAttempts
        ) {
          throw error;
        }
        const delay = Math.min(
          this.#retry.baseDelayMs * Math.pow(2, attempt - 1),
          this.#retry.maxDelayMs,
        );
        await sleep(delay);
      }
    }
    throw lastError;
  }

  async #postOnce<TResult>(path: string, input: unknown): Promise<TResult> {
    const response = await this.#fetch(urlFor(this.#baseUrl, path), {
      method: "POST",
      headers: this.#requestHeaders(),
      body: JSON.stringify(encodeJson(input)),
    });

    const text = await response.text();
    if (!response.ok) {
      const err = new Error(
        `${this.#provider} gateway ${path} failed: HTTP ${response.status} ${response.statusText}${
          text ? `: ${errorMessage(text)}` : ""
        }`,
      );
      (err as Error & { statusCode?: number }).statusCode = response.status;
      throw err;
    }

    if (!text || response.status === 204) return undefined as TResult;
    const value = decodeJson(JSON.parse(text));
    return unwrapResult(value) as TResult;
  }

  #requestHeaders(): Headers {
    const headers = new Headers(this.#headers);
    headers.set("accept", "application/json");
    headers.set("content-type", "application/json");
    if (this.#bearerToken) {
      headers.set("authorization", `Bearer ${this.#bearerToken}`);
    }
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
