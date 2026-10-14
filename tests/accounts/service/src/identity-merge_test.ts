import { expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import {
  InMemoryAccountsStore,
  type AccountsStore,
  type AccountSessionRecord,
} from "../../../../accounts/service/src/store.ts";
import {
  D1AccountsStore,
  type D1Database,
} from "../../../../accounts/service/src/d1-store.ts";
import { PostgresAccountsStore } from "../../../../accounts/service/src/postgres-store.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";
import {
  createIdentityMerge,
  proveIdentityMerge,
  consentIdentityMerge,
  activateIdentityMerge,
  quarantineIdentityMerge,
  restoreIdentityMerge,
  abortPendingIdentityMerge,
  handleIdentityMergeRequest,
} from "../../../../accounts/service/src/identity-merge.ts";
import {
  normalizeMergeEmail,
  type AccountEmailProofRecord,
  type IdentityMergeAcknowledgements,
  type IdentityMergeOperation,
} from "../../../../accounts/service/src/identity-state.ts";
import {
  loadD1AccountsMigrationCatalog,
  applyD1AccountsMigrationBatch,
  readD1AccountsMigrationState,
} from "../../../../accounts/service/src/d1-migrations.ts";

const now = 1_000_000;
const accountA = "tsub_identity_A";
const accountB = "tsub_identity_B";
const address = "Owner@example.test";
const sessionA: AccountSessionRecord = {
  sessionId: "session-target",
  subject: accountA,
  policy: "hosted",
  authTime: 990,
  reauthenticatedAt: 990,
  createdAt: 990_000,
  expiresAt: 1_100_000,
  absoluteExpiresAt: 2_000_000,
};
const sessionB: AccountSessionRecord = {
  ...sessionA,
  sessionId: "session-source",
  subject: accountB,
};

const baselineSql = `CREATE SCHEMA accounts_v1;
CREATE TABLE accounts_v1.accounts(subject text PRIMARY KEY,email text,email_verified boolean,display_name text,picture text,terms_version text,terms_accepted_at timestamptz,terms_accepted_source text,created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL);
CREATE TABLE accounts_v1.upstream_identities(provider_id text,upstream_issuer text,upstream_subject text,subject text REFERENCES accounts_v1.accounts(subject) ON DELETE CASCADE,created_at timestamptz,updated_at timestamptz,PRIMARY KEY(provider_id,upstream_issuer,upstream_subject));
CREATE TABLE accounts_v1.account_sessions(session_id text PRIMARY KEY,subject text REFERENCES accounts_v1.accounts(subject) ON DELETE CASCADE,created_at timestamptz,expires_at timestamptz);
CREATE TABLE accounts_v1.authorization_codes(code_hash text PRIMARY KEY,client_id text,redirect_uri text,scope text,subject text,takosumi_subject text REFERENCES accounts_v1.accounts(subject),capsule_id text,workspace_id text,role text,nonce text,code_challenge text,code_challenge_method text,created_at timestamptz,expires_at timestamptz);
CREATE TABLE accounts_v1.oauth_access_tokens(token_hash text PRIMARY KEY,client_id text,audience text,scope text,subject text,takosumi_subject text REFERENCES accounts_v1.accounts(subject),capsule_id text,workspace_id text,role text,interface_id text,interface_binding_id text,interface_resolved_revision bigint,created_at timestamptz,expires_at timestamptz);
CREATE TABLE accounts_v1.oauth_refresh_tokens(LIKE accounts_v1.oauth_access_tokens INCLUDING ALL);
CREATE TABLE accounts_v1.protected_references(id text PRIMARY KEY,subject text REFERENCES accounts_v1.accounts(subject),workspace_id text,org_id text,micro_usd bigint);`;

async function fixture(kind: "memory" | "d1" | "postgres" | "native-d1") {
  let store: AccountsStore;
  let d1: SqliteFakeD1 | undefined;
  let pg: PGlite | undefined;
  let native: import("miniflare").Miniflare | undefined;
  if (kind === "memory") store = new InMemoryAccountsStore();
  else if (kind === "native-d1") {
    const { Miniflare } = await import("miniflare");
    native = new Miniflare({
      modules: true,
      script: "export default {fetch(){return new Response('test');}}",
      compatibilityDate: "2026-07-01",
      d1Databases: { ACCOUNTS: "merge-critical-native" },
    });
    const db = await native.getD1Database("ACCOUNTS");
    const catalog = await loadD1AccountsMigrationCatalog();
    for (const migration of catalog.migrations)
      await applyD1AccountsMigrationBatch(
        db,
        migration,
        100 + migration.version,
      );
    store = new D1AccountsStore(db as unknown as D1Database, {
      schemaMode: "predeployed",
    });
  } else if (kind === "d1") {
    d1 = new SqliteFakeD1();
    store = new D1AccountsStore(d1 as unknown as D1Database);
  } else {
    pg = new PGlite();
    await pg.exec(baselineSql);
    await pg.exec(
      await Bun.file(
        new URL(
          "../../../../accounts/service/migrations/045_hosted_canonical_identity.sql",
          import.meta.url,
        ),
      ).text(),
    );
    store = new PostgresAccountsStore({
      queryObject: async <T>(sql: string, args: readonly unknown[] = []) => ({
        rows: (await pg!.query(sql, [...args])).rows as T[],
      }),
    });
  }
  for (const subject of [accountA, accountB])
    await store.saveAccount({
      subject,
      email: address,
      emailVerified: true,
      termsVersion: "protected-terms",
      termsAcceptedAt: 1,
      termsAcceptedSource: "original",
      createdAt: 1,
      updatedAt: 1,
    });
  for (const [subject, providerId] of [
    [accountA, "google"],
    [accountB, "github"],
  ] as const) {
    const binding = {
      subject,
      providerId,
      upstreamIssuer: `https://${providerId}.example.test`,
      upstreamSubject: subject,
      createdAt: 1,
      updatedAt: 1,
    };
    await store.linkUpstreamIdentity(binding);
    await store.saveAccountEmailProof!({
      ...binding,
      address,
      normalizedAddress: address,
      verification: "provider",
      authoritative: true,
      observedAt: 990_000,
      validUntil: 1_290_000,
    });
  }
  await store.saveAccountSession(sessionA);
  await store.saveAccountSession(sessionB);
  if (pg)
    await pg.query(
      "INSERT INTO accounts_v1.protected_references VALUES('resource_B',$1,'workspace_B','org_B',123456)",
      [accountB],
    );
  return {
    store,
    d1,
    pg,
    close: async () => {
      if (pg) await pg.close();
      if (native) await native.dispose();
    },
  };
}
function ack(op: IdentityMergeOperation): IdentityMergeAcknowledgements {
  return {
    operationId: op.operationId,
    sourceSubject: op.sourceSubject,
    targetSubject: op.targetSubject,
    externalBindings: "binding-review",
    workspaceMembership: "membership-review",
    billingLedger: "ledger-review",
    consumerIntentCustody: "original-org-intents-retained",
    rpSessions: "rp-session-revoke",
    personalWorkspaceId: "workspace_A",
    reconciledAt: now,
  };
}
async function receiptFor(
  store: AccountsStore,
  op: IdentityMergeOperation,
  role: "source" | "target",
  overrides: Partial<
    import("../../../../accounts/service/src/identity-state.ts").IdentityOperationReceiptRecord
  > = {},
) {
  const subject = role === "source" ? op.sourceSubject : op.targetSubject;
  const providerId = subject === accountB ? "github" : "google";
  const receipt: import("../../../../accounts/service/src/identity-state.ts").IdentityOperationReceiptRecord =
    {
      receiptId: `ircp_${crypto.randomUUID()}`,
      operationId: op.operationId,
      role,
      sourceSubject: op.sourceSubject,
      targetSubject: op.targetSubject,
      subject,
      providerId,
      upstreamIssuer: `https://${providerId}.example.test`,
      upstreamSubject: subject,
      browserBindingHash: op.browserBindingHash,
      policyVersion: op.policyVersion,
      identityGeneration:
        await store.getAccountAuthenticationGeneration!(subject),
      transactionDigest: `sha256:${crypto.randomUUID()}`,
      startedAt: now,
      completedAt: now,
      expiresAt: op.expiresAt,
      emailDigest: op.addressDigest,
      legConsent: true,
      legConsentAt: now,
      method: "upstream-oauth-operation",
      issuerSessionHash: await store.hashAccountSessionId!(
        "browser-receipt-anchor",
      ),
      ...overrides,
    };
  await store.createIdentityOperationReceipt!(receipt);
  return receipt;
}
const pendingReconciler = { reconcile: async () => undefined };
async function proved(store: AccountsStore) {
  let op = await createIdentityMerge({
    store,
    actor: accountA,
    sourceSubject: accountB,
    targetSubject: accountA,
    browserBindingHash: "browser",
    now,
  });
  op = await proveIdentityMerge({
    store,
    operation: op,
    session: sessionB,
    receiptId: (await receiptFor(store, op, "source")).receiptId,
    now,
  });
  op = await proveIdentityMerge({
    store,
    operation: op,
    session: sessionA,
    receiptId: (await receiptFor(store, op, "target")).receiptId,
    now,
  });
  return op;
}
async function consented(store: AccountsStore) {
  return await consentIdentityMerge({
    store,
    operation: await proved(store),
    session: sessionA,
    consent: true,
    reconciler: pendingReconciler,
    retryCapability: { pendingCapacity: 100, assertAvailable: async () => {} },
    now,
  });
}

for (const kind of ["memory", "d1", "postgres"] as const) {
  test(`${kind}: dual proof + consent + every owner ACK activates one canonical account, retains roots and references`, async () => {
    const f = await fixture(kind);
    try {
      await f.store.saveAccessToken("old-access", {
        clientId: "rp",
        subject: accountB,
        takosumiSubject: accountB,
        scope: "openid",
        expiresAt: 2_000_000,
      });
      await f.store.saveRefreshToken("old-refresh", {
        clientId: "rp",
        subject: accountA,
        takosumiSubject: accountA,
        scope: "openid",
        expiresAt: 2_000_000,
      });
      await f.store.saveHostedOidcGrant!({
        sid: "grant-B",
        issuerSessionId: "anchor-B",
        clientId: "rp",
        subject: accountB,
        scope: "openid",
        authTime: 990,
        createdAt: 990_000,
        absoluteExpiresAt: 2_000_000,
      });
      const op = await consented(f.store);
      expect(op.status).toBe("proved");
      expect(await f.store.isAccountAuthenticationFenced!(accountB)).toBe(true);
      expect(
        await f.store.findAccountSession(sessionA.sessionId),
      ).toBeUndefined();
      expect(await f.store.findAccessToken("old-access")).toBeUndefined();
      expect(await f.store.findRefreshToken("old-refresh")).toBeUndefined();
      expect((await f.store.findHostedOidcGrant!("grant-B"))?.revokedAt).toBe(
        now,
      );
      expect((await f.store.findCanonicalAccount!(accountB))?.subject).toBe(
        accountB,
      );
      const active = await activateIdentityMerge({
        store: f.store,
        operation: op,
        now,
        reconciler: { reconcile: async () => ack(op) },
      });
      expect(active.status).toBe("active");
      expect((await f.store.findCanonicalAccount!(accountB))?.subject).toBe(
        accountA,
      );
      expect(await f.store.isAccountAuthenticationFenced!(accountB)).toBe(
        false,
      );
      expect((await f.store.findAccount(accountB))?.termsVersion).toBe(
        "protected-terms",
      );
      expect(
        (
          await f.store.findUpstreamIdentity({
            providerId: "github",
            upstreamIssuer: "https://github.example.test",
            upstreamSubject: accountB,
          })
        )?.subject,
      ).toBe(accountB);
      expect(
        await activateIdentityMerge({ store: f.store, operation: active, now }),
      ).toEqual(active);
      if (f.pg)
        expect(
          (await f.pg.query("SELECT * FROM accounts_v1.protected_references"))
            .rows,
        ).toEqual([
          {
            id: "resource_B",
            subject: accountB,
            workspace_id: "workspace_B",
            org_id: "org_B",
            micro_usd: 123456,
          },
        ]);
    } finally {
      await f.close();
    }
  }, 20_000);
  test(`${kind}: proof replay, missing/partial owner ACK and lack of explicit consent confer no merge authority`, async () => {
    const f = await fixture(kind);
    try {
      const op = await proved(f.store);
      await expect(
        proveIdentityMerge({
          store: f.store,
          operation: op,
          session: sessionB,
          now,
        }),
      ).rejects.toThrow("operation_receipt_required");
      await expect(
        consentIdentityMerge({
          store: f.store,
          operation: op,
          session: sessionA,
          now,
          consent: false,
        }),
      ).rejects.toThrow("merge_conflict");
      const consent = await consentIdentityMerge({
        store: f.store,
        operation: op,
        session: sessionA,
        now,
        consent: true,
        reconciler: pendingReconciler,
        retryCapability: {
          pendingCapacity: 100,
          assertAvailable: async () => {},
        },
      });
      await expect(
        activateIdentityMerge({ store: f.store, operation: consent, now }),
      ).rejects.toThrow("merge_reconciliation_pending");
      await expect(
        activateIdentityMerge({
          store: f.store,
          operation: consent,
          now,
          reconciler: {
            reconcile: async () => ({
              ...ack(consent),
              consumerIntentCustody: "",
            }),
          },
        }),
      ).rejects.toThrow("merge_reconciliation_pending");
      expect((await f.store.findCanonicalAccount!(accountB))?.subject).toBe(
        accountB,
      );
    } finally {
      await f.close();
    }
  }, 20_000);
  test(`${kind}: email reuse, unverified/legacy provenance and local-part case collision cannot choose an account`, async () => {
    const f = await fixture(kind);
    try {
      const original = await f.store.findAccount(accountB);
      await f.store.saveAccount({
        ...original!,
        email: "new@example.test",
        emailVerified: true,
        updatedAt: now,
      });
      await expect(
        createIdentityMerge({
          store: f.store,
          actor: accountA,
          sourceSubject: accountB,
          targetSubject: accountA,
          browserBindingHash: "browser",
          now,
        }),
      ).rejects.toThrow("merge_conflict");
      await f.store.saveAccount({
        ...original!,
        emailVerified: false,
        updatedAt: now,
      });
      await expect(
        createIdentityMerge({
          store: f.store,
          actor: accountA,
          sourceSubject: accountB,
          targetSubject: accountA,
          browserBindingHash: "browser",
          now,
        }),
      ).rejects.toThrow("merge_conflict");
      await f.store.saveAccount({
        ...original!,
        emailVerified: true,
        updatedAt: now,
      });
      await f.store.saveAccount({
        subject: "tsub_case_collision",
        email: "owner@example.test",
        emailVerified: true,
        createdAt: 1,
        updatedAt: 1,
      });
      await expect(
        createIdentityMerge({
          store: f.store,
          actor: accountA,
          sourceSubject: accountB,
          targetSubject: accountA,
          browserBindingHash: "browser",
          now,
        }),
      ).rejects.toThrow("merge_conflict");
    } finally {
      await f.close();
    }
  }, 20_000);
  test(`${kind}: stale sessions or ordinary upstream SSO are not fresh operation ownership proof`, async () => {
    const f = await fixture(kind);
    try {
      const op = await createIdentityMerge({
        store: f.store,
        actor: accountA,
        sourceSubject: accountB,
        targetSubject: accountA,
        browserBindingHash: "browser",
        now,
      });
      await expect(
        proveIdentityMerge({
          store: f.store,
          operation: op,
          session: { ...sessionB, reauthenticatedAt: undefined },
          now,
        }),
      ).rejects.toThrow("operation_receipt_required");
      await expect(
        proveIdentityMerge({
          store: f.store,
          operation: op,
          session: { ...sessionB, reauthenticatedAt: 1 },
          now,
        }),
      ).rejects.toThrow("operation_receipt_required");
      await f.store.deleteAccountSession(sessionB.sessionId);
      await expect(
        proveIdentityMerge({
          store: f.store,
          operation: op,
          session: sessionB,
          now,
        }),
      ).rejects.toThrow("operation_receipt_required");
    } finally {
      await f.close();
    }
  }, 20_000);
  test(`${kind}: concurrent operation consent and credential unlink keep one working canonical login`, async () => {
    const f = await fixture(kind);
    try {
      const first = await proved(f.store);
      const second = await proved(f.store);
      const results = await Promise.allSettled(
        [first, second].map((operation) =>
          consentIdentityMerge({
            store: f.store,
            operation,
            session: sessionA,
            consent: true,
            reconciler: pendingReconciler,
            retryCapability: {
              pendingCapacity: 100,
              assertAvailable: async () => {},
            },
            now,
          }),
        ),
      );
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const op = (
        results.find(
          (r) => r.status === "fulfilled",
        ) as PromiseFulfilledResult<IdentityMergeOperation>
      ).value;
      await activateIdentityMerge({
        store: f.store,
        operation: op,
        now,
        reconciler: { reconcile: async () => ack(op) },
      });
      await f.store.saveAccountSession({
        ...sessionA,
        identityGeneration:
          await f.store.getAccountAuthenticationGeneration!(accountA),
      });
      const identity = {
        providerId: "github",
        upstreamIssuer: "https://github.example.test",
        upstreamSubject: accountB,
      };
      expect(
        await f.store.unlinkCanonicalUpstreamIdentity!({
          subject: accountA,
          identity,
          proof: {
            sessionId: sessionA.sessionId,
            subject: accountA,
            authTime: 990,
          },
          operationId: "unlink-B",
          now,
        }),
      ).toBe(true);
      expect(
        (await f.store.findUpstreamIdentityStatus!(identity))?.disabledAt,
      ).toBe(now);
      expect((await f.store.findCanonicalAccount!(accountB))?.subject).toBe(
        accountA,
      );
      await f.store.saveAccountSession({
        ...sessionA,
        identityGeneration:
          await f.store.getAccountAuthenticationGeneration!(accountA),
      });
      expect(
        await f.store.unlinkCanonicalUpstreamIdentity!({
          subject: accountA,
          identity: {
            providerId: "google",
            upstreamIssuer: "https://google.example.test",
            upstreamSubject: accountA,
          },
          proof: {
            sessionId: sessionA.sessionId,
            subject: accountA,
            authTime: 990,
          },
          operationId: "unlink-A",
          now,
        }),
      ).toBe(false);
    } finally {
      await f.close();
    }
  }, 20_000);
  test(`${kind}: hosted session global revoke is durable even for a grant written after the revocation scan`, async () => {
    const f = await fixture(kind);
    try {
      await f.store.revokeHostedOidcSessionGrants!("late-anchor", now);
      await f.store.saveHostedOidcGrant!({
        sid: "late-grant",
        issuerSessionId: "late-anchor",
        clientId: "rp",
        subject: accountA,
        scope: "openid",
        authTime: 990,
        createdAt: now,
        absoluteExpiresAt: 2_000_000,
        authorizationCodeHash: "code-digest",
      });
      expect(await f.store.isHostedOidcSessionRevoked!("late-anchor")).toBe(
        true,
      );
      expect(
        (await f.store.findHostedOidcGrantForCode!("code-digest"))?.sid,
      ).toBe("late-grant");
      await f.store.revokeHostedOidcGrant!("late-grant", now);
      await expect(
        f.store.saveHostedOidcGrant!({
          ...(await f.store.findHostedOidcGrant!("late-grant")!),
          revokedAt: undefined,
        }),
      ).rejects.toThrow("hosted_grant_conflict");
      expect(
        await f.store.touchHostedAccountSession!(
          sessionA.sessionId,
          now,
          3_000_000,
        ),
      ).toBe(true);
      expect(
        (await f.store.findAccountSession(sessionA.sessionId))?.expiresAt,
      ).toBe(2_000_000);
      expect(
        await f.store.touchHostedAccountSession!(
          sessionA.sessionId,
          2_000_001,
          3_000_000,
        ),
      ).toBe(false);
    } finally {
      await f.close();
    }
  }, 20_000);
}

test("HTTP merge route requires issuer session and exact Origin, hides private proof/email records and stays pending without owner ACK", async () => {
  const f = await fixture("memory");
  try {
    const request = (
      path: string,
      body: unknown,
      origin = "https://auth.example.test",
    ) =>
      new Request(
        `https://auth.example.test/api/v1/account/identity-merges${path}`,
        {
          method: "POST",
          headers: { origin, "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
    const invoke = (
      request: Request,
      session: AccountSessionRecord | undefined = sessionA,
    ) =>
      handleIdentityMergeRequest({
        request: new Request(request, {
          headers: {
            ...Object.fromEntries(request.headers),
            cookie: `__Host-takosumi_session=${session?.sessionId ?? ""}`,
          },
        }),
        store: f.store,
        session,
        browserBindingHash: "browser",
        issuerOrigin: "https://auth.example.test",
        now,
      });
    expect(
      (
        await handleIdentityMergeRequest({
          request: request("", {}),
          store: f.store,
          browserBindingHash: "browser",
          issuerOrigin: "https://auth.example.test",
          now,
        })
      )?.status,
    ).toBe(401);
    expect((await invoke(request("", {}, "https://evil.test")))?.status).toBe(
      403,
    );
    const created = await invoke(
      request("", { sourceSubject: accountB, targetSubject: accountA }),
    );
    expect(created?.status).toBe(201);
    const body = (await created!.json()) as { operationId: string };
    const payload = JSON.stringify(body);
    expect(payload).not.toContain(address);
    expect(payload).not.toContain(sessionA.sessionId);
    expect(
      (
        await invoke(
          request(`/${body.operationId}/prove`, {
            receiptId: (
              await receiptFor(
                f.store,
                (await f.store.findIdentityMergeOperation!(body.operationId))!,
                "source",
              )
            ).receiptId,
          }),
          sessionB,
        )
      )?.status,
    ).toBe(200);
    expect(
      (
        await invoke(
          request(`/${body.operationId}/prove`, {
            receiptId: (
              await receiptFor(
                f.store,
                (await f.store.findIdentityMergeOperation!(body.operationId))!,
                "target",
              )
            ).receiptId,
          }),
        )
      )?.status,
    ).toBe(200);
    const consent = await invoke(
      request(`/${body.operationId}/consent`, { consent: true }),
    );
    expect(consent?.status).toBe(409);
    expect(await f.store.findAccountSession(sessionA.sessionId)).toBeDefined();
    expect((await f.store.findCanonicalAccount!(accountB))?.subject).toBe(
      accountB,
    );
  } finally {
    await f.close();
  }
});

test("email normalization preserves local-part case/dots/plus tags, IDNA-normalizes only domain", () => {
  expect(normalizeMergeEmail(" User.Name+tag@EXAMPLE.test ")).toBe(
    "User.Name+tag@example.test",
  );
  expect(normalizeMergeEmail("User@bücher.example")).toBe(
    "User@xn--bcher-kva.example",
  );
  expect(normalizeMergeEmail("üser@example.test")).toBeUndefined();
  expect(normalizeMergeEmail("a@gmail.com")).not.toBe(
    normalizeMergeEmail("a@googlemail.com"),
  );
});

test("legacy emailVerified without fresh bound provenance and Google non-authoritative email need additional proof", async () => {
  const f = await fixture("memory");
  try {
    const proof = await f.store.findAccountEmailProof!(accountA);
    await f.store.saveAccountEmailProof!({ ...proof!, authoritative: false });
    await expect(
      createIdentityMerge({
        store: f.store,
        actor: accountA,
        sourceSubject: accountB,
        targetSubject: accountA,
        browserBindingHash: "browser",
        now,
      }),
    ).rejects.toThrow("merge_conflict");
    await f.store.saveAccountEmailProof!({
      ...proof!,
      authoritative: false,
      verification: "mailbox",
    });
    expect(
      (
        await createIdentityMerge({
          store: f.store,
          actor: accountA,
          sourceSubject: accountB,
          targetSubject: accountA,
          browserBindingHash: "browser",
          now,
        })
      ).status,
    ).toBe("pending");
    await f.store.saveAccountEmailProof!({
      ...proof!,
      observedAt: 1,
      validUntil: 2,
    });
    await expect(
      createIdentityMerge({
        store: f.store,
        actor: accountA,
        sourceSubject: accountB,
        targetSubject: accountA,
        browserBindingHash: "browser",
        now,
      }),
    ).rejects.toThrow("merge_conflict");
  } finally {
    await f.close();
  }
});

test("D1 v5 protected expansion retains exact applied prefix, account documents, old FK-bearing consumers and subject history", async () => {
  const db = new SqliteFakeD1();
  const catalog = await loadD1AccountsMigrationCatalog();
  for (const migration of catalog.migrations.slice(0, 5))
    await applyD1AccountsMigrationBatch(db, migration, 100 + migration.version);
  await db
    .prepare(
      "INSERT INTO takosumi_accounts_documents VALUES('accounts',?, ?, ?)",
    )
    .bind(
      accountB,
      JSON.stringify({ subject: accountB, emailVerified: true }),
      now,
    )
    .run();
  await db.exec(
    "CREATE TABLE protected_consumer(account_bucket TEXT NOT NULL DEFAULT 'accounts', account_key TEXT, amount INTEGER, FOREIGN KEY(account_bucket,account_key) REFERENCES takosumi_accounts_documents(bucket,key) ON DELETE CASCADE)",
  );
  await db
    .prepare("INSERT INTO protected_consumer(account_key,amount) VALUES(?,?)")
    .bind(accountB, 456)
    .run();
  const before = await db
    .prepare(
      "SELECT * FROM takosumi_accounts_schema_migrations ORDER BY version",
    )
    .all();
  // Inventory-style extra consumer table is excluded from the Accounts owned
  // closure; it is retained and FK checks must still be clean after expansion.
  await applyD1AccountsMigrationBatch(db, catalog.migrations[5]!, 200);
  const after = await db
    .prepare(
      "SELECT * FROM takosumi_accounts_schema_migrations WHERE version<5 ORDER BY version",
    )
    .all();
  expect(after.results).toEqual(before.results);
  expect(
    (
      await db
        .prepare("SELECT account_key,amount FROM protected_consumer")
        .all()
    ).results,
  ).toEqual([{ account_key: accountB, amount: 456 }]);
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual(
    [],
  );
  expect(
    (
      await db
        .prepare(
          "SELECT key FROM takosumi_accounts_documents WHERE bucket='accounts'",
        )
        .all()
    ).results,
  ).toEqual([{ key: accountB }]);
  const state = await readD1AccountsMigrationState(db, catalog);
  expect(state.headVersion).toBe(5);
});

for (const kind of ["memory", "d1", "postgres"] as const) {
  test(`${kind}: unlink of simultaneous last two login methods cannot remove both`, async () => {
    const f = await fixture(kind);
    try {
      const op = await consented(f.store);
      await activateIdentityMerge({
        store: f.store,
        operation: op,
        now,
        reconciler: { reconcile: async () => ack(op) },
      });
      await f.store.saveAccountSession({
        ...sessionA,
        identityGeneration:
          await f.store.getAccountAuthenticationGeneration!(accountA),
      });
      const outcomes = await Promise.all(
        [
          {
            providerId: "google",
            upstreamIssuer: "https://google.example.test",
            upstreamSubject: accountA,
          },
          {
            providerId: "github",
            upstreamIssuer: "https://github.example.test",
            upstreamSubject: accountB,
          },
        ].map((identity, i) =>
          f.store.unlinkCanonicalUpstreamIdentity!({
            subject: accountA,
            identity,
            proof: {
              sessionId: sessionA.sessionId,
              subject: accountA,
              authTime: 990,
            },
            operationId: `unlink-${i}`,
            now,
          }),
        ),
      );
      expect(outcomes.filter(Boolean)).toHaveLength(1);
      expect((await f.store.findCanonicalAccount!(accountB))?.subject).toBe(
        accountA,
      );
    } finally {
      await f.close();
    }
  }, 20_000);
  test(`${kind}: CAS revalidates current bound email proof and refuses stale observation changes`, async () => {
    const f = await fixture(kind);
    try {
      const op = await createIdentityMerge({
        store: f.store,
        actor: accountA,
        sourceSubject: accountB,
        targetSubject: accountA,
        browserBindingHash: "browser",
        now,
      });
      const evidence = await f.store.findAccountEmailProof!(accountA);
      await f.store.saveAccountEmailProof!({
        ...evidence!,
        observedAt: 999_000,
      });
      expect(
        await f.store.compareAndSetIdentityMerge!({
          expectedRevision: 0,
          next: { ...op, revision: 1, mutationId: "stale-email-observation" },
          now,
          emailProofs: [evidence!],
        }),
      ).toBe(false);
    } finally {
      await f.close();
    }
  }, 20_000);
  test(`${kind}: immutable hosted provider binding does not overwrite original subject`, async () => {
    const f = await fixture(kind);
    try {
      expect(
        await f.store.linkUpstreamIdentityIfAbsent!({
          providerId: "google",
          upstreamIssuer: "https://google.example.test",
          upstreamSubject: accountA,
          subject: accountB,
          createdAt: 1,
          updatedAt: now,
        }),
      ).toBe(false);
      expect(
        (
          await f.store.findUpstreamIdentity({
            providerId: "google",
            upstreamIssuer: "https://google.example.test",
            upstreamSubject: accountA,
          })
        )?.subject,
      ).toBe(accountA);
    } finally {
      await f.close();
    }
  }, 20_000);
}

test("native workerd D1 atomic merge and preserved FK references on exact additive v5 schema", async () => {
  const { Miniflare } = await import("miniflare");
  const mf = new Miniflare({
    modules: true,
    script: "export default {fetch(){return new Response('test');}}",
    compatibilityDate: "2026-07-01",
    d1Databases: { ACCOUNTS: "identity-merge-native" },
  });
  try {
    const db = await mf.getD1Database("ACCOUNTS");
    const catalog = await loadD1AccountsMigrationCatalog();
    for (const migration of catalog.migrations)
      await applyD1AccountsMigrationBatch(
        db,
        migration,
        100 + migration.version,
      );
    const store = new D1AccountsStore(db as unknown as D1Database, {
      schemaMode: "predeployed",
    });
    for (const [subject, providerId] of [
      [accountA, "google"],
      [accountB, "github"],
    ] as const) {
      await store.saveAccount({
        subject,
        email: address,
        emailVerified: true,
        createdAt: 1,
        updatedAt: 1,
      });
      const binding = {
        subject,
        providerId,
        upstreamIssuer: `https://${providerId}.example.test`,
        upstreamSubject: subject,
        createdAt: 1,
        updatedAt: 1,
      };
      await store.linkUpstreamIdentity(binding);
      await store.saveAccountEmailProof({
        ...binding,
        address,
        normalizedAddress: address,
        verification: "provider",
        authoritative: true,
        observedAt: 990_000,
        validUntil: 1_290_000,
      });
    }
    await store.saveAccountSession(sessionA);
    await store.saveAccountSession(sessionB);
    const op = await consented(store);
    const active = await activateIdentityMerge({
      store,
      operation: op,
      now,
      reconciler: { reconcile: async () => ack(op) },
    });
    expect(active.status).toBe("active");
    expect((await store.findCanonicalAccount(accountB))?.subject).toBe(
      accountA,
    );
    expect((await store.findAccount(accountB))?.subject).toBe(accountB);
    expect(
      (await db.prepare("PRAGMA foreign_key_check").all()).results,
    ).toEqual([]);
    expect(await readD1AccountsMigrationState(db, catalog)).toMatchObject({
      headVersion: 5,
      issues: [],
    });
  } finally {
    await mf.dispose();
  }
}, 30_000);

for (const kind of ["memory", "d1", "postgres"] as const) {
  test(`${kind}: reviewed mistaken-merge repair restores only authentication mappings after owner reconciliation`, async () => {
    const f = await fixture(kind);
    try {
      const pending = await consented(f.store);
      const active = await activateIdentityMerge({
        store: f.store,
        operation: pending,
        now,
        reconciler: { reconcile: async () => ack(pending) },
      });
      expect(await f.store.getAccountAuthenticationGeneration!(accountA)).toBe(
        2,
      );
      const quarantined = await quarantineIdentityMerge({
        store: f.store,
        operation: active,
        now: now + 1_000,
        reason: "owner-reviewed-suspected-link",
      });
      expect(await f.store.isAccountAuthenticationFenced!(accountA)).toBe(true);
      await expect(
        restoreIdentityMerge({
          store: f.store,
          operation: quarantined,
          now: now + 1_000,
        }),
      ).rejects.toThrow("recovery_review_required");
      expect((await f.store.findCanonicalAccount!(accountB))?.subject).toBe(
        accountA,
      );
      const recovery = {
        ...ack(quarantined),
        reconciledAt: now + 1_000,
        undoOperationId: "reviewed-undo",
        reviewedRecoveryRef: "billing-and-membership-owner-review",
      };
      const restored = await restoreIdentityMerge({
        store: f.store,
        operation: quarantined,
        now: now + 1_000,
        reconciler: {
          reconcile: async () => undefined,
          reconcileRecovery: async () => recovery,
        },
      });
      expect(restored.status).toBe("restored");
      expect((await f.store.findCanonicalAccount!(accountB))?.subject).toBe(
        accountB,
      );
      expect((await f.store.findAccount(accountA))?.subject).toBe(accountA);
      expect(await f.store.isAccountAuthenticationFenced!(accountA)).toBe(
        false,
      );
      expect(await f.store.getAccountAuthenticationGeneration!(accountA)).toBe(
        4,
      );
      if (f.pg)
        expect(
          (
            await f.pg.query(
              "SELECT micro_usd,workspace_id,org_id FROM accounts_v1.protected_references",
            )
          ).rows,
        ).toEqual([
          { micro_usd: 123456, workspace_id: "workspace_B", org_id: "org_B" },
        ]);
    } finally {
      await f.close();
    }
  }, 20_000);
  test(`${kind}: old session writes after merge revocation cannot become fresh ownership proof`, async () => {
    const f = await fixture(kind);
    try {
      const op = await consented(f.store);
      // A replica that validated before the fence writes an old session late.
      await f.store.saveAccountSession(sessionA);
      const stale = await f.store.findAccountSession(sessionA.sessionId);
      expect(stale?.identityGeneration ?? 0).not.toBe(
        await f.store.getAccountAuthenticationGeneration!(accountA),
      );
      const active = await activateIdentityMerge({
        store: f.store,
        operation: op,
        now,
        reconciler: { reconcile: async () => ack(op) },
      });
      expect(active.status).toBe("active");
      expect(
        await f.store.findAccountSession(sessionA.sessionId),
      ).toBeUndefined();
    } finally {
      await f.close();
    }
  }, 20_000);
}

test("Postgres protected 045 expansion retains applied history, foreign keys and old account/session/resource readers", async () => {
  const db = new PGlite();
  try {
    await db.exec(baselineSql);
    await db.exec(
      "CREATE TABLE accounts_v1.schema_migrations(version integer PRIMARY KEY,name text,checksum text,applied_at bigint)",
    );
    await db.query(
      "INSERT INTO accounts_v1.schema_migrations VALUES(44,'applied_history','sha256:immutable',44)",
    );
    await db.query(
      "INSERT INTO accounts_v1.accounts(subject,email,email_verified,created_at,updated_at) VALUES($1,$2,true,to_timestamp(1),to_timestamp(1))",
      [accountB, address],
    );
    await db.query(
      "INSERT INTO accounts_v1.account_sessions VALUES('old-session-hash',$1,to_timestamp(2),to_timestamp(1000))",
      [accountB],
    );
    await db.query(
      "INSERT INTO accounts_v1.protected_references VALUES('old-balance',$1,'workspace_B','org_B',7654321)",
      [accountB],
    );
    const before = (
      await db.query("SELECT * FROM accounts_v1.schema_migrations")
    ).rows;
    const fks = (
      await db.query(
        "SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE contype='f' ORDER BY conname",
      )
    ).rows;
    await db.exec(
      await Bun.file(
        new URL(
          "../../../../accounts/service/migrations/045_hosted_canonical_identity.sql",
          import.meta.url,
        ),
      ).text(),
    );
    expect(
      (await db.query("SELECT * FROM accounts_v1.schema_migrations")).rows,
    ).toEqual(before);
    expect(
      (
        await db.query(
          "SELECT subject,email,email_verified FROM accounts_v1.accounts",
        )
      ).rows,
    ).toEqual([{ subject: accountB, email: address, email_verified: true }]);
    expect(
      (
        await db.query(
          "SELECT session_id,subject FROM accounts_v1.account_sessions",
        )
      ).rows,
    ).toEqual([{ session_id: "old-session-hash", subject: accountB }]);
    expect(
      (await db.query("SELECT * FROM accounts_v1.protected_references")).rows,
    ).toEqual([
      {
        id: "old-balance",
        subject: accountB,
        workspace_id: "workspace_B",
        org_id: "org_B",
        micro_usd: 7654321,
      },
    ]);
    const newFks = (
      await db.query(
        "SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE contype='f' ORDER BY conname",
      )
    ).rows;
    expect(newFks).toEqual(expect.arrayContaining(fks));
    expect(
      (
        await db.query(
          "SELECT hosted_metadata FROM accounts_v1.account_sessions",
        )
      ).rows,
    ).toEqual([{ hosted_metadata: null }]);
    await expect(
      db.query(
        "INSERT INTO accounts_v1.hosted_identity_records(bucket,key,document,subject) VALUES('canonical_accounts','unknown','{}','tsub_missing')",
      ),
    ).rejects.toThrow();
  } finally {
    await db.close();
  }
}, 20_000);

for (const kind of ["memory", "d1", "postgres"] as const) {
  test(`${kind}: disabled versioned client leaves permanent marker even if old replica writes later grants`, async () => {
    const f = await fixture(kind);
    try {
      await f.store.revokeHostedOidcClientGrants!("client-v1", now);
      await f.store.saveHostedOidcGrant!({
        sid: "late-old-config",
        clientId: "client-v1",
        issuerSessionId: "browser-old-config",
        subject: accountA,
        scope: "openid",
        authTime: 990,
        createdAt: now,
        absoluteExpiresAt: 2_000_000,
      });
      expect(await f.store.isHostedOidcClientRevoked!("client-v1")).toBe(true);
      expect(await f.store.isHostedOidcClientRevoked!("client-v2")).toBe(false);
      await f.store.revokeHostedOidcClientGrants!("client-v1", now + 1_000);
      expect(await f.store.isHostedOidcClientRevoked!("client-v1")).toBe(true);
    } finally {
      await f.close();
    }
  }, 20_000);
}

for (const kind of ["memory", "d1", "postgres"] as const) {
  test(`${kind}: identical CAS retry cannot replay a consumed revision or increment generation twice`, async () => {
    const f = await fixture(kind);
    try {
      const op = await proved(f.store);
      const next = {
        ...op,
        revision: op.revision + 1,
        mutationId: "identical-cas-retry",
        consentAt: now,
      };
      const mutation = {
        expectedRevision: op.revision,
        next,
        now,
        reserve: true,
        retryCapacity: 100,
        sessions: [
          { sessionId: sessionA.sessionId, subject: accountA, authTime: 990 },
          { sessionId: sessionB.sessionId, subject: accountB, authTime: 990 },
        ],
      };
      expect(await f.store.compareAndSetIdentityMerge!(mutation)).toBe(true);
      expect(await f.store.getAccountAuthenticationGeneration!(accountA)).toBe(
        1,
      );
      expect(await f.store.compareAndSetIdentityMerge!(mutation)).toBe(false);
      expect(await f.store.getAccountAuthenticationGeneration!(accountA)).toBe(
        1,
      );
    } finally {
      await f.close();
    }
  }, 20_000);
}

test("Postgres ordinary self-host reads/writes remain compatible with protected pre-045 schema", async () => {
  const pg = new PGlite();
  try {
    await pg.exec(baselineSql);
    const store = new PostgresAccountsStore({
      queryObject: async <T>(sql: string, args: readonly unknown[] = []) => ({
        rows: (await pg.query(sql, [...args])).rows as T[],
      }),
    });
    await store.saveAccount({
      subject: accountA,
      email: address,
      emailVerified: true,
      createdAt: 1,
      updatedAt: 1,
    });
    const session = {
      sessionId: "legacy-session",
      subject: accountA,
      createdAt: 1,
      expiresAt: 2_000_000,
    };
    await store.saveAccountSession(session);
    expect(await store.findAccountSession(session.sessionId)).toEqual(session);
    expect(
      await store.replaceAccountSession(session.sessionId, {
        ...session,
        sessionId: "legacy-next",
      }),
    ).toBe(true);
    expect(
      (await store.findAccountSession("legacy-next"))?.policy,
    ).toBeUndefined();
    const token = {
      clientId: "legacy-client",
      subject: "legacy-sub",
      scope: "openid",
      expiresAt: 2_000_000,
    };
    await store.saveAuthorizationCode("legacy-code", {
      ...token,
      redirectUri: "https://legacy.example.test/callback",
    });
    expect(
      (await store.consumeAuthorizationCode("legacy-code"))?.oidcProfile,
    ).toBeUndefined();
    await store.saveAccessToken("legacy-access", token);
    expect((await store.findAccessToken("legacy-access"))?.subject).toBe(
      "legacy-sub",
    );
    await store.saveRefreshToken("legacy-refresh", token);
    expect(
      (await store.findRefreshToken("legacy-refresh"))?.oidcProfile,
    ).toBeUndefined();
  } finally {
    await pg.close();
  }
}, 20_000);

test("HTTP operation browser cookie remains stable independently of issuer session rotation", async () => {
  const f = await fixture("memory");
  try {
    const request = (
      path: string,
      body: unknown,
      cookie?: string,
      session = sessionA,
    ) =>
      new Request(
        `https://auth.example.test/api/v1/account/identity-merges${path}`,
        {
          method: "POST",
          headers: {
            origin: "https://auth.example.test",
            "content-type": "application/json",
            cookie: `__Host-takosumi_session=${session.sessionId}${cookie ? `; ${cookie}` : ""}`,
          },
          body: JSON.stringify(body),
        },
      );
    const created = await handleIdentityMergeRequest({
      request: request("", {
        sourceSubject: accountB,
        targetSubject: accountA,
      }),
      store: f.store,
      session: sessionA,
      issuerOrigin: "https://auth.example.test",
      now,
    });
    expect(created?.status).toBe(201);
    const setCookie = created!.headers.get("set-cookie")!;
    expect(setCookie).toContain("__Host-takosumi-merge-browser=");
    expect(setCookie).toContain("Secure; HttpOnly; SameSite=Lax");
    const cookie = setCookie.split(";")[0]!;
    const body = (await created!.json()) as { operationId: string };
    const receipt = await receiptFor(
      f.store,
      (await f.store.findIdentityMergeOperation!(body.operationId))!,
      "source",
    );
    const missing = await handleIdentityMergeRequest({
      request: request(
        `/${body.operationId}/prove`,
        { receiptId: receipt.receiptId },
        undefined,
        sessionB,
      ),
      store: f.store,
      session: sessionB,
      issuerOrigin: "https://auth.example.test",
      now,
    });
    expect(missing?.status).toBe(403);
    const proved = await handleIdentityMergeRequest({
      request: request(
        `/${body.operationId}/prove`,
        { receiptId: receipt.receiptId },
        cookie,
        sessionB,
      ),
      store: f.store,
      session: sessionB,
      issuerOrigin: "https://auth.example.test",
      now,
    });
    expect(proved?.status).toBe(200);
  } finally {
    await f.close();
  }
});

for (const kind of ["memory", "d1", "postgres", "native-d1"] as const) {
  test(`${kind}: third candidate inserted between preflight and reserve CAS fails without authority mutation`, async () => {
    const f = await fixture(kind);
    try {
      const operation = await proved(f.store);
      const original = f.store.compareAndSetIdentityMerge!.bind(f.store);
      f.store.compareAndSetIdentityMerge = async (input) => {
        if (input.reserve)
          await f.store.saveAccount({
            subject: "tsub_identity_C",
            email: "owner@example.test",
            emailVerified: true,
            createdAt: 1,
            updatedAt: 1,
          });
        return original(input);
      };
      await expect(
        consentIdentityMerge({
          store: f.store,
          operation,
          session: sessionA,
          consent: true,
          reconciler: pendingReconciler,
          retryCapability: {
            pendingCapacity: 100,
            assertAvailable: async () => {},
          },
          now,
        }),
      ).rejects.toThrow("merge_conflict");
      expect(await f.store.isAccountAuthenticationFenced!(accountA)).toBe(
        false,
      );
      expect(await f.store.isAccountAuthenticationFenced!(accountB)).toBe(
        false,
      );
      expect(await f.store.getAccountAuthenticationGeneration!(accountA)).toBe(
        0,
      );
      expect(
        await f.store.findAccountSession(sessionA.sessionId),
      ).toBeDefined();
    } finally {
      await f.close();
    }
  }, 30000);
  test(`${kind}: Unicode-domain collision inserted before activation CAS stops canonical mapping`, async () => {
    const f = await fixture(kind);
    try {
      // Full-width domain has the same IDNA value while old durable email is untouched.
      const operation = await consented(f.store);
      const original = f.store.compareAndSetIdentityMerge!.bind(f.store);
      f.store.compareAndSetIdentityMerge = async (input) => {
        if (input.activate)
          await f.store.saveAccount({
            subject: "tsub_identity_C",
            email: "Owner@ｅｘａｍｐｌｅ.test",
            emailVerified: true,
            createdAt: 1,
            updatedAt: 1,
          });
        return original(input);
      };
      await expect(
        activateIdentityMerge({
          store: f.store,
          operation,
          reconciler: { reconcile: async () => ack(operation) },
          now,
        }),
      ).rejects.toThrow("merge_conflict");
      expect((await f.store.findCanonicalAccount!(accountB))?.subject).toBe(
        accountB,
      );
      expect(await f.store.isAccountAuthenticationFenced!(accountA)).toBe(true);
      expect(await f.store.getAccountAuthenticationGeneration!(accountA)).toBe(
        1,
      );
    } finally {
      await f.close();
    }
  }, 30000);
  test(`${kind}: expired partial acknowledgement can only release operation-owned fences after reviewed rollback`, async () => {
    const f = await fixture(kind);
    try {
      const operation = await consented(f.store);
      const expired = now + 300001;
      const references = f.pg
        ? (await f.pg.query("SELECT * FROM accounts_v1.protected_references"))
            .rows
        : undefined;
      await expect(
        activateIdentityMerge({
          store: f.store,
          operation,
          reconciler: { reconcile: async () => ack(operation) },
          now: expired,
        }),
      ).rejects.toThrow();
      await expect(
        abortPendingIdentityMerge({
          store: f.store,
          operation,
          reconciler: {
            reconcile: async () => undefined,
            reconcileRecovery: async () => ({
              ...ack(operation),
              reconciledAt: expired,
              undoOperationId: "undo-pending",
              reviewedRecoveryRef: "reviewed-but-incomplete",
            }),
          },
          now: expired,
        }),
      ).rejects.toThrow("recovery_review_required");
      expect(await f.store.isAccountAuthenticationFenced!(accountA)).toBe(true);
      expect(await f.store.getAccountAuthenticationGeneration!(accountA)).toBe(
        1,
      );
      const reconciler = {
        reconcile: async () => undefined,
        reconcileRecovery: async () => ({
          ...ack(operation),
          reconciledAt: expired,
          undoOperationId: "undo-pending",
          reviewedRecoveryRef: "reviewed-recovery",
          preActivationRollback: {
            externalBindings: "owner-rollback",
            workspaceMembership: "membership-preserved",
            billingLedger: "ledger-unchanged",
            rpSessions: "session-revoked",
            consumerIntentCustody: "original-pending-operation-retained",
          },
        }),
      };
      const outcome = await abortPendingIdentityMerge({
        store: f.store,
        operation,
        reconciler,
        now: expired,
      });
      expect(outcome.status).toBe("aborted");
      expect(await f.store.isAccountAuthenticationFenced!(accountA)).toBe(
        false,
      );
      expect(await f.store.isAccountAuthenticationFenced!(accountB)).toBe(
        false,
      );
      expect((await f.store.findCanonicalAccount!(accountB))?.subject).toBe(
        accountB,
      );
      expect(await f.store.getAccountAuthenticationGeneration!(accountA)).toBe(
        2,
      );
      expect(
        await f.store.findAccountSession(sessionA.sessionId),
      ).toBeUndefined();
      expect(
        (
          await f.store.findIdentityOperationReceipt!(
            operation.sourceProof!.receiptId,
          )
        )?.consumedByOperation,
      ).toBe(operation.operationId);
      if (f.pg) {
        expect(
          (await f.pg.query("SELECT * FROM accounts_v1.protected_references"))
            .rows,
        ).toEqual(references);
        expect(
          (
            await f.pg.query(
              "SELECT document FROM accounts_v1.hosted_identity_records WHERE bucket='identity_merge_audit' ORDER BY key",
            )
          ).rows.some((r) =>
            JSON.stringify(r.document).includes(
              '"method":"upstream-oauth-operation"',
            ),
          ),
        ).toBe(true);
      }
    } finally {
      await f.close();
    }
  }, 30000);
  test(`${kind}: preactivation abort and activation have one terminal winner and reject foreign operation context`, async () => {
    const f = await fixture(kind);
    try {
      const operation = await consented(f.store);
      const reconciler = {
        reconcile: async () => ack(operation),
        reconcileRecovery: async () => ({
          ...ack(operation),
          undoOperationId: "undo-race",
          reviewedRecoveryRef: "review",
          preActivationRollback: {
            externalBindings: "x",
            workspaceMembership: "x",
            billingLedger: "x",
            rpSessions: "x",
            consumerIntentCustody: "x",
          },
        }),
      };
      await expect(
        abortPendingIdentityMerge({
          store: f.store,
          operation: { ...operation, operationId: "foreign-operation" },
          reconciler,
          now,
        }),
      ).rejects.toThrow("merge_conflict");
      const outcomes = await Promise.allSettled([
        abortPendingIdentityMerge({
          store: f.store,
          operation,
          reconciler,
          now,
        }),
        activateIdentityMerge({ store: f.store, operation, reconciler, now }),
      ]);
      expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const latest = await f.store.findIdentityMergeOperation!(
        operation.operationId,
      );
      expect(["aborted", "active"]).toContain(latest?.status);
      if (latest?.status === "aborted")
        expect((await f.store.findCanonicalAccount!(accountB))?.subject).toBe(
          accountB,
        );
    } finally {
      await f.close();
    }
  }, 30000);
}
