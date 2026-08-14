import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";
import { TAKOSUMI_ACCOUNTS_PAT_SCOPES } from "@takosjp/takosumi-accounts-contract";
import { and, asc, eq } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import {
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import { hashSessionId } from "./session-hash-salt.ts";
// hashSecret is the canonical sha256:<base64url> hasher shared across the
// package (previously re-implemented locally). Aliased to keep call sites.
import { sha256Text as hashSecret } from "./encoding.ts";
import type {
  AccountSessionRecord,
  AccountsBearerCredentialCandidates,
  AccountsStore,
  AuthorizationCodeRecord,
  OidcClientRecord,
  PasskeyCredentialRecord,
  PersonalAccessTokenInventoryPage,
  PersonalAccessTokenInventoryPageInput,
  PersonalAccessTokenRecord,
  PrivacyRequestRecord,
  TakosumiAccountRecord,
  TokenRecord,
  UpstreamIdentityRecord,
} from "./store.ts";
import { assertPersonalAccessTokenInventoryPageInput } from "./store.ts";
import {
  emptyRefreshChainPruneResult,
  isRefreshChainRetentionPhase,
  MAX_REFRESH_CHAIN_RETENTION_ROWS,
  nextRefreshChainRetentionPhase,
  type RefreshChainRetentionPageInput,
  type RefreshChainRetentionPageResult,
  type RefreshChainRetentionPhase,
} from "./refresh-chain-retention.ts";

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(
    statements: readonly D1PreparedStatement[],
  ): Promise<readonly D1Result<T>[]>;
  exec(query: string): Promise<D1ExecResult>;
}

export interface D1PreparedStatement {
  bind(...values: readonly D1Value[]): D1PreparedStatement;
  run(): Promise<D1Result>;
  first<T = unknown>(column?: string): Promise<T | null>;
  all<T = unknown>(): Promise<D1Result<T>>;
  raw?(): Promise<unknown[][]>;
}

export interface D1Result<T = unknown> {
  success: boolean;
  results?: T[];
  meta?: Record<string, unknown>;
  error?: string;
}

export interface D1ExecResult {
  count: number;
  duration: number;
}

export type D1Value = string | number | null | ArrayBuffer | Uint8Array;

export type D1AccountsSchemaMode = "bootstrap" | "predeployed";

export interface D1AccountsStoreOptions {
  /**
   * `bootstrap` retains the self-host/local first-use schema bootstrap.
   * `predeployed` is the hosted request path: migrations are an operator
   * responsibility and this store must never issue DDL.
   */
  readonly schemaMode?: D1AccountsSchemaMode;
}

/** Canonical physical table names shared with narrow in-process D1 readers. */
export const d1AccountsTableNames = {
  documents: "takosumi_accounts_documents",
  indexes: "takosumi_accounts_indexes",
} as const;

export function resolveD1AccountsSchemaMode(
  value: unknown,
): D1AccountsSchemaMode {
  if (value === undefined || value === "bootstrap") return "bootstrap";
  if (value === "predeployed") return value;
  throw new TypeError(
    "TAKOSUMI_ACCOUNTS_D1_SCHEMA_MODE must be bootstrap or predeployed",
  );
}

// D1's `db.exec()` treats each line as a separate statement, so every
// statement must fit on one line — both for real Cloudflare D1 and for
// miniflare's emulation. Keep these single-line and terminated with `;`.
export const D1_ACCOUNTS_STORE_INIT_SQL: string = [
  `CREATE TABLE IF NOT EXISTS ${d1AccountsTableNames.documents} (bucket TEXT NOT NULL, key TEXT NOT NULL, document TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (bucket, key));`,
  `CREATE TABLE IF NOT EXISTS ${d1AccountsTableNames.indexes} (index_name TEXT NOT NULL, index_key TEXT NOT NULL, bucket TEXT NOT NULL, document_key TEXT NOT NULL, sort_key INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (index_name, index_key, bucket, document_key));`,
  `CREATE INDEX IF NOT EXISTS takosumi_accounts_indexes_lookup ON ${d1AccountsTableNames.indexes} (index_name, index_key, sort_key);`,
  `CREATE INDEX IF NOT EXISTS takosumi_accounts_indexes_document ON ${d1AccountsTableNames.indexes} (bucket, document_key);`,
].join("\n");

interface D1IndexEntry {
  readonly name: string;
  readonly key: string;
  readonly sortKey?: number;
}

const d1AccountsDocuments = sqliteTable(
  d1AccountsTableNames.documents,
  {
    bucket: text("bucket").notNull(),
    key: text("key").notNull(),
    document: text("document").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.bucket, table.key] })],
);

const d1AccountsIndexes = sqliteTable(
  d1AccountsTableNames.indexes,
  {
    indexName: text("index_name").notNull(),
    indexKey: text("index_key").notNull(),
    bucket: text("bucket").notNull(),
    documentKey: text("document_key").notNull(),
    sortKey: integer("sort_key").notNull().default(0),
  },
  (table) => [
    primaryKey({
      columns: [
        table.indexName,
        table.indexKey,
        table.bucket,
        table.documentKey,
      ],
    }),
  ],
);

const d1AccountsSchema = {
  d1AccountsDocuments,
  d1AccountsIndexes,
};

type D1AccountsDrizzleDatabase = DrizzleD1Database<typeof d1AccountsSchema>;

interface D1DocumentRow {
  readonly document: string;
}

interface D1AccountsBearerCandidateRow extends D1DocumentRow {
  readonly kind: "session" | "session_account" | "access_token" | "pat";
}

const RESOLVE_ACCOUNTS_BEARER_CANDIDATES_SQL = `with
  presented_session as (
    select document from takosumi_accounts_documents
    where bucket = 'account_sessions' and key = ? limit 1
  ),
  presented_access_token as (
    select document from takosumi_accounts_documents
    where bucket = 'access_tokens' and key = ? limit 1
  ),
  presented_pat_secret as (
    select document from takosumi_accounts_documents
    where bucket = 'personal_access_token_secrets' and key = ? limit 1
  )
select 'session' as kind, document from presented_session
union all
select 'session_account' as kind, account.document
from presented_session
join takosumi_accounts_documents as account
  on account.bucket = 'accounts'
 and account.key = json_extract(presented_session.document, '$.subject')
union all
select 'access_token' as kind, document from presented_access_token
union all
select 'pat' as kind, pat.document
from presented_pat_secret
join takosumi_accounts_documents as pat
  on pat.bucket = 'personal_access_tokens'
 and pat.key = json_extract(presented_pat_secret.document, '$.tokenId')`;

