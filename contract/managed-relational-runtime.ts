import {
  TAKOSUMI_MANAGED_RUNTIME_INVOKE_PERMISSION,
  managedRuntimeConnection,
  managedRuntimeGatewayRequest,
  type ManagedRuntimeConnectionAuthority,
  type ManagedRuntimeConnectionMaterialization,
} from "./managed-runtime-connections.ts";

export const TAKOSUMI_MANAGED_RELATIONAL_RUNTIME_CONTRACT =
  "takosumi.managed-relational-runtime/v1" as const;
export const TAKOSUMI_MANAGED_RELATIONAL_RUNTIME_PATH =
  "/relational/v1/batch" as const;

export const MANAGED_RELATIONAL_LIMITS = Object.freeze({
  maxStatements: 50,
  maxStatementBytes: 64 * 1024,
  maxSqlBytes: 256 * 1024,
  maxParametersPerStatement: 100,
  maxParametersTotal: 1_000,
  maxRequestBytes: 1024 * 1024,
  maxResults: 50,
  maxColumnsPerResult: 256,
  maxRowsPerResult: 5_000,
  maxCellsTotal: 200_000,
  maxStringBytes: 1024 * 1024,
});

export type ManagedRelationalParameter = string | number | null;
export type ManagedRelationalResultValue = string | number | null;
export type ManagedRelationalMethod = "run" | "all" | "get" | "values";

export interface ManagedRelationalStatement {
  readonly sql: string;
  readonly params: readonly ManagedRelationalParameter[];
  readonly method: ManagedRelationalMethod;
}

export interface ManagedRelationalBatchRequest {
  readonly contract: typeof TAKOSUMI_MANAGED_RELATIONAL_RUNTIME_CONTRACT;
  readonly authority: {
    readonly resourceGeneration: number;
    readonly interfaceId: string;
    readonly interfaceBindingId: string;
    readonly interfaceResolvedRevision: number;
  };
  readonly mode: "ordered_atomic";
  readonly statements: readonly ManagedRelationalStatement[];
}

export interface ManagedRelationalResultMeta {
  readonly changed_db: boolean;
  readonly changes: number;
  readonly duration: number;
  readonly last_row_id: number;
  readonly size_after: number;
  readonly rows_read: number;
  readonly rows_written: number;
}

export interface ManagedRelationalStatementResult {
  readonly success: true;
  readonly columns: readonly string[];
  readonly rows: readonly (readonly ManagedRelationalResultValue[])[];
  readonly meta: ManagedRelationalResultMeta;
}

export interface ManagedRelationalBatchResponse {
  readonly contract: typeof TAKOSUMI_MANAGED_RELATIONAL_RUNTIME_CONTRACT;
  readonly results: readonly ManagedRelationalStatementResult[];
}

export class ManagedRelationalRuntimeContractError extends TypeError {
  constructor(readonly code: string) {
    super(code);
    this.name = "ManagedRelationalRuntimeContractError";
  }
}

export function managedRelationalConnection(
  materialization: ManagedRuntimeConnectionMaterialization,
  alias: string,
) {
  return managedRuntimeConnection(materialization, alias, {
    expectedKind: "RelationalDatabase",
    requiredPermission: TAKOSUMI_MANAGED_RUNTIME_INVOKE_PERMISSION,
  });
}

export function managedRelationalBatchGatewayRequest(
  authority: ManagedRuntimeConnectionAuthority,
  input: {
    readonly statements: readonly ManagedRelationalStatement[];
    readonly idempotencyKey: string;
  },
): Request {
  if (authority.resourceKind !== "RelationalDatabase") {
    throw invalid("relational_authority_kind_invalid");
  }
  const body = parseManagedRelationalBatchRequest({
    contract: TAKOSUMI_MANAGED_RELATIONAL_RUNTIME_CONTRACT,
    authority: {
      resourceGeneration: authority.resourceGeneration,
      interfaceId: authority.interfaceId,
      interfaceBindingId: authority.interfaceBindingId,
      interfaceResolvedRevision: authority.interfaceResolvedRevision,
    },
    mode: "ordered_atomic",
    statements: input.statements,
  });
  return managedRuntimeGatewayRequest(authority, {
    method: "POST",
    suffix: TAKOSUMI_MANAGED_RELATIONAL_RUNTIME_PATH,
    idempotencyKey: input.idempotencyKey,
    body,
  });
}

