/**
 * Portable logical-content encoding shared by Takosumi's local SQLite and
 * remote D1 readers.
 *
 * Version 2 deliberately does not inherit v1 row digests. V1 delegated REAL
 * rendering to SQLite's printf implementation and made the internal `_cf_KV`
 * exclusion depend on whether an export happened to contain that table. V2
 * reads typed cell payloads, encodes REAL values as IEEE-754 binary64 in JS,
 * and always declares the Cloudflare-owned table as excluded.
 */

export const SQLITE_LOGICAL_CONTENT_DIGEST_KIND =
  "takosumi.sqlite-logical-content@v2" as const;
export const SQLITE_LOGICAL_CONTENT_DIGEST_ALGORITHM = "sha256" as const;
export const SQLITE_LOGICAL_CONTENT_MAX_PAGE_SIZE = 1_000;

export interface SqliteLogicalTableDigest {
  readonly table: string;
  readonly columns: readonly string[];
  readonly rowCount: number;
  readonly rowDigest: string;
  readonly contentDigest: string;
}

export interface SqliteLogicalDatabaseDigest {
  readonly kind: typeof SQLITE_LOGICAL_CONTENT_DIGEST_KIND;
  readonly algorithm: typeof SQLITE_LOGICAL_CONTENT_DIGEST_ALGORITHM;
  readonly databaseDigest: string;
  readonly tables: readonly SqliteLogicalTableDigest[];
  readonly excludedTables: readonly SqliteLogicalExcludedTable[];
}