const PERSONAL_ACCESS_TOKEN_INVENTORY_PAGE_SQL = `with
  subject_tokens as (
    select idx.sort_key as created_at,
           idx.document_key as token_id,
           doc.document as document
      from ${d1AccountsTableNames.indexes} as idx
      join ${d1AccountsTableNames.documents} as doc
        on doc.bucket = 'personal_access_tokens'
       and doc.key = idx.document_key
     where idx.index_name = 'personal_access_tokens_by_subject'
       and idx.index_key = ?
       and idx.bucket = 'personal_access_tokens'
  ),
  cursor_state as (
    select case when ? = 0 then 0 else (
      select count(*) from subject_tokens
       where created_at = ? and token_id = ?
    ) end as anchor_count
  ),
  page as (
    select created_at, token_id, document
      from subject_tokens
     where ? = 0
        or created_at > ?
        or (created_at = ? and token_id > ?)
     order by created_at asc, token_id asc
     limit ?
  )
select 0 as row_kind,
       (select count(*) from subject_tokens) as total,
       cursor_state.anchor_count as anchor_count,
       cast(null as integer) as created_at,
       cast(null as text) as token_id,
       cast(null as text) as document
  from cursor_state
union all
select 1 as row_kind,
       cast(null as integer) as total,
       cast(null as integer) as anchor_count,
       page.created_at,
       page.token_id,
       page.document
  from page
order by row_kind asc, created_at asc, token_id asc`;

interface D1PersonalAccessTokenInventoryRow {
  readonly row_kind: unknown;
  readonly total: unknown;
  readonly anchor_count: unknown;
  readonly created_at: unknown;
  readonly token_id: unknown;
  readonly document: unknown;
}

function personalAccessTokenInventoryRecordFromD1Row(
  row: D1PersonalAccessTokenInventoryRow,
  subject: TakosumiSubject,
): PersonalAccessTokenRecord {
  if (
    row.row_kind !== 1 ||
    !Number.isSafeInteger(row.created_at) ||
    (row.created_at as number) < 0 ||
    typeof row.token_id !== "string" ||
    row.token_id.length === 0 ||
    typeof row.document !== "string"
  ) {
    throw new Error("D1 PAT inventory row is malformed");
  }
  let record: unknown;
  try {
    record = JSON.parse(row.document);
  } catch {
    throw new Error("D1 PAT inventory document is malformed");
  }
  if (
    !isUnknownRecord(record) ||
    record.tokenId !== row.token_id ||
    record.subject !== subject ||
    record.createdAt !== row.created_at ||
    typeof record.tokenPrefix !== "string" ||
    typeof record.name !== "string" ||
    !Array.isArray(record.scopes) ||
    record.scopes.length === 0 ||
    new Set(record.scopes).size !== record.scopes.length ||
    !record.scopes.every(
      (scope) =>
        typeof scope === "string" &&
        (TAKOSUMI_ACCOUNTS_PAT_SCOPES as readonly string[]).includes(scope),
    ) ||
    !optionalStringIsValid(record.workspaceId) ||
    !optionalTimestampIsValid(record.expiresAt) ||
    !optionalTimestampIsValid(record.revokedAt) ||
    !optionalTimestampIsValid(record.lastUsedAt)
  ) {
    throw new Error("D1 PAT inventory document is malformed");
  }
  return record as unknown as PersonalAccessTokenRecord;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalStringIsValid(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && value.length > 0);
}

function optionalTimestampIsValid(value: unknown): boolean {
  return (
    value === undefined ||
    (Number.isSafeInteger(value) && (value as number) >= 0)
  );
}

function duplicateBearerCandidate(
  kind: D1AccountsBearerCandidateRow["kind"],
): Error {
  return new Error(
    `D1 Accounts bearer candidate lookup returned duplicate ${kind}`,
  );
}

class D1AccountsDocumentIndexStore {
  readonly #binding: D1Database;
  readonly #db: D1AccountsDrizzleDatabase;

  constructor(binding: D1Database) {
    this.#binding = binding;
    this.#db = drizzle(binding as never, { schema: d1AccountsSchema });
  }

  async put<T>(
    bucket: string,
    key: string,
    record: T,
    indexes: readonly D1IndexEntry[],
  ): Promise<void> {
    const document = JSON.stringify(record);
    const now = Date.now();
    await this.#runAtomic([
      this.#binding
        .prepare(
          "INSERT OR REPLACE INTO takosumi_accounts_documents (bucket, key, document, updated_at) VALUES (?, ?, ?, ?)",
        )
        .bind(bucket, key, document, now),
      this.#deleteDocumentIndexEntriesStatement(bucket, key),
      ...indexes.map((index) =>
        this.#insertIndexEntryStatement(bucket, key, index),
      ),
    ]);
  }

  async refreshIndexEntries(
    bucket: string,
    key: string,
    indexes: readonly D1IndexEntry[],
  ): Promise<void> {
    await this.#runAtomic([
      this.#deleteDocumentIndexEntriesStatement(bucket, key),
      ...indexes.map((index) =>
        this.#insertIndexEntryStatement(bucket, key, index),
      ),
    ]);
  }

  async get<T>(bucket: string, key: string): Promise<T | undefined> {
    const row = await this.#db
      .select({ document: d1AccountsDocuments.document })
      .from(d1AccountsDocuments)
      .where(
        and(
          eq(d1AccountsDocuments.bucket, bucket),
          eq(d1AccountsDocuments.key, key),
        ),
      )
      .get();
    return row ? (JSON.parse(row.document) as T) : undefined;
  }

  async delete(bucket: string, key: string): Promise<void> {
    await this.#runAtomic([
      this.#binding
        .prepare(
          "DELETE FROM takosumi_accounts_documents WHERE bucket = ? AND key = ?",
        )
        .bind(bucket, key),
      this.#deleteDocumentIndexEntriesStatement(bucket, key),
    ]);
  }

  async deleteIndexEntries(indexName: string, indexKey: string): Promise<void> {
    await this.#db
      .delete(d1AccountsIndexes)
      .where(
        and(
          eq(d1AccountsIndexes.indexName, indexName),
          eq(d1AccountsIndexes.indexKey, indexKey),
        ),
      )
      .run();
  }

  async listByIndex<T>(indexName: string, indexKey: string): Promise<T[]> {
    const rows = await this.#db
      .select({ document: d1AccountsDocuments.document })
      .from(d1AccountsIndexes)
      .innerJoin(
        d1AccountsDocuments,
        and(
          eq(d1AccountsDocuments.bucket, d1AccountsIndexes.bucket),
          eq(d1AccountsDocuments.key, d1AccountsIndexes.documentKey),
        ),
      )
      .where(
        and(
          eq(d1AccountsIndexes.indexName, indexName),
          eq(d1AccountsIndexes.indexKey, indexKey),
        ),
      )
      .orderBy(
        asc(d1AccountsIndexes.sortKey),
        asc(d1AccountsIndexes.documentKey),
      );
    return rows.map((row) => JSON.parse(row.document) as T);
  }

  async listBucket<T>(bucket: string): Promise<T[]> {
    const rows = await this.#db
      .select({ document: d1AccountsDocuments.document })
      .from(d1AccountsDocuments)
      .where(eq(d1AccountsDocuments.bucket, bucket))
      .orderBy(asc(d1AccountsDocuments.key));
    return rows.map((row) => JSON.parse(row.document) as T);
  }

  #deleteDocumentIndexEntriesStatement(
    bucket: string,
    key: string,
  ): D1PreparedStatement {
    return this.#binding
      .prepare(
        "DELETE FROM takosumi_accounts_indexes WHERE bucket = ? AND document_key = ?",
      )
      .bind(bucket, key);
  }

  #insertIndexEntryStatement(
    bucket: string,
    key: string,
    index: D1IndexEntry,
  ): D1PreparedStatement {
    return this.#binding
      .prepare(
        "INSERT OR REPLACE INTO takosumi_accounts_indexes (index_name, index_key, bucket, document_key, sort_key) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(index.name, index.key, bucket, key, index.sortKey ?? 0);
  }

  async #runAtomic(statements: readonly D1PreparedStatement[]): Promise<void> {
    const results = await this.#binding.batch(statements);
    if (
      results.length !== statements.length ||
      results.some((result) => result.success === false)
    ) {
      throw new Error("D1 Accounts aggregate document/index write failed");
    }
  }
}

