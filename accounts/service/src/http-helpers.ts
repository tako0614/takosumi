import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";

export function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

/**
 * OAuth responses can carry one-shot credentials, authorization state, or
 * private claims. Rebuild the response with a fresh Headers object because
 * `Response.redirect()` headers are immutable in Node/workerd. The original
 * body, status, status text, Location, repeated Set-Cookie headers, and
 * runtime-specific response metadata are carried forward unchanged.
 */
export function withPrivateNoStoreHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  headers.set("pragma", "no-cache");

  // Cloudflare's Response may carry these fields even though the standard
  // ResponseInit type does not declare them. Preserve them when present so a
  // shared wrapper never drops a WebSocket or operator response metadata.
  const responseWithRuntimeFields = response as Response & {
    readonly cf?: unknown;
    readonly webSocket?: unknown;
  };
  const init = {
    status: response.status,
    statusText: response.statusText,
    headers,
    ...(responseWithRuntimeFields.cf !== undefined
      ? { cf: responseWithRuntimeFields.cf }
      : {}),
    ...(responseWithRuntimeFields.webSocket !== undefined
      ? { webSocket: responseWithRuntimeFields.webSocket }
      : {}),
  };
  return new Response(response.body, init);
}

/** OAuth protocol alias retained for the call sites that own that vocabulary. */
export function withOAuthNoStoreHeaders(response: Response): Response {
  return withPrivateNoStoreHeaders(response);
}

const REQUEST_ID_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQUEST_ID_ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

/**
 * Derives a request id for the canonical error envelope, mirroring
 * {@link core/api/deploy_control_shared.ts resolveRequestId}: an inbound
 * `x-request-id` / `x-correlation-id` header is echoed when well-shaped,
 * otherwise a fresh UUID is generated.
 */
export function requestIdFrom(request?: Request | null): string {
  const header =
    request?.headers.get("x-request-id") ??
    request?.headers.get("x-correlation-id") ??
    null;
  if (header && isValidRequestIdShape(header)) return header;
  return crypto.randomUUID();
}

function isValidRequestIdShape(value: string): boolean {
  if (value.length === 0 || value.length > 64) return false;
  return (
    REQUEST_ID_UUID_PATTERN.test(value) || REQUEST_ID_ULID_PATTERN.test(value)
  );
}

/**
 * Emits the canonical account-plane error envelope
 * `{ error: { code, message, requestId } }`, mirroring
 * {@link core/api/deploy_control_shared.ts errorEnvelope}. The fourth argument
 * accepts either the originating `Request` (the request id is derived from its
 * headers) or an already-resolved request id string; when omitted a fresh
 * UUID is generated.
 *
 * OIDC / OAuth (RFC 6749) responses MUST NOT use this helper; they keep their
 * `{ error, error_description }` shape.
 */
export function errorJson(
  code: string,
  message: string,
  status: number,
  source?: Request | string | null,
  headers: Record<string, string> = {},
  details?: unknown,
): Response {
  const requestId =
    typeof source === "string" ? source : requestIdFrom(source ?? undefined);
  const error =
    details === undefined
      ? { code, message, requestId }
      : { code, message, requestId, details };
  return json({ error }, status, headers);
}

export function methodNotAllowed(allow: string): Response {
  return errorJson("method_not_allowed", "method not allowed", 405, undefined, {
    allow,
  });
}

export const ACCOUNTS_JSON_BODY_MAX_BYTES = 1024 * 1024;
export const ACCOUNTS_FORM_BODY_MAX_BYTES = 32 * 1024;

export class RequestBodyReadError extends Error {
  readonly status: 400 | 413;
  readonly code: "invalid_request" | "request_too_large";

  constructor(
    code: "invalid_request" | "request_too_large",
    message: string,
    status: 400 | 413,
  ) {
    super(message);
    this.name = "RequestBodyReadError";
    this.code = code;
    this.status = status;
  }
}

/**
 * Read a UTF-8 request body with an enforced streaming cap. Content-Length is
 * only an early rejection hint: chunked/forged-length requests are counted as
 * bytes arrive and are cancelled once the route-class limit is crossed.
 */
export async function readBoundedRequestText(
  request: Request,
  maxBytes: number,
): Promise<string> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new RequestBodyReadError(
      "request_too_large",
      `request body exceeds ${maxBytes} bytes`,
      413,
    );
  }

  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel("request body limit exceeded").catch(() => undefined);
      throw new RequestBodyReadError(
        "request_too_large",
        `request body exceeds ${maxBytes} bytes`,
        413,
      );
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new RequestBodyReadError(
      "invalid_request",
      "request body must be valid UTF-8",
      400,
    );
  }
}

export async function readJsonObject(
  request: Request,
): Promise<Record<string, unknown> | null> {
  const text = await readBoundedRequestText(
    request,
    ACCOUNTS_JSON_BODY_MAX_BYTES,
  );
  try {
    const value = JSON.parse(text);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

export async function readOptionalJsonObject(
  request: Request,
): Promise<Record<string, unknown> | null> {
  const text = await readBoundedRequestText(
    request,
    ACCOUNTS_JSON_BODY_MAX_BYTES,
  );
  if (text.trim().length === 0) return {};
  try {
    const value = JSON.parse(text);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

export async function readFormUrlEncoded(
  request: Request,
): Promise<URLSearchParams> {
  return new URLSearchParams(
    await readBoundedRequestText(request, ACCOUNTS_FORM_BODY_MAX_BYTES),
  );
}

export function takosumiSubjectValue(
  value: unknown,
): TakosumiSubject | undefined {
  return typeof value === "string" && value.startsWith("tsub_")
    ? (value as TakosumiSubject)
    : undefined;
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

export function stringArrayValue(
  value: unknown,
): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return undefined;
  const output: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") return undefined;
    output.push(entry);
  }
  return output;
}

export function base64UrlBytesValue(
  value: unknown,
): Uint8Array<ArrayBuffer> | undefined {
  if (typeof value !== "string") return undefined;
  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  try {
    const binary = atob(padded);
    const output = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      output[index] = binary.charCodeAt(index);
    }
    return output;
  } catch {
    return undefined;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isPlainRecord(
  value: unknown,
): value is Record<string, unknown> {
  return isRecord(value);
}

export function bearerToken(authorization: string | null): string | null {
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
}

export function bearerChallenge(error: string): Response {
  return json({ error }, 401, {
    "www-authenticate": `Bearer error="${error}"`,
  });
}
