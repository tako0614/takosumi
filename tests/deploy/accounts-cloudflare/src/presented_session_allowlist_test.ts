import { afterEach, expect, test } from "bun:test";

import {
  rejectDisallowedCloudflarePresentedSession,
  type CloudflareWorkerEnv,
} from "../../../../deploy/accounts-cloudflare/src/handler.ts";
import type {
  D1Database,
  D1ExecResult,
  D1PreparedStatement,
  D1Result,
  D1Value,
} from "../../../../accounts/service/src/mod.ts";
import {
  __resetSessionHashSaltConfigForTesting,
  hashSessionIdWithSalt,
} from "../../../../accounts/service/src/session-hash-salt.ts";

afterEach(() => {
  __resetSessionHashSaltConfigForTesting();
});

test("unconfigured presented-session allowlist performs zero D1 I/O", async () => {
  const forbiddenDb = new Proxy(
    {},
    {
      get(_target, property) {
        throw new Error(`unconfigured allowlist touched D1.${String(property)}`);
      },
    },
  ) as D1Database;

  await expect(
    rejectDisallowedCloudflarePresentedSession({
      request: new Request("https://platform.example.test/bootstrap"),
      env: {
        TAKOSUMI_ACCOUNTS_DB: forbiddenDb,
      } as CloudflareWorkerEnv,
      sessionCredential: "sess_unconfigured_allowlist",
    }),
  ).resolves.toBeUndefined();
});

test.each([
  [
    "malformed allowlist access config",
    {
      TAKOSUMI_ACCOUNTS_LOGIN_EMAIL_ALLOWLIST: "allowed@example.test",
      TAKOSUMI_ACCOUNTS_PLATFORM_ACCESS: "restricted",
    },
  ],
  [
    "closed access without a non-empty allowlist",
    {
      TAKOSUMI_ACCOUNTS_LOGIN_EMAIL_ALLOWLIST: "*",
      TAKOSUMI_ACCOUNTS_PLATFORM_ACCESS: "closed",
    },
  ],
  [
    "an invalid verified-email boolean",
    {
      TAKOSUMI_ACCOUNTS_LOGIN_EMAIL_ALLOWLIST: "allowed@example.test",
      TAKOSUMI_ACCOUNTS_LOGIN_EMAIL_ALLOWLIST_REQUIRE_VERIFIED: "sometimes",
    },
  ],
] as const)(
  "absent presented session bypasses %s before config, salt, or D1 work",
  async (_label, config) => {
    const env = new Proxy(
      {
        TAKOSUMI_ACCOUNTS_DB: forbiddenD1("absent presented session"),
        ...config,
      },
      {
        get(target, property, receiver) {
          if (property === "TAKOSUMI_ACCOUNT_SESSION_HASH_SALT") {
            throw new Error("absent presented session read session hash salt");
          }
          return Reflect.get(target, property, receiver);
        },
      },
    ) as CloudflareWorkerEnv;

    await expect(
      rejectDisallowedCloudflarePresentedSession({
        request: new Request("https://platform.example.test/bootstrap"),
        env,
        sessionCredential: null,
      }),
    ).resolves.toBeUndefined();
  },
);

test("allowlisted presented session performs one bounded SELECT and no initialization", async () => {
  const db = new RecordingD1([
    {
      kind: "session",
      document: JSON.stringify({
        sessionId: "stored-session-hash",
        subject: "tsub_allowlisted_session",
        createdAt: 1_000,
        expiresAt: Date.now() + 60_000,
      }),
    },
    {
      kind: "session_account",
      document: JSON.stringify({
        subject: "tsub_allowlisted_session",
        email: "allowed@example.test",
        emailVerified: true,
        createdAt: 500,
        updatedAt: 1_500,
      }),
    },
  ]);

  await expect(
    rejectDisallowedCloudflarePresentedSession({
      request: new Request("https://platform.example.test/bootstrap"),
      env: {
        TAKOSUMI_ACCOUNTS_DB: db,
        TAKOSUMI_ACCOUNTS_LOGIN_EMAIL_ALLOWLIST: "allowed@example.test",
        TAKOSUMI_ACCOUNT_SESSION_HASH_SALT: "allowlisted-session-test-salt",
      } as CloudflareWorkerEnv,
      sessionCredential: "sess_allowlisted_presented",
    }),
  ).resolves.toBeUndefined();

  expect(db.prepared).toHaveLength(1);
  expect(db.prepared[0]?.trimStart().toLowerCase()).toStartWith("with");
  expect(db.prepared[0]?.toLowerCase()).toContain("select");
  expect(db.bound).toHaveLength(1);
  expect(db.bound[0]).toHaveLength(3);
  expect(db.bound[0]).not.toContain("sess_allowlisted_presented");
  expect(db.allCalls).toBe(1);
  expect(db.firstCalls).toBe(0);
  expect(db.runCalls).toBe(0);
  expect(db.batchCalls).toBe(0);
  expect(db.execCalls).toBe(0);
});

