import { afterEach, expect, test } from "bun:test";
import { Miniflare } from "miniflare";
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
import { sha256Text } from "../../../../accounts/service/src/encoding.ts";
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
  await store.revokeOidcClient("oidc_d1");
  expect(await store.findOidcClient("oidc_d1")).toBeUndefined();
  expect(await store.findOidcClientForCapsule("cap_d1")).toBeUndefined();
});

test("D1AccountsStore claims and finalizes one authorization-code lifecycle", async () => {
  const store = new D1AccountsStore(new SqliteFakeD1());
  const record = {
    clientId: "client_d1_code",
    redirectUri: "https://app.example.test/callback",
    scope: "openid",
    subject: "tsub_d1_code",
    codeChallenge: "challenge",
    codeChallengeMethod: "S256" as const,
    expiresAt: 60_000,
  };
  await store.saveAuthorizationCode("plain-d1-code", record);

  const opened = await store.openAuthorizationCodeRedemption("plain-d1-code");
  expect(opened.status).toBe("active");
  if (opened.status !== "active") return;
  expect(opened.candidate.record).toEqual(record);
  const claim = await store.claimValidatedAuthorizationCode(opened.candidate);
  expect(claim.status).toBe("claimed");
  if (claim.status !== "claimed") return;
  expect(
    await store.finalizeAuthorizationCodeRedemption({
      code: "plain-d1-code",
      claimId: claim.claimId,
      accessToken: "plain-d1-access",
      accessRecord: {
        clientId: record.clientId,
        scope: record.scope,
        subject: record.subject,
        expiresAt: 120_000,
      },
    }),
  ).toEqual({ status: "issued" });
  expect((await store.findAccessToken("plain-d1-access"))?.subject).toBe(
    record.subject,
  );
});

test("D1AccountsStore makes a second validated claim replay the first", async () => {
  const store = new D1AccountsStore(new SqliteFakeD1());
  const record = authorizationCodeRecord("d1-two-claimants");
  await store.saveAuthorizationCode("d1-code-two-claimants", record);
  const first = await store.openAuthorizationCodeRedemption(
    "d1-code-two-claimants",
  );
  const second = await store.openAuthorizationCodeRedemption(
    "d1-code-two-claimants",
  );
  if (first.status !== "active" || second.status !== "active") {
    throw new Error("expected two active validation snapshots");
  }
  const winner = await store.claimValidatedAuthorizationCode(first.candidate);
  const loser = await store.claimValidatedAuthorizationCode(second.candidate);
  expect(winner.status).toBe("claimed");
  expect(loser).toEqual({ status: "replayed" });
  if (winner.status !== "claimed") return;
  expect(
    await store.finalizeAuthorizationCodeRedemption({
      code: "d1-code-two-claimants",
      claimId: winner.claimId,
      accessToken: "d1-access-loser",
      accessRecord: oauthTokenRecord(record),
    }),
  ).toEqual({ status: "replayed" });
  expect(await store.findAccessToken("d1-access-loser")).toBeUndefined();
});

test("D1AccountsStore replay atomically revokes issued and rotated descendants", async () => {
  const store = new D1AccountsStore(new SqliteFakeD1());
  const code = "d1-code-replay-descendants";
  const record = authorizationCodeRecord("d1-replay-descendants");
  await store.saveAuthorizationCode(code, record);
  const opened = await store.openAuthorizationCodeRedemption(code);
  if (opened.status !== "active") throw new Error("expected active code");
  const claim = await store.claimValidatedAuthorizationCode(opened.candidate);
  if (claim.status !== "claimed") throw new Error("expected claim winner");
  expect(
    await store.finalizeAuthorizationCodeRedemption({
      code,
      claimId: claim.claimId,
      accessToken: "d1-access-root",
      accessRecord: oauthTokenRecord(record),
      refreshToken: "d1-refresh-root",
      refreshRecord: oauthTokenRecord(record),
    }),
  ).toEqual({ status: "issued" });
  expect(
    await store.addRefreshChainLink("d1-refresh-root", "d1-refresh-child"),
  ).toBe(true);
  await store.saveRefreshToken("d1-refresh-child", oauthTokenRecord(record));
  await store.saveAccessToken("d1-access-descendant", oauthTokenRecord(record));
  await store.linkAccessTokenToRefreshChain(
    "d1-refresh-child",
    "d1-access-descendant",
  );

  expect(await store.openAuthorizationCodeRedemption(code)).toEqual({
    status: "replayed",
  });
  expect(await store.findAccessToken("d1-access-root")).toBeUndefined();
  expect(await store.findAccessToken("d1-access-descendant")).toBeUndefined();
  expect(await store.findRefreshToken("d1-refresh-root")).toBeUndefined();
  expect(await store.findRefreshToken("d1-refresh-child")).toBeUndefined();
});