export function parseManagedRelationalBatchRequest(
  value: unknown,
): ManagedRelationalBatchRequest {
  const input = record(value, "relational_request_invalid");
  onlyKeys(
    input,
    ["contract", "authority", "mode", "statements"],
    "relational_request_invalid",
  );
  if (
    input.contract !== TAKOSUMI_MANAGED_RELATIONAL_RUNTIME_CONTRACT ||
    input.mode !== "ordered_atomic"
  ) {
    throw invalid("relational_request_invalid");
  }
  const authority = record(
    input.authority,
    "relational_request_authority_invalid",
  );
  onlyKeys(
    authority,
    [
      "resourceGeneration",
      "interfaceId",
      "interfaceBindingId",
      "interfaceResolvedRevision",
    ],
    "relational_request_authority_invalid",
  );
  if (
    !Array.isArray(input.statements) ||
    input.statements.length < 1 ||
    input.statements.length > MANAGED_RELATIONAL_LIMITS.maxStatements
  ) {
    throw invalid("relational_statement_count_invalid");
  }
  let sqlBytes = 0;
  let parameterCount = 0;
  const statements = input.statements.map((value) => {
    const statement = parseStatement(value);
    sqlBytes += utf8Bytes(statement.sql);
    parameterCount += statement.params.length;
    return statement;
  });
  if (
    sqlBytes > MANAGED_RELATIONAL_LIMITS.maxSqlBytes ||
    parameterCount > MANAGED_RELATIONAL_LIMITS.maxParametersTotal
  ) {
    throw invalid("relational_request_too_large");
  }
  const result: ManagedRelationalBatchRequest = {
    contract: TAKOSUMI_MANAGED_RELATIONAL_RUNTIME_CONTRACT,
    authority: {
      resourceGeneration: positiveInteger(
        authority.resourceGeneration,
        "relational_request_authority_invalid",
      ),
      interfaceId: token(
        authority.interfaceId,
        "relational_request_authority_invalid",
      ),
      interfaceBindingId: token(
        authority.interfaceBindingId,
        "relational_request_authority_invalid",
      ),
      interfaceResolvedRevision: positiveInteger(
        authority.interfaceResolvedRevision,
        "relational_request_authority_invalid",
      ),
    },
    mode: "ordered_atomic",
    statements,
  };
  if (
    utf8Bytes(JSON.stringify(result)) >
    MANAGED_RELATIONAL_LIMITS.maxRequestBytes
  ) {
    throw invalid("relational_request_too_large");
  }
  return result;
}

export function parseManagedRelationalBatchResponse(
  value: unknown,
  expectedStatements?: number,
): ManagedRelationalBatchResponse {
  const input = record(value, "relational_response_invalid");
  onlyKeys(input, ["contract", "results"], "relational_response_invalid");
  if (
    input.contract !== TAKOSUMI_MANAGED_RELATIONAL_RUNTIME_CONTRACT ||
    !Array.isArray(input.results) ||
    input.results.length < 1 ||
    input.results.length > MANAGED_RELATIONAL_LIMITS.maxResults ||
    (expectedStatements !== undefined &&
      input.results.length !== expectedStatements)
  ) {
    throw invalid("relational_response_invalid");
  }
  let cellCount = 0;
  const results = input.results.map((value) => {
    const result = record(value, "relational_result_invalid");
    onlyKeys(
      result,
      ["success", "columns", "rows", "meta"],
      "relational_result_invalid",
    );
    if (
      result.success !== true ||
      !Array.isArray(result.columns) ||
      result.columns.length > MANAGED_RELATIONAL_LIMITS.maxColumnsPerResult ||
      !Array.isArray(result.rows) ||
      result.rows.length > MANAGED_RELATIONAL_LIMITS.maxRowsPerResult
    ) {
      throw invalid("relational_result_invalid");
    }
    const columns = result.columns.map((value) =>
      token(value, "relational_result_invalid", 256),
    );
    // Duplicate labels are valid for joins. D1's raw result shape preserves
    // column order specifically so consumers can distinguish those cells.
    const rows = result.rows.map((value) => {
      if (!Array.isArray(value) || value.length !== columns.length) {
        throw invalid("relational_result_invalid");
      }
      cellCount += value.length;
      if (cellCount > MANAGED_RELATIONAL_LIMITS.maxCellsTotal) {
        throw invalid("relational_response_too_large");
      }
      return value.map(resultValue);
    });
    return {
      success: true as const,
      columns,
      rows,
      meta: parseMeta(result.meta),
    };
  });
  return {
    contract: TAKOSUMI_MANAGED_RELATIONAL_RUNTIME_CONTRACT,
    results,
  };
}

