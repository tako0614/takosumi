import { DomainError, type DomainErrorCode } from "../shared/errors.ts";

export interface ApiErrorEnvelope {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly requestId?: string;
    readonly details?: JsonValue;
  };
}

export interface ApiErrorResponse {
  readonly status: number;
  readonly body: ApiErrorEnvelope;
}

export interface ApiErrorEnvelopeOptions {
  readonly requestId?: string;
  readonly details?: unknown;
}

export type ApiAudience = "public" | "internal";

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | {
  readonly [key: string]: JsonValue;
};

type ProviderFailureReason =
  | "provider_timeout"
  | "provider_unavailable"
  | "provider_conflict"
  | "provider_rejected"
  | "unknown";

const SENSITIVE_DETAIL_KEY =
  /authorization|cookie|token|secret|password|credential|api[_-]?key|private[_-]?key/i;

const REDACTED = "[redacted]";

export function createPublicApiErrorResponse(
  error: unknown,
  options: ApiErrorEnvelopeOptions = {},
): ApiErrorResponse {
  return createApiErrorResponse(error, "public", options);
}

export function createInternalApiErrorResponse(
  error: unknown,
  options: ApiErrorEnvelopeOptions = {},
): ApiErrorResponse {
  return createApiErrorResponse(error, "internal", options);
}

export function createApiErrorResponse(
  error: unknown,
  audience: ApiAudience,
  options: ApiErrorEnvelopeOptions = {},
): ApiErrorResponse {
  const normalized = normalizeApiError(error, audience, options);
  return {
    status: normalized.status,
    body: {
      error: {
        code: normalized.code,
        message: normalized.message,
        ...(options.requestId ? { requestId: options.requestId } : {}),
        ...(normalized.details === undefined
          ? {}
          : { details: redactApiErrorDetails(normalized.details) }),
      },
    },
  };
}

export function createApiErrorEnvelope(
  error: unknown,
  audience: ApiAudience,
  options: ApiErrorEnvelopeOptions = {},
): ApiErrorEnvelope {
  return createApiErrorResponse(error, audience, options).body;
}

export function apiHttpStatusForError(error: unknown): number {
  if (isDomainError(error)) return httpStatusForDomainErrorCode(error.code);
  const providerReason = providerFailureReasonForError(error);
  if (providerReason) return httpStatusForProviderFailureReason(providerReason);
  return 500;
}

export function apiErrorCodeForError(error: unknown): string {
  if (isDomainError(error)) return error.code;
  return providerFailureReasonForError(error) ?? "internal_error";
}

export function httpStatusForDomainErrorCode(code: DomainErrorCode): number {
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

export function httpStatusForProviderFailureReason(
  reason: ProviderFailureReason,
): number {
  switch (reason) {
    case "provider_timeout":
      return 504;
    case "provider_unavailable":
      return 503;
    case "provider_conflict":
      return 409;
    case "provider_rejected":
      return 422;
    case "unknown":
      return 502;
  }
}

export function readRequestId(
  request: Request,
  fallback?: string,
): string | undefined {
  return request.headers.get("x-request-id") ??
    request.headers.get("x-correlation-id") ??
    fallback;
}

export function redactApiErrorDetails(details: unknown): JsonValue {
  return toRedactedJson(details, 0);
}

function normalizeApiError(
  error: unknown,
  _audience: ApiAudience,
  options: ApiErrorEnvelopeOptions,
): {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly details?: unknown;
} {
  if (isDomainError(error)) {
    return {
      status: httpStatusForDomainErrorCode(error.code),
      code: error.code,
      message: error.message,
      details: options.details ?? error.details,
    };
  }
  const providerReason = providerFailureReasonForError(error);
  if (providerReason) {
    return {
      status: httpStatusForProviderFailureReason(providerReason),
      code: providerReason,
      message: errorMessage(error, "provider operation failed"),
      details: options.details ?? providerFailureDetails(error),
    };
  }
  return {
    status: 500,
    code: "internal_error",
    message: "Internal server error",
    details: options.details,
  };
}

function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError ||
    (
      error instanceof Error &&
      error.name === "DomainError" &&
      "code" in error &&
      isDomainErrorCode((error as { code?: unknown }).code)
    );
}

function isDomainErrorCode(value: unknown): value is DomainErrorCode {
  return value === "invalid_argument" ||
    value === "not_found" ||
    value === "conflict" ||
    value === "permission_denied" ||
    value === "not_implemented";
}

function providerFailureReasonForError(
  error: unknown,
): ProviderFailureReason | undefined {
  const explicitReason = providerFailureReasonFromValue(
    property(error, "failureReason") ?? property(error, "reason"),
  );
  if (explicitReason) return explicitReason;

  const failure = property(error, "failure");
  const nestedReason = providerFailureReasonFromValue(
    property(failure, "reason") ?? property(failure, "failureReason"),
  );
  if (nestedReason) return nestedReason;

  if (
    !(error instanceof Error) || !error.name.toLowerCase().includes("provider")
  ) {
    return undefined;
  }
  return classifyProviderFailureMessage(error.message);
}

function providerFailureReasonFromValue(
  value: unknown,
): ProviderFailureReason | undefined {
  return value === "provider_timeout" ||
      value === "provider_unavailable" ||
      value === "provider_conflict" ||
      value === "provider_rejected" ||
      value === "unknown"
    ? value
    : undefined;
}

function classifyProviderFailureMessage(
  message: string,
): ProviderFailureReason {
  const normalized = message.toLowerCase();
  if (normalized.includes("timeout") || normalized.includes("timed out")) {
    return "provider_timeout";
  }
  if (
    normalized.includes("econnrefused") ||
    normalized.includes("connection refused") ||
    normalized.includes("network") ||
    normalized.includes("unavailable")
  ) {
    return "provider_unavailable";
  }
  if (
    normalized.includes("conflict") ||
    normalized.includes("already exists") ||
    normalized.includes("locked")
  ) {
    return "provider_conflict";
  }
  if (
    normalized.includes("invalid") ||
    normalized.includes("denied") ||
    normalized.includes("forbidden") ||
    normalized.includes("unauthorized") ||
    normalized.includes("not found")
  ) {
    return "provider_rejected";
  }
  return "unknown";
}

function providerFailureDetails(error: unknown): unknown {
  if (!error || typeof error !== "object") return undefined;
  const failure = property(error, "failure");
  if (failure) return failure;
  const retryable = property(error, "retryable");
  if (retryable !== undefined) {
    return { retryable };
  }
  return undefined;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function property(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || !(key in value)) return undefined;
  return (value as Record<string, unknown>)[key];
}

function toRedactedJson(value: unknown, depth: number): JsonValue {
  if (depth > 8) return "[truncated]";
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  if (Array.isArray(value)) {
    return value.map((item) => toRedactedJson(item, depth + 1));
  }
  if (typeof value !== "object") return String(value);

  const redacted: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    redacted[key] = SENSITIVE_DETAIL_KEY.test(key)
      ? REDACTED
      : toRedactedJson(item, depth + 1);
  }
  return redacted;
}
