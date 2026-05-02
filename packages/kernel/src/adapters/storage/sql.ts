export type SqlPrimitive = string | number | boolean | null;
export type SqlJson =
  | SqlPrimitive
  | { readonly [key: string]: SqlJson }
  | readonly SqlJson[];
export type SqlValue = SqlPrimitive | SqlJson | Date;
export type SqlParameters =
  | Readonly<Record<string, SqlValue | undefined>>
  | readonly (SqlValue | undefined)[];

export interface SqlQueryResult<
  Row extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly rows: readonly Row[];
  readonly rowCount: number;
}

export interface SqlClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    parameters?: SqlParameters,
  ): Promise<SqlQueryResult<Row>>;
  transaction?<T>(
    fn: (transaction: SqlTransaction) => T | Promise<T>,
  ): Promise<T>;
}

export interface SqlTransaction extends SqlClient {
  commit?(): Promise<void>;
  rollback?(): Promise<void>;
}
