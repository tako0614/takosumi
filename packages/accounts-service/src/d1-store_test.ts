import { expect, test } from "bun:test";
import { assertEquals, assertRejects } from "../../../test/assert.ts";
import {
  D1AccountsStore,
  type D1Database,
  type D1ExecResult,
  type D1PreparedStatement,
  type D1Result,
  type D1Value,
  LedgerAccountOwnershipConflictError,
} from "./d1-store.ts";
import { registerSessionHashSaltConfig } from "./session-hash-salt.ts";

test("D1AccountsStore initializes lazily and persists indexed records", async () => {
  const db = new MemoryD1Database();
  const store = new D1AccountsStore(db);

  await store.saveAccount({
    subject: "tsub_test",
    email: "user@example.test",
    displayName: "User",
    termsVersion: "terms-2026-05-13",
    termsAcceptedAt: 1000,
    termsAcceptedSource: "use-takos-start",
    createdAt: 1000,
    updatedAt: 1000,
  });
  await store.saveAccount({
    subject: "tsub_test",
    email: "renamed@example.test",
    displayName: "Renamed",
    createdAt: 1000,
    updatedAt: 2000,
  });
  await store.savePasskeyCredential({
    credentialId: "credential-1",
    subject: "tsub_test",
    publicKeyJwk: { kty: "EC" },
    signCount: 1,
    createdAt: 1000,
    updatedAt: 1000,
  });
  await store.saveBillingAccount({
    billingAccountId: "billing-1",
    subject: "tsub_test",
    provider: "stripe",
    stripeCustomerId: "cus_123",
    status: "active",
    createdAt: 1000,
    updatedAt: 1000,
  });

  expect(db.execCount).toEqual(1);
  expect((await store.findAccount("tsub_test"))?.email).toEqual("renamed@example.test");
  expect((await store.findAccount("tsub_test"))?.termsVersion).toEqual("terms-2026-05-13");
  expect((await store.listPasskeyCredentialsForSubject("tsub_test")).map((
      credential,
    ) => credential.credentialId)).toEqual(["credential-1"]);
  expect((await store.findBillingAccountForSubject("tsub_test"))?.billingAccountId).toEqual("billing-1");
  expect((await store.findBillingAccountByStripeCustomerId("cus_123"))
      ?.billingAccountId).toEqual("billing-1");
});

test("D1AccountsStore consumes one-shot records", async () => {
  const store = new D1AccountsStore(new MemoryD1Database());

  await store.saveAuthorizationCode("code-1", {
    clientId: "client-1",
    redirectUri: "https://takos.example/callback",
    scope: "openid",
    subject: "tsub_test",
    nonce: "nonce-1",
    expiresAt: Date.now() + 60_000,
  });

  expect((await store.consumeAuthorizationCode("code-1"))?.nonce).toEqual("nonce-1");
  expect(await store.consumeAuthorizationCode("code-1")).toEqual(undefined);

  const jti = {
    jti: "lt_1",
    installationId: "inst_1",
    subject: "tsub_test" as const,
    audience: "takos.chat",
    expiresAt: Date.now() + 60_000,
    consumedAt: Date.now(),
  };
  expect(await store.consumeLaunchTokenJti(jti)).toEqual(true);
  expect(await store.consumeLaunchTokenJti(jti)).toEqual(false);
});

