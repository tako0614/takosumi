import { createHash } from "node:crypto";

import type {
  D1Database,
  D1PreparedStatement,
  D1Result,
} from "../../worker/src/bindings.ts";

export interface CloudflareControlD1RestDatabaseOptions {
  readonly accountId: string;
  readonly databaseId: string;
  readonly apiToken: string;
  readonly fetch?: typeof fetch;
  readonly importPollIntervalMilliseconds?: number;
  readonly importPollAttempts?: number;
  readonly wait?: (milliseconds: number) => Promise<void>;
}

type D1Query = {
  readonly sql: string;
  readonly params?: readonly (string | number | null)[];
};

type D1ApiEnvelope = {
  readonly success?: boolean;
  readonly result?: readonly D1Result[];
};

type D1ImportResult = {
  readonly at_bookmark?: string;
  readonly error?: string;
  readonly filename?: string;
  readonly status?: "complete" | "error";
  readonly success?: boolean;
  readonly upload_url?: string;
};

type D1ImportEnvelope = {
  readonly success?: boolean;
  readonly result?: D1ImportResult;
};

/** Operator-only D1 REST adapter. Response bodies are never exposed in errors. */
export class CloudflareControlD1RestDatabase implements D1Database {
  readonly #url: URL;
  readonly #importUrl: URL;
  readonly #apiToken: string;
  readonly #fetch: typeof fetch;
  readonly #importPollIntervalMilliseconds: number;
  readonly #importPollAttempts: number;
  readonly #wait: (milliseconds: number) => Promise<void>;

  constructor(options: CloudflareControlD1RestDatabaseOptions) {
    const accountId = opaqueSegment(options.accountId, "account_id_invalid");
    const databaseId = opaqueSegment(options.databaseId, "database_id_invalid");
    this.#apiToken = required(options.apiToken, "api_token_missing");
    this.#fetch = options.fetch ?? fetch;
    this.#url = new URL(
      `/client/v4/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}/query`,
      "https://api.cloudflare.com",
    );
    this.#importUrl = new URL(
      `/client/v4/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}/import`,
      "https://api.cloudflare.com",
    );
    this.#importPollIntervalMilliseconds = boundedInteger(
      options.importPollIntervalMilliseconds ?? 1_000,
      0,
      60_000,
      "import_poll_interval_invalid",
    );
    this.#importPollAttempts = boundedInteger(
      options.importPollAttempts ?? 300,
      1,
      3_600,
      "import_poll_attempts_invalid",
    );
    this.#wait = options.wait ?? wait;
  }

  prepare(query: string): D1PreparedStatement {
    return new CloudflareControlD1RestStatement(this, query);
  }

  async batch<T = unknown>(
    statements: readonly D1PreparedStatement[],
  ): Promise<readonly D1Result<T>[]> {
    const queries = statements.map((statement) => {
      if (
        !(statement instanceof CloudflareControlD1RestStatement) ||
        statement.database !== this
      ) {
        throw new ControlD1RestError("batch_statement_invalid");
      }
      return statement.query;
    });
    if (queries.some((query) => requiresSqlFileImport(query.sql))) {
      await this.#importSql(renderSqlFile(queries));
      return statements.map(() => ({
        success: true,
      })) as readonly D1Result<T>[];
    }
    return (await this.#request({ batch: queries })) as readonly D1Result<T>[];
  }

  async run<T = unknown>(query: D1Query): Promise<D1Result<T>> {
    return ((await this.#request(query))[0] ?? {
      success: true,
      results: [],
    }) as D1Result<T>;
  }

  async #request(
    body: D1Query | { readonly batch: readonly D1Query[] },
  ): Promise<readonly D1Result[]> {
    let response: Response;
    try {
      response = await this.#fetch(this.#url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#apiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch {
      throw new ControlD1RestError("cloudflare_d1_request_failed");
    }

    let envelope: D1ApiEnvelope;
    try {
      envelope = (await response.json()) as D1ApiEnvelope;
    } catch {
      throw new ControlD1RestError("cloudflare_d1_response_invalid");
    }
    const results = envelope.result ?? [];
    if (
      !response.ok ||
      envelope.success !== true ||
      results.some((result) => result.success === false)
    ) {
      throw new ControlD1RestError("cloudflare_d1_query_failed");
    }
    return results;
  }

  async #importSql(sql: string): Promise<void> {
    const etag = createHash("md5").update(sql, "utf8").digest("hex");
    const initialized = await this.#requestImport({ action: "init", etag });
    if (importComplete(initialized)) return;
    if (initialized.status === "error" || initialized.error) {
      throw new ControlD1RestError("cloudflare_d1_import_failed");
    }
    if (initialized.at_bookmark && !initialized.upload_url) {
      await this.#pollImport(initialized.at_bookmark);
      return;
    }
    const filename = opaqueImportValue(
      initialized.filename,
      "cloudflare_d1_import_response_invalid",
    );
    if (initialized.upload_url) {
      await this.#uploadSql(initialized.upload_url, sql, etag);
    }
    const ingested = await this.#requestImport({
      action: "ingest",
      etag,
      filename,
    });
    if (importComplete(ingested)) return;
    if (ingested.status === "error" || ingested.error) {
      throw new ControlD1RestError("cloudflare_d1_import_failed");
    }
    await this.#pollImport(
      opaqueImportValue(
        ingested.at_bookmark,
        "cloudflare_d1_import_response_invalid",
      ),
    );
  }

  async #uploadSql(
    uploadUrl: string,
    sql: string,
    etag: string,
  ): Promise<void> {
    const url = trustedUploadUrl(uploadUrl);
    const bytes = new TextEncoder().encode(sql);
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: "PUT",
        headers: {
          "content-length": String(bytes.byteLength),
        },
        body: sql,
      });
    } catch {
      throw new ControlD1RestError("cloudflare_d1_import_upload_failed");
    }
    if (!response.ok || normalizedEtag(response.headers.get("etag")) !== etag) {
      throw new ControlD1RestError("cloudflare_d1_import_upload_failed");
    }
  }

  async #pollImport(bookmark: string): Promise<void> {
    for (let attempt = 0; attempt < this.#importPollAttempts; attempt += 1) {
      const result = await this.#requestImport({
        action: "poll",
        current_bookmark: bookmark,
      });
      if (importComplete(result)) return;
      if (result.status === "error" || result.error) {
        throw new ControlD1RestError("cloudflare_d1_import_failed");
      }
      if (attempt + 1 >= this.#importPollAttempts) break;
      await this.#wait(this.#importPollIntervalMilliseconds);
    }
    throw new ControlD1RestError("cloudflare_d1_import_timeout");
  }

  async #requestImport(
    body:
      | { readonly action: "init"; readonly etag: string }
      | {
          readonly action: "ingest";
          readonly etag: string;
          readonly filename: string;
        }
      | { readonly action: "poll"; readonly current_bookmark: string },
  ): Promise<D1ImportResult> {
    let response: Response;
    try {
      response = await this.#fetch(this.#importUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#apiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch {
      throw new ControlD1RestError("cloudflare_d1_import_request_failed");
    }
    let envelope: D1ImportEnvelope;
    try {
      envelope = (await response.json()) as D1ImportEnvelope;
    } catch {
      throw new ControlD1RestError("cloudflare_d1_import_response_invalid");
    }
    if (!response.ok || envelope.success !== true || !envelope.result) {
      throw new ControlD1RestError("cloudflare_d1_import_failed");
    }
    return envelope.result;
  }
}

