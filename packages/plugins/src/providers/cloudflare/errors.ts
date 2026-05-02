/**
 * Cloudflare API error classification (Phase 18.2 / H6).
 *
 * The Cloudflare REST API surfaces failures as JSON bodies of the form:
 *
 *   { "success": false, "errors": [ { "code": 7003, "message": "..." } ] }
 *
 * plus an HTTP status. Different sub-products (Workers / D1 / R2 / KV / DO)
 * use slightly different `code` ranges; this module normalises both the
 * native `code` and the HTTP status onto a small finite category and then
 * onto the provider-agnostic {@link ProviderErrorCategory} so kernel-side
 * retry policy can branch the same way it does for AWS / GCP / k8s.
 */

import type { ProviderErrorCategory } from "takosumi-contract";

/**
 * Cloudflare-native error categories. Every provider sub-module either throws
 * a {@link CloudflareProviderError} or surfaces a fetch-style `Response` that
 * the operator wraps; both paths land here for classification.
 */
export type CloudflareErrorCategory =
  | "not-found"
  | "conflict"
  | "permission-denied"
  | "rate-limited"
  | "timeout"
  | "service-unavailable"
  | "validation"
  | "internal"
  | "unknown";

export interface CloudflareErrorOptions {
  readonly cause?: unknown;
  readonly httpStatus?: number;
  readonly cloudflareCode?: number;
  readonly retryable?: boolean;
  readonly details?: Record<string, unknown>;
}

export class CloudflareProviderError extends Error {
  readonly category: CloudflareErrorCategory;
  readonly httpStatus?: number;
  readonly cloudflareCode?: number;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    category: CloudflareErrorCategory,
    message: string,
    options: CloudflareErrorOptions = {},
  ) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "CloudflareProviderError";
    this.category = category;
    this.httpStatus = options.httpStatus;
    this.cloudflareCode = options.cloudflareCode;
    this.retryable = options.retryable ?? defaultRetryable(category);
    this.details = options.details;
  }
}

function defaultRetryable(category: CloudflareErrorCategory): boolean {
  switch (category) {
    case "rate-limited":
    case "timeout":
    case "service-unavailable":
    case "internal":
      return true;
    default:
      return false;
  }
}

/**
 * Map a Cloudflare REST `errors[].code` onto an internal category. The
 * mapping covers the well-known codes; unknown codes fall through to
 * `unknown` for fail-closed safety.
 */
const CLOUDFLARE_CODE_MAP: Readonly<Record<number, CloudflareErrorCategory>> = {
  7003: "not-found", // could not route to script (worker not found)
  7506: "not-found", // service binding not found
  10000: "permission-denied", // authentication error
  10001: "permission-denied", // authorisation error
  10013: "not-found", // workers-api: no script with this name
  10018: "validation", // worker bundle invalid
  10026: "rate-limited", // daily request quota exceeded
  10027: "rate-limited", // worker exceeded CPU
  10037: "conflict", // worker name in use
  10052: "conflict", // dispatch namespace already exists
  10053: "not-found", // dispatch namespace missing
  10063: "validation", // invalid worker code
  100201: "rate-limited", // r2: too many requests
  100204: "permission-denied", // r2: access denied
  10070: "rate-limited", // d1: rate limit
  // R2 S3-compatible error names show up as strings; handled below.
};

const CLOUDFLARE_NAME_MAP: Readonly<Record<string, CloudflareErrorCategory>> = {
  // R2 S3-compat errors:
  NoSuchBucket: "not-found",
  NoSuchKey: "not-found",
  AccessDenied: "permission-denied",
  BucketAlreadyExists: "conflict",
  BucketAlreadyOwnedByYou: "conflict",
  SlowDown: "rate-limited",
  RequestTimeout: "timeout",
};

/**
 * Classify an unknown thrown value onto a {@link CloudflareErrorCategory}.
 * Inspects:
 *   - {@link CloudflareProviderError} instances (returns their category),
 *   - `httpStatus` / `statusCode` / `status` numeric fields,
 *   - `cloudflareCode` and the well-known `errors: [{code}]` body shape,
 *   - S3-compatible R2 error names (`NoSuchBucket`, `AccessDenied`, ...),
 *   - message regex fallback for common transient signatures.
 */