// F30: persistent refresh-chain document shapes. The D1 store keeps
// each row as a JSON document keyed by token / code hashes; the
// fields mirror the Postgres tables created by
// migrations/019_refresh_chain.sql.
interface RefreshChainLinkDocument {
  readonly parentHash: string;
  readonly childHash: string;
  readonly rootHash: string;
  readonly createdAt: number;
}

interface RevokedRefreshRootDocument {
  readonly rootHash: string;
  readonly revokedAt: number;
}

interface ConsumedAuthCodeDocument {
  readonly codeHash: string;
  readonly consumedAt: number;
}

interface AuthCodeTokenLinkDocument {
  readonly codeHash: string;
  // '' is the absent-value sentinel, matching the Postgres empty-string
  // scheme (migration 021). A real hash is any non-empty 'sha256:%' value.
  readonly accessTokenHash: string;
  readonly refreshRootHash: string;
  readonly createdAt: number;
}

interface RefreshChainAccessTokenDocument {
  readonly rootHash: string;
  readonly accessTokenHash: string;
  readonly createdAt: number;
}

interface RefreshChainRetentionCandidateRow {
  readonly key: string;
  readonly retention_at: number;
}

const D1_REFRESH_CHAIN_RETENTION_PHASES: Record<
  RefreshChainRetentionPhase,
  {
    readonly bucket: string;
    readonly indexName: string;
    readonly timestampField: "createdAt" | "revokedAt" | "consumedAt";
    readonly count:
      | "chainLinks"
      | "chainAccessTokens"
      | "revokedRoots"
      | "consumedCodes"
      | "authCodeTokenLinks";
  }
> = {
  chain_links: {
    bucket: "refresh_chain_links",
    indexName: "takosumi_accounts_refresh_chain_links_retention",
    timestampField: "createdAt",
    count: "chainLinks",
  },
  chain_access_tokens: {
    bucket: "refresh_chain_access_tokens",
    indexName: "takosumi_accounts_refresh_chain_access_tokens_retention",
    timestampField: "createdAt",
    count: "chainAccessTokens",
  },
  revoked_roots: {
    bucket: "revoked_refresh_roots",
    indexName: "takosumi_accounts_revoked_refresh_roots_retention",
    timestampField: "revokedAt",
    count: "revokedRoots",
  },
  consumed_codes: {
    bucket: "consumed_authorization_codes",
    indexName: "takosumi_accounts_consumed_authorization_codes_retention",
    timestampField: "consumedAt",
    count: "consumedCodes",
  },
  auth_code_token_links: {
    bucket: "auth_code_token_links",
    indexName: "takosumi_accounts_auth_code_token_links_retention",
    timestampField: "createdAt",
    count: "authCodeTokenLinks",
  },
};

interface PasskeyChallengeDocument {
  readonly challenge: string;
  readonly expiresAt: number;
}

export class D1AccountsStore implements AccountsStore {
  readonly #db: D1Database;
  readonly #documents: D1AccountsDocumentIndexStore;
  readonly #schemaMode: D1AccountsSchemaMode;
  #initialized?: Promise<void>;

  constructor(db: D1Database, options: D1AccountsStoreOptions = {}) {
    this.#db = db;
    this.#documents = new D1AccountsDocumentIndexStore(db);
    this.#schemaMode = resolveD1AccountsSchemaMode(options.schemaMode);
  }

  async initialize(): Promise<void> {
    if (!this.#initialized) {
      this.#initialized =
        this.#schemaMode === "predeployed"
          ? Promise.resolve()
          : this.#db.exec(D1_ACCOUNTS_STORE_INIT_SQL).then(() => {});
    }
    await this.#initialized;
  }