test("D1AccountsStore replay revokes every preserved legacy token link", async () => {
  const db = new SqliteFakeD1();
  const store = new D1AccountsStore(db);
  const code = "d1-code-multi-link-replay";
  const record = authorizationCodeRecord("d1-multi-link-replay");
  await store.saveAuthorizationCode(code, record);
  const opened = await store.openAuthorizationCodeRedemption(code);
  if (opened.status !== "active") throw new Error("expected active code");
  const claim = await store.claimValidatedAuthorizationCode(opened.candidate);
  if (claim.status !== "claimed") throw new Error("expected claim winner");
  expect(
    await store.finalizeAuthorizationCodeRedemption({
      code,
      claimId: claim.claimId,
      accessToken: "d1-multi-access-a",
      accessRecord: oauthTokenRecord(record),
      refreshToken: "d1-multi-refresh-a",
      refreshRecord: oauthTokenRecord(record),
    }),
  ).toEqual({ status: "issued" });

  const secondAccess = "d1-multi-access-b";
  const secondRefresh = "d1-multi-refresh-b";
  const secondChild = "d1-multi-refresh-b-child";
  const secondDescendant = "d1-multi-access-b-descendant";
  await store.saveAccessToken(secondAccess, oauthTokenRecord(record));
  await store.saveRefreshToken(secondRefresh, oauthTokenRecord(record));
  expect(await store.addRefreshChainLink(secondRefresh, secondChild)).toBe(
    true,
  );
  await store.saveRefreshToken(secondChild, oauthTokenRecord(record));
  await store.saveAccessToken(secondDescendant, oauthTokenRecord(record));
  await store.linkAccessTokenToRefreshChain(secondChild, secondDescendant);

  const [codeHash, accessHash, refreshHash] = await Promise.all([
    sha256Text(code),
    sha256Text(secondAccess),
    sha256Text(secondRefresh),
  ]);
  const linkKey = `${codeHash}\n${accessHash}\n${refreshHash}`;
  await db
    .prepare(
      `INSERT INTO takosumi_accounts_documents (
         bucket, key, document, updated_at
       ) VALUES ('auth_code_token_links', ?, ?, ?)`,
    )
    .bind(
      linkKey,
      JSON.stringify({
        codeHash,
        accessTokenHash: accessHash,
        refreshRootHash: refreshHash,
        createdAt: Date.now(),
      }),
      Date.now(),
    )
    .run();

  expect(await store.openAuthorizationCodeRedemption(code)).toEqual({
    status: "replayed",
  });
  expect(await store.findAccessToken("d1-multi-access-a")).toBeUndefined();
  expect(await store.findRefreshToken("d1-multi-refresh-a")).toBeUndefined();
  expect(await store.findAccessToken(secondAccess)).toBeUndefined();
  expect(await store.findRefreshToken(secondRefresh)).toBeUndefined();
  expect(await store.findRefreshToken(secondChild)).toBeUndefined();
  expect(await store.findAccessToken(secondDescendant)).toBeUndefined();
});

test("D1AccountsStore rejects a stale candidate without deleting its replacement", async () => {
  const store = new D1AccountsStore(new SqliteFakeD1());
  const code = "d1-code-substitution";
  await store.saveAuthorizationCode(code, authorizationCodeRecord("record-a"));
  const recordA = await store.openAuthorizationCodeRedemption(code);
  if (recordA.status !== "active") throw new Error("expected record A");
  await store.saveAuthorizationCode(code, authorizationCodeRecord("record-b"));

  expect(
    await store.claimValidatedAuthorizationCode(recordA.candidate),
  ).toEqual({ status: "stale" });
  const recordB = await store.openAuthorizationCodeRedemption(code);
  expect(recordB.status).toBe("active");
  if (recordB.status === "active") {
    expect(recordB.candidate.record.subject).toBe("record-b");
  }
});

