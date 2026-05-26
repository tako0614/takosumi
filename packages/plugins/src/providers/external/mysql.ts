/**
 * MySQL-flavoured client surface for the external profile.
 *
 * Mirrors `ExternalSqlClient` (postgres) but uses MySQL parameter style and
 * leaves transaction semantics to the operator-injected client. The plugin
 * does not ship a MySQL driver — operators inject a client wrapping mysql2,
 * MariaDB Connector, Aurora MySQL, etc. Keeps the binding layer thin so the
 * descriptor + connection string are the single source of truth.
 */
export type ExternalMysqlValue =
  | string
  | number
  | boolean
  | bigint
  | Uint8Array
  | Date
  | null;

export interface ExternalMysqlClient {
  query<TRow extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    parameters?:
      | readonly ExternalMysqlValue[]
      | Record<string, ExternalMysqlValue>,
  ): Promise<ExternalMysqlQueryResult<TRow>>;
  transaction?<TResult>(
    fn: (tx: ExternalMysqlClient) => Promise<TResult>,
  ): Promise<TResult>;
  ping?(): Promise<{ readonly ok: boolean; readonly latencyMs?: number }>;
  close?(): Promise<void>;
}

export interface ExternalMysqlQueryResult<
  TRow extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly rows: readonly TRow[];
  readonly affectedRows?: number;
  readonly insertId?: number | bigint;
}

export interface ExternalMysqlAdapterOptions {
  readonly client: ExternalMysqlClient;
  readonly clock?: () => Date;
}

/**
 * Workload-facing wrapper. Today this only re-exposes the injected client
 * after stamping connection metadata on each query for observability. It
 * exists so the resource binding closure can hand the workload one consistent
 * object whether the underlying driver is mysql2, mysql, or a pooled gateway.
 */
export class ExternalMysqlAdapter {
  readonly #client: ExternalMysqlClient;

  constructor(options: ExternalMysqlAdapterOptions) {
    this.#client = options.client;
  }

  query<TRow extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    parameters?:
      | readonly ExternalMysqlValue[]
      | Record<string, ExternalMysqlValue>,
  ): Promise<ExternalMysqlQueryResult<TRow>> {
    return this.#client.query<TRow>(sql, parameters);
  }

  transaction<TResult>(
    fn: (tx: ExternalMysqlClient) => Promise<TResult>,
  ): Promise<TResult> {
    if (!this.#client.transaction) {
      throw new Error("external MySQL client does not support transactions");
    }
    return this.#client.transaction(fn);
  }

  async ping(): Promise<
    { readonly ok: boolean; readonly latencyMs?: number } | undefined
  > {
    if (!this.#client.ping) return undefined;
    return await this.#client.ping();
  }

  async close(): Promise<void> {
    if (this.#client.close) await this.#client.close();
  }
}
