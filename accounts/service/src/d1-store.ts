import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";
import { and, asc, eq } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import {
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import type {
  ServiceBindingMaterialRecord,
  ServiceGrantMaterialRecord,
  InstallationEventRecord,
  InstallationRecord,
  LedgerAccountRecord,
  RuntimeBindingRecord,
  SpaceRecord,
} from "./ledger.ts";
import {
  assertValidServiceBindingMaterialRecord,
  assertValidServiceGrantMaterialRecord,
} from "./ledger.ts";
import { hashSessionId } from "./session-hash-salt.ts";
// hashSecret is the canonical sha256:<base64url> hasher shared across the
// package (previously re-implemented locally). Aliased to keep call sites.
import { sha256Text as hashSecret } from "./encoding.ts";
import type {
  AccountSessionRecord,
  AccountsStore,
  AuthorizationCodeRecord,
  BillingAccountRecord,
  BillingUsageRecord,
  BillingWebhookEventClaimResult,
  BillingWebhookEventRecord,
  LaunchTokenConsumeResult,
  LaunchTokenConsumptionRecord,
  LaunchTokenPruneResult,
  LaunchTokenRecord,
  OidcClientRecord,
  PasskeyCredentialRecord,
  PersonalAccessTokenRecord,
  RefreshChainPruneResult,
  TakosumiAccountRecord,
  TokenRecord,
  UpstreamIdentityRecord,
} from "./store.ts";
import { LedgerAccountOwnershipConflictError } from "./store.ts";

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
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

// LedgerAccountOwnershipConflictError is the shared ownership-conflict error
// thrown by every store's saveLedgerAccount (in-memory / Postgres / D1). It
// lives in store.ts so all three implementations share one contract; D1 callers
// import it through this store entrypoint.
export { LedgerAccountOwnershipConflictError };

// D1's `db.exec()` treats each line as a separate statement, so every
// statement must fit on one line — both for real Cloudflare D1 and for
// miniflare's emulation. Keep these single-line and terminated with `;`.
export const D1_ACCOUNTS_STORE_INIT_SQL: string = [
  "CREATE TABLE IF NOT EXISTS takosumi_accounts_documents (bucket TEXT NOT NULL, key TEXT NOT NULL, document TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (bucket, key));",
  "CREATE TABLE IF NOT EXISTS takosumi_accounts_indexes (index_name TEXT NOT NULL, index_key TEXT NOT NULL, bucket TEXT NOT NULL, document_key TEXT NOT NULL, sort_key INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (index_name, index_key, bucket, document_key));",
  "CREATE INDEX IF NOT EXISTS takosumi_accounts_indexes_lookup ON takosumi_accounts_indexes (index_name, index_key, sort_key);",
  "CREATE INDEX IF NOT EXISTS takosumi_accounts_indexes_document ON takosumi_accounts_indexes (bucket, document_key);",
].join("\n");

interface D1IndexEntry {
  readonly name: string;
  readonly key: string;
  readonly sortKey?: number;
}

interface D1DocumentRow {
  readonly document: string;
}

const d1AccountsDocuments = sqliteTable(
  "takosumi_accounts_documents",
  {
    bucket: text("bucket").notNull(),
    key: text("key").notNull(),
    document: text("document").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.bucket, table.key] })],
);