test("D1AccountsStore rolls back a failed finalize batch without partial tokens", async () => {
  const db = new FailingBatchD1();
  const store = new D1AccountsStore(db);
  const code = "d1-code-batch-failure";
  const record = authorizationCodeRecord("d1-batch-failure");
  await store.saveAuthorizationCode(code, record);
  const opened = await store.openAuthorizationCodeRedemption(code);
  if (opened.status !== "active") throw new Error("expected active code");
  const claim = await store.claimValidatedAuthorizationCode(opened.candidate);
  if (claim.status !== "claimed") throw new Error("expected claim winner");

  db.failNextBatchAt(2);
  await expect(
    store.finalizeAuthorizationCodeRedemption({
      code,
      claimId: claim.claimId,
      accessToken: "d1-access-partial",
      accessRecord: oauthTokenRecord(record),
      refreshToken: "d1-refresh-partial",
      refreshRecord: oauthTokenRecord(record),
    }),
  ).rejects.toThrow("injected D1 lifecycle batch failure");
  expect(await store.findAccessToken("d1-access-partial")).toBeUndefined();
  expect(await store.findRefreshToken("d1-refresh-partial")).toBeUndefined();
  expect(await store.openAuthorizationCodeRedemption(code)).toEqual({
    status: "replayed",
  });
});

test("workerd D1 linearizes replay before finalize without persisting tokens", async () => {
  const runtime = new Miniflare({
    compatibilityDate: "2026-07-17",
    modules: [
      {
        type: "ESModule",
        path: "authorization-code-lifecycle-workerd.mjs",
        contents: "export default {fetch(){return new Response('ok')}}",
      },
    ],
    d1Databases: { ACCOUNTS: "authorization-code-lifecycle-workerd" },
  });
  try {
    const rawDb = await runtime.getD1Database("ACCOUNTS");
    const store = new D1AccountsStore(rawDb as unknown as D1Database);
    const code = "workerd-code-replay-before-finalize";
    const record = authorizationCodeRecord("workerd-replay-before-finalize");
    await store.saveAuthorizationCode(code, record);
    const opened = await store.openAuthorizationCodeRedemption(code);
    if (opened.status !== "active") throw new Error("expected active code");
    const claim = await store.claimValidatedAuthorizationCode(opened.candidate);
    if (claim.status !== "claimed") throw new Error("expected claim winner");

    expect(await store.openAuthorizationCodeRedemption(code)).toEqual({
      status: "replayed",
    });
    expect(
      await store.finalizeAuthorizationCodeRedemption({
        code,
        claimId: claim.claimId,
        accessToken: "workerd-access-must-not-survive",
        accessRecord: oauthTokenRecord(record),
        refreshToken: "workerd-refresh-must-not-survive",
        refreshRecord: oauthTokenRecord(record),
      }),
    ).toEqual({ status: "replayed" });
    expect(
      await store.findAccessToken("workerd-access-must-not-survive"),
    ).toBeUndefined();
    expect(
      await store.findRefreshToken("workerd-refresh-must-not-survive"),
    ).toBeUndefined();
  } finally {
    await runtime.dispose();
  }
});

test("D1 authorization-code transitions use exactly one durable batch each", async () => {
  const db = new CountingD1Database();
  const store = new D1AccountsStore(db);
  await store.initialize();
  db.resetBatchCount();
  const code = "d1-single-batch-code";
  const record = authorizationCodeRecord("d1-single-batch");

  await store.saveAuthorizationCode(code, record);
  expect(db.batchCount).toBe(1);
  const opened = await store.openAuthorizationCodeRedemption(code);
  expect(db.batchCount).toBe(2);
  if (opened.status !== "active") throw new Error("expected active code");
  const claim = await store.claimValidatedAuthorizationCode(opened.candidate);
  expect(db.batchCount).toBe(3);
  if (claim.status !== "claimed") throw new Error("expected claim winner");
  expect(
    await store.finalizeAuthorizationCodeRedemption({
      code,
      claimId: claim.claimId,
      accessToken: "d1-single-batch-access",
      accessRecord: oauthTokenRecord(record),
    }),
  ).toEqual({ status: "issued" });
  expect(db.batchCount).toBe(4);
  expect(await store.openAuthorizationCodeRedemption(code)).toEqual({
    status: "replayed",
  });
  expect(db.batchCount).toBe(5);
});

