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
}

type D1Query = {
  readonly sql: string;
  readonly params?: readonly (string | number | null)[];
};

type D1ApiEnvelope = {
  readonly success?: boolean;
  readonly result?: readonly D1Result[];
};

/** Operator-only D1 REST adapter. Response bodies are never exposed in errors. */
export class CloudflareControlD1RestDatabase implements D1Database {
  readonly #url: URL;
  readonly #apiToken: string;
  readonly #fetch: typeof fetch;

  constructor(options: CloudflareControlD1RestDatabaseOptions) {
    const accountId = opaqueSegment(options.accountId, "account_id_invalid");
    const databaseId = opaqueSegment(options.databaseId, "database_id_invalid");
    this.#apiToken = required(options.apiToken, "api_token_missing");
    this.#fetch = options.fetch ?? fetch;
    this.#url = new URL(
      `/client/v4/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}/query`,
      "https://api.cloudflare.com",
    );
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
  if (typeof value === "string" || typeof value === "number") return value;
  throw new ControlD1RestError("query_parameter_invalid");
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
