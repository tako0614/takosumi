/**
 * Operator-injected Redis-style cache surface for the self-hosted profile.
 *
 * The self-hosted plugin does not bring a Redis client of its own. Operators
 * inject a `SelfHostedRedisCacheClient` that maps onto whatever Redis-protocol
 * server they run (Redis, KeyDB, Dragonfly, Valkey, etc.). The adapter wraps
 * the injected client with the small set of operations Takos workloads
 * typically need from a cache: `get / set / del / increment / expire`. Heavier
 * pub/sub or stream usage is intentionally out of scope — workloads that need
 * those should bind to a queue resource instead.
 */
import { freezeClone } from "./common.ts";

export type SelfHostedRedisCacheValue = string | Uint8Array;

export interface SelfHostedRedisCacheClient {
  get(key: string): Promise<SelfHostedRedisCacheValue | undefined>;
  set(input: SelfHostedRedisCacheSetInput): Promise<void>;
  del(keys: readonly string[]): Promise<number>;
  expire(input: SelfHostedRedisCacheExpireInput): Promise<boolean>;
  increment?(input: SelfHostedRedisCacheIncrementInput): Promise<number>;
  ping?(): Promise<{ readonly ok: boolean; readonly latencyMs?: number }>;
}

export interface SelfHostedRedisCacheSetInput {
  readonly key: string;
  readonly value: SelfHostedRedisCacheValue;
  readonly ttlSeconds?: number;
  /** Set only if the key does not already exist (NX). */
  readonly ifAbsent?: boolean;
  /** Set only if the key already exists (XX). */
  readonly ifPresent?: boolean;
}

export interface SelfHostedRedisCacheExpireInput {
  readonly key: string;
  readonly ttlSeconds: number;
}

export interface SelfHostedRedisCacheIncrementInput {
  readonly key: string;
  readonly delta?: number;
  readonly ttlSeconds?: number;
}

export interface SelfHostedRedisCacheAdapterOptions {
  readonly client: SelfHostedRedisCacheClient;
  readonly defaultTtlSeconds?: number;
  readonly keyPrefix?: string;
  readonly clock?: () => Date;
}

/**
 * Workload-facing adapter. Workloads receive a typed `cache` binding when the
 * `provider.selfhosted.redis-cache@v1` descriptor is materialized. The adapter
 * applies the operator-configured key prefix and default TTL transparently so
 * tenant code never has to.
 */
export class SelfHostedRedisCacheAdapter {
  readonly #client: SelfHostedRedisCacheClient;
  readonly #defaultTtl?: number;
  readonly #prefix?: string;

  constructor(options: SelfHostedRedisCacheAdapterOptions) {
    this.#client = options.client;
    this.#defaultTtl = options.defaultTtlSeconds;
    this.#prefix = options.keyPrefix;
  }

  async get(key: string): Promise<SelfHostedRedisCacheValue | undefined> {
    const value = await this.#client.get(this.#prefixed(key));
    return value === undefined ? undefined : value;
  }

  async set(
    input: SelfHostedRedisCacheSetInput,
  ): Promise<void> {
    await this.#client.set({
      ...input,
      key: this.#prefixed(input.key),
      ttlSeconds: input.ttlSeconds ?? this.#defaultTtl,
    });
  }

  async delete(keys: readonly string[]): Promise<number> {
    if (keys.length === 0) return 0;
    return await this.#client.del(keys.map((key) => this.#prefixed(key)));
  }

  async expire(
    input: SelfHostedRedisCacheExpireInput,
  ): Promise<boolean> {
    return await this.#client.expire({
      key: this.#prefixed(input.key),
      ttlSeconds: input.ttlSeconds,
    });
  }

  async increment(
    input: SelfHostedRedisCacheIncrementInput,
  ): Promise<number | undefined> {
    if (!this.#client.increment) return undefined;
    return await this.#client.increment({
      ...input,
      key: this.#prefixed(input.key),
      ttlSeconds: input.ttlSeconds ?? this.#defaultTtl,
    });
  }

  async ping(): Promise<
    { readonly ok: boolean; readonly latencyMs?: number } | undefined
  > {
    if (!this.#client.ping) return undefined;
    const result = await this.#client.ping();
    return freezeClone(result);
  }

  #prefixed(key: string): string {
    if (!this.#prefix) return key;
    return `${this.#prefix}:${key}`;
  }
}
