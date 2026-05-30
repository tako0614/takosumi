import type { SqlClient } from "../storage/sql.ts";
import type {
  ReplayProtectionMarkInput,
  ReplayProtectionStore,
} from "./store.ts";

/**
 * SQL-backed replay protection store.
 *
 * Used by production deploys where multiple PaaS replicas (k8s pods,
 * Cloudflare Worker isolates, Deno hosts behind a load balancer) terminate
 * signed internal RPC traffic. Each verifier inserts the observed
 * `(namespace, request_id)` pair into the shared
 * `internal_request_replay_log` table; the conflict on the composite
 * primary key is what guarantees only one replica wins the race.
 *
 * The SQL contract assumed here is the kernel storage `SqlClient`, so any
 * backend that can speak Postgres (or a Postgres-compatible dialect such as
 * Cloudflare D1 via the existing driver shim) can host the table without
 * bespoke wiring.
 */
export class SqlReplayProtectionStore implements ReplayProtectionStore {
  readonly #client: SqlClient;
  readonly #tableName: string;

  constructor(input: {
    readonly client: SqlClient;
    /** Defaults to `internal_request_replay_log`. */
    readonly tableName?: string;
  }) {
    this.#client = input.client;
    this.#tableName = input.tableName ?? "internal_request_replay_log";
  }

  async markSeen(input: ReplayProtectionMarkInput): Promise<boolean> {
    const sql = `insert into ${this.#tableName} ` +
      "(namespace, request_id, timestamp_ms, expires_at_ms, seen_at_ms) " +
      "values ($1, $2, $3, $4, $5) " +
      "on conflict (namespace, request_id) do nothing";
    const result = await this.#client.query(sql, [
      input.namespace,
      input.requestId,
      input.timestamp,
      input.expiresAt,
      input.seenAt,
    ]);
    // Postgres reports `rowCount = 1` when the insert wrote a new row and
    // `rowCount = 0` on conflict — the latter means a sibling process
    // already recorded this signature, so reject as replay.
    return result.rowCount > 0;
  }

  async cleanupExpired(now: number): Promise<void> {
    const sql = `delete from ${this.#tableName} where expires_at_ms <= $1`;
    await this.#client.query(sql, [now]);
  }
}
