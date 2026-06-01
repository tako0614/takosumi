import { expect, test } from "bun:test";
import {
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertStringIncludes,
} from "../../../test/assert.ts";
import {
  PostgresAccountsStore,
  type PostgresQueryClient,
  type PostgresQueryResult,
} from "./postgres-store.ts";
import { LedgerAccountOwnershipConflictError } from "./store.ts";

class RecordingPostgresClient implements PostgresQueryClient {
  calls: Array<{ sql: string; args: readonly unknown[] }> = [];
  queuedRows: unknown[][] = [];

  queryObject<T>(
    sql: string,
    args: readonly unknown[] = [],
  ): Promise<PostgresQueryResult<T>> {
    this.calls.push({ sql, args });
    return Promise.resolve({ rows: (this.queuedRows.shift() ?? []) as T[] });
  }
}

test("PostgresAccountsStore hashes OAuth credentials before writing", async () => {
  const client = new RecordingPostgresClient();
  const store = new PostgresAccountsStore(client);

  await store.saveAuthorizationCode("plain-code", {
    clientId: "client-1",
    redirectUri: "https://app.example.test/callback",
    scope: "openid profile",
    subject: "sub_pairwise",
   takosumiSubject: "tsub_owner",
    nonce: "nonce-1",
    expiresAt: 2_000,
  });

  expect(client.calls[0].sql).toContain("accounts_v1.authorization_codes");
  expect(typeof client.calls[0].args[0]).toEqual("string");
  expect(String(client.calls[0].args[0])).toContain("sha256:");
  expect(client.calls[0].args[0]).not.toEqual("plain-code");
});

test("PostgresAccountsStore hashes personal access tokens before writing", async () => {
  const client = new RecordingPostgresClient();
  const store = new PostgresAccountsStore(client);

  await store.savePersonalAccessToken("takpat_plain", {
    tokenId: "pat_1",
    tokenPrefix: "takpat_pl",
    subject: "tsub_owner",
    name: "CLI",
    scopes: ["read", "write"],
    createdAt: 1_000,
  });

  expect(client.calls[0].sql).toContain("accounts_v1.personal_access_tokens");
  expect(String(client.calls[0].args[1])).toContain("sha256:");
  expect(client.calls[0].args[1]).not.toEqual("takpat_plain");
});

test("PostgresAccountsStore maps account terms acceptance", async () => {
  const client = new RecordingPostgresClient();
  const store = new PostgresAccountsStore(client);

  await store.saveAccount({
    subject: "tsub_owner",
    email: "owner@example.test",
    displayName: "Owner",
    termsVersion: "terms-2026-05-13",
    termsAcceptedAt: 1_500,
    termsAcceptedSource: "use-takos-start",
    createdAt: 1_000,
    updatedAt: 2_000,
  });

  expect(client.calls[0].sql).toContain("email_verified");
  expect(client.calls[0].sql).toContain("terms_version");
  expect(client.calls[0].sql).toContain("terms_accepted_at");
  // `email_verified` is bound as $3 (no upstream assertion here -> null),
  // shifting the terms args down by one.
  expect(client.calls[0].args[2]).toEqual(null);
  expect(client.calls[0].args[4]).toEqual("terms-2026-05-13");
  expect(client.calls[0].args[5]).toEqual(new Date(1_500));
  expect(client.calls[0].args[6]).toEqual("use-takos-start");

  client.queuedRows.push([{
    subject: "tsub_owner",
    email: "owner@example.test",
    email_verified: true,
    display_name: "Owner",
    terms_version: "terms-2026-05-13",
    terms_accepted_at: new Date(1_500),
    terms_accepted_source: "use-takos-start",
    created_at: new Date(1_000),
    updated_at: new Date(2_000),
  }]);

  const record = await store.findAccount("tsub_owner");

  // The SELECT must read `email_verified` and `findAccount` must surface it as
  // `emailVerified` so the value survives the re-read at OIDC token issuance.
  expect(client.calls[1].sql).toContain("email_verified");
  expect(record).toEqual({
    subject: "tsub_owner",
    email: "owner@example.test",
    emailVerified: true,
    displayName: "Owner",
    termsVersion: "terms-2026-05-13",
    termsAcceptedAt: 1_500,
    termsAcceptedSource: "use-takos-start",
    createdAt: 1_000,
    updatedAt: 2_000,
  });
});

