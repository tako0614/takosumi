/**
 * Provider-agnostic error category (Phase 18.2 / H6).
 *
 * Each cloud provider (AWS / GCP / Kubernetes / Cloudflare) speaks a different
 * dialect when surfacing API errors:
 *
 * - AWS uses string `Code` values (e.g. `ResourceNotFoundException`,
 *   `ThrottlingException`) plus HTTP status overlays.
 * - GCP uses gRPC-style status strings (e.g. `NOT_FOUND`,
 *   `PERMISSION_DENIED`, `RESOURCE_EXHAUSTED`).
 * - Kubernetes uses HTTP statuses + `reason` strings (e.g. `Conflict`,
 *   `Forbidden`).
 * - Cloudflare uses error code numbers + JSON `{ "errors": [{ "code": ... }] }`
 *   bodies.
 *
 * Rather than hard-coding a provider-specific switch in every retry / fail-closed
 * code path, the kernel and provider plugins MUST normalise their native error
 * shape onto this enum. Retry policy is then expressed in terms of the
 * normalised category, not the provider dialect, so a "retry on transient"
 * rule applies uniformly across all four clouds.
 *
 * The categories are intentionally small and finite — every native code MUST
 * map onto exactly one of them. `unknown` is the fall-back for codes we
 * haven't explicitly mapped; it is treated as non-retryable so unknown errors
 * fail-closed.
 *
 * Provider plugins expose a `classifyXxxError(err) → ProviderErrorCategory`
 * helper alongside their native classifier so kernel-side code that doesn't
 * know which cloud it's talking to can still take a retry decision via
 * {@link isRetryableErrorCategory}.
 */
export type ProviderErrorCategory =
  /** Retryable transient failure (network blip, 5xx, connection reset). */
  | "transient"
  /** Permanent failure that retrying cannot recover (validation, missing
   *  precondition the caller can't fix, fatal config). */
  | "permanent"
  /** Provider rate-limited / throttled the request. Retry with backoff. */
  | "rate-limited"
  /** Caller credentials lack permission. Not retryable. */
  | "permission-denied"
  /** Resource not found. Usually permanent unless the caller is racing
   *  with a creation flow; the caller decides whether to retry. */
  | "not-found"
  /** Resource state conflict / optimistic-lock collision. Often retryable
   *  with fresh state. */
  | "conflict"
  /** Caller-supplied input was invalid. Permanent. */
  | "invalid"
  /** Could not classify. Treated as permanent for fail-closed safety. */
  | "unknown";

/**
 * Categories that the kernel-side retry loop should retry on.
 *
 * Note that `conflict` is intentionally NOT retried by this default policy —
 * conflicts are commonly retried at a higher level after re-fetching state
 * (e.g. k8s reconciler fetches the latest resourceVersion before re-applying),
 * and a blind low-level retry would loop forever on a true contention. Callers
 * that want the conflict-retry behaviour should branch explicitly.
 */
export function isRetryableErrorCategory(
  category: ProviderErrorCategory,
): boolean {
  return category === "transient" || category === "rate-limited";
}

/**
 * True for categories that represent a hard, fail-closed condition — the
 * caller should surface the error to the operator without further retry,
 * because retrying cannot fix the underlying cause.
 */
export function isFailClosedErrorCategory(
  category: ProviderErrorCategory,
): boolean {
  return (
    category === "permanent" ||
    category === "permission-denied" ||
    category === "invalid" ||
    category === "unknown"
  );
}

/**
 * A normalised provider error envelope. Provider plugins SHOULD populate this
 * shape on `Deployment.conditions[]` so the deployment service can render a
 * provider-agnostic UI without sniffing native error codes.
 */
export interface NormalisedProviderError {
  /** Cloud-agnostic category. */
  readonly category: ProviderErrorCategory;
  /** Provider name (e.g. `aws`, `gcp`, `k8s`, `cloudflare`). */
  readonly provider: string;
  /** Native error code as surfaced by the provider (best-effort). */
  readonly nativeCode?: string;
  /** Human-readable message. */
  readonly message: string;
  /** HTTP status when the underlying transport surfaced one. */
  readonly httpStatus?: number;
  /** True when the kernel-side retry loop is allowed to retry this error. */
  readonly retryable: boolean;
}

/**
 * Phase 18.2 / H6 — Provider-agnostic classifier registry. Each provider
 * plugin registers its `classifyXxxErrorAsProviderCategory` adapter under its
 * canonical provider name (`aws` / `gcp` / `k8s` / `cloudflare`). Kernel-side
 * code that holds an error + a provider name (e.g. an apply orchestrator
 * routing operations through multiple plugins) can then call
 * {@link normalizeProviderError} once, without sniffing error shapes.
 *
 * The registry is mutated at plugin-load time and read by {@link
 * normalizeProviderError}; no runtime mutation is expected after the kernel
 * has finished loading plugins. Callers that want a snapshot should copy the
 * result of {@link listRegisteredProviders}.
 */
type Classifier = (error: unknown) => ProviderErrorCategory;
const CLASSIFIER_REGISTRY = new Map<string, Classifier>();

/**
 * Register a provider error classifier under a canonical provider name.
 * Idempotent: re-registering with the same name overwrites the previous
 * entry (used by tests that swap stubs in/out).
 */
export function registerProviderErrorClassifier(
  provider: string,
  classifier: Classifier,
): void {
  CLASSIFIER_REGISTRY.set(provider, classifier);
}

/** List the provider names that currently have a classifier registered. */
export function listRegisteredProviders(): readonly string[] {
  return [...CLASSIFIER_REGISTRY.keys()].sort();
}

/**
 * Phase 18.2 / H6 — Normalise a thrown value onto the provider-agnostic
 * {@link ProviderErrorCategory} via the registered provider classifier. When
 * no classifier is registered for the supplied provider name, returns
 * `"unknown"` so callers fail-closed (per the enum contract — `unknown` is
 * non-retryable).
 *
 * This is the single entry point that kernel code SHOULD use; provider
 * plugins continue to expose their native classifier for tests / debugging.
 */
export function normalizeProviderError(
  error: unknown,
  provider: string,
): ProviderErrorCategory {
  const classifier = CLASSIFIER_REGISTRY.get(provider);
  if (!classifier) return "unknown";
  try {
    return classifier(error);
  } catch {
    // A classifier throwing on a malformed input is itself a kernel bug; we
    // fall back to `unknown` so the apply path still fails-closed cleanly.
    return "unknown";
  }
}
