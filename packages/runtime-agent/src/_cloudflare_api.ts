/**
 * Tiny helper for calling the Cloudflare REST API with a Bearer API token.
 *
 * Cloudflare API responses follow a uniform envelope:
 *   { result: T, success: bool, errors: [{code, message}], messages: [...] }
 *
 * This helper unwraps that envelope and converts non-success responses into
 * thrown errors. Used by the `Direct*Lifecycle` Cloudflare classes.
 *
 * The envelope returned by `cfFetch` carries `result: unknown` because the
 * response body is foreign JSON. Callers MUST run the envelope through a
 * structural parser (`parseCloudflareEnvelope` in `connectors/_wire.ts`)
 * before reading `result`. The `cfFetchValidated` wrapper applies a
 * parser-supplied validator inline so lifecycle code can stay concise.
 */

import {
  type CloudflareEnvelope as ValidatedEnvelope,
  parseCloudflareEnvelope,
} from "./connectors/_wire.ts";

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

export async function cfFetch(
  request: CloudflareRequest,
  options: CloudflareFetchOptions,
): Promise<
  {
    status: number;
    envelope: CloudflareEnvelope<unknown> | undefined;
    text: string;
  }
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
  let envelope: CloudflareEnvelope<unknown> | undefined;
  if (text) {
    try {
      const raw = JSON.parse(text);
      // We do a *minimal* envelope check here so that `ensureCfOk` and other
      // callers can rely on `envelope.success` being a real boolean. Per-shape
      // validation of `result` is the caller's responsibility (via
      // `cfFetchValidated` or by reading from the envelope only after a
      // contextual structural parser has been applied).
      if (
        typeof raw === "object" && raw !== null && !Array.isArray(raw) &&
        typeof (raw as Record<string, unknown>).success === "boolean"
      ) {
        envelope = raw as CloudflareEnvelope<unknown>;
      }
    } catch {
      envelope = undefined;
    }
  }
  return { status: response.status, envelope, text };
}

/**
 * Run a Cloudflare API call and validate the envelope's `result` with the
 * supplied structural parser. On success the returned envelope's `result`
 * has the narrowed type. On malformed bodies the parser throws
 * `ConnectorContractError`.
 */
export async function cfFetchValidated<T>(
  request: CloudflareRequest,
  options: CloudflareFetchOptions,
  parseResult: (raw: unknown, ctx: string, path: string) => T,
  context: string,
): Promise<
  {
    status: number;
    envelope: ValidatedEnvelope<T> | undefined;
    text: string;
  }
> {
  const raw = await cfFetch(request, options);
  let envelope: ValidatedEnvelope<T> | undefined;
  if (raw.envelope !== undefined) {
    // Re-parse from the raw envelope to apply structural checks. We pass
    // through the original object (already parsed) so this is cheap.
    envelope = parseCloudflareEnvelope(raw.envelope, context, parseResult);
  }
  return { status: raw.status, envelope, text: raw.text };
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
