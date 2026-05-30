import type {
  ReplayProtectionMarkInput,
  ReplayProtectionStore,
} from "./store.ts";

/**
 * Default in-memory backend for unit tests and local single-process hosts.
 * NOT safe for distributed deploys — pick {@link SqlReplayProtectionStore}
 * for any host that runs multiple PaaS replicas.
 */
export class InMemoryReplayProtectionStore implements ReplayProtectionStore {
  readonly #seen = new Map<string, number>();

  // deno-lint-ignore require-await
  async markSeen(input: ReplayProtectionMarkInput): Promise<boolean> {
    this.#evictExpired(input.seenAt);
    const key = composeKey(input.namespace, input.requestId);
    if (this.#seen.has(key)) return false;
    this.#seen.set(key, input.expiresAt);
    return true;
  }

  // deno-lint-ignore require-await
  async cleanupExpired(now: number): Promise<void> {
    this.#evictExpired(now);
  }

  #evictExpired(now: number): void {
    for (const [key, expiresAt] of this.#seen) {
      if (expiresAt <= now) this.#seen.delete(key);
    }
  }
}

function composeKey(namespace: string, requestId: string): string {
  return `${namespace}:${requestId}`;
}