export function classifyCloudflareError(
  error: unknown,
): CloudflareErrorCategory {
  if (error instanceof CloudflareProviderError) return error.category;
  if (!error || typeof error !== "object") return "unknown";
  const record = error as Record<string, unknown>;

  // Native Cloudflare error code on the thrown object directly.
  const cloudflareCode = pickNumber(
    record.cloudflareCode,
    record.code,
    record.errorCode,
  );
  if (cloudflareCode !== undefined && cloudflareCode in CLOUDFLARE_CODE_MAP) {
    return CLOUDFLARE_CODE_MAP[cloudflareCode];
  }

  // Cloudflare REST body shape: { success: false, errors: [{ code, message }] }
  const errorsBody = record.errors;
  if (Array.isArray(errorsBody)) {
    for (const entry of errorsBody) {
      if (!entry || typeof entry !== "object") continue;
      const entryObj = entry as Record<string, unknown>;
      const code = pickNumber(entryObj.code);
      if (code !== undefined && code in CLOUDFLARE_CODE_MAP) {
        return CLOUDFLARE_CODE_MAP[code];
      }
    }
  }

  // S3-compatible R2 error shape: name / Code is a string identifier.
  for (
    const candidate of [record.name, record.Code, record.code, record.__type]
  ) {
    if (typeof candidate !== "string") continue;
    if (candidate in CLOUDFLARE_NAME_MAP) {
      return CLOUDFLARE_NAME_MAP[candidate];
    }
  }

  // HTTP status fallback.
  const httpStatus = pickNumber(
    record.httpStatus,
    record.statusCode,
    record.status,
  );
  if (httpStatus !== undefined) {
    if (httpStatus === 404) return "not-found";
    if (httpStatus === 401 || httpStatus === 403) return "permission-denied";
    if (httpStatus === 408 || httpStatus === 504) return "timeout";
    if (httpStatus === 409) return "conflict";
    if (httpStatus === 422) return "validation";
    if (httpStatus === 429) return "rate-limited";
    if (httpStatus === 503) return "service-unavailable";
    if (httpStatus >= 500) return "internal";
    if (httpStatus >= 400) return "validation";
  }

  if (error instanceof Error) {
    const lc = error.message.toLowerCase();
    if (/timeout|timed out|aborted/.test(lc)) return "timeout";
    if (/rate.?limit|too many requests|throttl/.test(lc)) return "rate-limited";
    if (/not found/.test(lc)) return "not-found";
    if (/forbidden|unauthor/.test(lc)) return "permission-denied";
  }

  return "unknown";
}

function pickNumber(...candidates: unknown[]): number | undefined {
  for (const value of candidates) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

/**
 * Phase 18.2 / H6 — Map the Cloudflare-native category onto the provider-
 * agnostic {@link ProviderErrorCategory}.
 */
export function cloudflareErrorCategoryToProviderCategory(
  category: CloudflareErrorCategory,
): ProviderErrorCategory {
  switch (category) {
    case "not-found":
      return "not-found";
    case "conflict":
      return "conflict";
    case "permission-denied":
      return "permission-denied";
    case "rate-limited":
      return "rate-limited";
    case "timeout":
    case "service-unavailable":
    case "internal":
      return "transient";
    case "validation":
      return "invalid";
    case "unknown":
      return "unknown";
  }
}

/**
 * Phase 18.2 / H6 — Convenience wrapper that classifies a Cloudflare error
 * and normalises it onto the provider-agnostic enum in one call.
 */
export function classifyCloudflareErrorAsProviderCategory(
  error: unknown,
): ProviderErrorCategory {
  return cloudflareErrorCategoryToProviderCategory(
    classifyCloudflareError(error),
  );
}

export function isCloudflareRetryable(error: unknown): boolean {
  if (error instanceof CloudflareProviderError) return error.retryable;
  const category = classifyCloudflareError(error);
  return defaultRetryable(category);
}
