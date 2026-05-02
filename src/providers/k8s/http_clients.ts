import type {
  K8sApplyClient,
  K8sApplyResult,
  K8sConfigMapSpec,
  K8sDeleteClient,
  K8sDeploymentSpec,
  K8sIngressSpec,
  K8sNamespaceSpec,
  K8sSecretSpec,
  K8sServiceSpec,
} from "./clients.ts";

/**
 * Fetch-based gateway client for environments where the operator runs an
 * HTTP-side-car (kubectl proxy / aggregating gateway / SaaS API) instead of
 * exposing kubeconfig directly to the plugin. Mirrors the AWS / GCP / k8s
 * gateway pattern used elsewhere.
 */
export interface K8sHttpGatewayClientOptions {
  readonly baseUrl: string | URL;
  readonly bearerToken?: string;
  readonly headers?: HeadersInit;
  readonly fetch?: typeof fetch;
}

export class K8sHttpGatewayClient implements K8sApplyClient, K8sDeleteClient {
  readonly #gateway: JsonHttpGateway;

  constructor(options: K8sHttpGatewayClientOptions) {
    this.#gateway = new JsonHttpGateway(options);
  }

  applyNamespace(input: K8sNamespaceSpec): Promise<K8sApplyResult> {
    return this.#gateway.post("apply/namespace", input);
  }

  applyDeployment(input: K8sDeploymentSpec): Promise<K8sApplyResult> {
    return this.#gateway.post("apply/deployment", input);
  }

  applyService(input: K8sServiceSpec): Promise<K8sApplyResult> {
    return this.#gateway.post("apply/service", input);
  }

  applyIngress(input: K8sIngressSpec): Promise<K8sApplyResult> {
    return this.#gateway.post("apply/ingress", input);
  }

  applyConfigMap(input: K8sConfigMapSpec): Promise<K8sApplyResult> {
    return this.#gateway.post("apply/configmap", input);
  }

  applySecret(input: K8sSecretSpec): Promise<K8sApplyResult> {
    return this.#gateway.post("apply/secret", input);
  }

  deleteNamespace(input: { readonly name: string }): Promise<K8sApplyResult> {
    return this.#gateway.post("delete/namespace", input);
  }

  deleteDeployment(
    input: { readonly namespace: string; readonly name: string },
  ): Promise<K8sApplyResult> {
    return this.#gateway.post("delete/deployment", input);
  }

  deleteService(
    input: { readonly namespace: string; readonly name: string },
  ): Promise<K8sApplyResult> {
    return this.#gateway.post("delete/service", input);
  }

  deleteIngress(
    input: { readonly namespace: string; readonly name: string },
  ): Promise<K8sApplyResult> {
    return this.#gateway.post("delete/ingress", input);
  }

  deleteConfigMap(
    input: { readonly namespace: string; readonly name: string },
  ): Promise<K8sApplyResult> {
    return this.#gateway.post("delete/configmap", input);
  }

  deleteSecret(
    input: { readonly namespace: string; readonly name: string },
  ): Promise<K8sApplyResult> {
    return this.#gateway.post("delete/secret", input);
  }
}

class JsonHttpGateway {
  readonly #baseUrl: string;
  readonly #headers?: HeadersInit;
  readonly #bearerToken?: string;
  readonly #fetch: typeof fetch;

  constructor(options: K8sHttpGatewayClientOptions) {
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
        `k8s gateway ${path} failed: HTTP ${response.status} ${response.statusText}${
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
    // raw text
  }
  return text;
}