class CloudflareControlD1RestStatement implements D1PreparedStatement {
  #values: readonly unknown[] = [];

  constructor(
    readonly database: CloudflareControlD1RestDatabase,
    readonly sql: string,
  ) {}

  get query(): D1Query {
    return {
      sql: this.sql,
      ...(this.#values.length > 0
        ? { params: this.#values.map(d1Parameter) }
        : {}),
    };
  }

  bind(...values: readonly unknown[]): D1PreparedStatement {
    this.#values = values;
    return this;
  }

  async first<T = unknown>(): Promise<T | null> {
    const result = await this.database.run<T>(this.query);
    return result.results?.[0] ?? null;
  }

  async all<T = unknown>(): Promise<D1Result<T>> {
    return await this.database.run<T>(this.query);
  }

  async run<T = unknown>(): Promise<D1Result<T>> {
    return await this.database.run<T>(this.query);
  }
}

export class ControlD1RestError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ControlD1RestError";
  }
}

function d1Parameter(value: unknown): string | number | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new ControlD1RestError("query_parameter_invalid");
}

function renderSqlFile(queries: readonly D1Query[]): string {
  if (queries.length === 0) {
    throw new ControlD1RestError("compound_sql_empty");
  }
  return `${queries
    .map(renderBoundSql)
    .map((statement) => (statement.endsWith(";") ? statement : `${statement};`))
    .join("\n")}\n`;
}

