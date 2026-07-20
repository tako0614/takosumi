import { afterEach, expect, test } from "bun:test";
import {
  D1AccountsStore,
  type D1Database,
  type D1ExecResult,
  type D1PreparedStatement,
  type D1Result,
  type D1Value,
} from "../../../../accounts/service/src/d1-store.ts";
import {
  __resetSessionHashSaltConfigForTesting,
  registerSessionHashSaltConfig,
} from "../../../../accounts/service/src/session-hash-salt.ts";
import { requireAccountsBearer } from "../../../../accounts/service/src/account-session.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

afterEach(() => {
  __resetSessionHashSaltConfigForTesting();
});

test("D1AccountsStore persists identity/session data without a Capsule mirror", async () => {
  registerSessionHashSaltConfig({ salt: "d1-test-session-salt" });
  const store = new D1AccountsStore(new MemoryD1Database());
  const now = Date.now();
  await store.saveAccount({
    subject: "tsub_d1",
    email: "d1@example.test",
    createdAt: now,
    updatedAt: now,
  });
  await store.saveAccountSession({
    sessionId: "sess_d1",
    subject: "tsub_d1",
    createdAt: now,
    expiresAt: now + 60_000,
  });

  expect((await store.findAccount("tsub_d1"))?.email).toBe("d1@example.test");
  expect((await store.findAccountSession("sess_d1"))?.subject).toBe("tsub_d1");
});

test("D1AccountsStore indexes Capsule OIDC registrations directly", async () => {
  const store = new D1AccountsStore(new MemoryD1Database());
  await store.saveOidcClient({
    clientId: "oidc_d1",
    capsuleId: "cap_d1",
    namespacePath: "identity.oidc",
    issuerUrl: "https://app.example.test",
    redirectUris: ["https://capsule.example.test/oauth/callback"],
    allowedScopes: ["openid"],
    subjectMode: "pairwise",
    tokenEndpointAuthMethod: "none",
    createdAt: 1,
    updatedAt: 1,
  });

  expect((await store.findOidcClientForCapsule("cap_d1"))?.clientId).toBe(
    "oidc_d1",
  );
});

test("D1AccountsStore resolves a session and its account in one exact bearer query", async () => {
  registerSessionHashSaltConfig({ salt: "d1-bearer-session-salt" });
  const db = new CountingD1Database();
  const store = new D1AccountsStore(db);
  const now = Date.now();
  const token = "opaque.session.without-prefix-authority";
  await store.initialize();
  await store.saveAccount({
    subject: "tsub_d1_bearer",
    createdAt: now,
    updatedAt: now,
  });
  await store.saveAccountSession({
    sessionId: token,
    subject: "tsub_d1_bearer",
    createdAt: now,
    expiresAt: now + 60_000,
  });

  db.resetPrepareCount();
  const result = await requireAccountsBearer({
    request: bearerRequest(token),
    store,
    scope: "read",
  });

  expect(result).toEqual({
    ok: true,
    auth: { subject: "tsub_d1_bearer", credential: "session" },
  });
  expect(db.prepareCount).toBe(1);
});

test("D1AccountsStore rejects a cross-store collision after one bounded query", async () => {
  registerSessionHashSaltConfig({ salt: "d1-bearer-collision-salt" });
  const db = new CountingD1Database();
  const store = new D1AccountsStore(db);
  const now = Date.now();
  const token = "opaque.colliding-secret";
  await store.initialize();
  await store.saveAccount({
    subject: "tsub_d1_collision_session",
    createdAt: now,
    updatedAt: now,
  });
  await store.saveAccountSession({
    sessionId: token,
    subject: "tsub_d1_collision_session",
    createdAt: now,
    expiresAt: now + 60_000,
  });
  await store.saveAccessToken(token, {
    clientId: "client_d1_collision",
    scope: "capsules:read",
    subject: "principal_d1_collision",
    takosumiSubject: "tsub_d1_collision_oauth",
    expiresAt: now + 60_000,
  });
  await store.savePersonalAccessToken(token, {
    tokenId: "pat_d1_collision",
    tokenPrefix: "display-only",
    subject: "tsub_d1_collision_pat",
    name: "collision PAT",
    scopes: ["read"],
    createdAt: now,
  });

  db.resetPrepareCount();
  const result = await requireAccountsBearer({
    request: bearerRequest(token),
    store,
    scope: "read",
  });

  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.response.status).toBe(401);
  expect(db.prepareCount).toBe(1);
});

class CountingD1Database implements D1Database {
  readonly #delegate = new SqliteFakeD1();
  prepareCount = 0;

  prepare(query: string): D1PreparedStatement {
    this.prepareCount += 1;
    return this.#delegate.prepare(query);
  }