  async resolveAccountsBearerCandidates(
    token: string,
  ): Promise<AccountsBearerCredentialCandidates> {
    const [sessionHash, tokenHash] = await Promise.all([
      hashSessionId(token),
      hashSecret(token),
    ]);
    const result = await this.#db
      .prepare(RESOLVE_ACCOUNTS_BEARER_CANDIDATES_SQL)
      .bind(sessionHash, tokenHash, tokenHash)
      .all<D1AccountsBearerCandidateRow>();
    if (!result.success || !result.results) {
      throw new Error("D1 Accounts bearer candidate lookup failed");
    }

    let session: AccountSessionRecord | undefined;
    let sessionAccount: TakosumiAccountRecord | undefined;
    let accessToken: TokenRecord | undefined;
    let personalAccessToken: PersonalAccessTokenRecord | undefined;
    for (const row of result.results) {
      if (row.kind === "session") {
        if (session) throw duplicateBearerCandidate(row.kind);
        session = {
          ...(JSON.parse(row.document) as AccountSessionRecord),
          sessionId: token,
        };
      } else if (row.kind === "session_account") {
        if (sessionAccount) throw duplicateBearerCandidate(row.kind);
        sessionAccount = JSON.parse(row.document) as TakosumiAccountRecord;
      } else if (row.kind === "access_token") {
        if (accessToken) throw duplicateBearerCandidate(row.kind);
        accessToken = JSON.parse(row.document) as TokenRecord;
      } else if (row.kind === "pat") {
        if (personalAccessToken) throw duplicateBearerCandidate(row.kind);
        personalAccessToken = JSON.parse(
          row.document,
        ) as PersonalAccessTokenRecord;
      } else {
        throw new Error(
          "D1 Accounts bearer candidate lookup returned an unknown kind",
        );
      }
    }
    return {
      ...(session ? { session } : {}),
      ...(sessionAccount ? { sessionAccount } : {}),
      ...(accessToken ? { accessToken } : {}),
      ...(personalAccessToken ? { personalAccessToken } : {}),
    };
  }

  async saveAccount(record: TakosumiAccountRecord): Promise<void> {
    const existing = await this.findAccount(record.subject);
    const next = {
      ...existing,
      ...record,
      termsVersion: record.termsVersion ?? existing?.termsVersion,
      termsAcceptedAt: record.termsAcceptedAt ?? existing?.termsAcceptedAt,
      termsAcceptedSource:
        record.termsAcceptedSource ?? existing?.termsAcceptedSource,
    };
    await this.#put("accounts", record.subject, next, accountIndexes(next));
  }

  findAccount(
    subject: TakosumiSubject,
  ): Promise<TakosumiAccountRecord | undefined> {
    return this.#get("accounts", subject);
  }