function renderBoundSql(query: D1Query): string {
  const parameters = query.params ?? [];
  let parameterIndex = 0;
  let output = "";
  for (let index = 0; index < query.sql.length; index += 1) {
    const character = query.sql[index]!;
    const next = query.sql[index + 1];
    if (character === "'" || character === '"' || character === "`") {
      const end = copyQuoted(query.sql, index, character);
      output += query.sql.slice(index, end);
      index = end - 1;
      continue;
    }
    if (character === "[") {
      const end = query.sql.indexOf("]", index + 1);
      if (end < 0) throw new ControlD1RestError("query_sql_invalid");
      output += query.sql.slice(index, end + 1);
      index = end;
      continue;
    }
    if (character === "-" && next === "-") {
      const end = query.sql.indexOf("\n", index + 2);
      const boundary = end < 0 ? query.sql.length : end + 1;
      output += query.sql.slice(index, boundary);
      index = boundary - 1;
      continue;
    }
    if (character === "/" && next === "*") {
      const end = query.sql.indexOf("*/", index + 2);
      if (end < 0) throw new ControlD1RestError("query_sql_invalid");
      output += query.sql.slice(index, end + 2);
      index = end + 1;
      continue;
    }
    if (character === "?") {
      if (/\d/u.test(next ?? "")) {
        throw new ControlD1RestError("query_parameter_syntax_invalid");
      }
      if (parameterIndex >= parameters.length) {
        throw new ControlD1RestError("query_parameter_mismatch");
      }
      output += sqliteLiteral(parameters[parameterIndex++]);
      continue;
    }
    output += character;
  }
  if (parameterIndex !== parameters.length) {
    throw new ControlD1RestError("query_parameter_mismatch");
  }
  return output.trim();
}

function copyQuoted(sql: string, start: number, quote: string): number {
  for (let index = start + 1; index < sql.length; index += 1) {
    if (sql[index] !== quote) continue;
    if (sql[index + 1] === quote) {
      index += 1;
      continue;
    }
    return index + 1;
  }
  throw new ControlD1RestError("query_sql_invalid");
}

function sqliteLiteral(value: string | number | null): string {
  if (value === null) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ControlD1RestError("query_parameter_invalid");
    }
    return Object.is(value, -0) ? "0" : String(value);
  }
  const bytes = new TextEncoder().encode(value);
  const hex = [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `CAST(X'${hex}' AS TEXT)`;
}

function requiresSqlFileImport(sql: string): boolean {
  const tokens = leadingSqlTokens(sql, 3);
  return (
    tokens[0] === "CREATE" &&
    (tokens[1] === "TRIGGER" ||
      (tokens[1] === "TEMP" && tokens[2] === "TRIGGER"))
  );
}

function leadingSqlTokens(sql: string, maximum: number): readonly string[] {
  const tokens: string[] = [];
  for (let index = 0; index < sql.length && tokens.length < maximum;) {
    const character = sql[index]!;
    const next = sql[index + 1];
    if (/\s/u.test(character)) {
      index += 1;
      continue;
    }
    if (character === "-" && next === "-") {
      const end = sql.indexOf("\n", index + 2);
      index = end < 0 ? sql.length : end + 1;
      continue;
    }
    if (character === "/" && next === "*") {
      const end = sql.indexOf("*/", index + 2);
      if (end < 0) return tokens;
      index = end + 2;
      continue;
    }
    const match = /^[A-Za-z_][A-Za-z0-9_]*/u.exec(sql.slice(index));
    if (!match) return tokens;
    tokens.push(match[0].toUpperCase());
    index += match[0].length;
  }
  return tokens;
}

function importComplete(result: D1ImportResult): boolean {
  return result.status === "complete" && result.success === true;
}

function trustedUploadUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ControlD1RestError("cloudflare_d1_import_response_invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    value.length > 8_192
  ) {
    throw new ControlD1RestError("cloudflare_d1_import_response_invalid");
  }
  return url;
}

function opaqueImportValue(value: string | undefined, code: string): string {
  if (!value || value.length > 1_024 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new ControlD1RestError(code);
  }
  return value;
}

function normalizedEtag(value: string | null): string | null {
  const normalized = value
    ?.trim()
    .replace(/^W\//u, "")
    .replace(/^"|"$/gu, "")
    .toLowerCase();
  return normalized && /^[0-9a-f]{32}$/u.test(normalized) ? normalized : null;
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  code: string,
): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new ControlD1RestError(code);
  }
  return value;
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function opaqueSegment(value: string, code: string): string {
  const normalized = required(value, code);
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(normalized)) {
    throw new ControlD1RestError(code);
  }
  return normalized;
}

function required(value: string, code: string): string {
  const normalized = value.trim();
  if (!normalized) throw new ControlD1RestError(code);
  return normalized;
}