test("PostgresAccountsStore maps personal access token records", async () => {
  const client = new RecordingPostgresClient();
  client.queuedRows.push([{
    token_id: "pat_1",
    token_prefix: "takpat_ab",
    subject: "tsub_owner",
    name: "CLI",
    scopes: ["read", "admin"],
    created_at: new Date(1_000),
    expires_at: null,
    revoked_at: null,
    last_used_at: new Date(1_500),
  }]);
  const store = new PostgresAccountsStore(client);

  const record = await store.findPersonalAccessToken("takpat_plain");

  expect(client.calls[0].sql).toContain("token_hash = $1");
  expect(record).toEqual({
    tokenId: "pat_1",
    tokenPrefix: "takpat_ab",
    subject: "tsub_owner",
    name: "CLI",
    scopes: ["read", "admin"],
    createdAt: 1_000,
    expiresAt: undefined,
    revokedAt: undefined,
    lastUsedAt: 1_500,
  });
});

test("PostgresAccountsStore maps billing dunning and credit state", async () => {
  const client = new RecordingPostgresClient();
  const store = new PostgresAccountsStore(client);

  await store.saveBillingAccount({
    billingAccountId: "bill_1",
    subject: "tsub_owner",
    provider: "stripe",
    stripeCustomerId: "cus_1",
    stripeSubscriptionId: "sub_1",
    stripePriceId: "price_pro",
    planCode: "pro",
    currentPeriodEndUnix: 1_700_200_000,
    lastInvoiceId: "in_failed",
    dunningStartedAt: 2_000,
    nextPaymentAttemptUnix: 1_700_300_000,
    dunningAttemptCount: 2,
    dunningAction: "marked_uncollectible",
    dunningExhaustedAt: 2_500,
    lastCreditEventId: "evt_credit",
    lastCreditKind: "credit_note",
    lastCreditId: "cn_1",
    lastCreditAmount: 500,
    lastCreditCurrency: "usd",
    lastPlanTransitionEventId: "evt_plan",
    lastPlanFromCode: "plus",
    lastPlanToCode: "pro",
    lastPlanTransitionedAt: 1_800,
    lastTaxEventId: "evt_tax",
    taxPolicyRef: "tax-policy://us-sales-tax",
    taxJurisdiction: "US",
    taxAutomaticStatus: "complete",
    status: "past_due",
    createdAt: 1_000,
    updatedAt: 2_000,
  });

  expect(client.calls[0].sql).toContain("dunning_started_at");
  expect(client.calls[0].sql).toContain("last_credit_kind");
  expect(client.calls[0].sql).toContain("last_plan_transition_event_id");
  expect(client.calls[0].sql).toContain("tax_policy_ref");
  expect(client.calls[0].args[8]).toEqual("in_failed");
  expect(client.calls[0].args[9]).toEqual(new Date(2_000));
  expect(client.calls[0].args[10]).toEqual(1_700_300_000);
  expect(client.calls[0].args[11]).toEqual(2);
  expect(client.calls[0].args[12]).toEqual("marked_uncollectible");
  expect(client.calls[0].args[13]).toEqual(new Date(2_500));
  expect(client.calls[0].args[15]).toEqual("credit_note");
  expect(client.calls[0].args[17]).toEqual(500);
  expect(client.calls[0].args[19]).toEqual("evt_plan");
  expect(client.calls[0].args[22]).toEqual(new Date(1_800));
  expect(client.calls[0].args[24]).toEqual("tax-policy://us-sales-tax");

  client.queuedRows.push([{
    billing_account_id: "bill_1",
    subject: "tsub_owner",
    provider: "stripe",
    stripe_customer_id: "cus_1",
    stripe_subscription_id: "sub_1",
    stripe_price_id: "price_pro",
    plan_code: "pro",
    current_period_end_unix: "1700200000",
    last_invoice_id: "in_failed",
    dunning_started_at: new Date(2_000),
    next_payment_attempt_unix: "1700300000",
    dunning_attempt_count: "2",
    dunning_action: "marked_uncollectible",
    dunning_exhausted_at: new Date(2_500),
    last_credit_event_id: "evt_credit",
    last_credit_kind: "credit_note",
    last_credit_id: "cn_1",
    last_credit_amount: "500",
    last_credit_currency: "usd",
    last_plan_transition_event_id: "evt_plan",
    last_plan_from_code: "plus",
    last_plan_to_code: "pro",
    last_plan_transitioned_at: new Date(1_800),
    last_tax_event_id: "evt_tax",
    tax_policy_ref: "tax-policy://us-sales-tax",
    tax_jurisdiction: "US",
    tax_automatic_status: "complete",
    status: "past_due",
    created_at: new Date(1_000),
    updated_at: new Date(2_000),
  }]);

  const record = await store.findBillingAccount("bill_1");

  expect(record?.dunningStartedAt).toEqual(2_000);
  expect(record?.nextPaymentAttemptUnix).toEqual(1_700_300_000);
  expect(record?.dunningAttemptCount).toEqual(2);
  expect(record?.dunningAction).toEqual("marked_uncollectible");
  expect(record?.dunningExhaustedAt).toEqual(2_500);
  expect(record?.lastCreditKind).toEqual("credit_note");
  expect(record?.lastCreditAmount).toEqual(500);
  expect(record?.lastPlanFromCode).toEqual("plus");
  expect(record?.lastPlanToCode).toEqual("pro");
  expect(record?.lastPlanTransitionedAt).toEqual(1_800);
  expect(record?.taxPolicyRef).toEqual("tax-policy://us-sales-tax");
  expect(record?.taxJurisdiction).toEqual("US");
});