export interface SqliteLogicalExcludedTable {
  readonly table: "_cf_KV";
  readonly reason: "cloudflare_internal";
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const INTEGER = /^-?(?:0|[1-9][0-9]*)$/u;
const HEX_BYTES = /^(?:[0-9A-F]{2})*$/u;
const SQLITE_INTEGER_MIN = -(1n << 63n);
const SQLITE_INTEGER_MAX = (1n << 63n) - 1n;

/** Return a fresh canonical exclusion inventory for every evidence object. */
export function sqliteLogicalContentExcludedTables(): readonly SqliteLogicalExcludedTable[] {
  return [{ table: "_cf_KV", reason: "cloudflare_internal" }];
}

export function isSqliteLogicalContentExcludedTable(table: string): boolean {
  return table === "_cf_KV";
}

/**
 * Recursively key-sort a JSON-domain value. This is the sole JSON
 * canonicalization for v2 table and database digest inputs.
 */
export function canonicalSqliteLogicalJson(value: unknown): string {
  return canonicalJsonValue(value, new Set<object>());
}

/**
 * Build the shared typed-row query. SQLite performs a deterministic sort and
 * may spill it to its temp store; callers either stream the result locally or
 * add bounded LIMIT/OFFSET pages for D1.
 */
export function sqliteLogicalRowsQuery(
  table: string,
  columns: readonly string[],
  paginated: boolean,
): string {
  assertIdentifier(table);
  if (
    columns.length === 0 ||
    new Set(columns).size !== columns.length ||
    columns.some((column) => !IDENTIFIER.test(column))
  ) {
    throw new SqliteLogicalContentContractError(
      "logical_table_columns_invalid",
    );
  }
  const projections: string[] = [];
  const ordering: string[] = [];
  columns.forEach((column, index) => {
    const identifier = quoteIdentifier(column);
    const typeAlias = quoteIdentifier(logicalTypeAlias(index));
    const valueAlias = quoteIdentifier(logicalValueAlias(index));
    projections.push(`typeof(${identifier}) as ${typeAlias}`);
    projections.push(
      `case typeof(${identifier}) ` +
        `when 'null' then null ` +
        `when 'integer' then cast(${identifier} as text) ` +
        `when 'real' then ${identifier} ` +
        `when 'text' then upper(hex(cast(${identifier} as blob))) ` +
        `when 'blob' then upper(hex(${identifier})) ` +
        `else null end as ${valueAlias}`,
    );
    // The type alias separates storage classes. Within a class, decimal/hex
    // text and binary64 numbers all have engine-independent SQLite ordering.
    ordering.push(typeAlias, valueAlias);
  });
  return (
    `select ${projections.join(", ")} ` +
    `from ${quoteIdentifier(table)} ` +
    `order by ${ordering.join(", ")}` +
    (paginated ? " limit ? offset ?" : "")
  );
}

/** Decode one typed query result into the exact row bytes hashed by v2. */
export function canonicalSqliteLogicalRow(
  row: Readonly<Record<string, unknown>>,
  columnCount: number,
): string {
  if (!Number.isSafeInteger(columnCount) || columnCount < 1) {
    throw new SqliteLogicalContentContractError(
      "logical_row_column_count_invalid",
    );
  }
  const cells: string[] = [];
  for (let index = 0; index < columnCount; index += 1) {
    const { encoded } = logicalCell(row, index);
    cells.push(`${encoded.length}:${encoded}`);
  }
  return cells.join("");
}

/** Compare two typed results in the exact order used by the shared query. */
export function compareSqliteLogicalRows(
  left: Readonly<Record<string, unknown>>,
  right: Readonly<Record<string, unknown>>,
  columnCount: number,
): number {
  if (!Number.isSafeInteger(columnCount) || columnCount < 1) {
    throw new SqliteLogicalContentContractError(
      "logical_row_column_count_invalid",
    );
  }
  for (let index = 0; index < columnCount; index += 1) {
    const leftCell = logicalCell(left, index);
    const rightCell = logicalCell(right, index);
    if (leftCell.storageClass < rightCell.storageClass) return -1;
    if (leftCell.storageClass > rightCell.storageClass) return 1;
    if (leftCell.orderValue < rightCell.orderValue) return -1;
    if (leftCell.orderValue > rightCell.orderValue) return 1;
  }
  return 0;
}

function canonicalJsonValue(value: unknown, parents: Set<object>): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new SqliteLogicalContentContractError(
        "logical_json_number_invalid",
      );
    }
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new SqliteLogicalContentContractError("logical_json_value_invalid");
  }
  if (parents.has(value)) {
    throw new SqliteLogicalContentContractError("logical_json_cycle_invalid");
  }
  parents.add(value);
  try {
    if (Array.isArray(value)) {
      const entries: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) {
          throw new SqliteLogicalContentContractError(
            "logical_json_array_invalid",
          );
        }
        entries.push(canonicalJsonValue(value[index], parents));
      }
      return `[${entries.join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new SqliteLogicalContentContractError(
        "logical_json_object_invalid",
      );
    }
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJsonValue(object[key], parents)}`,
      )
      .join(",")}}`;
  } finally {
    parents.delete(value);
  }
}

function canonicalInteger(value: string): boolean {
  if (!INTEGER.test(value)) return false;
  try {
    const parsed = BigInt(value);
    return (
      parsed >= SQLITE_INTEGER_MIN &&
      parsed <= SQLITE_INTEGER_MAX &&
      parsed.toString() === value
    );
  } catch {
    return false;
  }
}

function logicalCell(
  row: Readonly<Record<string, unknown>>,
  index: number,
): {
  readonly storageClass: string;
  readonly orderValue: string | number;
  readonly encoded: string;
} {
  const storageClass = row[logicalTypeAlias(index)];
  const value = row[logicalValueAlias(index)];
  switch (storageClass) {
    case "null":
      if (value !== null) return invalidCell(index);
      return { storageClass, orderValue: "", encoded: "N" };
    case "integer":
      if (typeof value !== "string" || !canonicalInteger(value)) {
        return invalidCell(index);
      }
      return { storageClass, orderValue: value, encoded: `I${value}` };
    case "real":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return invalidCell(index);
      }
      return { storageClass, orderValue: value, encoded: `R${binary64Hex(value)}` };
    case "text":
      if (typeof value !== "string" || !HEX_BYTES.test(value)) {
        return invalidCell(index);
      }
      return { storageClass, orderValue: value, encoded: `T${value}` };
    case "blob":
      if (typeof value !== "string" || !HEX_BYTES.test(value)) {
        return invalidCell(index);
      }
      return { storageClass, orderValue: value, encoded: `B${value}` };
    default:
      return invalidCell(index);
  }
}

function binary64Hex(value: number): string {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, value, false);
  return [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function logicalTypeAlias(index: number): string {
  return `__takosumi_logical_type_${index}`;
}

function logicalValueAlias(index: number): string {
  return `__takosumi_logical_value_${index}`;
}

function assertIdentifier(value: string): void {
  if (!IDENTIFIER.test(value)) {
    throw new SqliteLogicalContentContractError("logical_identifier_invalid");
  }
}

function quoteIdentifier(value: string): string {
  assertIdentifier(value);
  return `"${value}"`;
}

function invalidCell(index: number): never {
  throw new SqliteLogicalContentContractError(
    `logical_row_cell_invalid:${index}`,
  );
}

export class SqliteLogicalContentContractError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "SqliteLogicalContentContractError";
  }
}