test("D1AccountsStore persists PAT metadata and billing usage indexes", async () => {
  const store = new D1AccountsStore(new MemoryD1Database());

  await store.savePersonalAccessToken("takpat_secret", {
    tokenId: "pat_1",
    tokenPrefix: "takpat_se",
    subject: "tsub_test",
    name: "CLI",
    scopes: ["read", "write"],
    createdAt: 1000,
    expiresAt: 2000,
  });
  expect((await store.findPersonalAccessToken("takpat_secret"))?.tokenId).toEqual("pat_1");
  expect((await store.listPersonalAccessTokensForSubject("tsub_test")).map((
      token,
    ) => token.name)).toEqual(["CLI"]);
  await store.recordPersonalAccessTokenUsed("pat_1", 1500);
  expect((await store.findPersonalAccessToken("takpat_secret"))?.lastUsedAt).toEqual(1500);
  expect((await store.revokePersonalAccessToken({
      subject: "tsub_test",
      tokenId: "pat_1",
      revokedAt: 1600,
    }))?.revokedAt).toEqual(1600);

  await store.saveBillingUsageRecord({
    usageReportId: "usage_report_1",
    installationId: "inst_1",
    billingAccountId: "bill_1",
    meter: "agent.compute.seconds",
    quantity: 12.5,
    unit: "seconds",
    requestDigest: "sha256:usage-1",
    metadata: { run_id: "run_1" },
    reportedAt: 3_000,
  });
  expect((await store.listBillingUsageRecordsForInstallation("inst_1")).map((
      record,
    ) => ({
      id: record.usageReportId,
      meter: record.meter,
      metadata: record.metadata,
    }))).toEqual([{
      id: "usage_report_1",
      meter: "agent.compute.seconds",
      metadata: { run_id: "run_1" },
    }]);
});

test("D1AccountsStore indexes OIDC clients and installation events", async () => {
  const store = new D1AccountsStore(new MemoryD1Database());

  await store.saveOidcClient({
    clientId: "toc_client",
    installationId: "inst_1",
    namespacePath: "identity.primary.oidc",
    issuerUrl: "https://accounts.example.test",
    redirectUris: ["http://localhost:8787/auth/oidc/callback"],
    allowedScopes: ["openid", "profile"],
    subjectMode: "pairwise",
    tokenEndpointAuthMethod: "client_secret_post",
    clientSecretHash: "sha256:test",
    createdAt: 1000,
    updatedAt: 1000,
  });

  expect((await store.findOidcClient("toc_client"))?.installationId).toEqual("inst_1");
  expect((await store.findOidcClientForInstallation("inst_1"))?.clientId).toEqual("toc_client");

  await store.appendInstallationEvent({
    eventId: "evt_1",
    installationId: "inst_1",
    eventType: "installation.created",
    payload: {},
    eventHash: "sha256:first",
    createdAt: 1000,
  });
  await store.appendInstallationEvent({
    eventId: "evt_2",
    installationId: "inst_1",
    eventType: "installation.status_changed",
    payload: { to: "ready" },
    previousEventHash: "sha256:first",
    eventHash: "sha256:second",
    createdAt: 2000,
  });

  expect((await store.listInstallationEvents("inst_1")).map((event) =>
      event.eventId
    )).toEqual(["evt_1", "evt_2"]);
});

test("D1AccountsStore prunes and consumes launch tokens", async () => {
  const store = new D1AccountsStore(new MemoryD1Database());
  const base = {
    installationId: "inst_1",
    accountId: "acct_1",
    spaceId: "space_1",
    appId: "takos.chat",
    subject: "tsub_test" as const,
    redirectUri: "https://takos.example.test/_takosumi/launch",
    scope: ["openid"],
    createdAt: 1_000,
  };
  await store.saveLaunchToken({
    ...base,
    installationId: "inst_expired",
    tokenHash: "sha256:expired",
    jti: "lt_expired",
    expiresAt: 2_000,
  });
  await store.saveLaunchToken({
    ...base,
    installationId: "inst_used",
    tokenHash: "sha256:used",
    jti: "lt_used",
    expiresAt: 10_000,
    usedAt: 3_000,
  });
  await store.saveLaunchToken({
    ...base,
    installationId: "inst_active",
    tokenHash: "sha256:active",
    jti: "lt_active",
    expiresAt: 10_000,
    createdAt: 4_000,
  });

  expect(await store.pruneLaunchTokens({ expiredBefore: 2_500, usedBefore: 3_500 })).toEqual({ deleted: 2, expired: 1, used: 1 });
  expect(await store.consumeLaunchToken({
      tokenHash: "sha256:expired",
      installationId: "inst_expired",
      redirectUri: base.redirectUri,
      consumedAt: 4_000,
    })).toEqual({ ok: false, reason: "not_found" });
  expect((await store.consumeLaunchToken({
      tokenHash: "sha256:active",
      installationId: "inst_active",
      redirectUri: base.redirectUri,
      consumedAt: 4_000,
    })).ok).toEqual(true);
});