test("disallowed presented session is canonically rejected and exactly revoked", async () => {
  const db = new RecordingD1([
    {
      kind: "session",
      document: JSON.stringify({
        sessionId: "stored-session-hash",
        subject: "tsub_disallowed_session",
        createdAt: 1_000,
        expiresAt: Date.now() + 60_000,
      }),
    },
    {
      kind: "session_account",
      document: JSON.stringify({
        subject: "tsub_disallowed_session",
        email: "removed@example.test",
        emailVerified: true,
        createdAt: 500,
        updatedAt: 1_500,
      }),
    },
  ]);
  const requestId = "11111111-1111-4111-8111-111111111111";
  const response = await rejectDisallowedCloudflarePresentedSession({
    request: new Request("https://platform.example.test/bootstrap", {
      headers: { "x-request-id": requestId },
    }),
    env: {
      TAKOSUMI_ACCOUNTS_DB: db,
      TAKOSUMI_ACCOUNTS_LOGIN_EMAIL_ALLOWLIST: "allowed@example.test",
      TAKOSUMI_ACCOUNT_SESSION_HASH_SALT: "disallowed-session-test-salt",
    } as CloudflareWorkerEnv,
    sessionCredential: "sess_disallowed_presented",
  });

  expect(response?.status).toBe(403);
  expect(await response?.json()).toEqual({
    error: {
      code: "login_not_allowed",
      message: "This deployment limits preview access before launch.",
      requestId,
    },
  });
  expect(response?.headers.get("cache-control")).toBe("no-store");
  expect(response?.headers.get("set-cookie")).toBe(
    "takosumi_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure",
  );
  expect(db.allCalls).toBe(1);
  expect(db.batchCalls).toBe(1);
  expect(db.batchStatementCount).toBe(2);
  expect(db.execCalls).toBe(0);
  expect(db.prepared[1]).toBe(
    "DELETE FROM takosumi_accounts_documents WHERE bucket = ? AND key = ?",
  );
  expect(db.bound[1]?.[0]).toBe("account_sessions");
  expect(db.bound[1]?.[1]).toBeString();
  expect(db.bound[1]?.[1]).not.toBe("sess_disallowed_presented");
  expect(db.prepared[2]).toBe(
    "DELETE FROM takosumi_accounts_indexes WHERE bucket = ? AND document_key = ?",
  );
  expect(db.bound[2]).toEqual(db.bound[1]);
});

test("same raw session is re-read and rejected in a second Cloudflare environment", async () => {
  const credential = "sess_same_raw_cloudflare_environments";
  const allowedDb = new RecordingD1(
    presentedSessionRows({
      subject: "tsub_cloudflare_same_raw_allowed",
      email: "allowed@example.test",
    }),
  );
  const disallowedDb = new RecordingD1(
    presentedSessionRows({
      subject: "tsub_cloudflare_same_raw_disallowed",
      email: "removed@example.test",
    }),
  );

  await expect(
    rejectDisallowedCloudflarePresentedSession({
      request: new Request("https://a.example.test/bootstrap"),
      env: configuredEnv(allowedDb, "same-raw-cloudflare-salt-a"),
      sessionCredential: credential,
    }),
  ).resolves.toBeUndefined();

  const rejected = await rejectDisallowedCloudflarePresentedSession({
    request: new Request("https://b.example.test/bootstrap"),
    env: configuredEnv(disallowedDb, "same-raw-cloudflare-salt-b"),
    sessionCredential: credential,
  });
  expect(rejected?.status).toBe(403);
  expect(disallowedDb.allCalls).toBe(1);
  expect(disallowedDb.batchCalls).toBe(1);
});

