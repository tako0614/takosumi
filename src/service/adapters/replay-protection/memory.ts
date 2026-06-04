import type {
  ReplayProtectionMarkInput,
  ReplayProtectionStore,
} from "./store.ts";

/**
 * In-process replay protection backend. The worker terminates every signed
 * internal request inside one process, so this single-process store is the
 * default and only implementation.
 */
export class InMemoryReplayProtectionStore implements ReplayProtectionStore {
  readonly #seen = new Map<string, number>();

  async markSeen(input: ReplayProtectionMarkInput): Promise<boolean> {
    this.#evictExpired(input.seenAt);
    const key = composeKey(input.namespace, input.requestId);
    if (this.#seen.has(key)) return false;
    this.#seen.set(key, input.expiresAt);
    return true;
  }

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