  exec(query: string): Promise<D1ExecResult> {
    return this.#delegate.exec(query);
  }

  resetPrepareCount(): void {
    this.prepareCount = 0;
  }
}

function bearerRequest(token: string): Request {
  return new Request("https://accounts.example.test/v1/control", {
    headers: { authorization: `Bearer ${token}` },
  });
}

interface DocumentRow {
  readonly document: string;
}

interface IndexRow {
  readonly indexName: string;
  readonly indexKey: string;
  readonly bucket: string;
  readonly documentKey: string;
  readonly sortKey: number;
}

class MemoryD1Database implements D1Database {
  readonly documents = new Map<string, string>();
  readonly indexes = new Map<string, IndexRow>();
  execCount = 0;
  lastChanges = 0;

  prepare(query: string): D1PreparedStatement {
    return new MemoryD1Statement(this, query);
  }

  exec(_query: string): Promise<D1ExecResult> {
    this.execCount += 1;
    return Promise.resolve({ count: 1, duration: 0 });
  }
}

class MemoryD1Statement implements D1PreparedStatement {
  #values: readonly D1Value[] = [];

  constructor(
    private readonly db: MemoryD1Database,
    private readonly query: string,
  ) {}

  bind(...values: readonly D1Value[]): D1PreparedStatement {
    this.#values = values;
    return this;
  }

