import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";
import type { AppInstallationStatus } from "./ledger.ts";

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
  const header = request?.headers.get("x-request-id") ??
    request?.headers.get("x-correlation-id") ?? null;
  if (header && isValidRequestIdShape(header)) return header;
  return crypto.randomUUID();
}

function isValidRequestIdShape(value: string): boolean {
  if (value.length === 0 || value.length > 64) return false;
  return REQUEST_ID_UUID_PATTERN.test(value) ||
    REQUEST_ID_ULID_PATTERN.test(value);
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
  const requestId = typeof source === "string"
    ? source
    : requestIdFrom(source ?? undefined);
  const error = details === undefined
    ? { code, message, requestId }
    : { code, message, requestId, details };
  return json({ error }, status, headers);
}

export function methodNotAllowed(allow: string): Response {
  return errorJson("method_not_allowed", "method not allowed", 405, undefined, {
    allow,
  });
}

export async function readJsonObject(
  request: Request,
): Promise<Record<string, unknown> | null> {
  try {
    const value = await request.json();
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

export async function readOptionalJsonObject(
  request: Request,
): Promise<Record<string, unknown> | null> {
  const text = await request.text();
  if (text.trim().length === 0) return {};
  try {
    const value = JSON.parse(text);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

export function takosumiSubjectValue(
  value: unknown,
): TakosumiSubject | undefined {
  return typeof value === "string" && value.startsWith("tsub_")
    ? value as TakosumiSubject
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
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(
    Math.ceil(value.length / 4) * 4,
    "=",
  );
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
  return typeof value === "object" && value !== null;
}

export function isPlainRecord(
  value: unknown,
): value is Record<string, unknown> {
  return isRecord(value) && !Array.isArray(value);
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

export function appInstallationStatusValue(
  value: unknown,
): AppInstallationStatus | undefined {
  return value === "installing" ||
      value === "ready" ||
      value === "failed" ||
      value === "suspended" ||
      value === "exported"
    ? value
    : undefined;
}