function parseStatement(value: unknown): ManagedRelationalStatement {
  const input = record(value, "relational_statement_invalid");
  onlyKeys(input, ["sql", "params", "method"], "relational_statement_invalid");
  if (
    typeof input.sql !== "string" ||
    !input.sql.trim() ||
    input.sql.trim() !== input.sql ||
    utf8Bytes(input.sql) > MANAGED_RELATIONAL_LIMITS.maxStatementBytes ||
    !Array.isArray(input.params) ||
    input.params.length > MANAGED_RELATIONAL_LIMITS.maxParametersPerStatement ||
    (input.method !== "run" &&
      input.method !== "all" &&
      input.method !== "get" &&
      input.method !== "values")
  ) {
    throw invalid("relational_statement_invalid");
  }
  const analysis = analyzeSql(input.sql);
  if (!analysis.single || !analysis.runtimeStatement) {
    throw invalid(
      analysis.ddlOrControl
        ? "relational_ddl_requires_resource_migration"
        : "relational_statement_invalid",
    );
  }
  if (analysis.parameterCount !== input.params.length) {
    throw invalid("relational_parameter_count_invalid");
  }
  const params = input.params.map((value) => {
    if (value === null || typeof value === "string") {
      if (
        typeof value === "string" &&
        utf8Bytes(value) > MANAGED_RELATIONAL_LIMITS.maxStringBytes
      ) {
        throw invalid("relational_parameter_invalid");
      }
      return value;
    }
    if (typeof value === "number" && Number.isFinite(value)) return value;
    throw invalid("relational_parameter_invalid");
  });
  return { sql: input.sql, params, method: input.method };
}