test("PostgresAccountsStore consumes authorization codes with DELETE RETURNING mapping", async () => {
  const client = new RecordingPostgresClient();
  client.queuedRows.push([{
    client_id: "client-1",
    redirect_uri: "https://app.example.test/callback",
    scope: "openid",
    subject: "sub_pairwise",
   takosumi_subject: "tsub_owner",
    installation_id: "inst_1",
    app_id: "app.demo",
    space_id: "space_1",
    role: "owner",
    nonce: "nonce-1",
    code_challenge: "challenge",
    code_challenge_method: "S256",
    expires_at: new Date(2_000),
  }]);
  const store = new PostgresAccountsStore(client);

  const record = await store.consumeAuthorizationCode("plain-code");

  expect(client.calls[0].sql).toContain("DELETE FROM accounts_v1.authorization_codes");
  expect(client.calls[0].sql).toContain("RETURNING");
  expect(record).toEqual({
    clientId: "client-1",
    redirectUri: "https://app.example.test/callback",
    scope: "openid",
    subject: "sub_pairwise",
   takosumiSubject: "tsub_owner",
    installationId: "inst_1",
    appId: "app.demo",
    spaceId: "space_1",
    role: "owner",
    nonce: "nonce-1",
    codeChallenge: "challenge",
    codeChallengeMethod: "S256",
    expiresAt: 2_000,
  });
});

test("PostgresAccountsStore writes billing usage metadata as jsonb", async () => {
  const client = new RecordingPostgresClient();
  const store = new PostgresAccountsStore(client);
  // The atomic conditional upsert RETURNs the usage_report_id when the write
  // (insert or owner-matching update) succeeds; queue it so the store does
  // not treat a non-empty result as an ownership conflict.
  client.queuedRows.push([{ usage_report_id: "usage_report_1" }]);

  await store.saveBillingUsageRecord({
    usageReportId: "usage_report_1",
    installationId: "inst_1",
    billingAccountId: "bill_1",
    meter: "agent.compute.seconds",
    quantity: 12.5,
    unit: "seconds",
    periodStart: 1_000,
    periodEnd: 2_000,
    idempotencyKey: "usage-window-1",
    requestDigest: "sha256:usage-1",
    metadata: { run_id: "run_1" },
    reportedBySubject: "tsub_owner",
    reportedAt: 3_000,
  });

  // The pre-read find() is gone (it raced); the conditional upsert is now the
  // only statement.
  expect(client.calls[0].sql).toContain("accounts_v1.billing_usage_records");
  expect(client.calls[0].sql).toContain("billing_usage_records.installation_id");
  expect(client.calls[0].sql).toContain("EXCLUDED.installation_id");
  expect(client.calls[0].sql).toContain("RETURNING usage_report_id");
  expect(client.calls[0].args[9]).toEqual("sha256:usage-1");
  expect(client.calls[0].args[10]).toEqual('{"run_id":"run_1"}');
});