test("concurrent Cloudflare environments keep lookup and deletion on one immutable salt", async () => {
  const credential = "sess_concurrent_cloudflare_salts";
  const saltA = "concurrent-cloudflare-session-salt-a";
  const saltB = "concurrent-cloudflare-session-salt-b";
  const hashA = await hashSessionIdWithSalt(credential, saltA);
  const hashB = await hashSessionIdWithSalt(credential, saltB);
  const dbA = new RecordingD1(
    presentedSessionRows({
      subject: "tsub_concurrent_cloudflare_disallowed",
      email: "removed@example.test",
    }),
  );
  const dbB = new RecordingD1(
    presentedSessionRows({
      subject: "tsub_concurrent_cloudflare_allowed",
      email: "allowed@example.test",
    }),
  );
  const lookupStarted = deferred();
  const releaseLookup = deferred();
  dbA.allStarted = lookupStarted.resolve;
  dbA.allGate = releaseLookup.promise;

  const pendingA = rejectDisallowedCloudflarePresentedSession({
    request: new Request("https://a.example.test/bootstrap"),
    env: configuredEnv(dbA, saltA),
    sessionCredential: credential,
  });
  await lookupStarted.promise;

  await expect(
    rejectDisallowedCloudflarePresentedSession({
      request: new Request("https://b.example.test/bootstrap"),
      env: configuredEnv(dbB, saltB),
      sessionCredential: credential,
    }),
  ).resolves.toBeUndefined();
  releaseLookup.resolve();

  const rejectedA = await pendingA;
  expect(rejectedA?.status).toBe(403);
  expect(dbA.bound[0]?.[0]).toBe(hashA);
  expect(dbA.bound[1]?.[1]).toBe(hashA);
  expect(dbA.bound[1]?.[1]).not.toBe(hashB);
  expect(dbB.bound[0]?.[0]).toBe(hashB);
});

test.each([
  [
    "closed access without a non-empty allowlist",
    {
      TAKOSUMI_ACCOUNTS_LOGIN_EMAIL_ALLOWLIST: "*",
      TAKOSUMI_ACCOUNTS_PLATFORM_ACCESS: "closed",
      TAKOSUMI_ACCOUNT_SESSION_HASH_SALT: "unused-config-test-salt",
    },
    "requires a non-empty",
  ],
  [
    "an invalid verified-email boolean",
    {
      TAKOSUMI_ACCOUNTS_LOGIN_EMAIL_ALLOWLIST: "allowed@example.test",
      TAKOSUMI_ACCOUNTS_LOGIN_EMAIL_ALLOWLIST_REQUIRE_VERIFIED: "sometimes",
      TAKOSUMI_ACCOUNT_SESSION_HASH_SALT: "unused-boolean-test-salt",
    },
    "expected a boolean string",
  ],
  [
    "a missing session hash salt",
    {
      TAKOSUMI_ACCOUNTS_LOGIN_EMAIL_ALLOWLIST: "allowed@example.test",
    },
    "must be set",
  ],
  [
    "a non-string session hash salt",
    {
      TAKOSUMI_ACCOUNTS_LOGIN_EMAIL_ALLOWLIST: "allowed@example.test",
      TAKOSUMI_ACCOUNT_SESSION_HASH_SALT: true,
    },
    "must be set",
  ],
] as const)("%s fails closed before D1 I/O", async (_label, config, message) => {
  const db = forbiddenD1("invalid presented-session configuration");
  await expect(
    rejectDisallowedCloudflarePresentedSession({
      request: new Request("https://platform.example.test/bootstrap"),
      env: {
        TAKOSUMI_ACCOUNTS_DB: db,
        ...config,
      } as CloudflareWorkerEnv,
      sessionCredential: "sess_invalid_presented_config",
    }),
  ).rejects.toThrow(message);
});

