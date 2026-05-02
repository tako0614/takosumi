import type {
  KubernetesProviderClient,
  KubernetesRouterClient,
  KubernetesRuntimeAgentClient,
} from "./clients.ts";

export interface KubernetesHttpGatewayClientOptions {
  readonly baseUrl: string | URL;
  readonly bearerToken?: string;
  readonly headers?: HeadersInit;
  readonly fetch?: typeof fetch;
}

export class KubernetesHttpGatewayClient
  implements
    KubernetesProviderClient,
    KubernetesRouterClient,
    KubernetesRuntimeAgentClient {
  readonly #gateway: JsonHttpGateway;

  constructor(options: KubernetesHttpGatewayClientOptions) {
    this.#gateway = new JsonHttpGateway(options);
  }

  reconcileDesiredState(
    desiredState: Parameters<
      KubernetesProviderClient["reconcileDesiredState"]
    >[0],
  ): ReturnType<KubernetesProviderClient["reconcileDesiredState"]> {
    return this.#gateway.post("provider/reconcile-desired-state", desiredState);
  }

  listOperations(): ReturnType<KubernetesProviderClient["listOperations"]> {
    return this.#gateway.post("provider/list-operations", {});
  }

  clearOperations(): ReturnType<KubernetesProviderClient["clearOperations"]> {
    return this.#gateway.post("provider/clear-operations", {});
  }

  applyRoutes(
    projection: Parameters<KubernetesRouterClient["applyRoutes"]>[0],
  ): ReturnType<KubernetesRouterClient["applyRoutes"]> {
    return this.#gateway.post("router/apply-routes", projection);
  }

  registerAgent(
    input: Parameters<KubernetesRuntimeAgentClient["registerAgent"]>[0],
  ): ReturnType<KubernetesRuntimeAgentClient["registerAgent"]> {
    return this.#gateway.post("runtime-agent/register-agent", input);
  }

  heartbeatAgent(
    input: Parameters<KubernetesRuntimeAgentClient["heartbeatAgent"]>[0],
  ): ReturnType<KubernetesRuntimeAgentClient["heartbeatAgent"]> {
    return this.#gateway.post("runtime-agent/heartbeat-agent", input);
  }

  async getAgent(
    agentId: Parameters<KubernetesRuntimeAgentClient["getAgent"]>[0],
  ): ReturnType<KubernetesRuntimeAgentClient["getAgent"]> {
    return optional(
      await this.#gateway.post("runtime-agent/get-agent", { agentId }),
    );
  }

  listAgents(): ReturnType<KubernetesRuntimeAgentClient["listAgents"]> {
    return this.#gateway.post("runtime-agent/list-agents", {});
  }

  requestDrain(
    agentId: Parameters<KubernetesRuntimeAgentClient["requestDrain"]>[0],
    at?: Parameters<KubernetesRuntimeAgentClient["requestDrain"]>[1],
  ): ReturnType<KubernetesRuntimeAgentClient["requestDrain"]> {
    return this.#gateway.post("runtime-agent/request-drain", { agentId, at });
  }

  revokeAgent(
    agentId: Parameters<KubernetesRuntimeAgentClient["revokeAgent"]>[0],
    at?: Parameters<KubernetesRuntimeAgentClient["revokeAgent"]>[1],
  ): ReturnType<KubernetesRuntimeAgentClient["revokeAgent"]> {
    return this.#gateway.post("runtime-agent/revoke-agent", { agentId, at });
  }

  enqueueWork(
    input: Parameters<KubernetesRuntimeAgentClient["enqueueWork"]>[0],
  ): ReturnType<KubernetesRuntimeAgentClient["enqueueWork"]> {
    return this.#gateway.post("runtime-agent/enqueue-work", input);
  }

  async leaseWork(
    input: Parameters<KubernetesRuntimeAgentClient["leaseWork"]>[0],
  ): ReturnType<KubernetesRuntimeAgentClient["leaseWork"]> {
    return optional(
      await this.#gateway.post("runtime-agent/lease-work", input),
    );
  }

  completeWork(
    input: Parameters<KubernetesRuntimeAgentClient["completeWork"]>[0],
  ): ReturnType<KubernetesRuntimeAgentClient["completeWork"]> {
    return this.#gateway.post("runtime-agent/complete-work", input);
  }

  failWork(
    input: Parameters<KubernetesRuntimeAgentClient["failWork"]>[0],
  ): ReturnType<KubernetesRuntimeAgentClient["failWork"]> {
    return this.#gateway.post("runtime-agent/fail-work", input);
  }

  async getWork(
    workId: Parameters<KubernetesRuntimeAgentClient["getWork"]>[0],
  ): ReturnType<KubernetesRuntimeAgentClient["getWork"]> {
    return optional(
      await this.#gateway.post("runtime-agent/get-work", { workId }),
    );
  }

  listWork(): ReturnType<KubernetesRuntimeAgentClient["listWork"]> {
    return this.#gateway.post("runtime-agent/list-work", {});
  }
}

class JsonHttpGateway {
  readonly #baseUrl: string;
  readonly #headers?: HeadersInit;
  readonly #bearerToken?: string;
  readonly #fetch: typeof fetch;

  constructor(options: KubernetesHttpGatewayClientOptions) {
    this.#baseUrl = `${options.baseUrl}`;
    this.#headers = options.headers;
    this.#bearerToken = options.bearerToken;
    this.#fetch = options.fetch ?? fetch;
  }

  async post<TResult>(path: string, input: unknown): Promise<TResult> {
    const response = await this.#fetch(urlFor(this.#baseUrl, path), {
      method: "POST",
      headers: this.#requestHeaders(),
      body: JSON.stringify(input),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `kubernetes gateway ${path} failed: HTTP ${response.status} ${response.statusText}${
          text ? `: ${errorMessage(text)}` : ""
        }`,
      );
    }
    if (!text || response.status === 204) return undefined as TResult;
    return unwrapResult(JSON.parse(text)) as TResult;
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
    value && typeof value === "object" && Object.hasOwn(value, "result") &&
    Object.keys(value).length === 1
  ) {
    return (value as { result: unknown }).result;
  }
  return value;
}

function errorMessage(text: string): string {
  try {
    const parsed = JSON.parse(text);
    if (
      parsed && typeof parsed === "object" &&
      typeof parsed.error === "string"
    ) {
      return parsed.error;
    }
  } catch {
    // Fall through to raw text.
  }
  return text;
}