test("PostgresAccountsStore rejects a cross-owner billing usage conflict", async () => {
  const client = new RecordingPostgresClient();
  const store = new PostgresAccountsStore(client);
  // 0 rows returned: the conditional ON CONFLICT ... WHERE owner-matches did
  // not fire because the existing row is owned by another installation.
  client.queuedRows.push([]);

  await assertRejects(
    () =>
      store.saveBillingUsageRecord({
        usageReportId: "usage_report_1",
        installationId: "inst_other",
        billingAccountId: "bill_other",
        meter: "agent.compute.seconds",
        quantity: 99,
        unit: "seconds",
        requestDigest: "sha256:usage-2",
        metadata: {},
        reportedAt: 3_000,
      }),
    TypeError,
    "already owned by another installation",
  );
});

test("PostgresAccountsStore maps billing usage records", async () => {
  const client = new RecordingPostgresClient();
  client.queuedRows.push([{
    usage_report_id: "usage_report_1",
    installation_id: "inst_1",
    billing_account_id: "bill_1",
    meter: "agent.compute.seconds",
    quantity: 12.5,
    unit: "seconds",
    period_start: new Date(1_000),
    period_end: null,
    idempotency_key: "usage-window-1",
    request_digest: "sha256:usage-1",
    metadata: '{"run_id":"run_1"}',
    reported_by_subject: "tsub_owner",
    reported_at: new Date(3_000),
  }]);
  const store = new PostgresAccountsStore(client);

  const records = await store.listBillingUsageRecordsForInstallation("inst_1");

  expect(client.calls[0].sql).toContain("installation_id = $1");
  expect(records).toEqual([{
    usageReportId: "usage_report_1",
    installationId: "inst_1",
    billingAccountId: "bill_1",
    meter: "agent.compute.seconds",
    quantity: 12.5,
    unit: "seconds",
    periodStart: 1_000,
    periodEnd: undefined,
    idempotencyKey: "usage-window-1",
    requestDigest: "sha256:usage-1",
    metadata: { run_id: "run_1" },
    reportedBySubject: "tsub_owner",
    reportedAt: 3_000,
  }]);
});

test("PostgresAccountsStore reports launch token jti insert conflicts", async () => {
  const client = new RecordingPostgresClient();
  client.queuedRows.push([{ jti: "lt_1" }], []);
  const store = new PostgresAccountsStore(client);
  const record = {
    jti: "lt_1",
    installationId: "inst_1",
    subject: "tsub_owner" as const,
    audience: "app.demo",
    expiresAt: 2_000,
    consumedAt: 1_000,
  };

  expect(await store.consumeLaunchTokenJti(record)).toEqual(true);
  expect(await store.consumeLaunchTokenJti(record)).toEqual(false);
});

test("PostgresAccountsStore prunes expired and used launch tokens", async () => {
  const client = new RecordingPostgresClient();
  client.queuedRows.push([{ deleted: 3, expired: 2, used: 1 }]);
  const store = new PostgresAccountsStore(client);

  const result = await store.pruneLaunchTokens({
    expiredBefore: 2_000,
    usedBefore: 3_000,
  });

  expect(result).toEqual({ deleted: 3, expired: 2, used: 1 });
  expect(client.calls[0].sql).toContain("DELETE FROM installation_v1.launch_tokens");
  expect(client.calls[0].sql).toContain("expires_at <= $1");
  expect(client.calls[0].sql).toContain("used_at IS NOT NULL");
  expect(client.calls[0].args).toEqual([new Date(2_000), new Date(3_000)]);
});

test("PostgresAccountsStore does not write retired service import storage", async () => {
  const client = new RecordingPostgresClient();
  const store = new PostgresAccountsStore(client);

  await store.saveAppInstallation({
    installationId: "inst_1",
    accountId: "acct_1",
    spaceId: "space_1",
    appId: "app.demo",
    sourceGitUrl: "https://git.example.test/app.git",
    sourceRef: "main",
    sourceCommit: "abc123",
    planSnapshotDigest: "sha256:manifest",
    artifactDigest: undefined,
    mode: "shared-cell",
    runtimeBindingId: undefined,
    billingAccountId: "billing_inst_1",
    status: "installing",
    createdBySubject: "tsub_owner",
    createdAt: 1_000,
    updatedAt: 1_000,
  });

  expect(client.calls[0].sql.includes("service_imports_json")).toEqual(false);
  expect(client.calls[0].sql).toContain("billing_account_id");
  expect(client.calls[0].args.includes("billing_inst_1")).toEqual(true);
});

