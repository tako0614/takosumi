import type { ExternalSqlClient } from "./sql.ts";
import type { ExternalObjectClient } from "./object_storage.ts";

/**
 * Operator-injected Postgres connection pool client. The plugin treats this as
 * a thin wrapper over the underlying driver (node-postgres / postgres-js / Deno
 * postgres) — the operator owns connection lifecycle, TLS, and pool sizing,
 * and exposes a `query` method that adheres to the `ExternalSqlClient`
 * contract.
 */
export interface ExternalPostgresPoolClient extends ExternalSqlClient {
  /** Optional close hook used by graceful shutdown. */
  close?(): Promise<void>;
  /** Optional health check used by readiness probes. */
  healthcheck?(): Promise<
    { readonly ok: boolean; readonly latencyMs?: number }
  >;
}

/**
 * Operator-injected S3-compatible client. Keeps API surface narrow so that
 * MinIO / Ceph / Cloudflare R2 / wasabi / actual AWS S3 can all satisfy it.
 */
export interface ExternalS3CompatClient extends ExternalObjectClient {
  /** Optional close hook used by graceful shutdown. */
  close?(): Promise<void>;
  /** Optional bucket bootstrap (idempotent). */
  ensureBucket?(input: {
    readonly bucket: string;
    readonly region?: string;
  }): Promise<void>;
}

/**
 * Aggregated operator-injected adapter bag for the external profile. The
 * profile composer reads this to wire base adapters in addition to client-ref
 * configuration.
 */
export interface ExternalInjectedClients {
  readonly postgres?: ExternalPostgresPoolClient;
  readonly objectStorage?: ExternalS3CompatClient;
}