test("configured allowlist fails closed when the Accounts D1 binding is missing", async () => {
  await expect(
    rejectDisallowedCloudflarePresentedSession({
      request: new Request("https://platform.example.test/bootstrap"),
      env: {
        TAKOSUMI_ACCOUNTS_LOGIN_EMAIL_ALLOWLIST: "allowed@example.test",
        TAKOSUMI_ACCOUNT_SESSION_HASH_SALT: "missing-db-test-salt",
      } as CloudflareWorkerEnv,
      sessionCredential: "sess_missing_db",
    }),
  ).rejects.toThrow("TAKOSUMI_ACCOUNTS_DB D1 binding is required");
});

test.each([
  ["a thrown D1 error", new Error("Accounts D1 unavailable"), undefined],
  [
    "a failed D1 result",
    undefined,
    { success: false, results: [] } satisfies D1Result,
  ],
  [
    "a result without rows",
    undefined,
    { success: true } satisfies D1Result,
  ],
] as const)("%s fails closed", async (_label, allFailure, allResult) => {
  const db = new RecordingD1([]);
  db.allFailure = allFailure;
  db.allResult = allResult;
  await expect(
    rejectDisallowedCloudflarePresentedSession({
      request: new Request("https://platform.example.test/bootstrap"),
      env: configuredEnv(db, `d1-failure-${_label}`),
      sessionCredential: `sess_d1_failure_${dbFailureSlug(_label)}`,
    }),
  ).rejects.toThrow();
  expect(db.batchCalls).toBe(0);
  expect(db.execCalls).toBe(0);
});

test.each([
  ["a null row", [null]],
  [
    "duplicate session rows",
    [
      { kind: "session", document: "{}" },
      { kind: "session", document: "{}" },
    ],
  ],
  ["an unknown candidate kind", [{ kind: "runtime", document: "{}" }]],
  ["malformed candidate JSON", [{ kind: "session", document: "{" }]],
] as const)("%s is never treated as allowed evidence", async (_label, rows) => {
  const db = new RecordingD1(rows);
  await expect(
    rejectDisallowedCloudflarePresentedSession({
      request: new Request("https://platform.example.test/bootstrap"),
      env: configuredEnv(db, `malformed-evidence-${_label}`),
      sessionCredential: `sess_malformed_${dbFailureSlug(_label)}`,
    }),
  ).rejects.toThrow();
  expect(db.batchCalls).toBe(0);
  expect(db.execCalls).toBe(0);
});

test("unknown session evidence remains for the caller's canonical 401 path", async () => {
  const db = new RecordingD1([]);
  await expect(
    rejectDisallowedCloudflarePresentedSession({
      request: new Request("https://platform.example.test/bootstrap"),
      env: configuredEnv(db, "unknown-session-test-salt"),
      sessionCredential: "sess_unknown_presented",
    }),
  ).resolves.toBeUndefined();
  expect(db.allCalls).toBe(1);
  expect(db.batchCalls).toBe(0);
  expect(db.execCalls).toBe(0);
});

test("non-session request credentials remain on the caller's canonical 401 path", async () => {
  await expect(
    rejectDisallowedCloudflarePresentedSession({
      request: new Request("https://platform.example.test/bootstrap", {
        headers: { authorization: "Bearer takpat_not_a_session" },
      }),
      env: {
        TAKOSUMI_ACCOUNTS_DB: forbiddenD1("non-session credential"),
        TAKOSUMI_ACCOUNTS_LOGIN_EMAIL_ALLOWLIST: "allowed@example.test",
      } as CloudflareWorkerEnv,
      sessionCredential: null,
    }),
  ).resolves.toBeUndefined();
});