function analyzeSql(sql: string): {
  readonly single: boolean;
  readonly runtimeStatement: boolean;
  readonly ddlOrControl: boolean;
  readonly parameterCount: number;
} {
  let state:
    | "plain"
    | "single"
    | "double"
    | "backtick"
    | "bracket"
    | "line-comment"
    | "block-comment" = "plain";
  let firstWord = "";
  let currentWord = "";
  let maximumParameter = 0;
  let statementEnded = false;
  let single = true;
  const finishWord = () => {
    if (!firstWord && currentWord) firstWord = currentWord.toUpperCase();
    currentWord = "";
  };
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index]!;
    const next = sql[index + 1];
    if (state === "line-comment") {
      if (char === "\n") state = "plain";
      continue;
    }
    if (state === "block-comment") {
      if (char === "*" && next === "/") {
        state = "plain";
        index += 1;
      }
      continue;
    }
    if (state === "single" || state === "double" || state === "backtick") {
      const delimiter =
        state === "single" ? "'" : state === "double" ? '"' : "`";
      if (char === delimiter) {
        if (next === delimiter) index += 1;
        else state = "plain";
      }
      continue;
    }
    if (state === "bracket") {
      if (char === "]") state = "plain";
      continue;
    }
    if (char === "-" && next === "-") {
      finishWord();
      state = "line-comment";
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      finishWord();
      state = "block-comment";
      index += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === "`" || char === "[") {
      finishWord();
      state =
        char === "'"
          ? "single"
          : char === '"'
            ? "double"
            : char === "`"
              ? "backtick"
              : "bracket";
      continue;
    }
    if (/[A-Za-z_]/u.test(char)) {
      if (statementEnded) single = false;
      currentWord += char;
      continue;
    }
    finishWord();
    if (char === ";") {
      if (statementEnded) single = false;
      statementEnded = true;
      continue;
    }
    if (statementEnded && !/\s/u.test(char)) single = false;
    if (char === "?" && !statementEnded) {
      let digits = "";
      while (/[0-9]/u.test(sql[index + 1] ?? "")) {
        digits += sql[index + 1];
        index += 1;
      }
      if (digits) {
        const numbered = Number(digits);
        if (
          !Number.isSafeInteger(numbered) ||
          numbered < 1 ||
          numbered > MANAGED_RELATIONAL_LIMITS.maxParametersPerStatement
        ) {
          single = false;
        } else {
          maximumParameter = Math.max(maximumParameter, numbered);
        }
      } else {
        maximumParameter += 1;
      }
    } else if (
      (char === ":" || char === "@" || char === "$") &&
      /[A-Za-z_]/u.test(next ?? "")
    ) {
      single = false;
    }
  }
  finishWord();
  if (state !== "plain" && state !== "line-comment") single = false;
  const runtimeStatement = [
    "SELECT",
    "INSERT",
    "UPDATE",
    "DELETE",
    "REPLACE",
    "WITH",
  ].includes(firstWord);
  const ddlOrControl = [
    "CREATE",
    "ALTER",
    "DROP",
    "PRAGMA",
    "VACUUM",
    "ATTACH",
    "DETACH",
    "REINDEX",
    "ANALYZE",
    "BEGIN",
    "COMMIT",
    "ROLLBACK",
    "SAVEPOINT",
    "RELEASE",
    "END",
  ].includes(firstWord);
  return {
    single,
    runtimeStatement,
    ddlOrControl,
    parameterCount: maximumParameter,
  };
}

function parseMeta(value: unknown): ManagedRelationalResultMeta {
  const input = record(value, "relational_result_meta_invalid");
  onlyKeys(
    input,
    [
      "changed_db",
      "changes",
      "duration",
      "last_row_id",
      "size_after",
      "rows_read",
      "rows_written",
    ],
    "relational_result_meta_invalid",
  );
  if (typeof input.changed_db !== "boolean") {
    throw invalid("relational_result_meta_invalid");
  }
  return {
    changed_db: input.changed_db,
    changes: nonNegativeNumber(input.changes),
    duration: nonNegativeNumber(input.duration),
    last_row_id: nonNegativeNumber(input.last_row_id),
    size_after: nonNegativeNumber(input.size_after),
    rows_read: nonNegativeNumber(input.rows_read),
    rows_written: nonNegativeNumber(input.rows_written),
  };
}

function resultValue(value: unknown): ManagedRelationalResultValue {
  if (value === null || typeof value === "string") {
    if (
      typeof value === "string" &&
      utf8Bytes(value) > MANAGED_RELATIONAL_LIMITS.maxStringBytes
    ) {
      throw invalid("relational_result_invalid");
    }
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw invalid("relational_result_invalid");
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid(code);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw invalid(code);
  return value as Record<string, unknown>;
}

function onlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  code: string,
): void {
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.includes(key))) throw invalid(code);
}

function token(value: unknown, code: string, maximum = 256): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.trim() !== value ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw invalid(code);
  }
  return value;
}

function positiveInteger(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw invalid(code);
  return Number(value);
}

function nonNegativeNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw invalid("relational_result_meta_invalid");
  }
  return value;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function invalid(code: string): ManagedRelationalRuntimeContractError {
  return new ManagedRelationalRuntimeContractError(code);
}
