/**
 * Replay protection adapter for signed internal RPC traffic.
 *
 * Hardens the service's internal request path (opentofu-runner / executor
 * container callbacks verified by `readInternalAuth`) against single-use
 * `request-id` replay. The in-process {@link InMemoryReplayProtectionStore}
 * is the default and only implementation; it is sufficient because the
 * worker terminates every signed request inside one process.
 */

/**
 * Logical namespace recorded alongside a request-id. The verification path in
 * `internal_auth.ts` records inbound requests under `internal-request`.
 */
export type ReplayProtectionNamespace = "internal-request";

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
 * Contract for the in-process replay protection store backing the signed
 * internal request path. The {@link InMemoryReplayProtectionStore} is the
 * default implementation injected at the host edge.
 */
export interface ReplayProtectionStore {
  /**
   * Atomic idempotent insert.
   *
   * Returns `true` if the request-id was first observed by this call
   * (request is fresh and may be processed). Returns `false` if the same id
   * was already recorded (request must be rejected as a replay).
   */
  markSeen(input: ReplayProtectionMarkInput): Promise<boolean>;

  /**
   * Removes entries whose `expiresAt` is `<=` `now`, bounding store growth.
   * Calling it multiple times in a row is safe — the operation is idempotent.
   */
  cleanupExpired(now: number): Promise<void>;
}
