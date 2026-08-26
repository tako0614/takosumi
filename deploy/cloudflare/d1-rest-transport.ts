import type {
  D1Database,
  D1PreparedStatement,
  D1Result,
} from "../../worker/src/bindings.ts";

export interface CloudflareD1RestTransportOptions {
  readonly accountId: string;
  readonly databaseId: string;
  readonly apiToken: string;
  readonly fetch?: typeof fetch;
  readonly errorFactory?: (code: string) => Error;
}

export interface D1RestQuery {
  readonly sql: string;
  readonly params?: readonly (string | number | null)[];
}

interface D1BookmarkApiEnvelope {
  readonly success?: boolean;
  readonly result?: { readonly bookmark?: unknown };
}

export class D1RestTransportError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "D1RestTransportError";
  }
}

/** Generic Cloudflare D1 REST query/batch transport. It owns no schema policy. */
export class CloudflareD1RestTransport implements D1Database {
  readonly #url: URL;
  readonly #bookmarkUrl: URL;
  readonly #apiToken: string;
  readonly #fetch: typeof fetch;
  readonly #errorFactory: (code: string) => Error;

  constructor(options: CloudflareD1RestTransportOptions) {
    const accountId = opaqueSegment(options.accountId, "account_id_invalid");
    const databaseId = opaqueSegment(options.databaseId, "database_id_invalid");
    this.#apiToken = required(options.apiToken, "api_token_missing");
    this.#fetch = options.fetch ?? fetch;
    this.#errorFactory =
      options.errorFactory ?? ((code) => new D1RestTransportError(code));
    this.#url = new URL(
      `/client/v4/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}/query`,
      "https://api.cloudflare.com",
    );
    this.#bookmarkUrl = new URL(
      `/client/v4/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}/time_travel/bookmark`,
      "https://api.cloudflare.com",
    );
  }

  prepare(query: string): D1PreparedStatement {
    return new CloudflareD1RestStatement(this, query, (code) =>
      this.fail(code),
    );
  }

  async batch<T = unknown>(
    statements: readonly D1PreparedStatement[],
  ): Promise<readonly D1Result<T>[]> {
    return (await this.request({
      batch: this.restQueries(statements),
    })) as readonly D1Result<T>[];
  }

  async run<T = unknown>(query: D1RestQuery): Promise<D1Result<T>> {
    return (await this.request(query))[0] as D1Result<T>;
  }

  /** Read the current Time Travel bookmark. This method never restores D1. */
  async readTimeTravelBookmark(): Promise<string> {
    let response: Response;
    try {
      response = await this.#fetch(this.#bookmarkUrl, {
        method: "GET",
        headers: { authorization: `Bearer ${this.#apiToken}` },
      });
    } catch {
      this.fail("cloudflare_d1_bookmark_request_failed");
    }

    let envelope: D1BookmarkApiEnvelope;
    try {
      envelope = (await response.json()) as D1BookmarkApiEnvelope;
    } catch {
      this.fail("cloudflare_d1_bookmark_response_invalid");
    }
    const bookmark = envelope.result?.bookmark;
    if (
      !response.ok ||
      envelope.success !== true ||
      typeof bookmark !== "string" ||
      bookmark.length === 0 ||
      bookmark.length > 4_096 ||
      /[\r\n]/u.test(bookmark)
    ) {
      this.fail("cloudflare_d1_bookmark_failed");
    }
    return bookmark;
  }

  protected restQueries(
    statements: readonly D1PreparedStatement[],
  ): readonly D1RestQuery[] {
    return statements.map((statement) => {
      if (
        !(statement instanceof CloudflareD1RestStatement) ||
        statement.database !== this
      ) {
        this.fail("batch_statement_invalid");
      }
      return statement.query;
    });
  }

  protected async request(
    body: D1RestQuery | { readonly batch: readonly D1RestQuery[] },
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
      this.fail("cloudflare_d1_request_failed");
    }

    let envelope: unknown;
    try {
      envelope = await response.json();
    } catch {
      this.fail("cloudflare_d1_response_invalid");
    }
    if (!response.ok || !isRecord(envelope) || envelope.success !== true) {
      this.fail("cloudflare_d1_query_failed");
    }
    const results = envelope.result;
    const expectedResultCount = "batch" in body ? body.batch.length : 1;
    if (
      !Array.isArray(results) ||
      results.length === 0 ||
      results.length !== expectedResultCount ||
      results.some(
        (result) =>
          !isRecord(result) ||
          result.success !== true ||
          !Array.isArray(result.results),
      )
    ) {
      this.fail("cloudflare_d1_response_invalid");
    }
    return results as unknown as readonly D1Result[];
  }

  protected fail(code: string): never {
    throw this.#errorFactory(code);
  }
}

class CloudflareD1RestStatement implements D1PreparedStatement {
  #values: readonly unknown[] = [];

  constructor(
    readonly database: CloudflareD1RestTransport,
    readonly sql: string,
    readonly reject: (code: string) => never,
  ) {}

  get query(): D1RestQuery {
    return {
      sql: this.sql,
      ...(this.#values.length > 0
        ? { params: this.#values.map((value) => d1Parameter(value, this.reject)) }
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

function d1Parameter(
  value: unknown,
  reject: (code: string) => never,
): string | number | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return reject("query_parameter_invalid");
}

function opaqueSegment(value: string, code: string): string {
  const normalized = required(value, code);
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(normalized)) {
    throw new D1RestTransportError(code);
  }
  return normalized;
}

function required(value: string, code: string): string {
  const normalized = value.trim();
  if (!normalized) throw new D1RestTransportError(code);
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
