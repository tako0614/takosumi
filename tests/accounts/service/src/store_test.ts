import { expect, test } from "bun:test";
import { assertEquals, assertThrows } from "../../../helpers/assert.ts";
import { InMemoryAccountsStore } from "../../../../accounts/service/src/store.ts";

test("InMemoryAccountsStore persists accounts and upstream identity links", () => {
  const store = new InMemoryAccountsStore();
  store.saveAccount({
    subject: "tsub_test",
    email: "user@example.test",
    displayName: "User",
    termsVersion: "terms-2026-05-13",
    termsAcceptedAt: 1000,
    termsAcceptedSource: "account-terms",
    createdAt: 1000,
    updatedAt: 1000,
  });
  store.saveAccount({
    subject: "tsub_test",
    email: "renamed@example.test",
    displayName: "Renamed",
    createdAt: 1000,
    updatedAt: 2000,
  });
  store.linkUpstreamIdentity({
    providerId: "github",
    upstreamIssuer: "https://github.com",
    upstreamSubject: "12345",
    subject: "tsub_test",
    createdAt: 1000,
    updatedAt: 1000,
  });

  expect(store.findAccount("tsub_test")?.email).toEqual("renamed@example.test");
  expect(store.findAccount("tsub_test")?.termsVersion).toEqual(
    "terms-2026-05-13",
  );
  expect(store.findAccount("tsub_test")?.termsAcceptedAt).toEqual(1000);
  expect(
    store.findUpstreamIdentity({
      providerId: "github",
      upstreamIssuer: "https://github.com",
      upstreamSubject: "12345",
    })?.subject,
  ).toEqual("tsub_test");
});

test("InMemoryAccountsStore resolves only verified email addresses", () => {
  const store = new InMemoryAccountsStore();
  store.saveAccount({
    subject: "tsub_verified",
    email: "Member@Example.Test",
    emailVerified: true,
    createdAt: 1000,
    updatedAt: 1000,
  });
  store.saveAccount({
    subject: "tsub_unverified",
    email: "pending@example.test",
    emailVerified: false,
    createdAt: 1000,
    updatedAt: 1000,
  });

  expect(
    store.findAccountByVerifiedEmail(" member@example.test ")?.subject,
  ).toEqual("tsub_verified");
  expect(store.findAccountByVerifiedEmail("pending@example.test")).toEqual(
    undefined,
  );
  expect(store.findAccountByVerifiedEmail("missing@example.test")).toEqual(
    undefined,
  );
});

test("InMemoryAccountsStore indexes passkey credentials by subject", () => {
  const store = new InMemoryAccountsStore();
  store.savePasskeyCredential({
    credentialId: "credential-1",
    subject: "tsub_test",
    publicKeyJwk: { kty: "EC" },
    signCount: 1,
    createdAt: 1000,
    updatedAt: 1000,
  });

  expect(store.findPasskeyCredential("credential-1")?.subject).toEqual(
    "tsub_test",
  );
  expect(
    store
      .listPasskeyCredentialsForSubject("tsub_test")
      .map((credential) => credential.credentialId),
  ).toEqual(["credential-1"]);
});

test("InMemoryAccountsStore persists and deletes account sessions", () => {
  const store = new InMemoryAccountsStore();
  store.saveAccountSession({
    sessionId: "session-1",
    subject: "tsub_test",
    createdAt: 1000,
    expiresAt: 2000,
  });

  expect(store.findAccountSession("session-1")?.subject).toEqual("tsub_test");
  store.deleteAccountSession("session-1");
  expect(store.findAccountSession("session-1")).toEqual(undefined);
});

test("InMemoryAccountsStore manages personal access token metadata", () => {
  const store = new InMemoryAccountsStore();
  store.savePersonalAccessToken("takpat_secret", {
    tokenId: "pat_1",
    tokenPrefix: "takpat_se",
    subject: "tsub_test",
    name: "CLI",
    scopes: ["read", "write"],
    createdAt: 1000,
    expiresAt: 2000,
  });

  expect(store.findPersonalAccessToken("takpat_secret")?.tokenId).toEqual(
    "pat_1",
  );
  expect(
    store
      .listPersonalAccessTokensForSubject("tsub_test")
      .map((token) => token.name),
  ).toEqual(["CLI"]);
  store.recordPersonalAccessTokenUsed("pat_1", 1500);
  expect(store.findPersonalAccessToken("takpat_secret")?.lastUsedAt).toEqual(
    1500,
  );
  expect(
    store.revokePersonalAccessToken({
      subject: "tsub_test",
      tokenId: "pat_1",
      revokedAt: 1600,
    })?.revokedAt,
  ).toEqual(1600);
  expect(
    store.revokePersonalAccessToken({
      subject: "tsub_other",
      tokenId: "pat_1",
      revokedAt: 1700,
    }),
  ).toEqual(undefined);
});