  run(): Promise<D1Result> {
    const query = normalizedQuery(this.query);
    const canonical = canonicalQuery(this.query);
    if (
      canonical.startsWith(
        "insert into takosumi_accounts_documents (bucket, key, document, updated_at) values (?, ?, ?, ?) on conflict",
      )
    ) {
      const [bucket, key] = this.#stringValues(2);
      const document = stringBindValue(this.#rawValues()[4]);
      this.db.documents.set(documentKey(bucket, key), document);
      this.db.lastChanges = 1;
      return Promise.resolve({ success: true, meta: { changes: 1 } });
    }
    if (
      canonical.startsWith(
        "insert into takosumi_accounts_indexes (index_name, index_key, bucket, document_key, sort_key) values (?, ?, ?, ?, ?) on conflict",
      )
    ) {
      const [indexName, indexKey, bucket, key] = this.#stringValues(4);
      const sortKey = numberValue(this.#values[4]);
      this.db.indexes.set(indexRowKey(indexName, indexKey, bucket, key), {
        indexName,
        indexKey,
        bucket,
        documentKey: key,
        sortKey,
      });
      this.db.lastChanges = 1;
      return Promise.resolve({ success: true, meta: { changes: 1 } });
    }
    if (
      canonical.startsWith(
        "delete from takosumi_accounts_indexes where (takosumi_accounts_indexes.bucket = ? and takosumi_accounts_indexes.document_key = ?)",
      )
    ) {
      const [bucket, key] = this.#stringValues(2);
      for (const [indexKey, row] of this.db.indexes) {
        if (row.bucket === bucket && row.documentKey === key) {
          this.db.indexes.delete(indexKey);
        }
      }
      this.db.lastChanges = 1;
      return Promise.resolve({ success: true, meta: { changes: 1 } });
    }
    if (
      canonical.startsWith(
        "delete from takosumi_accounts_indexes where (takosumi_accounts_indexes.index_name = ? and takosumi_accounts_indexes.index_key = ?)",
      )
    ) {
      const [indexName, indexKey] = this.#stringValues(2);
      for (const [rowKey, row] of this.db.indexes) {
        if (row.indexName === indexName && row.indexKey === indexKey) {
          this.db.indexes.delete(rowKey);
        }
      }
      this.db.lastChanges = 1;
      return Promise.resolve({ success: true, meta: { changes: 1 } });
    }
    if (
      canonical.startsWith(
        "delete from takosumi_accounts_documents where (takosumi_accounts_documents.bucket = ? and takosumi_accounts_documents.key = ?)",
      )
    ) {
      const [bucket, key] = this.#stringValues(2);
      this.db.lastChanges = this.db.documents.delete(documentKey(bucket, key))
        ? 1
        : 0;
      return Promise.resolve({
        success: true,
        meta: { changes: this.db.lastChanges },
      });
    }
    if (
      query.startsWith("INSERT OR REPLACE INTO takosumi_accounts_documents")
    ) {
      const [bucket, key, document] = this.#stringValues(3);
      this.db.documents.set(documentKey(bucket, key), document);
      this.db.lastChanges = 1;
      return Promise.resolve({ success: true, meta: { changes: 1 } });
    }
    if (query.startsWith("INSERT OR IGNORE INTO takosumi_accounts_documents")) {
      const [bucket, key, document] = this.#stringValues(3);
      const keyValue = documentKey(bucket, key);
      if (this.db.documents.has(keyValue)) {
        this.db.lastChanges = 0;
        return Promise.resolve({ success: true, meta: { changes: 0 } });
      }
      this.db.documents.set(keyValue, document);
      this.db.lastChanges = 1;
      return Promise.resolve({ success: true, meta: { changes: 1 } });
    }
    if (
      query.startsWith(
        "DELETE FROM takosumi_accounts_indexes WHERE bucket = ? AND document_key = ?",
      )
    ) {
      const [bucket, key] = this.#stringValues(2);
      for (const [indexKey, row] of this.db.indexes) {
        if (row.bucket === bucket && row.documentKey === key) {
          this.db.indexes.delete(indexKey);
        }
      }
      this.db.lastChanges = 1;
      return Promise.resolve({ success: true, meta: { changes: 1 } });
    }
    if (
      query.startsWith(
        "DELETE FROM takosumi_accounts_indexes WHERE index_name = ? AND index_key = ?",
      )
    ) {
      const [indexName, indexKey] = this.#stringValues(2);
      for (const [rowKey, row] of this.db.indexes) {
        if (row.indexName === indexName && row.indexKey === indexKey) {
          this.db.indexes.delete(rowKey);
        }
      }
      this.db.lastChanges = 1;
      return Promise.resolve({ success: true, meta: { changes: 1 } });
    }
    if (query.startsWith("INSERT OR REPLACE INTO takosumi_accounts_indexes")) {
      const [indexName, indexKey, bucket, key] = this.#stringValues(4);
      const sortKey = numberValue(this.#values[4]);
      this.db.indexes.set(indexRowKey(indexName, indexKey, bucket, key), {
        indexName,
        indexKey,
        bucket,
        documentKey: key,
        sortKey,
      });
      this.db.lastChanges = 1;
      return Promise.resolve({ success: true, meta: { changes: 1 } });
    }
    if (
      query.startsWith(
        "DELETE FROM takosumi_accounts_documents WHERE bucket = ? AND key = ?",
      )
    ) {
      const [bucket, key] = this.#stringValues(2);
      this.db.lastChanges = this.db.documents.delete(documentKey(bucket, key))
        ? 1
        : 0;
      return Promise.resolve({
        success: true,
        meta: { changes: this.db.lastChanges },
      });
    }
    if (
      query.startsWith(
        "UPDATE takosumi_accounts_documents SET document = ?, updated_at = ? WHERE bucket = ? AND key = ? AND document = ?",
      )
    ) {
      // CAS update: matches the SQLite UPDATE that the D1 store uses for
      // version-guarded account state. Replace the row only when the current
      // document equals the expected document. The
      // bind order is: nextDocument, updatedAt (number), bucket, key,
      // expectedDocument.
      const nextDocument = stringBindValue(this.#rawValues()[0]);
      const bucket = stringBindValue(this.#rawValues()[2]);
      const key = stringBindValue(this.#rawValues()[3]);
      const expectedDocument = stringBindValue(this.#rawValues()[4]);
      const storedKey = documentKey(bucket, key);
      const current = this.db.documents.get(storedKey);
      if (current === expectedDocument) {
        this.db.documents.set(storedKey, nextDocument);
        this.db.lastChanges = 1;
        return Promise.resolve({ success: true, meta: { changes: 1 } });
      }
      this.db.lastChanges = 0;
      return Promise.resolve({ success: true, meta: { changes: 0 } });
    }
    throw new Error(`unexpected D1 run query: ${this.query}`);
  }

  first<T = unknown>(_column?: string): Promise<T | null> {
    const query = normalizedQuery(this.query);
    if (
      query.startsWith(
        "SELECT document FROM takosumi_accounts_documents WHERE bucket = ? AND key = ?",
      )
    ) {
      const [bucket, key] = this.#stringValues(2);
      const document = this.db.documents.get(documentKey(bucket, key));
      return Promise.resolve(document ? ({ document } as T) : null);
    }
    if (
      query.startsWith(
        "DELETE FROM takosumi_accounts_documents WHERE bucket = ? AND key = ? RETURNING document",
      )
    ) {
      const [bucket, key] = this.#stringValues(2);
      const keyValue = documentKey(bucket, key);
      const document = this.db.documents.get(keyValue);
      this.db.lastChanges = this.db.documents.delete(keyValue) ? 1 : 0;
      return Promise.resolve(document ? ({ document } as T) : null);
    }
    if (query === "SELECT changes() AS changes") {
      return Promise.resolve({ changes: this.db.lastChanges } as T);
    }
    throw new Error(`unexpected D1 first query: ${this.query}`);
  }

  all<T = unknown>(): Promise<D1Result<T>> {
    const query = normalizedQuery(this.query);
    if (
      query.startsWith(
        "SELECT i.document_key, d.document FROM takosumi_accounts_indexes",
      )
    ) {
      const [indexName, indexKey] = this.#stringValues(2);
      const rows = [...this.db.indexes.values()]
        .filter(
          (row) => row.indexName === indexName && row.indexKey === indexKey,
        )
        .sort(
          (left, right) =>
            left.sortKey - right.sortKey ||
            left.documentKey.localeCompare(right.documentKey),
        )
        .flatMap((row): Array<{ document_key: string; document: string }> => {
          const document = this.db.documents.get(
            documentKey(row.bucket, row.documentKey),
          );
          return document ? [{ document_key: row.documentKey, document }] : [];
        });
      return Promise.resolve({ success: true, results: rows as T[] });
    }
    if (query.startsWith("SELECT d.document FROM takosumi_accounts_indexes")) {
      const [indexName, indexKey] = this.#stringValues(2);
      const rows = [...this.db.indexes.values()]
        .filter(
          (row) => row.indexName === indexName && row.indexKey === indexKey,
        )
        .sort(
          (left, right) =>
            left.sortKey - right.sortKey ||
            left.documentKey.localeCompare(right.documentKey),
        )
        .flatMap((row): DocumentRow[] => {
          const document = this.db.documents.get(
            documentKey(row.bucket, row.documentKey),
          );
          return document ? [{ document }] : [];
        });
      return Promise.resolve({ success: true, results: rows as T[] });
    }
    if (
      query.startsWith(
        "SELECT document FROM takosumi_accounts_documents WHERE bucket = ?",
      )
    ) {
      const [bucket] = this.#stringValues(1);
      const rows = [...this.db.documents.entries()]
        .filter(([key]) => key.startsWith(`${bucket}\n`))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([, document]) => ({ document }));
      return Promise.resolve({ success: true, results: rows as T[] });
    }
    throw new Error(`unexpected D1 all query: ${this.query}`);
  }

  raw(): Promise<unknown[][]> {
    const canonical = canonicalQuery(this.query);
    if (
      canonical.startsWith(
        "select document from takosumi_accounts_documents where (takosumi_accounts_documents.bucket = ? and takosumi_accounts_documents.key = ?)",
      )
    ) {
      const [bucket, key] = this.#stringValues(2);
      const document = this.db.documents.get(documentKey(bucket, key));
      return Promise.resolve(document ? [[document]] : []);
    }
    if (
      canonical.startsWith(
        "select takosumi_accounts_documents.document from takosumi_accounts_indexes inner join takosumi_accounts_documents",
      )
    ) {
      const [indexName, indexKey] = this.#stringValues(2);
      const rows = [...this.db.indexes.values()]
        .filter(
          (row) => row.indexName === indexName && row.indexKey === indexKey,
        )
        .sort(
          (left, right) =>
            left.sortKey - right.sortKey ||
            left.documentKey.localeCompare(right.documentKey),
        )
        .flatMap((row): unknown[][] => {
          const document = this.db.documents.get(
            documentKey(row.bucket, row.documentKey),
          );
          return document ? [[document]] : [];
        });
      return Promise.resolve(rows);
    }
    if (
      canonical.startsWith(
        "select document from takosumi_accounts_documents where takosumi_accounts_documents.bucket = ? order by takosumi_accounts_documents.key",
      )
    ) {
      const [bucket] = this.#stringValues(1);
      const rows = [...this.db.documents.entries()]
        .filter(([key]) => key.startsWith(`${bucket}\n`))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([, document]) => [document]);
      return Promise.resolve(rows);
    }
    throw new Error(`unexpected D1 raw query: ${this.query}`);
  }

  #stringValues(count: number): string[] {
    return this.#values.slice(0, count).map((value) => {
      if (typeof value !== "string") {
        throw new TypeError(
          `expected string D1 bind value, got ${typeof value}`,
        );
      }
      return value;
    });
  }

  #rawValues(): readonly D1Value[] {
    return this.#values;
  }
}

function stringBindValue(value: D1Value): string {
  if (typeof value !== "string") {
    throw new TypeError(`expected string D1 bind value, got ${typeof value}`);
  }
  return value;
}

function documentKey(bucket: string, key: string): string {
  return `${bucket}\n${key}`;
}

function indexRowKey(
  indexName: string,
  indexKey: string,
  bucket: string,
  key: string,
): string {
  return [indexName, indexKey, bucket, key].join("\n");
}

function normalizedQuery(query: string): string {
  return query.replace(/\s+/g, " ").trim();
}

function canonicalQuery(query: string): string {
  return query.replace(/"/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

function numberValue(value: D1Value): number {
  if (typeof value !== "number") {
    throw new TypeError(`expected number D1 bind value, got ${typeof value}`);
  }
  return value;
}