test("D1AccountsStore predeployed mode performs zero DDL across document operations", async () => {
  registerSessionHashSaltConfig({ salt: "d1-predeployed-session-salt" });
  const db = new CountingD1Database();
  await new D1AccountsStore(db).initialize();
  db.resetExecCount();

  const store = new D1AccountsStore(db, { schemaMode: "predeployed" });
  await store.initialize();
  await store.saveAccount({
    subject: "tsub_predeployed",
    email: "predeployed@example.test",
    emailVerified: true,
    createdAt: 1_000,
    updatedAt: 1_000,
  });
  await store.saveAccountSession({
    sessionId: "sess_predeployed",
    subject: "tsub_predeployed",
    createdAt: 1_000,
    expiresAt: 60_000,
  });

  expect((await store.findAccount("tsub_predeployed"))?.email).toBe(
    "predeployed@example.test",
  );
  expect(
    (await store.findAccountByVerifiedEmail("predeployed@example.test"))
      ?.subject,
  ).toBe("tsub_predeployed");
  expect((await store.findAccountSession("sess_predeployed"))?.subject).toBe(
    "tsub_predeployed",
  );

  await store.deleteAccountSession("sess_predeployed");
  expect(await store.findAccountSession("sess_predeployed")).toBeUndefined();
  expect(db.execCount).toBe(0);
});

