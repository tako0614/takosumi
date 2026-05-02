/**
 * Tiny helper for calling the Cloudflare REST API with a Bearer API token.
 *
 * Cloudflare API responses follow a uniform envelope:
 *   { result: T, success: bool, errors: [{code, message}], messages: [...] }
 *
 * This helper unwraps that envelope and converts non-success responses into
 * thrown errors. Used by the `Direct*Lifecycle` Cloudflare classes.
 */

export interface CloudflareEnvelope<T> {
  readonly result: T;
  readonly success: boolean;
  readonly errors?: readonly { code: number; message: string }[];
  readonly messages?: readonly { code: number; message: string }[];
}

export interface CloudflareFetchOptions {
  readonly apiToken: string;
  readonly fetch?: typeof fetch;
}

export interface CloudflareRequest {
  readonly method: string;
  readonly path: string; // path beneath https://api.cloudflare.com/client/v4
  readonly body?: unknown;
  readonly query?: Record<string, string>;
}

const BASE_URL = "https://api.cloudflare.com/client/v4";

export async function cfFetch<T = unknown>(
  request: CloudflareRequest,
  options: CloudflareFetchOptions,
): Promise<
  { status: number; envelope: CloudflareEnvelope<T> | undefined; text: string }
> {
  const fetchImpl = options.fetch ?? fetch;
  const url = new URL(
    request.path.startsWith("/")
      ? `${BASE_URL}${request.path}`
      : `${BASE_URL}/${request.path}`,
  );
  if (request.query) {
    for (const [k, v] of Object.entries(request.query)) {
      url.searchParams.set(k, v);
    }
  }
  const response = await fetchImpl(url, {
    method: request.method,
    headers: {
      "authorization": `Bearer ${options.apiToken}`,
      ...(request.body !== undefined
        ? { "content-type": "application/json" }
        : {}),
      "accept": "application/json",
    },
    body: request.body !== undefined ? JSON.stringify(request.body) : undefined,
  });
  const text = await response.text();
  let envelope: CloudflareEnvelope<T> | undefined;
  if (text) {
    try {
      envelope = JSON.parse(text) as CloudflareEnvelope<T>;
    } catch {
      envelope = undefined;
    }
  }
  return { status: response.status, envelope, text };
}

export function ensureCfOk<T>(
  result: {
    status: number;
    envelope: CloudflareEnvelope<T> | undefined;
    text: string;
  },
  context: string,
): T {
  if (
    result.status >= 200 && result.status < 300 && result.envelope?.success
  ) {
    return result.envelope.result;
  }
  const errs = result.envelope?.errors?.map((e) => `${e.code}:${e.message}`)
    .join(", ") ?? result.text ?? "";
  throw new Error(
    `${context} failed: HTTP ${result.status}${errs ? `: ${errs}` : ""}`,
  );
}
