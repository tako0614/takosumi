import type { Miniflare } from "miniflare";
import type {
  D1Database,
  D1PreparedStatement,
  D1Result,
} from "../../../worker/src/bindings.ts";

// Keep every D1 operation inside workerd. Miniflare's getD1Database() uses a
// synchronous message-port bridge that failed its response-id assertion in CI.
export const workerdD1Module = (path: string) => ({
  type: "ESModule" as const,
  path,
  contents: `
    export default {
      async fetch(request, env) {
        const command = await request.json();
        const statement = ({ sql, values }) => env.CONTROL.prepare(sql).bind(...values);
        try {
          let result;
          if (command.kind === "batch") {
            result = await env.CONTROL.batch(command.statements.map(statement));
          } else {
            const prepared = statement(command);
            result = command.kind === "raw"
              ? await prepared.raw(command.options)
              : await prepared[command.kind]();
          }
          return Response.json({ result });
        } catch (error) {
          return Response.json({ error: String(error) }, { status: 500 });
        }
      },
    };
  `,
});

interface StatementCommand {
  readonly sql: string;
  readonly values: readonly unknown[];
}

function transportValue(value: unknown): unknown {
  if (value === null) return null;
  // JSON would silently turn undefined and non-finite numbers into null.
  // Reject them before crossing the fixture boundary, as native D1 does.
  if (value === undefined || typeof value === "bigint" ||
    (typeof value === "number" && !Number.isFinite(value))) {
    throw new TypeError("Unsupported D1 bind value");
  }
  if (value instanceof ArrayBuffer) return Array.from(new Uint8Array(value));
  if (ArrayBuffer.isView(value)) {
    return Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  }
  if (Array.isArray(value)) {
    const bytes = Array.from(value);
    if (!bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
      throw new TypeError("Unsupported D1 byte array");
    }
    return bytes;
  }
  if (typeof value === "object" || typeof value === "function" || typeof value === "symbol") {
    throw new TypeError("Unsupported D1 bind value");
  }
  return value;
}

export function workerdD1Database(runtime: Miniflare): D1Database {
  async function send<T>(command: object): Promise<T> {
    const response = await runtime.dispatchFetch("http://d1.test/", {
      method: "POST",
      body: JSON.stringify(command),
      headers: { "content-type": "application/json" },
    });
    const payload = await response.json() as { result?: T; error?: string };
    if (!response.ok) throw new Error(payload.error ?? `D1 fixture HTTP ${response.status}`);
    return payload.result as T;
  }

  class Statement implements D1PreparedStatement {
    constructor(readonly sql: string, readonly values: readonly unknown[] = []) {}

    bind(...values: readonly unknown[]): D1PreparedStatement {
      return new Statement(this.sql, values.map(transportValue));
    }

    first<T = unknown>(): Promise<T | null> {
      return send<T | null>({ kind: "first", sql: this.sql, values: this.values });
    }

    all<T = unknown>(): Promise<D1Result<T>> {
      return send<D1Result<T>>({ kind: "all", sql: this.sql, values: this.values });
    }

    run<T = unknown>(): Promise<D1Result<T>> {
      return send<D1Result<T>>({ kind: "run", sql: this.sql, values: this.values });
    }

    raw<T = unknown>(options?: { columnNames?: boolean }): Promise<T[][]> {
      return send<T[][]>({ kind: "raw", sql: this.sql, values: this.values, options });
    }
  }

  return {
    prepare: (sql) => new Statement(sql),
    batch<T = unknown>(statements: readonly D1PreparedStatement[]): Promise<readonly D1Result<T>[]> {
      const commands: StatementCommand[] = statements.map((statement) => {
        if (!(statement instanceof Statement)) {
          throw new TypeError("D1 fixture batch requires statements from the same database");
        }
        return { sql: statement.sql, values: statement.values };
      });
      return send<readonly D1Result<T>[]>({ kind: "batch", statements: commands });
    },
  };
}