test("D1AccountsStore predeployed mode fails closed on a missing schema without DDL", async () => {
  const db = new CountingD1Database();
  const store = new D1AccountsStore(db, { schemaMode: "predeployed" });

  await expect(store.findAccount("tsub_missing_schema")).rejects.toThrow();
  expect(db.execCount).toBe(0);
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

test("D1AccountsStore rotates sessions with one durable compare-and-replace batch", async () => {
  registerSessionHashSaltConfig({ salt: "d1-session-rotation-salt" });
  const db = new MemoryD1Database();
  const store = new D1AccountsStore(db);
  const previous = {
    sessionId: "sess_previous",
    subject: "tsub_rotation" as const,
    createdAt: 1_000,
    expiresAt: 60_000,
  };
  const next = {
    sessionId: "sess_next",
    subject: "tsub_rotation" as const,
    createdAt: 2_000,
    expiresAt: 120_000,
  };
  await store.saveAccountSession(previous);

  db.failNextBatchAt(1);
  await expect(
    store.replaceAccountSession(previous.sessionId, next),
  ).rejects.toThrow("injected D1 batch failure");
  expect(await store.findAccountSession(previous.sessionId)).toEqual(previous);
  expect(await store.findAccountSession(next.sessionId)).toBeUndefined();

  expect(await store.replaceAccountSession(previous.sessionId, next)).toBe(
    true,
  );
  expect(await store.findAccountSession(previous.sessionId)).toBeUndefined();
  expect(await store.findAccountSession(next.sessionId)).toEqual(next);
  expect(
    await store.replaceAccountSession(previous.sessionId, {
      ...next,
      sessionId: "sess_lost_race",
    }),
  ).toBe(false);
  expect(await store.findAccountSession("sess_lost_race")).toBeUndefined();
});

test("D1AccountsStore updates account documents and verified-email indexes atomically", async () => {
  const db = new MemoryD1Database();
  const store = new D1AccountsStore(db);
  await store.saveAccount({
    subject: "tsub_atomic_index",
    email: "before@example.test",
    emailVerified: true,
    createdAt: 1_000,
    updatedAt: 1_000,
  });

  db.failNextBatchAt(2);
  await expect(
    store.saveAccount({
      subject: "tsub_atomic_index",
      email: "after@example.test",
      emailVerified: true,
      createdAt: 1_000,
      updatedAt: 2_000,
    }),
  ).rejects.toThrow("injected D1 batch failure");

  expect((await store.findAccount("tsub_atomic_index"))?.email).toBe(
    "before@example.test",
  );
  expect(
    (await store.findAccountByVerifiedEmail("before@example.test"))?.subject,
  ).toBe("tsub_atomic_index");
  expect(
    await store.findAccountByVerifiedEmail("after@example.test"),
  ).toBeUndefined();
});

function authorizationCodeRecord(subject: string) {
  return {
    clientId: "client_d1_lifecycle",
    redirectUri: "https://app.example.test/callback",
    scope: "openid offline_access",
    subject,
    codeChallenge: "challenge",
    codeChallengeMethod: "S256" as const,
    expiresAt: Date.now() + 60_000,
  };
}

function oauthTokenRecord(record: ReturnType<typeof authorizationCodeRecord>) {
  return {
    clientId: record.clientId,
    scope: record.scope,
    subject: record.subject,
    expiresAt: Date.now() + 60_000,
  };
}

class FailingBatchD1 implements D1Database {
  readonly #delegate = new SqliteFakeD1();
  #failAt?: number;

  prepare(query: string): D1PreparedStatement {
    return this.#delegate.prepare(query);
  }

  exec(query: string): Promise<D1ExecResult> {
    return this.#delegate.exec(query);
  }

  batch<T = unknown>(
    statements: readonly D1PreparedStatement[],
  ): Promise<readonly D1Result<T>[]> {
    const failAt = this.#failAt;
    this.#failAt = undefined;
    if (failAt === undefined) {
      return this.#delegate.batch(statements) as Promise<
        readonly D1Result<T>[]
      >;
    }
    let index = 0;
    const wrapped = statements.map(
      (statement) =>
        new FailingD1Statement(statement, () => index++ === failAt),
    );
    return this.#delegate.batch(wrapped) as Promise<readonly D1Result<T>[]>;
  }

  failNextBatchAt(statementIndex: number): void {
    this.#failAt = statementIndex;
  }
}

class FailingD1Statement implements D1PreparedStatement {
  constructor(
    private readonly delegate: D1PreparedStatement,
    private readonly shouldFail: () => boolean,
  ) {}

  bind(...values: readonly D1Value[]): D1PreparedStatement {
    return new FailingD1Statement(
      this.delegate.bind(...values),
      this.shouldFail,
    );
  }

  run<T = unknown>(): Promise<D1Result<T>> {
    if (this.shouldFail()) {
      throw new Error("injected D1 lifecycle batch failure");
    }
    return this.delegate.run() as Promise<D1Result<T>>;
  }

  first<T = unknown>(column?: string): Promise<T | null> {
    return this.delegate.first<T>(column);
  }

  all<T = unknown>(): Promise<D1Result<T>> {
    return this.delegate.all<T>();
  }
}

class CountingD1Database implements D1Database {
  readonly #delegate = new SqliteFakeD1();
  execCount = 0;
  prepareCount = 0;
  batchCount = 0;

  prepare(query: string): D1PreparedStatement {
    this.prepareCount += 1;
    return this.#delegate.prepare(query);
  }

  exec(query: string): Promise<D1ExecResult> {
    this.execCount += 1;
    return this.#delegate.exec(query);
  }

  batch<T = unknown>(
    statements: readonly D1PreparedStatement[],
  ): Promise<readonly D1Result<T>[]> {
    this.batchCount += 1;
    return this.#delegate.batch(statements) as Promise<readonly D1Result<T>[]>;
  }

  resetBatchCount(): void {
    this.batchCount = 0;
  }

  resetPrepareCount(): void {
    this.prepareCount = 0;
  }

  resetExecCount(): void {
    this.execCount = 0;
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
  #failBatchAt?: number;

  prepare(query: string): D1PreparedStatement {
    return new MemoryD1Statement(this, query);
  }

  exec(_query: string): Promise<D1ExecResult> {
    this.execCount += 1;
    return Promise.resolve({ count: 1, duration: 0 });
  }

  async batch<T = unknown>(
    statements: readonly D1PreparedStatement[],
  ): Promise<readonly D1Result<T>[]> {
    const documents = new Map(this.documents);
    const indexes = new Map(this.indexes);
    const previousChanges = this.lastChanges;
    const failAt = this.#failBatchAt;
    this.#failBatchAt = undefined;
    try {
      const results: D1Result<T>[] = [];
      for (let index = 0; index < statements.length; index += 1) {
        if (index === failAt) throw new Error("injected D1 batch failure");
        results.push((await statements[index]!.run()) as D1Result<T>);
      }
      return results;
    } catch (error) {
      this.documents.clear();
      for (const [key, value] of documents) this.documents.set(key, value);
      this.indexes.clear();
      for (const [key, value] of indexes) this.indexes.set(key, value);
      this.lastChanges = previousChanges;
      throw error;
    }
  }

  failNextBatchAt(statementIndex: number): void {
    this.#failBatchAt = statementIndex;
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
        "insert into takosumi_accounts_documents (bucket, key, document, updated_at) select 'account_sessions', ?, ?, ? where exists",
      )
    ) {
      const [nextKey, nextDocument] = this.#stringValues(2);
      const previousKey = stringBindValue(this.#rawValues()[3]);
      if (this.db.documents.has(documentKey("account_sessions", previousKey))) {
        this.db.documents.set(
          documentKey("account_sessions", nextKey),
          nextDocument,
        );
        this.db.lastChanges = 1;
      } else {
        this.db.lastChanges = 0;
      }
      return Promise.resolve({
        success: true,
        meta: { changes: this.db.lastChanges },
      });
    }
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
        "DELETE FROM takosumi_accounts_documents WHERE bucket = 'account_sessions' AND key = ?",
      )
    ) {
      const [key] = this.#stringValues(1);
      this.db.lastChanges = this.db.documents.delete(
        documentKey("account_sessions", key),
      )
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
