/**
 * Minimal D1/SQLite query port used by generic Core stores.
 *
 * Resource Shape stores used to own this structural type. Keeping the port in
 * storage prevents generic Interface/Offering readers from depending on a
 * retired hosting domain while leaving the applied D1 schema/migrations
 * untouched.
 */
export interface D1Like {
  prepare(query: string): D1LikePreparedStatement;
  batch?<T = unknown>(
    statements: readonly D1LikePreparedStatement[],
  ): Promise<
    readonly {
      readonly results?: readonly T[];
      readonly meta?: { readonly changes?: number };
    }[]
  >;
}

export interface D1LikePreparedStatement {
  bind(...values: readonly unknown[]): D1LikePreparedStatement;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{
    readonly results?: readonly T[];
    readonly meta?: { readonly rows_read?: number };
  }>;
  run<T = unknown>(): Promise<{
    readonly meta?: { readonly changes?: number };
  }>;
}
