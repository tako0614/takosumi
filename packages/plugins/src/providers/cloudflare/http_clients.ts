import type { provider } from "takosumi-contract";
import type { CloudflareProviderClient } from "./clients.ts";

export interface CloudflareHttpGatewayClientOptions {
  readonly baseUrl: string | URL;
  readonly bearerToken?: string;
  readonly headers?: HeadersInit;
  readonly fetch?: typeof fetch;
}

export class CloudflareHttpGatewayClient
  implements CloudflareProviderClient, provider.ProviderMaterializer {
  readonly #gateway: JsonHttpGateway;

  constructor(options: CloudflareHttpGatewayClientOptions) {
    this.#gateway = new JsonHttpGateway(options);
  }

  materializeDesiredState(
    desiredState: Parameters<
      CloudflareProviderClient["materializeDesiredState"]
    >[
      0
    ],
  ): ReturnType<CloudflareProviderClient["materializeDesiredState"]> {
    return this.#gateway.post(
      "provider/materialize-desired-state",
      desiredState,
    );
  }

  reconcileDesiredState(
    desiredState: Parameters<
      CloudflareProviderClient["materializeDesiredState"]
    >[
      0
    ],
  ): ReturnType<CloudflareProviderClient["materializeDesiredState"]> {
    return this.#gateway.post("provider/reconcile-desired-state", desiredState);
  }

  verifyDesiredState(
    desiredState: Parameters<
      CloudflareProviderClient["materializeDesiredState"]
    >[
      0
    ],
  ): ReturnType<NonNullable<CloudflareProviderClient["verifyDesiredState"]>> {
    return this.#gateway.post("provider/verify-desired-state", desiredState);
  }

  teardownDesiredState(
    desiredState: Parameters<
      CloudflareProviderClient["materializeDesiredState"]
    >[
      0
    ],
  ): Promise<provider.ProviderMaterializationPlan | void> {
    return this.#gateway.post(
      "provider/teardown-desired-state",
      desiredState,
    );
  }

  listOperations(): ReturnType<CloudflareProviderClient["listOperations"]> {
    return this.#gateway.post("provider/list-operations", {});
  }

  clearOperations(): ReturnType<CloudflareProviderClient["clearOperations"]> {
    return this.#gateway.post("provider/clear-operations", {});
  }

  detectDrift(input: unknown): Promise<unknown> {
    return this.#gateway.post("provider/detect-drift", input);
  }

  materialize(
    desiredState: Parameters<provider.ProviderMaterializer["materialize"]>[0],
  ): ReturnType<provider.ProviderMaterializer["materialize"]> {
    return this.materializeDesiredState(desiredState);
  }

  listRecordedOperations(): ReturnType<
    provider.ProviderMaterializer["listRecordedOperations"]
  > {
    return this.listOperations();
  }

  clearRecordedOperations(): ReturnType<
    provider.ProviderMaterializer["clearRecordedOperations"]
  > {
    return this.clearOperations();
  }
}

class JsonHttpGateway {
  readonly #baseUrl: string;
  readonly #headers?: HeadersInit;
  readonly #bearerToken?: string;
  readonly #fetch: typeof fetch;

  constructor(options: CloudflareHttpGatewayClientOptions) {
    this.#baseUrl = `${options.baseUrl}`;
    this.#headers = options.headers;
    this.#bearerToken = options.bearerToken;
    this.#fetch = options.fetch ?? fetch;
  }

  async post<TResult>(path: string, input: unknown): Promise<TResult> {
    const response = await this.#fetch(urlFor(this.#baseUrl, path), {
      method: "POST",
      headers: this.#requestHeaders(),
      body: JSON.stringify(encodeJson(input)),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `cloudflare gateway ${path} failed: HTTP ${response.status} ${response.statusText}${
          text ? `: ${errorMessage(text)}` : ""
        }`,
      );
    }
    if (!text || response.status === 204) return undefined as TResult;
    return unwrapResult(decodeJson(JSON.parse(text))) as TResult;
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
    if (value.$type === "Uint8Array" && typeof value.base64 === "string") {
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