test("D1AccountsStore launch token consume is atomic across concurrent races (F7)", async () => {
  // F7 race fix regression: when two consumers race on the same active
  // token, only one must succeed. The CAS UPDATE on the document body
  // is the mechanism; the loser observes a 0-rows-affected result and
  // we return `{ ok: false, reason: "used" }`.
  const store = new D1AccountsStore(new MemoryD1Database());
  await store.saveLaunchToken({
    tokenHash: "sha256:race",
    jti: "lt_race",
    installationId: "inst_race",
    accountId: "acct_race",
    spaceId: "space_race",
    appId: "takos.chat",
    subject: "tsub_test",
    redirectUri: "https://takos.example.test/_takosumi/launch",
    scope: ["openid"],
    expiresAt: 10_000,
    createdAt: 1_000,
  });

  const [first, second] = await Promise.all([
    store.consumeLaunchToken({
      tokenHash: "sha256:race",
      installationId: "inst_race",
      redirectUri: "https://takos.example.test/_takosumi/launch",
      consumedAt: 2_000,
    }),
    store.consumeLaunchToken({
      tokenHash: "sha256:race",
      installationId: "inst_race",
      redirectUri: "https://takos.example.test/_takosumi/launch",
      consumedAt: 2_001,
    }),
  ]);

  // Exactly one consumer wins; the other observes "used" semantics.
  const winners = [first, second].filter((result) => result.ok === true);
  const losers = [first, second].filter((result) => result.ok === false);
  expect(winners.length).toEqual(1);
  expect(losers.length).toEqual(1);
  // The loser must report the token as already consumed, not an
  // unrelated reason like "expired" or "not_found".
  for (const loser of losers) {
    if (loser.ok === false) {
      expect(loser.reason).toEqual("used");
    }
  }
});

test("D1AccountsStore addRefreshChainLink is an atomic single-winner claim (G6)", async () => {
  // G6 race fix regression: two concurrent rotations of the same parent
  // refresh token must not both register a child link. The INSERT OR
  // IGNORE keyed on the parent hash guarantees exactly one winner; the
  // loser observes a 0-rows-affected result and reports `false` so the
  // route layer treats it as reuse instead of minting a second family.
  const store = new D1AccountsStore(new MemoryD1Database());

  const [first, second] = await Promise.all([
    store.addRefreshChainLink("refresh-root", "refresh-child-a"),
    store.addRefreshChainLink("refresh-root", "refresh-child-b"),
  ]);

  const winners = [first, second].filter((linked) => linked === true);
  const losers = [first, second].filter((linked) => linked === false);
  expect(winners.length).toEqual(1);
  expect(losers.length).toEqual(1);
  // A child link is recorded for the parent, and a subsequent link attempt
  // for the same parent is rejected (sequential reuse path).
  const child = await store.getRefreshChainChild("refresh-root");
  expect(child !== undefined).toEqual(true);
  const thirdAttempt = await store.addRefreshChainLink(
    "refresh-root",
    "refresh-child-c",
  );
  expect(thirdAttempt).toEqual(false);
});

