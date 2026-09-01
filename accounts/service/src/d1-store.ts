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
  AuthorizationCodeRedemptionCandidate,
  AuthorizationCodeRecord,
  ClaimValidatedAuthorizationCodeResult,
  FinalizeAuthorizationCodeRedemptionInput,
  FinalizeAuthorizationCodeRedemptionResult,
  OidcClientRecord,
  OpenAuthorizationCodeRedemptionResult,
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

interface AuthCodeTokenLinkDocument {
  readonly codeHash: string;
  // '' is the absent-value sentinel, matching the Postgres empty-string
  // scheme (migration 021). A real hash is any non-empty 'sha256:%' value.
  readonly accessTokenHash: string;
  readonly refreshRootHash: string;
  readonly createdAt: number;
}

interface AuthorizationCodeRedemptionDocument {
  readonly state: "active" | "issuing" | "issued" | "replayed";
  readonly recordVersion: string;
  readonly record?: AuthorizationCodeRecord;
  readonly claimId?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly claimedAt?: number;
  readonly issuedAt?: number;
  readonly replayedAt?: number;
  readonly accessTokenHash?: string;
  readonly refreshTokenHash?: string;
}

interface RefreshChainAccessTokenDocument {
  readonly rootHash: string;
  readonly accessTokenHash: string;
  readonly createdAt: number;
}

interface RefreshChainRetentionCandidateRow {
  readonly key: string;
  readonly retention_at: number;
  readonly record_version: string | null;
}

const D1_REFRESH_CHAIN_RETENTION_PHASES: Record<
  RefreshChainRetentionPhase,
  {
    readonly bucket: string;
    readonly indexName: string;
    readonly timestampExpression: string;
    readonly predicate?: string;
    readonly recordVersionExpression?: string;
    readonly count:
      | "chainLinks"
      | "chainAccessTokens"
      | "revokedRoots"
      | "consumedCodes"
      | "authCodeTokenLinks"
      | "authorizationCodeRedemptions";
  }