test("deceptive mixed evidence cannot hide behind an allowlisted session", async () => {
  const subject = "tsub_deceptive_mixed_evidence";
  const db = new RecordingD1([
    {
      kind: "session",
      document: JSON.stringify({
        sessionId: "stored-session-hash",
        subject,
        createdAt: 1_000,
        expiresAt: Date.now() + 60_000,
      }),
    },
    {
      kind: "session_account",
      document: JSON.stringify({
        subject,
        email: "allowed@example.test",
        emailVerified: true,
        createdAt: 500,
        updatedAt: 1_500,
      }),
    },
    {
      kind: "access_token",
      document: JSON.stringify({
        subject: "pairwise-deceptive",
        takosumiSubject: "tsub_disallowed_collision",
        clientId: "toc_deceptive_collision",
        scope: "openid",
        expiresAt: Date.now() + 60_000,
      }),
    },
  ]);

  const response = await rejectDisallowedCloudflarePresentedSession({
    request: new Request("https://platform.example.test/bootstrap"),
    env: configuredEnv(db, "deceptive-mixed-evidence-test-salt"),
    sessionCredential: "sess_deceptive_mixed_evidence",
  });

  expect(response?.status).toBe(403);
  expect(response?.headers.get("set-cookie")).toBeNull();
  expect(db.allCalls).toBe(1);
  expect(db.rawCalls).toBe(1);
  expect(db.batchCalls).toBe(0);
  expect(db.execCalls).toBe(0);
});

function forbiddenD1(label: string): D1Database {
  return new Proxy(
    {},
    {
      get(_target, property) {
        throw new Error(`${label} touched D1.${String(property)}`);
      },
    },
  ) as D1Database;
}

function configuredEnv(db: D1Database, salt: string): CloudflareWorkerEnv {
  return {
    TAKOSUMI_ACCOUNTS_DB: db,
    TAKOSUMI_ACCOUNTS_LOGIN_EMAIL_ALLOWLIST: "allowed@example.test",
    TAKOSUMI_ACCOUNT_SESSION_HASH_SALT: salt,
  } as CloudflareWorkerEnv;
}

function presentedSessionRows(input: {
  readonly subject: `tsub_${string}`;
  readonly email: string;
}): readonly unknown[] {
  return [
    {
      kind: "session",
      document: JSON.stringify({
        sessionId: "stored-session-hash",
        subject: input.subject,
        createdAt: 1_000,
        expiresAt: Date.now() + 60_000,
      }),
    },
    {
      kind: "session_account",
      document: JSON.stringify({
        subject: input.subject,
        email: input.email,
        emailVerified: true,
        createdAt: 500,
        updatedAt: 1_500,
      }),
    },
  ];
}

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function dbFailureSlug(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9]+/gu, "_");
}

class RecordingD1 implements D1Database {
  readonly prepared: string[] = [];
  readonly bound: D1Value[][] = [];
  allCalls = 0;
  firstCalls = 0;
  runCalls = 0;
  rawCalls = 0;
  batchCalls = 0;
  batchStatementCount = 0;
  execCalls = 0;
  allFailure: unknown;
  allResult: D1Result | undefined;
  allStarted: (() => void) | undefined;
  allGate: Promise<void> | undefined;

  constructor(private readonly rows: readonly unknown[]) {}

  prepare(query: string): D1PreparedStatement {
    this.prepared.push(query);
    return new RecordingStatement(this, this.rows);
  }

  async batch<T = unknown>(
    statements: readonly D1PreparedStatement[],
  ): Promise<readonly D1Result<T>[]> {
    this.batchCalls += 1;
    this.batchStatementCount += statements.length;
    return statements.map(() => ({ success: true }));
  }

  async exec(_query: string): Promise<D1ExecResult> {
    this.execCalls += 1;
    return { count: 0, duration: 0 };
  }
}

class RecordingStatement implements D1PreparedStatement {
  constructor(
    private readonly db: RecordingD1,
    private readonly rows: readonly unknown[],
  ) {}

  bind(...values: readonly D1Value[]): D1PreparedStatement {
    this.db.bound.push([...values]);
    return this;
  }

  async all<T = unknown>(): Promise<D1Result<T>> {
    this.db.allCalls += 1;
    this.db.allStarted?.();
    await this.db.allGate;
    if (this.db.allFailure !== undefined) throw this.db.allFailure;
    if (this.db.allResult !== undefined) {
      return this.db.allResult as D1Result<T>;
    }
    return { success: true, results: [...this.rows] as T[] };
  }

  async first<T = unknown>(_column?: string): Promise<T | null> {
    this.db.firstCalls += 1;
    return null;
  }

  async run(): Promise<D1Result> {
    this.db.runCalls += 1;
    return { success: true };
  }

  async raw(): Promise<unknown[][]> {
    this.db.rawCalls += 1;
    return [];
  }
}
