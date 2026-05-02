/**
 * Typed error classes for the production-grade k8s provider.
 *
 * Each class corresponds to a kubectl / API-server error category that the
 * reconciler needs to react to differently:
 *
 * - `NotFound`   → safe to skip on delete; on get it signals drift
 * - `Conflict`   → optimistic-lock collision; reconciler retries with backoff
 * - `Forbidden`  → operator credential is missing RBAC; surfaces as failed condition
 * - `Throttled`  → API server rate-limited the request; retry with backoff
 * - `Timeout`    → upstream wall-clock timeout; retry up to budget
 * - `Drift`      → live state diverged from declared; reconciler may re-apply
 *
 * Adapters can throw these directly; the reconciler also synthesises them
 * from gateway HTTP responses (4xx / 5xx) when an injected client returns a
 * raw `Response`-like error.
 */
export type K8sErrorCode =
  | "not-found"
  | "conflict"
  | "forbidden"
  | "throttled"
  | "timeout"
  | "drift"
  | "unavailable"
  | "invalid";

export interface K8sErrorOptions {
  readonly cause?: unknown;
  readonly status?: number;
  readonly reason?: string;
  readonly objectAddress?: string;
  readonly retryable?: boolean;
  readonly details?: Record<string, unknown>;
}

export class K8sProviderError extends Error {
  readonly code: K8sErrorCode;
  readonly status?: number;
  readonly reason?: string;
  readonly objectAddress?: string;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    code: K8sErrorCode,
    message: string,
    options: K8sErrorOptions = {},
  ) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "K8sProviderError";
    this.code = code;
    this.status = options.status;
    this.reason = options.reason;
    this.objectAddress = options.objectAddress;
    this.retryable = options.retryable ?? defaultRetryable(code);
    this.details = options.details;
  }
}

export class K8sNotFoundError extends K8sProviderError {
  constructor(message: string, options?: K8sErrorOptions) {
    super("not-found", message, { ...options, retryable: false });
    this.name = "K8sNotFoundError";
  }
}

export class K8sConflictError extends K8sProviderError {
  constructor(message: string, options?: K8sErrorOptions) {
    super("conflict", message, { ...options, retryable: true });
    this.name = "K8sConflictError";
  }
}

export class K8sForbiddenError extends K8sProviderError {
  constructor(message: string, options?: K8sErrorOptions) {
    super("forbidden", message, { ...options, retryable: false });
    this.name = "K8sForbiddenError";
  }
}

export class K8sThrottledError extends K8sProviderError {
  readonly retryAfterMs?: number;
  constructor(
    message: string,
    options?: K8sErrorOptions & { readonly retryAfterMs?: number },
  ) {
    super("throttled", message, { ...options, retryable: true });
    this.name = "K8sThrottledError";
    this.retryAfterMs = options?.retryAfterMs;
  }
}

export class K8sTimeoutError extends K8sProviderError {
  constructor(message: string, options?: K8sErrorOptions) {
    super("timeout", message, { ...options, retryable: true });
    this.name = "K8sTimeoutError";
  }
}

export class K8sDriftError extends K8sProviderError {
  readonly observed?: Record<string, unknown>;
  readonly desired?: Record<string, unknown>;
  constructor(
    message: string,
    options?: K8sErrorOptions & {
      readonly observed?: Record<string, unknown>;
      readonly desired?: Record<string, unknown>;
    },
  ) {
    super("drift", message, { ...options, retryable: false });
    this.name = "K8sDriftError";
    this.observed = options?.observed;
    this.desired = options?.desired;
  }
}

export function fromHttpStatus(
  status: number,
  message: string,
  options: K8sErrorOptions = {},
): K8sProviderError {
  const opts = { ...options, status };
  switch (status) {
    case 404:
      return new K8sNotFoundError(message, opts);
    case 409:
      return new K8sConflictError(message, opts);
    case 403:
      return new K8sForbiddenError(message, opts);
    case 401:
      return new K8sForbiddenError(message, opts);
    case 408:
    case 504:
      return new K8sTimeoutError(message, opts);
    case 429:
      return new K8sThrottledError(message, opts);
    case 422:
      return new K8sProviderError("invalid", message, {
        ...opts,
        retryable: false,
      });
    case 500:
    case 502:
    case 503:
      return new K8sProviderError("unavailable", message, {
        ...opts,
        retryable: true,
      });
    default:
      return new K8sProviderError("unavailable", message, {
        ...opts,
        retryable: status >= 500,
      });
  }
}

export function isRetryable(error: unknown): boolean {
  if (error instanceof K8sProviderError) return error.retryable;
  if (
    error instanceof Error && /timeout|aborted|network/i.test(error.message)
  ) {
    return true;
  }
  return false;
}

function defaultRetryable(code: K8sErrorCode): boolean {
  switch (code) {
    case "conflict":
    case "throttled":
    case "timeout":
    case "unavailable":
      return true;
    default:
      return false;
  }
}

/**
 * Phase 18.2 / H6 — Map a Kubernetes-native {@link K8sErrorCode} onto the
 * provider-agnostic {@link ProviderErrorCategory} so kernel-side retry policy
 * can branch uniformly across all four clouds.
 */
import type { ProviderErrorCategory } from "takosumi-contract";

export function k8sErrorCodeToProviderCategory(
  code: K8sErrorCode,
): ProviderErrorCategory {
  switch (code) {
    case "not-found":
      return "not-found";
    case "conflict":
      return "conflict";
    case "forbidden":
      return "permission-denied";
    case "throttled":
      return "rate-limited";
    case "timeout":
    case "unavailable":
      return "transient";
    case "drift":
      return "permanent";
    case "invalid":
      return "invalid";
  }
}

/**
 * Phase 18.2 / H6 — Classify a thrown value (k8s error or otherwise) onto the
 * provider-agnostic enum.
 */
export function classifyK8sErrorAsProviderCategory(
  error: unknown,
): ProviderErrorCategory {
  if (error instanceof K8sProviderError) {
    return k8sErrorCodeToProviderCategory(error.code);
  }
  if (
    error instanceof Error &&
    /timeout|aborted|network/i.test(error.message)
  ) {
    return "transient";
  }
  return "unknown";
}