> = {
  chain_links: {
    bucket: "refresh_chain_links",
    indexName: "takosumi_accounts_refresh_chain_links_retention",
    timestampExpression:
      "CAST(json_extract(document, '$.createdAt') AS INTEGER)",
    count: "chainLinks",
  },
  chain_access_tokens: {
    bucket: "refresh_chain_access_tokens",
    indexName: "takosumi_accounts_refresh_chain_access_tokens_retention",
    timestampExpression:
      "CAST(json_extract(document, '$.createdAt') AS INTEGER)",
    count: "chainAccessTokens",
  },
  revoked_roots: {
    bucket: "revoked_refresh_roots",
    indexName: "takosumi_accounts_revoked_refresh_roots_retention",
    timestampExpression:
      "CAST(json_extract(document, '$.revokedAt') AS INTEGER)",
    count: "revokedRoots",
  },
  consumed_codes: {
    bucket: "consumed_authorization_codes",
    indexName: "takosumi_accounts_consumed_authorization_codes_retention",
    timestampExpression:
      "CAST(json_extract(document, '$.consumedAt') AS INTEGER)",
    predicate: `AND NOT EXISTS (
      SELECT 1
        FROM takosumi_accounts_documents AS redemption
       WHERE redemption.bucket = 'authorization_code_redemptions'
         AND redemption.key = takosumi_accounts_documents.key
    )`,
    count: "consumedCodes",
  },
  auth_code_token_links: {
    bucket: "auth_code_token_links",
    indexName: "takosumi_accounts_auth_code_token_links_retention",
    timestampExpression:
      "CAST(json_extract(document, '$.createdAt') AS INTEGER)",
    predicate: `AND NOT EXISTS (
      SELECT 1
        FROM takosumi_accounts_documents AS redemption
       WHERE redemption.bucket = 'authorization_code_redemptions'
         AND redemption.key = json_extract(
               takosumi_accounts_documents.document,
               '$.codeHash'
             )
    )`,
    count: "authCodeTokenLinks",
  },
  authorization_code_redemptions: {
    bucket: "authorization_code_redemptions",
    indexName:
      "takosumi_accounts_authorization_code_redemptions_terminal_retention",
    timestampExpression:
      "CAST(COALESCE(json_extract(document, '$.replayedAt'), json_extract(document, '$.issuedAt')) AS INTEGER)",
    predicate:
      "AND json_extract(document, '$.state') IN ('issued', 'replayed')",
    recordVersionExpression: "json_extract(document, '$.recordVersion')",
    count: "authorizationCodeRedemptions",
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

  async saveAuthorizationCode(
    code: string,
    record: AuthorizationCodeRecord,
  ): Promise<void> {
    await this.initialize();
    const codeHash = await hashSecret(code);
    const now = Date.now();
    const redemption: AuthorizationCodeRedemptionDocument = {
      state: "active",
      recordVersion: crypto.randomUUID(),
      record,
      createdAt: now,
      updatedAt: now,
    };
    await this.#runLifecycleBatch([
      ...this.#authorizationCodeReplayStatements(codeHash, now, true),
      this.#db
        .prepare(
          "INSERT OR REPLACE INTO takosumi_accounts_documents (bucket, key, document, updated_at) VALUES ('authorization_codes', ?, ?, ?)",
        )
        .bind(codeHash, JSON.stringify(record), now),
      this.#db
        .prepare(
          "INSERT OR REPLACE INTO takosumi_accounts_documents (bucket, key, document, updated_at) VALUES ('authorization_code_redemptions', ?, ?, ?)",
        )
        .bind(codeHash, JSON.stringify(redemption), now),
    ]);
  }

  async openAuthorizationCodeRedemption(
    code: string,
  ): Promise<OpenAuthorizationCodeRedemptionResult> {
    await this.initialize();
    const codeHash = await hashSecret(code);
    const now = Date.now();
    const results = await this.#runLifecycleBatch([
      ...this.#authorizationCodeReplayStatements(codeHash, now, true),
      this.#db
        .prepare(
          "SELECT document FROM takosumi_accounts_documents WHERE bucket = 'authorization_code_redemptions' AND key = ? LIMIT 1",
        )
        .bind(codeHash),
    ]);
    const document = d1LifecycleDocumentFromResult(results.at(-1));
    if (!document) return { status: "unknown" };
    if (document.state !== "active") return { status: "replayed" };
    if (!document.record) {
      throw new Error("D1 active authorization-code redemption is malformed");
    }
    return {
      status: "active",
      candidate: {
        redemptionId: codeHash,
        recordVersion: document.recordVersion,
        record: document.record,
      },
    };
  }

  async claimValidatedAuthorizationCode(
    candidate: AuthorizationCodeRedemptionCandidate,
  ): Promise<ClaimValidatedAuthorizationCodeResult> {
    await this.initialize();
    const claimId = crypto.randomUUID();
    const now = Date.now();
    const results = await this.#runLifecycleBatch([
      this.#db
        .prepare(
          `UPDATE takosumi_accounts_documents
              SET document = json_set(
                    document,
                    '$.state', 'issuing',
                    '$.claimId', ?,
                    '$.claimedAt', ?,
                    '$.updatedAt', ?
                  ),
                  updated_at = ?
            WHERE bucket = 'authorization_code_redemptions'
              AND key = ?
              AND json_extract(document, '$.state') = 'active'
              AND json_extract(document, '$.recordVersion') = ?`,
        )
        .bind(
          claimId,
          now,
          now,
          now,
          candidate.redemptionId,
          candidate.recordVersion,
        ),
      this.#db
        .prepare(
          `DELETE FROM takosumi_accounts_documents
            WHERE bucket = 'authorization_codes'
              AND key = ?
              AND EXISTS (
                SELECT 1 FROM takosumi_accounts_documents
                 WHERE bucket = 'authorization_code_redemptions'
                   AND key = ?
                   AND json_extract(document, '$.state') = 'issuing'
                   AND json_extract(document, '$.claimId') = ?
              )`,
        )
        .bind(candidate.redemptionId, candidate.redemptionId, claimId),
      this.#db
        .prepare(
          `UPDATE takosumi_accounts_documents
              SET document = json_set(
                    document,
                    '$.state', 'replayed',
                    '$.replayedAt', COALESCE(
                      json_extract(document, '$.replayedAt'),
                      ?
                    ),
                    '$.updatedAt', ?
                  ),
                  updated_at = ?
            WHERE bucket = 'authorization_code_redemptions'
              AND key = ?
              AND json_extract(document, '$.recordVersion') = ?
              AND json_extract(document, '$.state') IN ('issuing', 'issued')
              AND COALESCE(json_extract(document, '$.claimId'), '') <> ?`,
        )
        .bind(
          now,
          now,
          now,
          candidate.redemptionId,
          candidate.recordVersion,
          claimId,
        ),
      ...this.#authorizationCodeReplayStatements(
        candidate.redemptionId,
        now,
        false,
      ),
      this.#db
        .prepare(
          "SELECT document FROM takosumi_accounts_documents WHERE bucket = 'authorization_code_redemptions' AND key = ? LIMIT 1",
        )
        .bind(candidate.redemptionId),
    ]);
    const document = d1LifecycleDocumentFromResult(results.at(-1));
    if (!document) return { status: "lost" };
    if (document.recordVersion !== candidate.recordVersion) {
      return { status: "stale" };
    }
    if (document.state === "replayed") return { status: "replayed" };
    if (document.state === "issuing" && document.claimId === claimId) {
      return { status: "claimed", claimId };
    }
    return { status: "lost" };
  }

  async finalizeAuthorizationCodeRedemption(
    input: FinalizeAuthorizationCodeRedemptionInput,
  ): Promise<FinalizeAuthorizationCodeRedemptionResult> {
    if (
      (input.refreshToken === undefined) !==
      (input.refreshRecord === undefined)
    ) {
      throw new TypeError(
        "authorization-code refresh token and record must be provided together",
      );
    }
    await this.initialize();
    const [codeHash, accessTokenHash, refreshTokenHash] = await Promise.all([
      hashSecret(input.code),
      hashSecret(input.accessToken),
      input.refreshToken ? hashSecret(input.refreshToken) : undefined,
    ]);
    const now = Date.now();
    const accessDocument = JSON.stringify(input.accessRecord);
    const refreshDocument = input.refreshRecord
      ? JSON.stringify(input.refreshRecord)
      : undefined;
    const linkKey = `${codeHash}\n${accessTokenHash}\n${refreshTokenHash ?? ""}`;
    const chainAccessKey = refreshTokenHash
      ? `${refreshTokenHash}\n${accessTokenHash}`
      : undefined;
    const statements: D1PreparedStatement[] = [
      this.#conditionalAuthorizationCodeInsert(
        "access_tokens",
        accessTokenHash,
        accessDocument,
        now,
        codeHash,
        input.claimId,
      ),
    ];
    if (refreshTokenHash && refreshDocument) {
      statements.push(
        this.#conditionalAuthorizationCodeInsert(
          "refresh_tokens",
          refreshTokenHash,
          refreshDocument,
          now,
          codeHash,
          input.claimId,
        ),
        this.#conditionalAuthorizationCodeInsert(
          "refresh_chain_access_tokens",
          chainAccessKey!,
          JSON.stringify({
            rootHash: refreshTokenHash,
            accessTokenHash,
            createdAt: now,
          } satisfies RefreshChainAccessTokenDocument),
          now,
          codeHash,
          input.claimId,
        ),
        this.#conditionalAuthorizationCodeIndexInsert(
          "refresh_chain_access_tokens_by_root",
          refreshTokenHash,
          "refresh_chain_access_tokens",
          chainAccessKey!,
          now,
          codeHash,
          input.claimId,
        ),
      );
    }
    statements.push(
      this.#conditionalAuthorizationCodeInsert(
        "consumed_authorization_codes",
        codeHash,
        JSON.stringify({ codeHash, consumedAt: now }),
        now,
        codeHash,
        input.claimId,
        true,
      ),
      this.#conditionalAuthorizationCodeInsert(
        "auth_code_token_links",
        linkKey,
        JSON.stringify({
          codeHash,
          accessTokenHash,
          refreshRootHash: refreshTokenHash ?? "",
          createdAt: now,
        } satisfies AuthCodeTokenLinkDocument),
        now,
        codeHash,
        input.claimId,
        true,
      ),
      this.#conditionalAuthorizationCodeIndexInsert(
        "auth_code_token_links_by_code",
        codeHash,
        "auth_code_token_links",
        linkKey,
        now,
        codeHash,
        input.claimId,
      ),
      this.#db
        .prepare(
          `UPDATE takosumi_accounts_documents
              SET document = json_set(
                    document,
                    '$.state', 'issued',
                    '$.accessTokenHash', ?,
                    '$.refreshTokenHash', json(?),
                    '$.issuedAt', ?,
                    '$.updatedAt', ?
                  ),
                  updated_at = ?
            WHERE bucket = 'authorization_code_redemptions'
              AND key = ?
              AND json_extract(document, '$.state') = 'issuing'
              AND json_extract(document, '$.claimId') = ?`,
        )
        .bind(
          accessTokenHash,
          JSON.stringify(refreshTokenHash ?? null),
          now,
          now,
          now,
          codeHash,
          input.claimId,
        ),
      this.#db
        .prepare(
          "SELECT document FROM takosumi_accounts_documents WHERE bucket = 'authorization_code_redemptions' AND key = ? LIMIT 1",
        )
        .bind(codeHash),
    );
    const results = await this.#runLifecycleBatch(statements);
    const document = d1LifecycleDocumentFromResult(results.at(-1));
    if (!document) return { status: "lost" };
    if (document.state === "replayed") return { status: "replayed" };
    if (
      document.state === "issued" &&
      document.claimId === input.claimId &&
      document.accessTokenHash === accessTokenHash
    ) {
      return { status: "issued" };
    }
    return { status: "lost" };
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
      phase === "consumed_codes" ? input.consumedCodeBefore : input.chainBefore;
    const after = decodeD1RefreshChainRetentionCursor(input.cursor?.after);
    const timestampExpression = config.timestampExpression;
    const refreshActivityPredicate =
      phase === "authorization_code_redemptions"
        ? `AND NOT EXISTS (
             SELECT 1
               FROM takosumi_accounts_documents AS chain
              WHERE chain.bucket = 'refresh_chain_links'
                AND CAST(json_extract(chain.document, '$.createdAt') AS INTEGER) > ?
                AND json_extract(chain.document, '$.rootHash') IN (
                  SELECT NULLIF(
                           json_extract(
                             takosumi_accounts_documents.document,
                             '$.refreshTokenHash'
                           ),
                           ''
                         )
                  UNION
                  SELECT NULLIF(
                           json_extract(auth_link.document, '$.refreshRootHash'),
                           ''
                         )
                    FROM takosumi_accounts_documents AS auth_link
                   WHERE auth_link.bucket = 'auth_code_token_links'
                     AND json_extract(auth_link.document, '$.codeHash') =
                         takosumi_accounts_documents.key
                )
           )`
        : "";
    const result = await this.#db
      .prepare(
        `SELECT key, ${timestampExpression} AS retention_at,
                ${config.recordVersionExpression ?? "NULL"} AS record_version
           FROM takosumi_accounts_documents INDEXED BY ${config.indexName}
          WHERE bucket = '${config.bucket}'
            ${config.predicate ?? ""}
            AND ${timestampExpression} <= ?
            ${refreshActivityPredicate}
            AND (${timestampExpression}, key) > (?, ?)
          ORDER BY ${timestampExpression}, key
          LIMIT ?`,
      )
      .bind(
        cutoff,
        ...(phase === "authorization_code_redemptions" ? [cutoff] : []),
        after.at,
        after.key,
        input.limit,
      )
      .all<RefreshChainRetentionCandidateRow>();
    if (!result.success || !result.results) {
      throw new Error(
        `D1 refresh-chain retention candidate query failed for ${phase}`,
      );
    }

    let deleted = 0;
    for (const row of result.results) {
      if (phase === "authorization_code_redemptions") {
        if (!row.record_version) {
          throw new Error(
            "D1 authorization-code retention candidate is malformed",
          );
        }
        const deletion = await this.#db
          .prepare(
            `DELETE FROM takosumi_accounts_documents AS redemption
              WHERE redemption.bucket = 'authorization_code_redemptions'
                AND redemption.key = ?
                AND json_extract(redemption.document, '$.recordVersion') = ?
                AND json_extract(redemption.document, '$.state') IN ('issued', 'replayed')
                AND CAST(COALESCE(
                      json_extract(redemption.document, '$.replayedAt'),
                      json_extract(redemption.document, '$.issuedAt')
                    ) AS INTEGER) = ?
                AND NOT EXISTS (
                  SELECT 1
                    FROM takosumi_accounts_documents AS chain
                   WHERE chain.bucket = 'refresh_chain_links'
                     AND CAST(
                           json_extract(chain.document, '$.createdAt') AS INTEGER
                         ) > ?
                     AND json_extract(chain.document, '$.rootHash') IN (
                       SELECT NULLIF(
                                json_extract(
                                  redemption.document,
                                  '$.refreshTokenHash'
                                ),
                                ''
                              )
                       UNION
                       SELECT NULLIF(
                                json_extract(
                                  auth_link.document,
                                  '$.refreshRootHash'
                                ),
                                ''
                              )
                         FROM takosumi_accounts_documents AS auth_link
                        WHERE auth_link.bucket = 'auth_code_token_links'
                          AND json_extract(
                                auth_link.document,
                                '$.codeHash'
                              ) = redemption.key
                     )
                )`,
          )
          .bind(row.key, row.record_version, Number(row.retention_at), cutoff)
          .run();
        const changes = d1ChangeCount(deletion);
        if (!deletion.success || changes === undefined || changes > 1) {
          throw new Error(
            "D1 authorization-code retention delete result is malformed",
          );
        }
        deleted += changes;
      } else if (phase === "revoked_roots") {
        const deletion = await this.#db
          .prepare(
            `DELETE FROM takosumi_accounts_documents
              WHERE bucket = 'revoked_refresh_roots'
                AND key = ?
                AND CAST(json_extract(document, '$.revokedAt') AS INTEGER) = ?`,
          )
          .bind(row.key, Number(row.retention_at))
          .run();
        const changes = d1ChangeCount(deletion);
        if (!deletion.success || changes === undefined || changes > 1) {
          throw new Error(
            "D1 revoked refresh-root retention delete result is malformed",
          );
        }
        deleted += changes;
      } else if (phase === "consumed_codes") {
        const deletion = await this.#db
          .prepare(
            `DELETE FROM takosumi_accounts_documents AS consumed
              WHERE consumed.bucket = 'consumed_authorization_codes'
                AND consumed.key = ?
                AND CAST(
                      json_extract(consumed.document, '$.consumedAt') AS INTEGER
                    ) = ?
                AND NOT EXISTS (
                  SELECT 1
                    FROM takosumi_accounts_documents AS redemption
                   WHERE redemption.bucket = 'authorization_code_redemptions'
                     AND redemption.key = consumed.key
                )`,
          )
          .bind(row.key, Number(row.retention_at))
          .run();
        const changes = d1ChangeCount(deletion);
        if (!deletion.success || changes === undefined || changes > 1) {
          throw new Error(
            "D1 consumed authorization-code retention delete result is malformed",
          );
        }
        deleted += changes;
      } else if (phase === "auth_code_token_links") {
        const deletion = await this.#db
          .prepare(
            `DELETE FROM takosumi_accounts_documents AS link
              WHERE link.bucket = 'auth_code_token_links'
                AND link.key = ?
                AND NOT EXISTS (
                  SELECT 1
                    FROM takosumi_accounts_documents AS redemption
                   WHERE redemption.bucket = 'authorization_code_redemptions'
                     AND redemption.key =
                         json_extract(link.document, '$.codeHash')
                )`,
          )
          .bind(row.key)
          .run();
        const changes = d1ChangeCount(deletion);
        if (!deletion.success || changes === undefined || changes > 1) {
          throw new Error(
            "D1 authorization-code link retention delete result is malformed",
          );
        }
        if (changes === 1) {
          await this.#db
            .prepare(
              `DELETE FROM takosumi_accounts_indexes
                WHERE bucket = 'auth_code_token_links'
                  AND document_key = ?`,
            )
            .bind(row.key)
            .run();
        }
        deleted += changes;
      } else {
        await this.#delete(config.bucket, row.key);
        deleted += 1;
      }
    }
    const counts = emptyRefreshChainPruneResult();
    counts[config.count] = deleted;
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

  #authorizationCodeReplayStatements(
    codeHash: string,
    replayedAt: number,
    transition: boolean,
  ): D1PreparedStatement[] {
    // The lifecycle row keeps one representative token pair, while the
    // expand-window link bucket can contain several historical pairs for the
    // same code. Derive roots from both under one replayed-state guard so a
    // migrated multi-link code cannot leave older descendants alive.
    const replayLineageCtes = `WITH replayed(code_hash) AS (
      SELECT key
        FROM takosumi_accounts_documents
       WHERE bucket = 'authorization_code_redemptions'
         AND key = ?
         AND json_extract(document, '$.state') = 'replayed'
    ),
    refresh_roots(root_hash) AS (
      SELECT NULLIF(
               json_extract(redemption.document, '$.refreshTokenHash'),
               ''
             )
        FROM takosumi_accounts_documents AS redemption
        JOIN replayed ON replayed.code_hash = redemption.key
       WHERE redemption.bucket = 'authorization_code_redemptions'
      UNION
      SELECT NULLIF(json_extract(link.document, '$.refreshRootHash'), '')
        FROM takosumi_accounts_documents AS link
        JOIN replayed
          ON json_extract(link.document, '$.codeHash') = replayed.code_hash
       WHERE link.bucket = 'auth_code_token_links'
    )`;
    const statements: D1PreparedStatement[] = [];
    if (transition) {
      statements.push(
        this.#db
          .prepare(
            `UPDATE takosumi_accounts_documents
                SET document = json_set(
                      document,
                      '$.state', 'replayed',
                      '$.replayedAt', COALESCE(
                        json_extract(document, '$.replayedAt'),
                        ?
                      ),
                      '$.updatedAt', ?
                    ),
                    updated_at = ?
              WHERE bucket = 'authorization_code_redemptions'
                AND key = ?
                AND json_extract(document, '$.state') IN ('issuing', 'issued')`,
          )
          .bind(replayedAt, replayedAt, replayedAt, codeHash),
      );
    }
    statements.push(
      this.#db
        .prepare(
          `INSERT OR IGNORE INTO takosumi_accounts_documents (
             bucket, key, document, updated_at
           )
           SELECT 'consumed_authorization_codes', ?,
                  json_object('codeHash', ?, 'consumedAt', ?), ?
             FROM takosumi_accounts_documents
            WHERE bucket = 'authorization_code_redemptions'
              AND key = ?
              AND json_extract(document, '$.state') = 'replayed'`,
        )
        .bind(codeHash, codeHash, replayedAt, replayedAt, codeHash),
      this.#db
        .prepare(
          `${replayLineageCtes}
           INSERT INTO takosumi_accounts_documents (
             bucket, key, document, updated_at
           )
           SELECT 'revoked_refresh_roots', root_hash,
                  json_object(
                    'rootHash', root_hash,
                    'revokedAt', ?
                  ),
                  ?
             FROM refresh_roots
            WHERE root_hash IS NOT NULL
           ON CONFLICT(bucket, key) DO UPDATE SET
             document = excluded.document,
             updated_at = excluded.updated_at`,
        )
        .bind(codeHash, replayedAt, replayedAt),
      this.#db
        .prepare(
          `${replayLineageCtes}
           DELETE FROM takosumi_accounts_documents
            WHERE bucket = 'access_tokens'
              AND EXISTS (SELECT 1 FROM replayed)
              AND (
                key IN (
                  SELECT NULLIF(
                           json_extract(
                             redemption.document,
                             '$.accessTokenHash'
                           ),
                           ''
                         )
                    FROM takosumi_accounts_documents AS redemption
                    JOIN replayed ON replayed.code_hash = redemption.key
                   WHERE redemption.bucket = 'authorization_code_redemptions'
                  UNION
                  SELECT NULLIF(
                           json_extract(link.document, '$.accessTokenHash'),
                           ''
                         )
                    FROM takosumi_accounts_documents AS link
                    JOIN replayed
                      ON json_extract(link.document, '$.codeHash') =
                         replayed.code_hash
                   WHERE link.bucket = 'auth_code_token_links'
                )
                OR key IN (
                  SELECT json_extract(chain.document, '$.accessTokenHash')
                    FROM takosumi_accounts_documents AS chain
                   WHERE chain.bucket = 'refresh_chain_access_tokens'
                     AND json_extract(chain.document, '$.rootHash') IN (
                       SELECT root_hash
                         FROM refresh_roots
                        WHERE root_hash IS NOT NULL
                     )
                )
              )`,
        )
        .bind(codeHash),
      this.#db
        .prepare(
          `${replayLineageCtes}
           DELETE FROM takosumi_accounts_documents
            WHERE bucket = 'refresh_tokens'
              AND EXISTS (SELECT 1 FROM replayed)
              AND (
                key IN (
                  SELECT root_hash
                    FROM refresh_roots
                   WHERE root_hash IS NOT NULL
                )
                OR key IN (
                  SELECT json_extract(link.document, '$.parentHash')
                    FROM takosumi_accounts_documents AS link
                   WHERE link.bucket = 'refresh_chain_links'
                     AND json_extract(link.document, '$.rootHash') IN (
                       SELECT root_hash
                         FROM refresh_roots
                        WHERE root_hash IS NOT NULL
                     )
                  UNION
                  SELECT json_extract(link.document, '$.childHash')
                    FROM takosumi_accounts_documents AS link
                   WHERE link.bucket = 'refresh_chain_links'
                     AND json_extract(link.document, '$.rootHash') IN (
                       SELECT root_hash
                         FROM refresh_roots
                        WHERE root_hash IS NOT NULL
                     )
                )
              )`,
        )
        .bind(codeHash),
      this.#db
        .prepare(
          `DELETE FROM takosumi_accounts_documents
            WHERE bucket = 'authorization_codes'
              AND key = ?
              AND EXISTS (
                SELECT 1 FROM takosumi_accounts_documents
                 WHERE bucket = 'authorization_code_redemptions'
                   AND key = ?
                   AND json_extract(document, '$.state') = 'replayed'
              )`,
        )
        .bind(codeHash, codeHash),
    );
    return statements;
  }

  #conditionalAuthorizationCodeInsert(
    bucket: string,
    key: string,
    document: string,
    updatedAt: number,
    codeHash: string,
    claimId: string,
    ignoreConflict = false,
  ): D1PreparedStatement {
    return this.#db
      .prepare(
        `INSERT ${ignoreConflict ? "OR IGNORE " : ""}INTO takosumi_accounts_documents (
           bucket, key, document, updated_at
         )
         SELECT ?, ?, ?, ?
          WHERE EXISTS (
            SELECT 1 FROM takosumi_accounts_documents
             WHERE bucket = 'authorization_code_redemptions'
               AND key = ?
               AND json_extract(document, '$.state') = 'issuing'
               AND json_extract(document, '$.claimId') = ?
          )`,
      )
      .bind(bucket, key, document, updatedAt, codeHash, claimId);
  }

  #conditionalAuthorizationCodeIndexInsert(
    indexName: string,
    indexKey: string,
    bucket: string,
    documentKey: string,
    sortKey: number,
    codeHash: string,
    claimId: string,
  ): D1PreparedStatement {
    return this.#db
      .prepare(
        `INSERT OR REPLACE INTO takosumi_accounts_indexes (
           index_name, index_key, bucket, document_key, sort_key
         )
         SELECT ?, ?, ?, ?, ?
          WHERE EXISTS (
            SELECT 1 FROM takosumi_accounts_documents
             WHERE bucket = 'authorization_code_redemptions'
               AND key = ?
               AND json_extract(document, '$.state') = 'issuing'
               AND json_extract(document, '$.claimId') = ?
          )`,
      )
      .bind(
        indexName,
        indexKey,
        bucket,
        documentKey,
        sortKey,
        codeHash,
        claimId,
      );
  }

  async #runLifecycleBatch(
    statements: readonly D1PreparedStatement[],
  ): Promise<readonly D1Result[]> {
    const results = await this.#db.batch(statements);
    if (
      results.length !== statements.length ||
      results.some((result) => result.success !== true)
    ) {
      throw new Error("D1 authorization-code lifecycle batch failed");
    }
    return results;
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

function d1LifecycleDocumentFromResult(
  result: D1Result | undefined,
): AuthorizationCodeRedemptionDocument | undefined {
  const row = result?.results?.[0] as D1DocumentRow | undefined;
  if (!row) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.document);
  } catch {
    throw new Error("D1 authorization-code lifecycle document is malformed");
  }
  if (
    !isUnknownRecord(parsed) ||
    !["active", "issuing", "issued", "replayed"].includes(
      String(parsed.state),
    ) ||
    typeof parsed.recordVersion !== "string" ||
    parsed.recordVersion.length === 0 ||
    !Number.isSafeInteger(parsed.createdAt) ||
    !Number.isSafeInteger(parsed.updatedAt)
  ) {
    throw new Error("D1 authorization-code lifecycle document is malformed");
  }
  return parsed as unknown as AuthorizationCodeRedemptionDocument;
}