test("InMemoryAccountsStore persists billing usage records per installation", () => {
  const store = new InMemoryAccountsStore();
  store.saveBillingUsageRecord({
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
  store.saveBillingUsageRecord({
    usageReportId: "usage_report_2",
    installationId: "inst_2",
    billingAccountId: "bill_1",
    meter: "agent.compute.seconds",
    quantity: 1,
    unit: "seconds",
    requestDigest: "sha256:usage-2",
    metadata: {},
    reportedAt: 3_500,
  });

  expect(
    store.listBillingUsageRecordsForInstallation("inst_1").map((record) => ({
      id: record.usageReportId,
      meter: record.meter,
      requestDigest: record.requestDigest,
      metadata: record.metadata,
    })),
  ).toEqual([
    {
      id: "usage_report_1",
      meter: "agent.compute.seconds",
      requestDigest: "sha256:usage-1",
      metadata: { run_id: "run_1" },
    },
  ]);
  expect(
    store
      .listBillingUsageRecordsForBillingAccount("bill_1")
      .map((record) => record.usageReportId),
  ).toEqual(["usage_report_1", "usage_report_2"]);
  store.markBillingUsageRecordsExported({
    billingAccountId: "bill_1",
    usageReportIds: ["usage_report_1"],
    provider: "stripe",
    exportId: "export_1",
    exportReference: "ii_1",
    exportedAt: 4_000,
  });
  expect(store.findBillingUsageRecord("usage_report_1")).toMatchObject({
    billingExportProvider: "stripe",
    billingExportId: "export_1",
    billingExportReference: "ii_1",
    billingExportedAt: 4_000,
  });
});

test("InMemoryAccountsStore indexes billing accounts by subject and Stripe customer", () => {
  const store = new InMemoryAccountsStore();
  store.saveBillingAccount({
    billingAccountId: "billing-1",
    subject: "tsub_test",
    provider: "stripe",
    stripeCustomerId: "cus_123",
    lastInvoiceId: "in_123",
    dunningStartedAt: 1_100,
    nextPaymentAttemptUnix: 1_700_300_000,
    dunningAttemptCount: 2,
    dunningAction: "marked_uncollectible",
    dunningExhaustedAt: 1_300,
    lastCreditEventId: "evt_credit",
    lastCreditKind: "refund",
    lastCreditId: "re_123",
    lastCreditAmount: 1200,
    lastCreditCurrency: "usd",
    lastPlanTransitionEventId: "evt_plan",
    lastPlanFromCode: "starter",
    lastPlanToCode: "pro",
    lastPlanTransitionedAt: 1_200,
    lastTaxEventId: "evt_tax",
    taxPolicyRef: "tax-policy://us-sales-tax",
    taxJurisdiction: "US",
    taxAutomaticStatus: "complete",
    status: "active",
    createdAt: 1000,
    updatedAt: 1000,
  });

  expect(store.findBillingAccount("billing-1")?.subject).toEqual("tsub_test");
  expect(
    store.findBillingAccountForSubject("tsub_test")?.stripeCustomerId,
  ).toEqual("cus_123");
  expect(
    store.findBillingAccountByStripeCustomerId("cus_123")?.billingAccountId,
  ).toEqual("billing-1");
  expect(store.findBillingAccount("billing-1")?.lastCreditId).toEqual("re_123");
  expect(store.findBillingAccount("billing-1")?.dunningAction).toEqual(
    "marked_uncollectible",
  );
  expect(store.findBillingAccount("billing-1")?.lastPlanToCode).toEqual("pro");
  expect(store.findBillingAccount("billing-1")?.taxAutomaticStatus).toEqual(
    "complete",
  );
});

test("InMemoryAccountsStore validates ServiceBindingMaterial records before saving", () => {
  const store = new InMemoryAccountsStore();

  assertThrows(
    () =>
      store.saveServiceBindingMaterial({
        bindingId: "bind_launch",
        installationId: "inst_1",
        name: "launch",
        kind: "auth.bootstrap_token",
        configRef: "takosumi-accounts://inst_1/launch-token/kid",
        secretRefs: ["secret://inst_1/launch-token/private-key"],
        createdAt: 1_000,
        updatedAt: 1_000,
      }),
    TypeError,
    "auth.bootstrap_token must not store secret references",
  );
});

test("InMemoryAccountsStore persists billing webhook event status", () => {
  const store = new InMemoryAccountsStore();
  store.saveBillingWebhookEvent({
    eventId: "evt_1",
    eventType: "checkout.session.completed",
    status: "received",
    receivedAt: 1000,
    updatedAt: 1000,
  });
  store.saveBillingWebhookEvent({
    eventId: "evt_1",
    eventType: "checkout.session.completed",
    status: "processed",
    receivedAt: 1000,
    updatedAt: 2000,
  });

  expect(store.findBillingWebhookEvent("evt_1")?.status).toEqual("processed");
  expect(store.findBillingWebhookEvent("evt_missing")).toEqual(undefined);
});

test("InMemoryAccountsStore persists AppInstallation ledger records", () => {
  const store = new InMemoryAccountsStore();
  store.saveLedgerAccount({
    accountId: "acct_1",
    legalOwnerSubject: "tsub_owner",
    billingAccountId: "billing-1",
    createdAt: 1000,
    updatedAt: 1000,
  });
  store.saveSpace({
    spaceId: "space_1",
    accountId: "acct_1",
    kind: "personal",
    createdAt: 1000,
    updatedAt: 1000,
  });
  store.saveAppInstallation({
    installationId: "inst_1",
    accountId: "acct_1",
    spaceId: "space_1",
    appId: "takos.chat",
    sourceGitUrl: "https://github.com/takos/takos",
    sourceRef: "v1.2.3",
    sourceCommit: "abc123",
    planDigest: "sha256:app",
    artifactDigest: "sha256:compiled",
    mode: "shared-cell",
    billingAccountId: "billing-inst-1",
    status: "installing",
    createdBySubject: "tsub_owner",
    createdAt: 1000,
    updatedAt: 1000,
  });
  store.saveServiceBindingMaterial({
    bindingId: "bind_auth",
    installationId: "inst_1",
    name: "auth",
    kind: "identity.oidc",
    configRef: "config://inst_1/auth",
    secretRefs: ["secret://inst_1/auth/client-secret"],
    createdAt: 1000,
    updatedAt: 1000,
  });
  store.saveServiceGrantMaterial({
    grantId: "grant_1",
    installationId: "inst_1",
    capability: "deploy.intent.write",
    scope: { pathPrefix: "deployments/" },
    grantedAt: 1000,
  });

  expect(store.findLedgerAccount("acct_1")?.billingAccountId).toEqual(
    "billing-1",
  );
  expect(store.listSpacesForAccount("acct_1")[0]?.spaceId).toEqual("space_1");
  expect(
    store.listAppInstallationsForSpace("space_1")[0]?.installationId,
  ).toEqual("inst_1");
  expect(
    store.listAppInstallationsForSpace("space_1")[0]?.billingAccountId,
  ).toEqual("billing-inst-1");
  expect(
    store.listServiceBindingMaterialsForInstallation("inst_1")[0]?.kind,
  ).toEqual("identity.oidc");
  expect(store.listServiceGrantMaterialsForInstallation("inst_1")).toEqual([]);
});

test("InMemoryAccountsStore lists spaces by legal owner across accounts", () => {
  const store = new InMemoryAccountsStore();
  store.saveLedgerAccount({
    accountId: "acct_owned_a",
    legalOwnerSubject: "tsub_owner",
    createdAt: 1000,
    updatedAt: 1000,
  });
  store.saveLedgerAccount({
    accountId: "acct_owned_b",
    legalOwnerSubject: "tsub_owner",
    createdAt: 1001,
    updatedAt: 1001,
  });
  store.saveLedgerAccount({
    accountId: "acct_foreign",
    legalOwnerSubject: "tsub_other",
    createdAt: 1002,
    updatedAt: 1002,
  });
  store.saveSpace({
    spaceId: "space_a",
    accountId: "acct_owned_a",
    kind: "personal",
    createdAt: 1000,
    updatedAt: 1000,
  });
  store.saveSpace({
    spaceId: "space_b",
    accountId: "acct_owned_b",
    kind: "org",
    createdAt: 1001,
    updatedAt: 1001,
  });
  store.saveSpace({
    spaceId: "space_foreign",
    accountId: "acct_foreign",
    kind: "org",
    createdAt: 1002,
    updatedAt: 1002,
  });

  const owned = store.listSpacesForOwner("tsub_owner");
  const ids = [...owned].map((s) => s.spaceId).sort();
  expect(ids).toEqual(["space_a", "space_b"]);
  expect(ids).not.toContain("space_foreign");
  expect(store.listSpacesForOwner("tsub_nobody")).toEqual([]);
});

test("InMemoryAccountsStore appends InstallationEvent records in order", () => {
  const store = new InMemoryAccountsStore();
  store.appendInstallationEvent({
    eventId: "evt_1",
    installationId: "inst_1",
    eventType: "installation.created",
    payload: {},
    eventHash: "sha256:first",
    createdAt: 1000,
  });
  store.appendInstallationEvent({
    eventId: "evt_2",
    installationId: "inst_1",
    eventType: "installation.status_changed",
    payload: { to: "ready" },
    previousEventHash: "sha256:first",
    eventHash: "sha256:second",
    createdAt: 2000,
  });

  expect(
    store.listInstallationEvents("inst_1").map((event) => event.eventId),
  ).toEqual(["evt_1", "evt_2"]);
});

test("InMemoryAccountsStore consumes authorization codes once", () => {
  const store = new InMemoryAccountsStore();
  store.saveAuthorizationCode("code-1", {
    clientId: "client-1",
    redirectUri: "http://localhost/callback",
    scope: "openid",
    subject: "tsub_test",
    nonce: "nonce-1",
    expiresAt: Date.now() + 60_000,
  });

  expect(store.consumeAuthorizationCode("code-1")?.nonce).toEqual("nonce-1");
  expect(store.consumeAuthorizationCode("code-1")).toEqual(undefined);
});

test("InMemoryAccountsStore consumes launch token jtis once", () => {
  const store = new InMemoryAccountsStore();
  const record = {
    jti: "lt_1",
    installationId: "inst_1",
    subject: "tsub_test" as const,
    audience: "takos.chat",
    expiresAt: Date.now() + 60_000,
    consumedAt: Date.now(),
  };

  expect(store.consumeLaunchTokenJti(record)).toEqual(true);
  expect(store.consumeLaunchTokenJti(record)).toEqual(false);
});

test("InMemoryAccountsStore prunes expired and used launch tokens", () => {
  const store = new InMemoryAccountsStore();
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
  store.saveLaunchToken({
    ...base,
    installationId: "inst_expired",
    tokenHash: "sha256:expired",
    jti: "lt_expired",
    expiresAt: 2_000,
  });
  store.saveLaunchToken({
    ...base,
    installationId: "inst_used",
    tokenHash: "sha256:used",
    jti: "lt_used",
    expiresAt: 10_000,
    usedAt: 3_000,
  });
  store.saveLaunchToken({
    ...base,
    installationId: "inst_active",
    tokenHash: "sha256:active",
    jti: "lt_active",
    expiresAt: 10_000,
    createdAt: 4_000,
  });

  expect(
    store.pruneLaunchTokens({ expiredBefore: 2_500, usedBefore: 3_500 }),
  ).toEqual({ deleted: 2, expired: 1, used: 1 });
  expect(
    store.consumeLaunchToken({
      tokenHash: "sha256:expired",
      installationId: "inst_expired",
      redirectUri: base.redirectUri,
      consumedAt: 4_000,
    }),
  ).toEqual({ ok: false, reason: "not_found" });
  expect(
    store.consumeLaunchToken({
      tokenHash: "sha256:active",
      installationId: "inst_active",
      redirectUri: base.redirectUri,
      consumedAt: 4_000,
    }).ok,
  ).toEqual(true);
});

test("InMemoryAccountsStore indexes OIDC clients by installation", () => {
  const store = new InMemoryAccountsStore();
  store.saveOidcClient({
    clientId: "toc_client",
    installationId: "inst_1",
    namespacePath: "takosumi.identity.oidc",
    issuerUrl: "https://accounts.example.test",
    redirectUris: ["http://localhost:8787/auth/oidc/callback"],
    allowedScopes: ["openid", "profile"],
    subjectMode: "pairwise",
    tokenEndpointAuthMethod: "client_secret_post",
    clientSecretHash: "sha256:test",
    createdAt: 1000,
    updatedAt: 1000,
  });

  expect(store.findOidcClient("toc_client")?.installationId).toEqual("inst_1");
  expect(store.findOidcClientForInstallation("inst_1")?.clientId).toEqual(
    "toc_client",
  );
});

test("InMemoryAccountsStore deletes access and refresh tokens together", () => {
  const store = new InMemoryAccountsStore();
  const record = {
    clientId: "client-1",
    scope: "openid offline_access",
    subject: "tsub_test",
    expiresAt: Date.now() + 60_000,
  };
  store.saveAccessToken("access-1", record);
  store.saveRefreshToken("refresh-1", record);

  expect(store.findAccessToken("access-1")?.subject).toEqual("tsub_test");
  expect(store.findRefreshToken("refresh-1")?.subject).toEqual("tsub_test");

  store.deleteToken("access-1");
  store.deleteToken("refresh-1");

  expect(store.findAccessToken("access-1")).toEqual(undefined);
  expect(store.findRefreshToken("refresh-1")).toEqual(undefined);
});

test("InMemoryAccountsStore persists refresh rotation chain and cascade revokes (F30)", () => {
  const store = new InMemoryAccountsStore();
  const baseToken = {
    clientId: "client-1",
    scope: "openid offline_access",
    subject: "tsub_test",
    expiresAt: Date.now() + 60_000,
  };
  // Initial issuance: root refresh token + access token linked through code.
  store.saveRefreshToken("refresh-root", baseToken);
  store.saveAccessToken("access-root", baseToken);
  store.markAuthorizationCodeConsumed("code-1");
  store.linkAccessTokenToAuthCode("code-1", "access-root", "refresh-root");
  // First rotation: child refresh + access linked to the chain root.
  store.saveRefreshToken("refresh-child", baseToken);
  store.saveAccessToken("access-child", baseToken);
  store.addRefreshChainLink("refresh-root", "refresh-child");
  store.linkAccessTokenToRefreshChain("refresh-root", "access-child");

  expect(store.getRefreshChainChild("refresh-root")).toEqual("refresh-child");
  expect(store.isAuthorizationCodeConsumed("code-1")).toEqual(true);
  expect(store.isAuthorizationCodeConsumed("code-other")).toEqual(false);

  // Cascade revoke: replaying refresh-root must delete every refresh token
  // in the chain and every access token minted by the chain.
  const revoked = store.revokeRefreshChain("refresh-root");
  expect([...revoked].sort()).toEqual(["refresh-child", "refresh-root"].sort());
  expect(store.findRefreshToken("refresh-root")).toEqual(undefined);
  expect(store.findRefreshToken("refresh-child")).toEqual(undefined);
  expect(store.findAccessToken("access-child")).toEqual(undefined);
});

test("InMemoryAccountsStore addRefreshChainLink is an atomic single-winner claim (G6)", () => {
  const store = new InMemoryAccountsStore();
  // Two concurrent rotations of the SAME valid parent token. Only the
  // first link insert may win; the second must report a conflict so the
  // caller can treat it as reuse instead of minting a second child family.
  const first = store.addRefreshChainLink("refresh-root", "refresh-child-a");
  const second = store.addRefreshChainLink("refresh-root", "refresh-child-b");
  expect(first).toEqual(true);
  expect(second).toEqual(false);
  // The winning child link is the one that is recorded; the loser never
  // overwrites it.
  expect(store.getRefreshChainChild("refresh-root")).toEqual("refresh-child-a");
});

test("InMemoryAccountsStore reuses auth code cascade revokes downstream tokens (F30)", () => {
  const store = new InMemoryAccountsStore();
  const baseToken = {
    clientId: "client-1",
    scope: "openid offline_access",
    subject: "tsub_test",
    expiresAt: Date.now() + 60_000,
  };
  store.saveAccessToken("access-1", baseToken);
  store.saveRefreshToken("refresh-1", baseToken);
  store.markAuthorizationCodeConsumed("code-1");
  store.linkAccessTokenToAuthCode("code-1", "access-1", "refresh-1");

  const cascade = store.revokeTokensIssuedFromCode("code-1");
  expect(cascade.access).toEqual(["access-1"]);
  expect(cascade.refresh).toEqual(["refresh-1"]);
  expect(store.findAccessToken("access-1")).toEqual(undefined);
  expect(store.findRefreshToken("refresh-1")).toEqual(undefined);
});

test("InMemoryAccountsStore rejects a ledger ownership change (consistent with D1/PG)", () => {
  const store = new InMemoryAccountsStore();
  store.saveLedgerAccount({
    accountId: "acct_1",
    legalOwnerSubject: "tsub_alice",
    createdAt: 1_000,
    updatedAt: 1_000,
  });
  // Re-binding the same accountId to a different owner is rejected at the
  // store boundary (defense in depth) rather than silently overwriting.
  assertThrows(
    () =>
      store.saveLedgerAccount({
        accountId: "acct_1",
        legalOwnerSubject: "tsub_mallory",
        createdAt: 2_000,
        updatedAt: 2_000,
      }),
    Error,
    "already owned by a different Takosumi subject",
  );
  expect(store.findLedgerAccount("acct_1")?.legalOwnerSubject).toEqual(
    "tsub_alice",
  );
  // The same owner may still update its own row.
  store.saveLedgerAccount({
    accountId: "acct_1",
    legalOwnerSubject: "tsub_alice",
    billingAccountId: "bill_1",
    createdAt: 1_000,
    updatedAt: 3_000,
  });
  expect(store.findLedgerAccount("acct_1")?.billingAccountId).toEqual("bill_1");
});

test("InMemoryAccountsStore isRefreshRootRevoked reflects revoked roots", () => {
  const store = new InMemoryAccountsStore();
  store.addRefreshChainLink("refresh-root", "refresh-child");
  expect(store.isRefreshRootRevoked("refresh-root")).toEqual(false);
  expect(store.isRefreshRootRevoked("refresh-child")).toEqual(false);
  store.revokeRefreshChain("refresh-root");
  // The whole chain (root + any descendant) resolves to a revoked root.
  expect(store.isRefreshRootRevoked("refresh-root")).toEqual(true);
  expect(store.isRefreshRootRevoked("refresh-child")).toEqual(true);
  // An unrelated token is not revoked.
  expect(store.isRefreshRootRevoked("other")).toEqual(false);
});

test("InMemoryAccountsStore pruneRefreshChain deletes only rows past the cutoffs", () => {
  const store = new InMemoryAccountsStore();
  store.addRefreshChainLink("refresh-root", "refresh-child");
  store.markAuthorizationCodeConsumed("code-1");
  store.linkAccessTokenToAuthCode("code-1", "access-1", "refresh-root");
  store.revokeRefreshChain("refresh-root");

  // A cutoff in the past prunes nothing (all rows are newer).
  const noop = store.pruneRefreshChain({
    chainBefore: 0,
    consumedCodeBefore: 0,
  });
  expect(noop.chainLinks).toEqual(0);
  expect(noop.consumedCodes).toEqual(0);
  expect(store.isAuthorizationCodeConsumed("code-1")).toEqual(true);

  // A cutoff in the future prunes everything.
  const future = Date.now() + 1_000;
  const pruned = store.pruneRefreshChain({
    chainBefore: future,
    consumedCodeBefore: future,
  });
  expect(pruned.chainLinks).toEqual(1);
  expect(pruned.revokedRoots).toEqual(1);
  expect(pruned.consumedCodes).toEqual(1);
  expect(pruned.authCodeTokenLinks).toEqual(1);
  expect(store.isAuthorizationCodeConsumed("code-1")).toEqual(false);
  expect(store.isRefreshRootRevoked("refresh-root")).toEqual(false);
});

test("InMemoryAccountsStore passkey challenge is single-shot and expiry-aware", () => {
  const store = new InMemoryAccountsStore();
  store.savePasskeyChallenge("key-1", "challenge-1", 10_000);
  // First consume returns the challenge; a second consume is empty (deleted).
  expect(store.consumePasskeyChallenge("key-1", 5_000)).toEqual("challenge-1");
  expect(store.consumePasskeyChallenge("key-1", 5_000)).toEqual(undefined);
  // An expired challenge is not returned (and is removed).
  store.savePasskeyChallenge("key-2", "challenge-2", 1_000);
  expect(store.consumePasskeyChallenge("key-2", 2_000)).toEqual(undefined);
  expect(store.consumePasskeyChallenge("key-2", 0)).toEqual(undefined);
});