const d1AccountsIndexes = sqliteTable(
  "takosumi_accounts_indexes",
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

class D1AccountsDocumentIndexStore {
  readonly #db: D1AccountsDrizzleDatabase;

  constructor(binding: D1Database) {
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
    await this.#db
      .insert(d1AccountsDocuments)
      .values({ bucket, key, document, updatedAt: now })
      .onConflictDoUpdate({
        target: [d1AccountsDocuments.bucket, d1AccountsDocuments.key],
        set: { document, updatedAt: now },
      })
      .run();
    await this.deleteDocumentIndexEntries(bucket, key);
    await this.insertIndexEntries(bucket, key, indexes);
  }

  async refreshIndexEntries(
    bucket: string,
    key: string,
    indexes: readonly D1IndexEntry[],
  ): Promise<void> {
    await this.deleteDocumentIndexEntries(bucket, key);
    await this.insertIndexEntries(bucket, key, indexes);
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
    await this.deleteDocumentIndexEntries(bucket, key);
    await this.#db
      .delete(d1AccountsDocuments)
      .where(
        and(
          eq(d1AccountsDocuments.bucket, bucket),
          eq(d1AccountsDocuments.key, key),
        ),
      )
      .run();
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

  private async deleteDocumentIndexEntries(
    bucket: string,
    key: string,
  ): Promise<void> {
    await this.#db
      .delete(d1AccountsIndexes)
      .where(
        and(
          eq(d1AccountsIndexes.bucket, bucket),
          eq(d1AccountsIndexes.documentKey, key),
        ),
      )
      .run();
  }

  private async insertIndexEntries(
    bucket: string,
    key: string,
    indexes: readonly D1IndexEntry[],
  ): Promise<void> {
    for (const index of indexes) {
      await this.#db
        .insert(d1AccountsIndexes)
        .values({
          indexName: index.name,
          indexKey: index.key,
          bucket,
          documentKey: key,
          sortKey: index.sortKey ?? 0,
        })
        .onConflictDoUpdate({
          target: [
            d1AccountsIndexes.indexName,
            d1AccountsIndexes.indexKey,
            d1AccountsIndexes.bucket,
            d1AccountsIndexes.documentKey,
          ],
          set: { sortKey: index.sortKey ?? 0 },
        })
        .run();
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

interface PasskeyChallengeDocument {
  readonly challenge: string;
  readonly expiresAt: number;
}

export class D1AccountsStore implements AccountsStore {
  readonly #db: D1Database;
  readonly #documents: D1AccountsDocumentIndexStore;
  #initialized?: Promise<void>;

  constructor(db: D1Database) {
    this.#db = db;
    this.#documents = new D1AccountsDocumentIndexStore(db);
  }

  async initialize(): Promise<void> {
    if (!this.#initialized) {
      this.#initialized = this.#db
        .exec(D1_ACCOUNTS_STORE_INIT_SQL)
        .then(() => {});
    }
    await this.#initialized;
  }

  async saveAccount(record: TakosumiAccountRecord): Promise<void> {
    const existing = await this.findAccount(record.subject);
    await this.#put("accounts", record.subject, {
      ...existing,
      ...record,
      termsVersion: record.termsVersion ?? existing?.termsVersion,
      termsAcceptedAt: record.termsAcceptedAt ?? existing?.termsAcceptedAt,
      termsAcceptedSource:
        record.termsAcceptedSource ?? existing?.termsAcceptedSource,
    });
  }

  findAccount(
    subject: TakosumiSubject,
  ): Promise<TakosumiAccountRecord | undefined> {
    return this.#get("accounts", subject);
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

  async saveBillingAccount(record: BillingAccountRecord): Promise<void> {
    const stored: BillingAccountRecord = {
      ...record,
      version: record.version ?? 1,
    };
    await this.#deleteIndexEntries(
      "billing_accounts_by_subject",
      stored.subject,
    );
    if (stored.stripeCustomerId) {
      await this.#deleteIndexEntries(
        "billing_accounts_by_stripe_customer",
        stored.stripeCustomerId,
      );
    }
    await this.#put(
      "billing_accounts",
      stored.billingAccountId,
      stored,
      billingAccountIndexes(stored),
    );
  }

  /**
   * G15 fix: compare-and-swap billing-account write for D1. Reads the stored
   * document, and only when its `version` still equals `expectedVersion`
   * (an absent version compares as 0) performs an atomic
   * `#updateDocumentIfMatches` whose predicate is the exact stored document
   * body. The winning write advances `version` by one; a concurrent writer
   * that already advanced the row loses the byte-exact document match and
   * causes this method to return `false`, mirroring the postgres
   * `WHERE COALESCE(version, 0) = $expected` guard.
   */
  async saveBillingAccountIfVersion(
    record: BillingAccountRecord,
    expectedVersion: number,
  ): Promise<boolean> {
    const current = await this.#get<BillingAccountRecord>(
      "billing_accounts",
      record.billingAccountId,
    );
    if (!current) return false;
    if ((current.version ?? 0) !== expectedVersion) return false;
    const next: BillingAccountRecord = {
      ...record,
      version: expectedVersion + 1,
    };
    const swapped = await this.#updateDocumentIfMatches(
      "billing_accounts",
      record.billingAccountId,
      JSON.stringify(current),
      JSON.stringify(next),
    );
    if (!swapped) return false;
    await this.#deleteIndexEntries("billing_accounts_by_subject", next.subject);
    if (next.stripeCustomerId) {
      await this.#deleteIndexEntries(
        "billing_accounts_by_stripe_customer",
        next.stripeCustomerId,
      );
    }
    await this.#refreshIndexEntries(
      "billing_accounts",
      next.billingAccountId,
      billingAccountIndexes(next),
    );
    return true;
  }

  findBillingAccount(
    billingAccountId: string,
  ): Promise<BillingAccountRecord | undefined> {
    return this.#get("billing_accounts", billingAccountId);
  }

  async findBillingAccountForSubject(
    subject: TakosumiSubject,
  ): Promise<BillingAccountRecord | undefined> {
    return (
      await this.#listByIndex<BillingAccountRecord>(
        "billing_accounts_by_subject",
        subject,
      )
    )[0];
  }

  async findBillingAccountByStripeCustomerId(
    stripeCustomerId: string,
  ): Promise<BillingAccountRecord | undefined> {
    return (
      await this.#listByIndex<BillingAccountRecord>(
        "billing_accounts_by_stripe_customer",
        stripeCustomerId,
      )
    )[0];
  }

  saveBillingWebhookEvent(record: BillingWebhookEventRecord): Promise<void> {
    return this.#put("billing_webhook_events", record.eventId, record);
  }

  findBillingWebhookEvent(
    eventId: string,
  ): Promise<BillingWebhookEventRecord | undefined> {
    return this.#get("billing_webhook_events", eventId);
  }

  /**
   * Atomic webhook claim built on SQLite's `INSERT OR IGNORE` (which the
   * existing `#putIfAbsent` helper wraps). If the insert produced no row
   * change, the event id was already recorded - read it back so the caller
   * can short-circuit duplicate processing.
   */
  async claimBillingWebhookEvent(
    record: BillingWebhookEventRecord,
  ): Promise<BillingWebhookEventClaimResult> {
    const inserted = await this.#putIfAbsent(
      "billing_webhook_events",
      record.eventId,
      record,
    );
    if (inserted) return { inserted: true };
    const existing = await this.#get<BillingWebhookEventRecord>(
      "billing_webhook_events",
      record.eventId,
    );
    if (!existing) return { inserted: true };
    return { inserted: false, existing };
  }

  async saveBillingUsageRecord(record: BillingUsageRecord): Promise<void> {
    // Cross-owner ownership guard, mirroring the Postgres path
    // (postgres/billing.ts saveBillingUsageRecord), which uses a conditional
    // ON CONFLICT ... DO UPDATE ... WHERE installation_id/billing_account_id
    // match and throws when 0 rows are affected. The unconditional #put used
    // before let the racy route-layer check-then-act mis-attribute a usage
    // report to another installation. Enforce the invariant at the storage
    // layer regardless of the route check.
    const indexes: readonly D1IndexEntry[] = [
      {
        name: "billing_usage_by_installation",
        key: record.installationId,
        sortKey: record.reportedAt,
      },
    ];
    // G6 atomic claim: only the first writer for this usageReportId wins the
    // insert (and its index rows are written by the same primitive).
    const claimed = await this.#putIfAbsentWithIndexes(
      "billing_usage_records",
      record.usageReportId,
      record,
      indexes,
    );
    if (claimed) return;
    // Key already exists. Reject a cross-owner overwrite; allow a same-owner
    // idempotent re-report to update the row.
    const existing = await this.#get<BillingUsageRecord>(
      "billing_usage_records",
      record.usageReportId,
    );
    if (
      existing &&
      (existing.installationId !== record.installationId ||
        existing.billingAccountId !== record.billingAccountId)
    ) {
      throw new TypeError(
        "billing usage report id is already owned by another installation",
      );
    }
    // Same owner (or a row that vanished after the failed claim): perform the
    // ordinary upsert, which deletes and reinserts the secondary index rows.
    // For a same-owner re-report the index key (installationId) is unchanged,
    // so the index rewrite is effectively a no-op beyond the sortKey refresh.
    await this.#put(
      "billing_usage_records",
      record.usageReportId,
      record,
      indexes,
    );
  }

  findBillingUsageRecord(
    usageReportId: string,
  ): Promise<BillingUsageRecord | undefined> {
    return this.#get("billing_usage_records", usageReportId);
  }

  listBillingUsageRecordsForInstallation(
    installationId: string,
  ): Promise<readonly BillingUsageRecord[]> {
    return this.#listByIndex("billing_usage_by_installation", installationId);
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

  async consumeLaunchTokenJti(
    record: LaunchTokenConsumptionRecord,
  ): Promise<boolean> {
    return await this.#putIfAbsent(
      "launch_token_consumptions",
      record.jti,
      record,
    );
  }

  async saveLaunchToken(record: LaunchTokenRecord): Promise<void> {
    const existing = await this.#listByIndex<LaunchTokenRecord>(
      "launch_tokens_by_installation",
      record.installationId,
    );
    for (const token of existing) {
      if (token.usedAt === undefined && token.expiresAt > record.createdAt) {
        await this.#put(
          "launch_tokens",
          token.tokenHash,
          { ...token, usedAt: record.createdAt },
          launchTokenIndexes(token),
        );
      }
    }
    await this.#put(
      "launch_tokens",
      record.tokenHash,
      record,
      launchTokenIndexes(record),
    );
  }

  async consumeLaunchToken(input: {
    tokenHash: string;
    installationId: string;
    redirectUri: string;
    consumedAt: number;
  }): Promise<LaunchTokenConsumeResult> {
    // F7 fix: launch-token consume must be atomic to avoid a read → check
    // → write race where two concurrent consumers both observe
    // `usedAt === undefined`. We still read first to surface the
    // redirect-mismatch / expired / not-found error envelope, but the
    // actual "claim the token" step is performed by an atomic conditional
    // UPDATE on the SQLite document row. The marker is the JSON document
    // payload itself: we serialize the consumed record and only persist
    // it when the previous document had no `"usedAt"` key (i.e. the
    // first consumer wins). The CAS predicate is the document's current
    // value, mirroring postgres/launch-tokens.ts:116-126 which uses
    // `WHERE used_at IS NULL`.
    const record = await this.#get<LaunchTokenRecord>(
      "launch_tokens",
      input.tokenHash,
    );
    if (!record || record.installationId !== input.installationId) {
      return { ok: false, reason: "not_found" };
    }
    if (record.redirectUri !== input.redirectUri) {
      return { ok: false, reason: "redirect_mismatch" };
    }
    if (record.expiresAt <= input.consumedAt) {
      return { ok: false, reason: "expired" };
    }
    if (record.usedAt !== undefined) return { ok: false, reason: "used" };
    const consumed = { ...record, usedAt: input.consumedAt };
    const claimed = await this.#updateDocumentIfMatches(
      "launch_tokens",
      input.tokenHash,
      JSON.stringify(record),
      JSON.stringify(consumed),
    );
    if (!claimed) {
      // Another consumer won the race. Either it was already consumed
      // (used) or the record changed in some other way (which would
      // currently only happen if `saveLaunchToken` was concurrently
      // refreshing it, but in production that path only marks tokens
      // used). Treat as "used" for the closed error envelope.
      return { ok: false, reason: "used" };
    }
    // Refresh indexes for the now-consumed record so future lookups by
    // installation reflect the `usedAt` state. Index entries are derived
    // from the record so we only need to rewrite the secondary index
    // rows; the document body was already overwritten atomically.
    await this.#refreshIndexEntries(
      "launch_tokens",
      consumed.tokenHash,
      launchTokenIndexes(consumed),
    );
    return { ok: true, record: consumed };
  }

  async pruneLaunchTokens(input: {
    expiredBefore: number;
    usedBefore: number;
  }): Promise<LaunchTokenPruneResult> {
    let expired = 0;
    let used = 0;
    const tokens = await this.#listBucket<LaunchTokenRecord>("launch_tokens");
    for (const token of tokens) {
      if (token.usedAt !== undefined && token.usedAt <= input.usedBefore) {
        await this.#delete("launch_tokens", token.tokenHash);
        used += 1;
        continue;
      }
      if (token.expiresAt <= input.expiredBefore) {
        await this.#delete("launch_tokens", token.tokenHash);
        expired += 1;
      }
    }
    return { deleted: expired + used, expired, used };
  }

  saveOidcClient(record: OidcClientRecord): Promise<void> {
    return this.#saveOidcClient(record);
  }

  async #saveOidcClient(record: OidcClientRecord): Promise<void> {
    await this.#deleteIndexEntries(
      "oidc_clients_by_installation",
      record.installationId,
    );
    await this.#put("oidc_clients", record.clientId, record, [
      {
        name: "oidc_clients_by_installation",
        key: record.installationId,
        sortKey: record.createdAt,
      },
    ]);
  }

  findOidcClient(clientId: string): Promise<OidcClientRecord | undefined> {
    return this.#get("oidc_clients", clientId);
  }

  async findOidcClientForInstallation(
    installationId: string,
  ): Promise<OidcClientRecord | undefined> {
    return (
      await this.#listByIndex<OidcClientRecord>(
        "oidc_clients_by_installation",
        installationId,
      )
    )[0];
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

  async pruneRefreshChain(input: {
    chainBefore: number;
    consumedCodeBefore: number;
  }): Promise<RefreshChainPruneResult> {
    // refresh_chain_links are keyed by parentHash; #delete removes the
    // document AND its by_root / by_child index entries.
    const chainLinks = await this.#pruneBucketBefore<RefreshChainLinkDocument>(
      "refresh_chain_links",
      (doc) => doc.parentHash,
      (doc) => doc.createdAt,
      input.chainBefore,
    );
    // refresh_chain_access_tokens are keyed by `${rootHash}\n${accessHash}`.
    const chainAccessTokens =
      await this.#pruneBucketBefore<RefreshChainAccessTokenDocument>(
        "refresh_chain_access_tokens",
        (doc) => `${doc.rootHash}\n${doc.accessTokenHash}`,
        (doc) => doc.createdAt,
        input.chainBefore,
      );
    const revokedRoots =
      await this.#pruneBucketBefore<RevokedRefreshRootDocument>(
        "revoked_refresh_roots",
        (doc) => doc.rootHash,
        (doc) => doc.revokedAt,
        input.chainBefore,
      );
    const consumedCodes =
      await this.#pruneBucketBefore<ConsumedAuthCodeDocument>(
        "consumed_authorization_codes",
        (doc) => doc.codeHash,
        (doc) => doc.consumedAt,
        input.consumedCodeBefore,
      );
    // auth_code_token_links are keyed by `${code}\n${access}\n${refreshRoot}`.
    const authCodeTokenLinks =
      await this.#pruneBucketBefore<AuthCodeTokenLinkDocument>(
        "auth_code_token_links",
        (doc) =>
          `${doc.codeHash}\n${doc.accessTokenHash}\n${doc.refreshRootHash}`,
        (doc) => doc.createdAt,
        input.consumedCodeBefore,
      );
    return {
      chainLinks,
      chainAccessTokens,
      revokedRoots,
      consumedCodes,
      authCodeTokenLinks,
    };
  }

  async #pruneBucketBefore<T>(
    bucket: string,
    keyOf: (doc: T) => string,
    createdAtOf: (doc: T) => number,
    before: number,
  ): Promise<number> {
    const docs = await this.#listBucket<T>(bucket);
    let deleted = 0;
    for (const doc of docs) {
      if (createdAtOf(doc) > before) continue;
      await this.#delete(bucket, keyOf(doc));
      deleted += 1;
    }
    return deleted;
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

  async saveLedgerAccount(record: LedgerAccountRecord): Promise<void> {
    // F7 fix: defense-in-depth at the store layer. If the account row
    // already exists with a different legalOwnerSubject, reject the write
    // rather than silently overwriting. The application path in
    // installation-lifecycle-routes.ts already performs a check-and-set
    // guard; this prevents a buggy or malicious caller from skipping
    // that guard at the store boundary. Mirrors the postgres path's
    // intent (caller-enforced) by enforcing it once more here.
    const existing = await this.#get<LedgerAccountRecord>(
      "ledger_accounts",
      record.accountId,
    );
    if (existing && existing.legalOwnerSubject !== record.legalOwnerSubject) {
      throw new LedgerAccountOwnershipConflictError(
        record.accountId,
        existing.legalOwnerSubject,
        record.legalOwnerSubject,
      );
    }
    await this.#put("ledger_accounts", record.accountId, record, [
      {
        name: "ledger_accounts_by_owner",
        key: record.legalOwnerSubject,
        sortKey: record.createdAt,
      },
    ]);
  }

  findLedgerAccount(
    accountId: string,
  ): Promise<LedgerAccountRecord | undefined> {
    return this.#get("ledger_accounts", accountId);
  }

  saveSpace(record: SpaceRecord): Promise<void> {
    return this.#put("spaces", record.spaceId, record, [
      {
        name: "spaces_by_account",
        key: record.accountId,
        sortKey: record.createdAt,
      },
    ]);
  }

  findSpace(spaceId: string): Promise<SpaceRecord | undefined> {
    return this.#get("spaces", spaceId);
  }

  listSpacesForAccount(accountId: string): Promise<readonly SpaceRecord[]> {
    return this.#listByIndex("spaces_by_account", accountId);
  }

  async listSpacesForOwner(
    subject: TakosumiSubject,
  ): Promise<readonly SpaceRecord[]> {
    // KV-index store: resolve the subject's legally-owned ledger accounts via
    // the `ledger_accounts_by_owner` index, then collect each account's spaces
    // via `spaces_by_account`, deduplicating by spaceId.
    let ownedAccounts = await this.#listByIndex<LedgerAccountRecord>(
      "ledger_accounts_by_owner",
      subject,
    );
    if (ownedAccounts.length === 0) {
      // Lazy backfill: the `ledger_accounts_by_owner` index is written only on
      // `saveLedgerAccount`, so ledger accounts persisted BEFORE this index
      // existed have no index entry and the lookup above returns empty. An
      // empty result is ambiguous — the subject may genuinely own nothing, or
      // their (legacy) ledger accounts may simply be un-indexed. Resolve the
      // ambiguity by scanning `ledger_accounts` and (re)writing the by-owner
      // index entries for every row found, then re-reading the index. This is
      // idempotent and self-healing: once the index is populated this branch
      // is not re-entered for an owning subject, and the happy path (a
      // non-empty index) is never touched. The in-memory + Postgres stores
      // already return all legal-owner spaces; this keeps D1 in parity.
      const reindexed = await this.#backfillLedgerAccountsByOwnerIndex();
      if (reindexed) {
        ownedAccounts = await this.#listByIndex<LedgerAccountRecord>(
          "ledger_accounts_by_owner",
          subject,
        );
      }
    }
    const byId = new Map<string, SpaceRecord>();
    for (const account of ownedAccounts) {
      const spaces = await this.#listByIndex<SpaceRecord>(
        "spaces_by_account",
        account.accountId,
      );
      for (const space of spaces) {
        byId.set(space.spaceId, space);
      }
    }
    return [...byId.values()];
  }

  /**
   * Reindex helper for the `ledger_accounts_by_owner` secondary index. Scans
   * every `ledger_accounts` document and (re)writes its by-owner index entry
   * keyed on `legalOwnerSubject`. Needed because the index is written only on
   * `saveLedgerAccount`, so ledger accounts persisted before the index existed
   * have no entry; `listSpacesForOwner` invokes this lazily when its by-owner
   * lookup is empty so legacy org owners no longer degrade to direct-owner
   * spaces. Idempotent: `#refreshIndexEntries` deletes and rewrites the
   * document's index rows, so re-running it on an already-indexed store is a
   * no-op beyond rewriting the same rows. Returns whether any rows were found
   * (false ⇒ the bucket is empty, so re-reading the index would be wasted).
   */
  async #backfillLedgerAccountsByOwnerIndex(): Promise<boolean> {
    const accounts =
      await this.#listBucket<LedgerAccountRecord>("ledger_accounts");
    for (const account of accounts) {
      await this.#refreshIndexEntries("ledger_accounts", account.accountId, [
        {
          name: "ledger_accounts_by_owner",
          key: account.legalOwnerSubject,
          sortKey: account.createdAt,
        },
      ]);
    }
    return accounts.length > 0;
  }

  saveAppInstallation(record: InstallationRecord): Promise<void> {
    const indexes: D1IndexEntry[] = [
      {
        name: "installations_by_space",
        key: record.spaceId,
        sortKey: record.createdAt,
      },
    ];
    if (record.billingAccountId) {
      indexes.push({
        name: "installations_by_billing_account",
        key: record.billingAccountId,
        sortKey: record.createdAt,
      });
    }
    return this.#put(
      "app_installations",
      record.installationId,
      record,
      indexes,
    );
  }

  findAppInstallation(
    installationId: string,
  ): Promise<InstallationRecord | undefined> {
    return this.#get("app_installations", installationId);
  }

  listAppInstallationsForSpace(
    spaceId: string,
  ): Promise<readonly InstallationRecord[]> {
    return this.#listByIndex("installations_by_space", spaceId);
  }

  listAppInstallationsForBillingAccount(
    billingAccountId: string,
  ): Promise<readonly InstallationRecord[]> {
    return this.#listByIndex(
      "installations_by_billing_account",
      billingAccountId,
    );
  }

  saveRuntimeBinding(record: RuntimeBindingRecord): Promise<void> {
    // Wave 6 dropped runtime_bindings. Phase I converted the Postgres path
    // to a no-op shim. D1 path follows the same pattern (Phase K audit K5):
    // RuntimeBindingRecord remains a live in-memory orchestration entity
    // but is no longer persisted.
    void record;
    return Promise.resolve();
  }

  findRuntimeBinding(
    runtimeBindingId: string,
  ): Promise<RuntimeBindingRecord | undefined> {
    void runtimeBindingId;
    return Promise.resolve(undefined);
  }

  saveServiceBindingMaterial(
    record: ServiceBindingMaterialRecord,
  ): Promise<void> {
    assertValidServiceBindingMaterialRecord(record);
    return this.#put("service_binding_materials", record.bindingId, record, [
      {
        name: "service_binding_materials_by_installation",
        key: record.installationId,
        sortKey: record.createdAt,
      },
    ]);
  }

  listServiceBindingMaterialsForInstallation(
    installationId: string,
  ): Promise<readonly ServiceBindingMaterialRecord[]> {
    return this.#listByIndex(
      "service_binding_materials_by_installation",
      installationId,
    );
  }

  saveServiceGrantMaterial(record: ServiceGrantMaterialRecord): Promise<void> {
    // Wave 6 dropped app_grants; Phase I no-op shim precedent applies.
    try {
      assertValidServiceGrantMaterialRecord(record);
    } catch (error) {
      return Promise.reject(error);
    }
    return Promise.resolve();
  }

  findServiceGrantMaterial(
    grantId: string,
  ): Promise<ServiceGrantMaterialRecord | undefined> {
    void grantId;
    return Promise.resolve(undefined);
  }

  listServiceGrantMaterialsForInstallation(
    installationId: string,
  ): Promise<readonly ServiceGrantMaterialRecord[]> {
    void installationId;
    return Promise.resolve([]);
  }

  async appendInstallationEvent(
    record: InstallationEventRecord,
  ): Promise<void> {
    // SECURITY (audit hash-chain fork): D1 has no per-installation row lock, so
    // two concurrent appends that read the same chain tail would each INSERT a
    // successor sharing previousEventHash, forking the tamper-evident ledger.
    // Key the event document by its CHAIN POSITION (installationId,
    // previousEventHash) and insert with INSERT OR IGNORE, so only one successor
    // per position can win. The loser gets inserted === false and we throw;
    // appendLedgerEvent's retry loop then re-reads the advanced tail and
    // re-appends. (Postgres achieves the same via FOR UPDATE NOWAIT.)
    const chainKey = `${record.installationId}::${record.previousEventHash ?? "<genesis>"}`;
    const inserted = await this.#putIfAbsentWithIndexes(
      "installation_events",
      chainKey,
      record,
      [
        {
          name: "installation_events_by_installation",
          key: record.installationId,
          sortKey: record.createdAt,
        },
      ],
    );
    if (!inserted) {
      throw new Error(
        `installation event chain position already claimed for ` +
          `${record.installationId} (previousEventHash=` +
          `${record.previousEventHash ?? "<genesis>"}); concurrent appender won`,
      );
    }
  }

  listInstallationEvents(
    installationId: string,
  ): Promise<readonly InstallationEventRecord[]> {
    return this.#listByIndex(
      "installation_events_by_installation",
      installationId,
    );
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

  /**
   * Atomic compare-and-swap on the document body. Replaces the row only
   * when the current document equals `expectedDocument`. Returns true if
   * the update affected exactly one row; false otherwise. Mirrors the
   * postgres path's `UPDATE ... WHERE used_at IS NULL` pattern but for
   * the JSON-blob shape used by D1.
   */
  async #updateDocumentIfMatches(
    bucket: string,
    key: string,
    expectedDocument: string,
    nextDocument: string,
  ): Promise<boolean> {
    await this.initialize();
    const result = await this.#db
      .prepare(
        "UPDATE takosumi_accounts_documents SET document = ?, updated_at = ? WHERE bucket = ? AND key = ? AND document = ?",
      )
      .bind(nextDocument, Date.now(), bucket, key, expectedDocument)
      .run();
    const changes =
      d1ChangeCount(result) ?? (await this.#selectLastChangeCount());
    return changes > 0;
  }

  /**
   * Rewrites the secondary index rows for an existing document key
   * without touching the document body. Used by atomic CAS update paths
   * that already wrote the document via `#updateDocumentIfMatches`.
   */
  async #refreshIndexEntries(
    bucket: string,
    key: string,
    indexes: readonly D1IndexEntry[],
  ): Promise<void> {
    await this.initialize();
    await this.#documents.refreshIndexEntries(bucket, key, indexes);
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

function upstreamIdentityKey(input: {
  providerId: string;
  upstreamIssuer: string;
  upstreamSubject: string;
}): string {
  return [input.providerId, input.upstreamIssuer, input.upstreamSubject].join(
    "\n",
  );
}

function launchTokenIndexes(
  record: LaunchTokenRecord,
): readonly D1IndexEntry[] {
  return [
    {
      name: "launch_tokens_by_installation",
      key: record.installationId,
      sortKey: record.createdAt,
    },
  ];
}

function billingAccountIndexes(
  record: BillingAccountRecord,
): readonly D1IndexEntry[] {
  const indexes: D1IndexEntry[] = [
    {
      name: "billing_accounts_by_subject",
      key: record.subject,
      sortKey: record.createdAt,
    },
  ];
  if (record.stripeCustomerId) {
    indexes.push({
      name: "billing_accounts_by_stripe_customer",
      key: record.stripeCustomerId,
      sortKey: record.createdAt,
    });
  }
  return indexes;
}

function d1ChangeCount(result: D1Result): number | undefined {
  const changes = result.meta?.changes;
  return typeof changes === "number" ? changes : undefined;
}
