export type DeployControlErrorCode =
  | "invalid_argument"
  | "unauthenticated"
  | "permission_denied"
  | "not_found"
  | "failed_precondition"
  // Historical: request-size rejections ship as resource_exhausted -> 413.
  // Admission throttling uses rate_limited -> 429 (never 413).
  | "resource_exhausted"
  | "rate_limited"
  | "unavailable"
  | "not_implemented"
  | "internal_error";

export type DeployControlErrorHttpStatus =
  | 400
  | 401
  | 403
  | 404
  | 409
  | 413
  | 429
  | 500
  | 501
  | 503;

export const DEPLOY_CONTROL_ERROR_CODES = [
  "invalid_argument",
  "unauthenticated",
  "permission_denied",
  "not_found",
  "failed_precondition",
  "resource_exhausted",
  "rate_limited",
  "unavailable",
  "not_implemented",
  "internal_error",
] as const satisfies readonly DeployControlErrorCode[];

export const DEPLOY_CONTROL_ERROR_HTTP_STATUS_BY_CODE = {
  invalid_argument: 400,
  unauthenticated: 401,
  permission_denied: 403,
  not_found: 404,
  failed_precondition: 409,
  resource_exhausted: 413,
  rate_limited: 429,
  unavailable: 503,
  not_implemented: 501,
  internal_error: 500,
} as const satisfies Record<
  DeployControlErrorCode,
  DeployControlErrorHttpStatus
>;

/**
 * Optional client backoff hint carried in `error.details.retryAfterSeconds`
 * for `rate_limited` / `unavailable`; the HTTP layer mirrors it into the
 * `Retry-After` response header.
 */
export function retryAfterSecondsFromDetails(
  details: unknown,
): number | undefined {
  if (typeof details !== "object" || details === null) return undefined;
  const value = (details as { readonly retryAfterSeconds?: unknown })
    .retryAfterSeconds;
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.ceil(value)
    : undefined;
}

export interface DeployControlErrorEnvelope {
  readonly error: {
    readonly code: DeployControlErrorCode;
    readonly message: string;
    readonly requestId: string;
    readonly details?: unknown;
  };
}

export type TakosumiApiErrorCode = DeployControlErrorCode;
export type TakosumiApiErrorHttpStatus = DeployControlErrorHttpStatus;
export type TakosumiApiErrorEnvelope = DeployControlErrorEnvelope;
