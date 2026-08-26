import { createHash } from "node:crypto";

import type { D1PreparedStatement, D1Result } from "../../worker/src/bindings.ts";
import {
  CloudflareD1RestTransport,
  type CloudflareD1RestTransportOptions,
  type D1RestQuery,
} from "../cloudflare/d1-rest-transport.ts";

export interface CloudflareControlD1RestDatabaseOptions {
  readonly accountId: string;
  readonly databaseId: string;
  readonly apiToken: string;
  readonly fetch?: typeof fetch;
  readonly importPollIntervalMilliseconds?: number;
  readonly importPollAttempts?: number;
  readonly wait?: (milliseconds: number) => Promise<void>;
}

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

function controlTransportOptions(
  options: CloudflareControlD1RestDatabaseOptions,
): CloudflareD1RestTransportOptions {
  const accountId = opaqueSegment(options.accountId, "account_id_invalid");
  const databaseId = opaqueSegment(options.databaseId, "database_id_invalid");
  const apiToken = required(options.apiToken, "api_token_missing");
  return {
    accountId,
    databaseId,
    apiToken,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    errorFactory: (code) => new ControlD1RestError(code),
  };
}

/** Operator-only D1 REST adapter. Response bodies are never exposed in errors. */
export class CloudflareControlD1RestDatabase extends CloudflareD1RestTransport {
  readonly #importUrl: URL;
  readonly #apiToken: string;
  readonly #fetch: typeof fetch;
  readonly #importPollIntervalMilliseconds: number;
  readonly #importPollAttempts: number;
  readonly #wait: (milliseconds: number) => Promise<void>;

  constructor(options: CloudflareControlD1RestDatabaseOptions) {
    super(controlTransportOptions(options));
    const accountId = opaqueSegment(options.accountId, "account_id_invalid");
    const databaseId = opaqueSegment(options.databaseId, "database_id_invalid");
    this.#apiToken = required(options.apiToken, "api_token_missing");
    this.#fetch = options.fetch ?? fetch;
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

  async batch<T = unknown>(
    statements: readonly D1PreparedStatement[],
  ): Promise<readonly D1Result<T>[]> {
    const queries = this.restQueries(statements);
    if (queries.some((query) => requiresSqlFileImport(query.sql))) {
      await this.#importSql(renderSqlFile(queries));
      return statements.map(() => ({
        success: true,
      })) as readonly D1Result<T>[];
    }
    return await super.batch<T>(statements);
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
    let currentBookmark = opaqueImportValue(
      bookmark,
      "cloudflare_d1_import_response_invalid",
    );
    for (let attempt = 0; attempt < this.#importPollAttempts; attempt += 1) {
      const result = await this.#requestImport({
        action: "poll",
        current_bookmark: currentBookmark,
      });
      if (importComplete(result)) return;
      if (result.status === "error" || result.error) {
        throw new ControlD1RestError("cloudflare_d1_import_failed");
      }
      currentBookmark = opaqueImportValue(
        result.at_bookmark,
        "cloudflare_d1_import_response_invalid",
      );
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

export class ControlD1RestError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ControlD1RestError";
  }
}

function renderSqlFile(queries: readonly D1RestQuery[]): string {
  if (queries.length === 0) {
    throw new ControlD1RestError("compound_sql_empty");
  }
  return `${queries
    .map(renderBoundSql)
    .map((statement) => (statement.endsWith(";") ? statement : `${statement};`))
    .join("\n")}\n`;
}

function renderBoundSql(query: D1RestQuery): string {
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
    (tokens[0] === "CREATE" &&
      (tokens[1] === "TRIGGER" ||
        (tokens[1] === "TEMP" && tokens[2] === "TRIGGER"))) ||
    (tokens[0] === "DROP" && tokens[1] === "TRIGGER")
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