test("PostgresAccountsStore validates AppBinding records before writing", async () => {
  const client = new RecordingPostgresClient();
  const store = new PostgresAccountsStore(client);

  await assertRejects(
    () =>
      store.saveAppBinding({
        bindingId: "bind_launch",
        installationId: "inst_1",
        name: "launch",
        kind: "install-launch-token@v1",
        configRef: "takosumi-accounts://inst_1/launch-token/kid",
        secretRefs: ["secret://inst_1/launch-token/private-key"],
        createdAt: 1_000,
        updatedAt: 1_000,
      }),
    TypeError,
    "install-launch-token@v1 must not store secret references",
  );
  expect(client.calls.length).toEqual(0);
});

test("PostgresAccountsStore orders InstallationEvents by append sequence", async () => {
  const client = new RecordingPostgresClient();
  const store = new PostgresAccountsStore(client);

  await store.listInstallationEvents("inst_1");

  expect(client.calls[0].sql).toContain("ORDER BY event_sequence, event_id");
});

test("PostgresAccountsStore guards ledger account ownership at the store boundary (F7)", async () => {
  const client = new RecordingPostgresClient();
  const store = new PostgresAccountsStore(client);
  // The conditional upsert RETURNs account_id on a successful insert /
  // owner-matching update; queue it so the store does not treat the write as
  // an ownership conflict.
  client.queuedRows.push([{ account_id: "acct_1" }]);

  await store.saveLedgerAccount({
    accountId: "acct_1",
    legalOwnerSubject: "tsub_alice",
    billingAccountId: undefined,
    createdAt: 1_000,
    updatedAt: 1_000,
  });

  // The UPSERT keeps the original `legal_owner_subject` in the SET
  // clause (because it equals EXCLUDED.legal_owner_subject) but the
  // `WHERE` clause refuses to overwrite the row when the existing
  // owner differs from the incoming one.
  expect(client.calls[0].sql).toContain("ON CONFLICT (account_id)");
  expect(client.calls[0].sql).toContain("WHERE installation_v1.ledger_accounts.legal_owner_subject");
  expect(client.calls[0].sql).toContain("= EXCLUDED.legal_owner_subject");
  // The UPDATE clause no longer touches legal_owner_subject directly,
  // since we never want to silently rebind a ledger account to a
  // different owner.
  expect(client.calls[0].sql.includes(
      "legal_owner_subject = EXCLUDED.legal_owner_subject",
    )).toEqual(false);
});

test("PostgresAccountsStore throws on a ledger ownership change (F7, consistent with D1/in-memory)", async () => {
  const client = new RecordingPostgresClient();
  const store = new PostgresAccountsStore(client);
  // 0 rows from the conditional upsert: the existing row is owned by a
  // different subject, so the WHERE owner-match did not fire.
  client.queuedRows.push([]);
  // The conflict branch re-reads the existing row to populate the error.
  client.queuedRows.push([{
    account_id: "acct_1",
    legal_owner_subject: "tsub_alice",
    billing_account_id: null,
    created_at: new Date(1_000),
    updated_at: new Date(1_000),
  }]);

  await assertRejects(
    () =>
      store.saveLedgerAccount({
        accountId: "acct_1",
        legalOwnerSubject: "tsub_mallory",
        billingAccountId: undefined,
        createdAt: 2_000,
        updatedAt: 2_000,
      }),
    LedgerAccountOwnershipConflictError,
    "already owned by a different Takosumi subject",
  );
});

test("PostgresAccountsStore serializes installation event appends with a row lock (F7)", async () => {
  const client = new RecordingPostgresClient();
  const store = new PostgresAccountsStore(client);

  await store.appendInstallationEvent({
    eventId: "evt_1",
    installationId: "inst_1",
    eventType: "installation.created",
    payload: {},
    eventHash: "sha256:first",
    createdAt: 1_000,
  });

  // BEGIN / lock insert / SELECT ... FOR UPDATE NOWAIT / INSERT event /
  // COMMIT, in that order.
  expect(client.calls[0].sql.trim()).toEqual("BEGIN");
  expect(client.calls[1].sql).toContain("installation_event_chain_locks");
  expect(client.calls[2].sql).toContain("FOR UPDATE NOWAIT");
  expect(client.calls[3].sql).toContain("INSERT INTO installation_v1.installation_events");
  expect(client.calls[4].sql.trim()).toEqual("COMMIT");
});
