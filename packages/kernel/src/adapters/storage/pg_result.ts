/**
 * Wraps a raw `pg` Result-like object into the kernel's `SqlQueryResult`
 * shape with the right defaults for DDL / non-SELECT / RETURNING-with-no-rows
 * cases.
 *
 * Why this lives in its own file: the npm `pg` library returns
 * `result.rows === undefined` for DDL queries (`CREATE TABLE`,
 * `BEGIN`/`COMMIT`, etc.) and may report `result.rowCount === null` for
 * commands that don't apply to rows. Reading `.length` on `undefined` was
 * what blocked kernel migrations in pre-fix builds. Centralising the
 * defensive normalisation here so every pg-backed wrapper (the kernel
 * boot client, the standalone db-migrate scripts) shares one definition.
 */
import type { SqlQueryResult } from "./sql.ts";

export interface PgResultLike {
  readonly rows?: readonly unknown[];
  readonly rowCount?: number | null;
}

export function wrapPgResult<Row extends Record<string, unknown>>(
  result: PgResultLike,
): SqlQueryResult<Row> {
  const rows = (result.rows ?? []) as Row[];
  const rowCount = result.rowCount ?? rows.length;
  return { rows, rowCount };
}