  async findAccountByVerifiedEmail(
    email: string,
  ): Promise<TakosumiAccountRecord | undefined> {
    const normalized = normalizeAccountEmail(email);
    if (!normalized) return undefined;
    return (
      await this.#listByIndex<TakosumiAccountRecord>(
        "accounts_by_verified_email",
        normalized,
      )
    )[0];
  }

  linkUpstreamIdentity(record: UpstreamIdentityRecord): Promise<void> {
    return this.#put(
      "upstream_identities",
      upstreamIdentityKey(record),
      record,
    );
  }

  findUpstreamIdentity(input: {
    providerId: string;
    upstreamIssuer: string;
    upstreamSubject: string;
  }): Promise<UpstreamIdentityRecord | undefined> {
    return this.#get("upstream_identities", upstreamIdentityKey(input));
  }

  savePasskeyCredential(record: PasskeyCredentialRecord): Promise<void> {
    return this.#put("passkey_credentials", record.credentialId, record, [
      {
        name: "passkeys_by_subject",
        key: record.subject,
        sortKey: record.createdAt,
      },
    ]);
  }

  findPasskeyCredential(
    credentialId: string,
  ): Promise<PasskeyCredentialRecord | undefined> {
    return this.#get("passkey_credentials", credentialId);
  }

  listPasskeyCredentialsForSubject(
    subject: TakosumiSubject,
  ): Promise<readonly PasskeyCredentialRecord[]> {
    return this.#listByIndex("passkeys_by_subject", subject);
  }

  async saveAccountSession(record: AccountSessionRecord): Promise<void> {
    // F7 fix: persist the SHA-256-hashed sessionId so a read-only D1 leak
    // cannot be replayed against the API. Symmetric to the postgres path
    // (postgres/sessions.ts), which uses the same per-deployment salt env
    // `TAKOSUMI_ACCOUNT_SESSION_HASH_SALT`. The raw sessionId is preserved
    // in-memory on the returned record so logging/debugging keeps the
    // raw identity.
    const sessionHash = await hashSessionId(record.sessionId);
    await this.#put("account_sessions", sessionHash, {
      ...record,
      sessionId: sessionHash,
    });
  }

  async findAccountSession(
    sessionId: string,
  ): Promise<AccountSessionRecord | undefined> {
    const sessionHash = await hashSessionId(sessionId);
    const stored = await this.#get<AccountSessionRecord>(
      "account_sessions",
      sessionHash,
    );
    if (!stored) return undefined;
    // The stored sessionId column holds the hash; re-attach the raw value
    // the caller supplied so consumers compare on the identity they hold.
    return { ...stored, sessionId };
  }

  async deleteAccountSession(sessionId: string): Promise<void> {
    const sessionHash = await hashSessionId(sessionId);
    await this.#delete("account_sessions", sessionHash);
  }

  async replaceAccountSession(
    previousSessionId: string,
    next: AccountSessionRecord,
  ): Promise<boolean> {
    await this.initialize();
    const [previousHash, nextHash] = await Promise.all([
      hashSessionId(previousSessionId),
      hashSessionId(next.sessionId),
    ]);
    if (previousHash === nextHash) return false;
    const nextDocument = JSON.stringify({ ...next, sessionId: nextHash });
    const results = await this.#db.batch([
      this.#db
        .prepare(
          `INSERT INTO takosumi_accounts_documents
            (bucket, key, document, updated_at)
          SELECT 'account_sessions', ?, ?, ?
          WHERE EXISTS (
            SELECT 1 FROM takosumi_accounts_documents
            WHERE bucket = 'account_sessions' AND key = ?
          )`,
        )
        .bind(nextHash, nextDocument, Date.now(), previousHash),
      this.#db
        .prepare(
          "DELETE FROM takosumi_accounts_documents WHERE bucket = 'account_sessions' AND key = ?",
        )
        .bind(previousHash),
    ]);
    if (results.length !== 2 || results.some((result) => !result.success)) {
      throw new Error("D1 Accounts session replacement batch failed");
    }
    return (d1ChangeCount(results[0]!) ?? 0) > 0;
  }

  async savePrivacyRequest(record: PrivacyRequestRecord): Promise<void> {
    const existing = await this.findPrivacyRequest(record.requestId);
    if (existing && existing.subject !== record.subject) {
      throw new TypeError(
        "privacy request id is already owned by another subject",
      );
    }
    await this.#put("privacy_requests", record.requestId, record, [
      {
        name: "privacy_requests_by_subject",
        key: record.subject,
        sortKey: record.createdAt,
      },
    ]);
  }

  findPrivacyRequest(
    requestId: string,
  ): Promise<PrivacyRequestRecord | undefined> {
    return this.#get("privacy_requests", requestId);
  }

  async listPrivacyRequestsForSubject(
    subject: TakosumiSubject,
  ): Promise<readonly PrivacyRequestRecord[]> {
    return (
      await this.#listByIndex<PrivacyRequestRecord>(
        "privacy_requests_by_subject",
        subject,
      )
    ).sort(
      (a, b) =>
        b.createdAt - a.createdAt || a.requestId.localeCompare(b.requestId),
    );
  }

  saveAuthorizationCode(
    code: string,
    record: AuthorizationCodeRecord,
  ): Promise<void> {
    return hashSecret(code).then((hash) =>
      this.#put("authorization_codes", hash, record),
    );
  }

  async consumeAuthorizationCode(
    code: string,
  ): Promise<AuthorizationCodeRecord | undefined> {
    return await this.#take("authorization_codes", await hashSecret(code));
  }

  async saveAccessToken(token: string, record: TokenRecord): Promise<void> {
    await this.#put("access_tokens", await hashSecret(token), record);
  }

  async findAccessToken(token: string): Promise<TokenRecord | undefined> {
    return await this.#get("access_tokens", await hashSecret(token));
  }

  async saveRefreshToken(token: string, record: TokenRecord): Promise<void> {
    await this.#put("refresh_tokens", await hashSecret(token), record);
  }

  async findRefreshToken(token: string): Promise<TokenRecord | undefined> {
    return await this.#get("refresh_tokens", await hashSecret(token));
  }

  async deleteToken(token: string): Promise<void> {
    const tokenHash = await hashSecret(token);
    await this.#delete("access_tokens", tokenHash);
    await this.#delete("refresh_tokens", tokenHash);
  }

  async savePersonalAccessToken(
    token: string,
    record: PersonalAccessTokenRecord,
  ): Promise<void> {
    await this.#put("personal_access_tokens", record.tokenId, record, [
      {
        name: "personal_access_tokens_by_subject",
        key: record.subject,
        sortKey: record.createdAt,
      },
    ]);
    await this.#put("personal_access_token_secrets", await hashSecret(token), {
      tokenId: record.tokenId,
    });
  }

  async findPersonalAccessToken(
    token: string,
  ): Promise<PersonalAccessTokenRecord | undefined> {
    const secret = await this.#get<{ tokenId: string }>(
      "personal_access_token_secrets",
      await hashSecret(token),
    );
    return secret
      ? await this.#get("personal_access_tokens", secret.tokenId)
      : undefined;
  }

  listPersonalAccessTokensForSubject(
    subject: TakosumiSubject,
  ): Promise<readonly PersonalAccessTokenRecord[]> {
    return this.#listByIndex("personal_access_tokens_by_subject", subject);
  }

  async listPersonalAccessTokenInventoryPage(
    input: PersonalAccessTokenInventoryPageInput,
  ): Promise<PersonalAccessTokenInventoryPage> {
    assertPersonalAccessTokenInventoryPageInput(input);
    await this.initialize();
    const hasCursor = input.cursor ? 1 : 0;
    const cursorCreatedAt = input.cursor?.createdAt ?? 0;
    const cursorTokenId = input.cursor?.tokenId ?? "";
    const result = await this.#db
      .prepare(PERSONAL_ACCESS_TOKEN_INVENTORY_PAGE_SQL)
      .bind(
        input.subject,
        hasCursor,
        cursorCreatedAt,
        cursorTokenId,
        hasCursor,
        cursorCreatedAt,
        cursorCreatedAt,
        cursorTokenId,
        input.limit + 1,
      )
      .all<D1PersonalAccessTokenInventoryRow>();
    if (!result.success || !Array.isArray(result.results)) {
      throw new Error("D1 PAT inventory read failed");
    }
    const [meta, ...rows] = result.results;
    if (
      !meta ||
      meta.row_kind !== 0 ||
      !Number.isSafeInteger(meta.total) ||
      (meta.total as number) < 0 ||
      (meta.anchor_count !== 0 && meta.anchor_count !== 1) ||
      (hasCursor === 0 && meta.anchor_count !== 0) ||
      rows.length > input.limit + 1
    ) {
      throw new Error("D1 PAT inventory metadata is malformed");
    }
    const items = rows.map((row) =>
      personalAccessTokenInventoryRecordFromD1Row(row, input.subject),
    );
    return {
      items,
      total: meta.total as number,
      cursorValid: hasCursor === 0 || meta.anchor_count === 1,
    };
  }

  async revokePersonalAccessToken(input: {
    subject: TakosumiSubject;
    tokenId: string;
    revokedAt: number;
  }): Promise<PersonalAccessTokenRecord | undefined> {
    const record = await this.#get<PersonalAccessTokenRecord>(
      "personal_access_tokens",
      input.tokenId,
    );
    if (!record || record.subject !== input.subject) return undefined;
    const updated = { ...record, revokedAt: input.revokedAt };
    await this.#put("personal_access_tokens", updated.tokenId, updated, [
      {
        name: "personal_access_tokens_by_subject",
        key: updated.subject,
        sortKey: updated.createdAt,
      },
    ]);
    return updated;
  }

  async recordPersonalAccessTokenUsed(
    tokenId: string,
    lastUsedAt: number,
  ): Promise<void> {
    const record = await this.#get<PersonalAccessTokenRecord>(
      "personal_access_tokens",
      tokenId,
    );
    if (!record) return;
    await this.#put(
      "personal_access_tokens",
      tokenId,
      { ...record, lastUsedAt },
      [
        {
          name: "personal_access_tokens_by_subject",
          key: record.subject,
          sortKey: record.createdAt,
        },
      ],
    );
  }

  saveOidcClient(record: OidcClientRecord): Promise<void> {
    return this.#saveOidcClient(record);
  }

  async #saveOidcClient(record: OidcClientRecord): Promise<void> {
    const existing = await this.findOidcClient(record.clientId);
    if (existing && existing.capsuleId !== record.capsuleId) {
      throw new Error(
        `OIDC client ${record.clientId} is already bound to another Capsule`,
      );
    }
    const existingForCapsule = await this.findOidcClientForCapsule(
      record.capsuleId,
    );
    if (existingForCapsule && existingForCapsule.clientId !== record.clientId) {
      throw new Error(
        `Capsule ${record.capsuleId} already has another OIDC client`,
      );
    }
    await this.#deleteIndexEntries("oidc_clients_by_capsule", record.capsuleId);
    await this.#put("oidc_clients", record.clientId, record, [
      {
        name: "oidc_clients_by_capsule",
        key: record.capsuleId,
        sortKey: record.createdAt,
      },
    ]);
  }

  findOidcClient(clientId: string): Promise<OidcClientRecord | undefined> {
    return this.#get("oidc_clients", clientId);
  }

  async findOidcClientForCapsule(
    capsuleId: string,
  ): Promise<OidcClientRecord | undefined> {
    return (
      await this.#listByIndex<OidcClientRecord>(
        "oidc_clients_by_capsule",
        capsuleId,
      )
    )[0];
  }

  async revokeOidcClient(clientId: string): Promise<void> {
    await this.#delete("oidc_clients", clientId);
  }

  // F30 fix: persistent OIDC refresh-chain state. Mirrors the Postgres
  // migration 019_refresh_chain.sql tables; each is stored as a bucket
  // in the D1 document store with token / code hashes as keys. The
  // chain-link bucket also carries the chain root in the payload so a
  // cascade revoke can walk the full chain by `root_token_hash`.
  async addRefreshChainLink(
    parentToken: string,
    childToken: string,
  ): Promise<boolean> {
    const parentHash = await hashSecret(parentToken);
    const childHash = await hashSecret(childToken);
    // The chain link is keyed by parentHash, so the root is derived from
    // the parent's own (child) link if it already exists as a descendant.
    // This SELECT does not race the claim below: it only resolves the
    // root for the row we are about to attempt to insert. The parent may be a
    // root (a doc keyed by parentHash exists) OR a rotated child of an earlier
    // link (it then only exists as another link's childHash VALUE), so resolve
    // through the same child-aware lookup as #resolveRefreshChainRootHash. The
    // previous direct #get-only resolution mislabeled the root for a
    // grandchild+ rotation (it fell back to parentHash), diverging from the
    // Postgres `WHERE child_token_hash = $1` resolution.
    const rootHash = await this.#resolveRefreshChainRootHash(parentHash);
    // G6 fix: ATOMIC rotation claim. `#putIfAbsentWithIndexes` is backed by
    // SQLite `INSERT OR IGNORE` keyed on (bucket, parentHash), so it inserts
    // at most one link per parent and reports whether THIS call won. A
    // `false` result means a link for this parent already existed — the
    // parent token was already rotated (e.g. a concurrent presentation of
    // the same valid refresh token) — so the caller must treat it as reuse
    // rather than minting a second child family. The previous read-then-#put
    // overwrote the child link, letting two concurrent rotations both
    // "succeed" and double-spend the parent.
    return await this.#putIfAbsentWithIndexes<RefreshChainLinkDocument>(
      "refresh_chain_links",
      parentHash,
      { parentHash, childHash, rootHash, createdAt: Date.now() },
      [
        { name: "refresh_chain_links_by_root", key: rootHash },
        // by_child index keyed on childHash so #resolveRefreshChainRootHash
        // can resolve a rotated (child) token to its root in O(log n) via an
        // index lookup instead of a full-bucket scan. Mirrors the Postgres
        // refresh_chain_links_child_idx (migration 019).
        { name: "refresh_chain_links_by_child", key: childHash },
      ],
    );
  }

  async getRefreshChainChild(token: string): Promise<string | undefined> {
    const hash = await hashSecret(token);
    const link = await this.#get<RefreshChainLinkDocument>(
      "refresh_chain_links",
      hash,
    );
    return link?.childHash;
  }

  async revokeRefreshChain(rootToken: string): Promise<readonly string[]> {
    const presentedHash = await hashSecret(rootToken);
    const rootHash = await this.#resolveRefreshChainRootHash(presentedHash);
    await this.#put<RevokedRefreshRootDocument>(
      "revoked_refresh_roots",
      rootHash,
      { rootHash, revokedAt: Date.now() },
    );
    const hashes = await this.#chainRefreshHashes(rootHash);
    const all = new Set(hashes);
    all.add(presentedHash);
    // Cascade-delete every refresh token in the chain. The refresh
    // token bucket is keyed by sha256 token hash (see
    // `saveRefreshToken`), so we can delete by hash directly.
    for (const hash of all) {
      await this.#delete("refresh_tokens", hash);
    }
    await this.#cascadeRevokeChainAccessTokens(rootHash);
    return [...all];
  }

  async linkAccessTokenToRefreshChain(
    refreshTokenRoot: string,
    accessToken: string,
  ): Promise<void> {
    const presentedHash = await hashSecret(refreshTokenRoot);
    const rootHash = await this.#resolveRefreshChainRootHash(presentedHash);
    const accessHash = await hashSecret(accessToken);
    const linkKey = `${rootHash}\n${accessHash}`;
    await this.#put<RefreshChainAccessTokenDocument>(
      "refresh_chain_access_tokens",
      linkKey,
      { rootHash, accessTokenHash: accessHash, createdAt: Date.now() },
      [{ name: "refresh_chain_access_tokens_by_root", key: rootHash }],
    );
  }

  async #cascadeRevokeChainAccessTokens(rootHash: string): Promise<void> {
    const links = await this.#listByIndex<RefreshChainAccessTokenDocument>(
      "refresh_chain_access_tokens_by_root",
      rootHash,
    );
    for (const link of links) {
      await this.#delete("access_tokens", link.accessTokenHash);
    }
  }

  async markAuthorizationCodeConsumed(code: string): Promise<void> {
    const codeHash = await hashSecret(code);
    await this.#put<ConsumedAuthCodeDocument>(
      "consumed_authorization_codes",
      codeHash,
      { codeHash, consumedAt: Date.now() },
    );
  }

  async isAuthorizationCodeConsumed(code: string): Promise<boolean> {
    const codeHash = await hashSecret(code);
    const row = await this.#get<ConsumedAuthCodeDocument>(
      "consumed_authorization_codes",
      codeHash,
    );
    return row !== undefined;
  }

  async linkAccessTokenToAuthCode(
    code: string,
    accessToken: string,
    refreshTokenRoot?: string,
  ): Promise<void> {
    const codeHash = await hashSecret(code);
    const accessHash = await hashSecret(accessToken);
    // Absent refresh root is stored as the empty-string sentinel '', matching
    // the Postgres path (migration 021). Keeping ONE sentinel scheme across
    // both reference distributions is what makes the no-offline_access case
    // representable on Postgres (NULL is forbidden in its PRIMARY KEY); the
    // two stores must not diverge on this.
    const refreshRootHash =
      refreshTokenRoot === undefined ? "" : await hashSecret(refreshTokenRoot);
    // Composite key: code|access|refreshRoot so multiple links can
    // coexist for one code (one auth code may produce one access +
    // refresh pair, but the table is keyed on the tuple for symmetry
    // with the postgres PRIMARY KEY).
    const linkKey = `${codeHash}\n${accessHash}\n${refreshRootHash}`;
    await this.#put<AuthCodeTokenLinkDocument>(
      "auth_code_token_links",
      linkKey,
      {
        codeHash,
        accessTokenHash: accessHash,
        refreshRootHash,
        createdAt: Date.now(),
      },
      [{ name: "auth_code_token_links_by_code", key: codeHash }],
    );
  }

  async revokeTokensIssuedFromCode(
    code: string,
  ): Promise<{ access: readonly string[]; refresh: readonly string[] }> {
    const codeHash = await hashSecret(code);
    const links = await this.#listByIndex<AuthCodeTokenLinkDocument>(
      "auth_code_token_links_by_code",
      codeHash,
    );
    const accessHashes = new Set<string>();
    const refreshRootHashes = new Set<string>();
    for (const link of links) {
      // '' is the absent-value sentinel (symmetric with Postgres migration
      // 021); a real hash is any non-empty value.
      if (link.accessTokenHash !== "") accessHashes.add(link.accessTokenHash);
      if (link.refreshRootHash !== "") {
        refreshRootHashes.add(link.refreshRootHash);
      }
    }
    // Cascade-delete access tokens directly by hash.
    for (const hash of accessHashes) {
      await this.#delete("access_tokens", hash);
    }
    // For each refresh root recorded against this code, cascade-revoke
    // the entire chain. Since the link stores the hash, we use the
    // hash-keyed internal variant of the chain revoke.
    for (const rootHash of refreshRootHashes) {
      await this.#revokeRefreshChainByRootHash(rootHash);
    }
    return {
      access: [...accessHashes],
      refresh: [...refreshRootHashes],
    };
  }

  async #resolveRefreshChainRootHash(presentedHash: string): Promise<string> {
    const direct = await this.#get<RefreshChainLinkDocument>(
      "refresh_chain_links",
      presentedHash,
    );
    if (direct) return direct.rootHash;
    // The presented token may be a child of an earlier rotation (the common
    // case after the first rotation); the parent's link carries this token as
    // its `childHash`. Resolve via the by_child index so this is an O(log n)
    // index lookup, NOT a full-bucket scan of every tenant's chain links. This
    // mirrors the Postgres refresh_chain_links_child_idx path. (Before this
    // fix, #listBucket loaded every refresh_chain_links row across all
    // accounts on every rotation — see CLOUD-STORES finding.)
    const byChild = await this.#listByIndex<RefreshChainLinkDocument>(
      "refresh_chain_links_by_child",
      presentedHash,
    );
    for (const link of byChild) {
      if (link.childHash === presentedHash) return link.rootHash;
    }
    return presentedHash;
  }

  async #chainRefreshHashes(rootHash: string): Promise<readonly string[]> {
    const links = await this.#listByIndex<RefreshChainLinkDocument>(
      "refresh_chain_links_by_root",
      rootHash,
    );
    const hashes = new Set<string>();
    hashes.add(rootHash);
    for (const link of links) {
      hashes.add(link.parentHash);
      hashes.add(link.childHash);
    }
    return [...hashes];
  }

  async #revokeRefreshChainByRootHash(rootHash: string): Promise<void> {
    await this.#put<RevokedRefreshRootDocument>(
      "revoked_refresh_roots",
      rootHash,
      { rootHash, revokedAt: Date.now() },
    );
    const hashes = await this.#chainRefreshHashes(rootHash);
    for (const hash of hashes) {
      await this.#delete("refresh_tokens", hash);
    }
    await this.#cascadeRevokeChainAccessTokens(rootHash);
  }

  async isRefreshRootRevoked(token: string): Promise<boolean> {
    const presentedHash = await hashSecret(token);
    const rootHash = await this.#resolveRefreshChainRootHash(presentedHash);
    const revoked = await this.#get<RevokedRefreshRootDocument>(
      "revoked_refresh_roots",
      rootHash,
    );
    return revoked !== undefined;
  }

  /**
   * Bounded retention page for the production scheduler. This never
   * materializes an entire bucket and never deletes more than input.limit
   * documents in one invocation.
   */
  async pruneRefreshChainPage(
    input: RefreshChainRetentionPageInput,
  ): Promise<RefreshChainRetentionPageResult> {
    assertRefreshChainRetentionPageInput(input);
    const phase = input.cursor?.phase ?? "chain_links";
    if (!isRefreshChainRetentionPhase(phase)) {
      throw new TypeError("invalid refresh-chain retention cursor phase");
    }
    const config = D1_REFRESH_CHAIN_RETENTION_PHASES[phase];
    const cutoff =
      phase === "consumed_codes" || phase === "auth_code_token_links"
        ? input.consumedCodeBefore
        : input.chainBefore;
    const after = decodeD1RefreshChainRetentionCursor(input.cursor?.after);
    const timestampExpression = `CAST(json_extract(document, '$.${config.timestampField}') AS INTEGER)`;
    const result = await this.#db
      .prepare(
        `SELECT key, ${timestampExpression} AS retention_at
           FROM takosumi_accounts_documents INDEXED BY ${config.indexName}
          WHERE bucket = '${config.bucket}'
            AND ${timestampExpression} <= ?
            AND (${timestampExpression}, key) > (?, ?)
          ORDER BY ${timestampExpression}, key
          LIMIT ?`,
      )
      .bind(cutoff, after.at, after.key, input.limit)
      .all<RefreshChainRetentionCandidateRow>();
    if (!result.success || !result.results) {
      throw new Error(
        `D1 refresh-chain retention candidate query failed for ${phase}`,
      );
    }

    for (const row of result.results) {
      await this.#delete(config.bucket, row.key);
    }
    const counts = emptyRefreshChainPruneResult();
    counts[config.count] = result.results.length;
    const last = result.results.at(-1);
    if (result.results.length === input.limit && last) {
      return {
        ...counts,
        scanned: result.results.length,
        done: false,
        cursor: {
          phase,
          after: encodeD1RefreshChainRetentionCursor(
            Number(last.retention_at),
            last.key,
          ),
        },
      };
    }
    const nextPhase = nextRefreshChainRetentionPhase(phase);
    return {
      ...counts,
      scanned: result.results.length,
      done: nextPhase === undefined,
      ...(nextPhase ? { cursor: { phase: nextPhase } } : {}),
    };
  }

  async savePasskeyChallenge(
    key: string,
    challenge: string,
    expiresAt: number,
  ): Promise<void> {
    await this.#put<PasskeyChallengeDocument>("passkey_challenges", key, {
      challenge,
      expiresAt,
    });
  }

  async consumePasskeyChallenge(
    key: string,
    now: number,
  ): Promise<string | undefined> {
    // #take is delete-on-read, so the challenge is single-shot across
    // isolates/replicas even when consumed concurrently: only one caller
    // gets the row back. An expired row is still removed and treated as
    // absent.
    const taken = await this.#take<PasskeyChallengeDocument>(
      "passkey_challenges",
      key,
    );
    if (taken === undefined) return undefined;
    if (taken.expiresAt <= now) return undefined;
    return taken.challenge;
  }

  async #put<T>(
    bucket: string,
    key: string,
    record: T,
    indexes: readonly D1IndexEntry[] = [],
  ): Promise<void> {
    await this.initialize();
    await this.#documents.put(bucket, key, record, indexes);
  }

  // Raw D1 helper kept intentionally: Drizzle's D1 insert result shape is
  // driver-specific, while these account flows need SQLite `INSERT OR IGNORE`
  // plus an exact affected-row count to preserve atomic claim semantics.
  async #putIfAbsent<T>(
    bucket: string,
    key: string,
    record: T,
  ): Promise<boolean> {
    await this.initialize();
    const result = await this.#db
      .prepare(
        "INSERT OR IGNORE INTO takosumi_accounts_documents (bucket, key, document, updated_at) VALUES (?, ?, ?, ?)",
      )
      .bind(bucket, key, JSON.stringify(record), Date.now())
      .run();
    const changes =
      d1ChangeCount(result) ?? (await this.#selectLastChangeCount());
    return changes > 0;
  }

  /**
   * Conditional insert that also writes secondary index rows when (and
   * only when) the document insert wins. Built on SQLite `INSERT OR
   * IGNORE` so concurrent callers contending for the same (bucket, key)
   * see exactly one winner. Returns true when this call inserted the
   * document, false when the key already existed. Used by the atomic
   * refresh-chain rotation claim (G6).
   */
  async #putIfAbsentWithIndexes<T>(
    bucket: string,
    key: string,
    record: T,
    indexes: readonly D1IndexEntry[] = [],
  ): Promise<boolean> {
    await this.initialize();
    const result = await this.#db
      .prepare(
        "INSERT OR IGNORE INTO takosumi_accounts_documents (bucket, key, document, updated_at) VALUES (?, ?, ?, ?)",
      )
      .bind(bucket, key, JSON.stringify(record), Date.now())
      .run();
    const changes =
      d1ChangeCount(result) ?? (await this.#selectLastChangeCount());
    if (changes <= 0) return false;
    await this.#documents.refreshIndexEntries(bucket, key, indexes);
    return true;
  }

  async #get<T>(bucket: string, key: string): Promise<T | undefined> {
    await this.initialize();
    return await this.#documents.get<T>(bucket, key);
  }

  async #delete(bucket: string, key: string): Promise<void> {
    await this.initialize();
    await this.#documents.delete(bucket, key);
  }

  // Raw D1 helper kept intentionally: D1 needs single-shot delete-and-return
  // behavior for authorization codes and passkey challenges. Keeping the
  // RETURNING statement visible prevents accidental read-then-delete rewrites.
  async #take<T>(bucket: string, key: string): Promise<T | undefined> {
    await this.initialize();
    const row = await this.#db
      .prepare(
        "DELETE FROM takosumi_accounts_documents WHERE bucket = ? AND key = ? RETURNING document",
      )
      .bind(bucket, key)
      .first<D1DocumentRow>();
    if (!row) return undefined;
    await this.#db
      .prepare(
        "DELETE FROM takosumi_accounts_indexes WHERE bucket = ? AND document_key = ?",
      )
      .bind(bucket, key)
      .run();
    return JSON.parse(row.document) as T;
  }

  async #deleteIndexEntries(
    indexName: string,
    indexKey: string,
  ): Promise<void> {
    await this.initialize();
    await this.#documents.deleteIndexEntries(indexName, indexKey);
  }

  async #listByIndex<T>(indexName: string, indexKey: string): Promise<T[]> {
    await this.initialize();
    return await this.#documents.listByIndex<T>(indexName, indexKey);
  }

  async #listBucket<T>(bucket: string): Promise<T[]> {
    await this.initialize();
    return await this.#documents.listBucket<T>(bucket);
  }

  async #selectLastChangeCount(): Promise<number> {
    const row = await this.#db
      .prepare("SELECT changes() AS changes")
      .first<{ changes: number }>();
    return Number(row?.changes ?? 0);
  }
}

