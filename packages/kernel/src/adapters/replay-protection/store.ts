/**
 * Replay protection adapter for signed internal RPC traffic.
 *
 * Phase 18.3 (M4) hardens the kernel's internal API against cross-process /
 * cross-pod replay. Process-local memory only protects a single PaaS process;
 * when the kernel runs as a multi-replica deploy (k8s pods,
 * Cloudflare Worker isolates, multiple Deno hosts behind a load balancer)
 * the same signed `request-id` could be replayed against a sibling process
 * that has not yet observed it.
 *
 * The adapter exposes two implementations:
 *
 * - {@link InMemoryReplayProtectionStore} provides local-only semantics.
 *   Suitable for unit tests, single-process dev hosts, and any
 *   surface that is guaranteed to terminate every signed request inside one
 *   process (e.g. a Worker isolate that fronts a single durable object).
 * - {@link SqlReplayProtectionStore} persists observed request-ids in the
 *   shared `internal_request_replay_log` table so multiple PaaS replicas
 *   reach a single source of truth before they accept a request.
 *
 * Both implementations share the same {@link ReplayProtectionStore} contract
 * so the kernel can pick the backend at the host edge without rewriting the
 * verification path.
 */

/**
 * Logical namespace recorded alongside a request-id. The verification path
 * in `internal_auth.ts` reuses the same store for inbound requests
 * (`internal-request`) and signed responses (`internal-response`); keeping
 * them in distinct namespaces prevents a request signature from masking a
 * later response signature with the same id.
 */
export type ReplayProtectionNamespace =
  | "internal-request"
  | "internal-response";

/**
 * Atomic insert input. Implementations MUST treat `(namespace, requestId)`
 * as the conflict key.
 */
export interface ReplayProtectionMarkInput {
  readonly namespace: ReplayProtectionNamespace;
  readonly requestId: string;
  /**
   * Wall-clock millisecond timestamp at which the request signature was
   * issued. Used by `cleanupExpired` to garbage-collect rows older than
   * the configured TTL.
   */
  readonly timestamp: number;
  /**
   * Wall-clock millisecond timestamp at which the entry expires. After this
   * point the record can be evicted by `cleanupExpired` and a fresh signed
   * request reusing the same id can be accepted again.
   */
  readonly expiresAt: number;
  /** Wall-clock millisecond timestamp captured at insert time. */
  readonly seenAt: number;
}

/**
 * Backend-agnostic contract for distributed replay protection.
 *
 * Production hosts (Worker / k8s pod fleets) inject a
 * {@link SqlReplayProtectionStore} so multiple processes share one
 * `internal_request_replay_log` row per signed request-id. Local /
 * unit-test hosts inject the in-memory implementation.
 */
export interface ReplayProtectionStore {
  /**
   * Atomic idempotent insert.
   *
   * Returns `true` if the request-id was first observed by this call
   * (request is fresh and may be processed). Returns `false` if a sibling
   * process already recorded the same id (request must be rejected as a
   * replay). Implementations MUST be safe under concurrent callers — the
   * SQL backend uses `INSERT ... ON CONFLICT DO NOTHING` and inspects the
   * affected row count.
   */
  markSeen(input: ReplayProtectionMarkInput): Promise<boolean>;

  /**
   * Removes rows whose `expiresAt` is `<=` `now`. Production hosts run
   * this on a background interval (Phase 18.3 cleanup job) to bound
   * `internal_request_replay_log` growth. Calling it multiple times in a
   * row is safe — the operation is idempotent.
   */
  cleanupExpired(now: number): Promise<void>;
}
