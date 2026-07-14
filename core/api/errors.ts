import type { Context, Hono as HonoApp } from "hono";
import { DomainError, type DomainErrorCode } from "../shared/errors.ts";

export interface ApiErrorEnvelope {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly requestId: string;
    readonly details?: unknown;
  };
}

export class MalformedJsonRequestError extends Error {
  constructor() {
    super("Malformed JSON request body");
    this.name = "MalformedJsonRequestError";
  }
}

export class RequestBodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Request body exceeds ${maxBytes} bytes`);
    this.name = "RequestBodyTooLargeError";
  }
}

export function apiError(
  code: string,
  message: string,
  details?: unknown,
  requestId: string = crypto.randomUUID(),
): ApiErrorEnvelope {
  return details === undefined
    ? { error: { code, message, requestId } }
    : { error: { code, message, requestId, details } };
}

const REQUEST_ID_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQUEST_ID_ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

/**
 * Resolves a request id for {@link apiError} from a Hono Context, mirroring
 * {@link core/api/deploy_control_shared.ts resolveRequestId}: echo a well-shaped
 * inbound `x-request-id` / `x-correlation-id` header, otherwise mint a UUID.
 */
export function requestIdFromContext(c: Context): string {
  const header = c.req.header("x-request-id") ?? c.req.header("x-correlation-id");
  if (header && isValidRequestIdShape(header)) return header;
  return crypto.randomUUID();
}

function isValidRequestIdShape(value: string): boolean {
  if (value.length === 0 || value.length > 64) return false;
  return REQUEST_ID_UUID_PATTERN.test(value) ||
    REQUEST_ID_ULID_PATTERN.test(value);
}

export function registerApiErrorHandler(app: HonoApp): void {
  const maybeApp = app as HonoApp & {
    onError?: HonoApp["onError"];
  };
  maybeApp.onError?.((error, c) => apiExceptionResponse(c, error));
}

export function apiExceptionResponse(c: Context, error: unknown): Response {
  const requestId = requestIdFromContext(c);
  if (error instanceof MalformedJsonRequestError) {
    return c.json(apiError("invalid_json", error.message, undefined, requestId), 400);
  }
  if (error instanceof RequestBodyTooLargeError) {
    return c.json(
      apiError("payload_too_large", error.message, undefined, requestId),
      413,
    );
  }
  if (error instanceof DomainError) {
    return c.json(
      apiError(error.code, error.message, error.details, requestId),
      httpStatusForDomainErrorCode(error.code),
    );
  }
  return c.json(
    apiError("internal_error", "Internal server error", undefined, requestId),
    500,
  );
}

function httpStatusForDomainErrorCode(
  code: DomainErrorCode,
): 400 | 403 | 404 | 409 | 501 {
  switch (code) {
    case "invalid_argument":
      return 400;
    case "not_found":
      return 404;
    case "conflict":
      return 409;
    case "permission_denied":
      return 403;
    case "not_implemented":
      return 501;
  }
}

export async function readJsonObject(
  request: Request,
  options: { readonly maxBytes?: number } = {},
): Promise<Record<string, unknown>> {
  const contentLength = Number(request.headers.get("content-length"));
  if (
    options.maxBytes !== undefined &&
    Number.isFinite(contentLength) &&
    contentLength > options.maxBytes
  ) {
    throw new RequestBodyTooLargeError(options.maxBytes);
  }
  const rawBody = await request.text();
  if (
    options.maxBytes !== undefined &&
    new TextEncoder().encode(rawBody).byteLength > options.maxBytes
  ) {
    throw new RequestBodyTooLargeError(options.maxBytes);
  }
  if (rawBody.trim() === "") return {};
  let value: unknown;
  try {
    value = JSON.parse(rawBody);
  } catch {
    throw new MalformedJsonRequestError();
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}