test("D1AccountsStore hashes session ids on write, read, and delete (F7)", async () => {
  const db = new MemoryD1Database();
  const store = new D1AccountsStore(db);
  registerSessionHashSaltConfig({ allowDevFallback: true });

  await store.saveAccountSession({
    sessionId: "raw-session-id",
    subject: "tsub_test",
    createdAt: 1_000,
    expiresAt: 9_000,
  });

  // The stored document key must not contain the raw sessionId.
  const storedKeys = [...db.documents.keys()].filter((key) =>
    key.startsWith("account_sessions\n")
  );
  expect(storedKeys.length).toEqual(1);
  const storedDocumentKey = storedKeys[0].slice("account_sessions\n".length);
  // Document key is the hash (sha256:base64url...), never the raw id.
  expect(storedDocumentKey.startsWith("sha256:")).toEqual(true);
  expect(storedDocumentKey.includes("raw-session-id")).toEqual(false);

  // Read by raw sessionId still works; the returned record exposes the
  // raw sessionId so logging/debugging keeps identity intact.
  const found = await store.findAccountSession("raw-session-id");
  expect(found?.sessionId).toEqual("raw-session-id");
  expect(found?.subject).toEqual("tsub_test");

  // Delete by raw sessionId removes the hashed row.
  await store.deleteAccountSession("raw-session-id");
  expect(await store.findAccountSession("raw-session-id")).toEqual(undefined);
});

test("D1AccountsStore rejects ledger account ownership conflicts (F7)", async () => {
  const store = new D1AccountsStore(new MemoryD1Database());
  await store.saveLedgerAccount({
    accountId: "acct_shared",
    legalOwnerSubject: "tsub_alice",
    createdAt: 1_000,
    updatedAt: 1_000,
  });

  // Re-saving with the same owner is a benign update.
  await store.saveLedgerAccount({
    accountId: "acct_shared",
    legalOwnerSubject: "tsub_alice",
    billingAccountId: "bill_1",
    createdAt: 1_000,
    updatedAt: 2_000,
  });
  expect((await store.findLedgerAccount("acct_shared"))?.billingAccountId).toEqual("bill_1");

  // A different owner is refused at the store boundary
  // (defense-in-depth).
  await assertRejects(
    () =>
      store.saveLedgerAccount({
        accountId: "acct_shared",
        legalOwnerSubject: "tsub_mallory",
        createdAt: 1_000,
        updatedAt: 3_000,
      }),
    LedgerAccountOwnershipConflictError,
  );
  // The existing owner must remain intact after the rejected write.
  expect((await store.findLedgerAccount("acct_shared"))?.legalOwnerSubject).toEqual("tsub_alice");
});

test("D1AccountsStore resolves a rotated child token to its root via the by-child index", async () => {
  const store = new D1AccountsStore(new MemoryD1Database());
  // root -> child -> grandchild rotation chain.
  await store.addRefreshChainLink("refresh-root", "refresh-child");
  await store.addRefreshChainLink("refresh-child", "refresh-grandchild");
  // isRefreshRootRevoked exercises #resolveRefreshChainRootHash: presenting a
  // deep child (only ever stored as a childHash VALUE, never a key) must
  // resolve to the chain root. Before the by-child index fix this required a
  // full-bucket scan; it must still resolve correctly.
  await store.revokeRefreshChain("refresh-grandchild");
  expect(await store.isRefreshRootRevoked("refresh-grandchild")).toEqual(true);
  expect(await store.isRefreshRootRevoked("refresh-root")).toEqual(true);
  expect(await store.isRefreshRootRevoked("refresh-child")).toEqual(true);
  expect(await store.isRefreshRootRevoked("unrelated")).toEqual(false);
});

test("D1AccountsStore links a no-offline_access auth code with the empty sentinel (PG/D1 parity)", async () => {
  const store = new D1AccountsStore(new MemoryD1Database());
  store.saveAccessToken("access-1", {
    clientId: "client-1",
    scope: "openid",
    subject: "tsub_test",
    expiresAt: Date.now() + 60_000,
  });
  store.markAuthorizationCodeConsumed("code-1");
  // No refresh root (the common non-offline_access flow). This must not throw
  // and the link must be revocable on code replay.
  await store.linkAccessTokenToAuthCode("code-1", "access-1");
  const cascade = await store.revokeTokensIssuedFromCode("code-1");
  // Exactly one access-token hash is revoked, and (crucially) the empty-string
  // refresh-root sentinel is NOT surfaced as a refresh root.
  expect(cascade.access.length).toEqual(1);
  expect(cascade.access[0].startsWith("sha256:")).toEqual(true);
  expect(cascade.refresh).toEqual([]);
  expect(await store.findAccessToken("access-1")).toEqual(undefined);
});