function assertRefreshChainRetentionPageInput(
  input: RefreshChainRetentionPageInput,
): void {
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit <= 0 ||
    input.limit > MAX_REFRESH_CHAIN_RETENTION_ROWS
  ) {
    throw new TypeError(
      `refresh-chain retention limit must be between 1 and ${MAX_REFRESH_CHAIN_RETENTION_ROWS}`,
    );
  }
  if (
    !Number.isFinite(input.chainBefore) ||
    !Number.isFinite(input.consumedCodeBefore)
  ) {
    throw new TypeError("refresh-chain retention cutoffs must be finite");
  }
}

function encodeD1RefreshChainRetentionCursor(at: number, key: string): string {
  return JSON.stringify([at, key]);
}

function decodeD1RefreshChainRetentionCursor(value: string | undefined): {
  readonly at: number;
  readonly key: string;
} {
  if (value === undefined) return { at: -1, key: "" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new TypeError("invalid D1 refresh-chain retention cursor");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    !Number.isFinite(parsed[0]) ||
    typeof parsed[1] !== "string"
  ) {
    throw new TypeError("invalid D1 refresh-chain retention cursor");
  }
  return { at: Number(parsed[0]), key: parsed[1] };
}

function upstreamIdentityKey(input: {
  providerId: string;
  upstreamIssuer: string;
  upstreamSubject: string;
}): string {
  return [input.providerId, input.upstreamIssuer, input.upstreamSubject].join(
    "\n",
  );
}

function accountIndexes(
  record: TakosumiAccountRecord,
): readonly D1IndexEntry[] {
  const email = normalizeAccountEmail(record.email);
  if (!email || record.emailVerified !== true) return [];
  return [{ name: "accounts_by_verified_email", key: email }];
}

function normalizeAccountEmail(email: string | undefined): string | undefined {
  const trimmed = email?.trim().toLowerCase();
  return trimmed ? trimmed : undefined;
}

function d1ChangeCount(result: D1Result): number | undefined {
  const changes = result.meta?.changes;
  return typeof changes === "number" ? changes : undefined;
}