test("D1AccountsStore pruneRefreshChain removes rows past the cutoffs", async () => {
  const store = new D1AccountsStore(new MemoryD1Database());
  await store.addRefreshChainLink("refresh-root", "refresh-child");
  store.markAuthorizationCodeConsumed("code-1");
  await store.linkAccessTokenToAuthCode("code-1", "access-1", "refresh-root");
  await store.revokeRefreshChain("refresh-root");

  // Past cutoff: nothing is old enough to prune.
  const noop = await store.pruneRefreshChain({
    chainBefore: 0,
    consumedCodeBefore: 0,
  });
  expect(noop.chainLinks).toEqual(0);
  expect(await store.isAuthorizationCodeConsumed("code-1")).toEqual(true);

  // Future cutoff: every retention-managed row is removed.
  const future = Date.now() + 60_000;
  const pruned = await store.pruneRefreshChain({
    chainBefore: future,
    consumedCodeBefore: future,
  });
  expect(pruned.chainLinks).toEqual(1);
  expect(pruned.revokedRoots).toEqual(1);
  expect(pruned.consumedCodes).toEqual(1);
  expect(pruned.authCodeTokenLinks >= 1).toEqual(true);
  expect(await store.isAuthorizationCodeConsumed("code-1")).toEqual(false);
  expect(await store.isRefreshRootRevoked("refresh-root")).toEqual(false);
});

test("D1AccountsStore passkey challenge is single-shot and expiry-aware", async () => {
  const store = new D1AccountsStore(new MemoryD1Database());
  await store.savePasskeyChallenge("key-1", "challenge-1", 10_000);
  expect(await store.consumePasskeyChallenge("key-1", 5_000)).toEqual("challenge-1");
  // Single-shot: the second read is empty (delete-on-read).
  expect(await store.consumePasskeyChallenge("key-1", 5_000)).toEqual(undefined);
  // Expired challenge is not returned.
  await store.savePasskeyChallenge("key-2", "challenge-2", 1_000);
  expect(await store.consumePasskeyChallenge("key-2", 2_000)).toEqual(undefined);
});

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
    if (
      query.startsWith("INSERT OR REPLACE INTO takosumi_accounts_documents")
    ) {
      const [bucket, key, document] = this.#stringValues(3);
      this.db.documents.set(documentKey(bucket, key), document);
      this.db.lastChanges = 1;
      return Promise.resolve({ success: true, meta: { changes: 1 } });
    }
    if (
      query.startsWith("INSERT OR IGNORE INTO takosumi_accounts_documents")
    ) {
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
      this.db.indexes.set(
        indexRowKey(indexName, indexKey, bucket, key),
        { indexName, indexKey, bucket, documentKey: key, sortKey },
      );
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
      // CAS update: matches the SQLite UPDATE that the D1 store uses to
      // atomically claim a launch token (F7 fix). Replace the row only
      // when the current document equals the expected document. The
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
      return Promise.resolve(
        document ? ({ document } as T) : null,
      );
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
      return Promise.resolve(
        document ? ({ document } as T) : null,
      );
    }
    if (query === "SELECT changes() AS changes") {
      return Promise.resolve({ changes: this.db.lastChanges } as T);
    }
    throw new Error(`unexpected D1 first query: ${this.query}`);
  }

  all<T = unknown>(): Promise<D1Result<T>> {
    const query = normalizedQuery(this.query);
    if (query.startsWith("SELECT d.document FROM takosumi_accounts_indexes")) {
      const [indexName, indexKey] = this.#stringValues(2);
      const rows = [...this.db.indexes.values()]
        .filter((row) =>
          row.indexName === indexName && row.indexKey === indexKey
        )
        .sort((left, right) =>
          left.sortKey - right.sortKey ||
          left.documentKey.localeCompare(right.documentKey)
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

function numberValue(value: D1Value): number {
  if (typeof value !== "number") {
    throw new TypeError(`expected number D1 bind value, got ${typeof value}`);
  }
  return value;
}
