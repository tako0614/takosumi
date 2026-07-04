import type {
  TakosumiAccountsPatScope,
  TakosumiSubject,
} from "@takosjp/takosumi-accounts-contract";
import type {
  ServiceBindingMaterialRecord,
  ServiceGrantMaterialRecord,
  AppCapsuleLedgerStore,
  CapsuleEventRecord,
  CapsuleRecord,
  LedgerAccountRecord,
  RuntimeBindingRecord,
  WorkspaceRecord,
} from "./ledger.ts";
import {
  assertValidServiceBindingMaterialRecord,
  assertValidServiceGrantMaterialRecord,
} from "./ledger.ts";

export interface AuthorizationCodeRecord {
  clientId: string;
  redirectUri: string;
  scope: string;
  subject: string;
  takosumiSubject?: TakosumiSubject;
  capsuleId?: string;
  appId?: string;
  workspaceId?: string;
  role?: string;
  nonce?: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  expiresAt: number;
}

export interface TokenRecord {
  clientId: string;
  scope: string;
  subject: string;
  takosumiSubject?: TakosumiSubject;
  capsuleId?: string;
  appId?: string;
  workspaceId?: string;
  role?: string;
  expiresAt: number;
}

export interface PersonalAccessTokenRecord {
  tokenId: string;
  tokenPrefix: string;
  subject: TakosumiSubject;
  name: string;
  scopes: readonly TakosumiAccountsPatScope[];
  workspaceId?: string;
  createdAt: number;
  expiresAt?: number;
  revokedAt?: number;
  lastUsedAt?: number;
}

export interface TakosumiAccountRecord {
  subject: TakosumiSubject;
  email?: string;
  /**
   * The upstream identity provider's `email_verified` assertion, carried onto
   * the account by `resolveUpstreamAccount`. Tri-state on purpose:
   * - `true`  — the upstream IdP asserted the email is verified;
   * - `false` — the upstream IdP asserted the email is NOT verified;
   * - `undefined` — genuinely unknown (the provider omitted the claim).
   *
   * Persisted as a NULLable column with no DEFAULT on Postgres so an existing
   * row predating this field reads back as `undefined` (unknown), never a
   * coerced `false`. The OIDC token endpoint only emits `email_verified: true`
   * in the id_token when this is exactly `true`.
   */
  emailVerified?: boolean;
  displayName?: string;
  termsVersion?: string;
  termsAcceptedAt?: number;
  termsAcceptedSource?: string;
  createdAt: number;
  updatedAt: number;
}

export interface UpstreamIdentityRecord {
  providerId: string;
  upstreamIssuer: string;
  upstreamSubject: string;
  subject: TakosumiSubject;
  createdAt: number;
  updatedAt: number;
}

export interface PasskeyCredentialRecord {
  credentialId: string;
  subject: TakosumiSubject;
  publicKeyJwk: JsonWebKey;
  signCount: number;
  transports?: readonly string[];
  createdAt: number;
  updatedAt: number;
}

export interface AccountSessionRecord {
  sessionId: string;
  subject: TakosumiSubject;
  createdAt: number;
  expiresAt: number;
}

export interface LaunchTokenConsumptionRecord {
  jti: string;
  capsuleId: string;
  subject: TakosumiSubject;
  audience: string;
  expiresAt: number;
  consumedAt: number;
}

export interface LaunchTokenRecord {
  tokenHash: string;
  jti: string;
  capsuleId: string;
  accountId: string;
  workspaceId: string;
  appId: string;
  subject: TakosumiSubject;
  redirectUri: string;
  scope: readonly string[];
  expiresAt: number;
  createdAt: number;
  usedAt?: number;
}

export type LaunchTokenConsumeResult =
  | { ok: true; record: LaunchTokenRecord }
  | {
      ok: false;
      reason: "not_found" | "redirect_mismatch" | "expired" | "used";
    };

export interface LaunchTokenPruneResult {
  deleted: number;
  expired: number;
  used: number;
}

/**
 * Result of {@link AccountsStore.pruneRefreshChain}. Counts the rows deleted
 * from each retention-managed refresh-chain / authorization-code table so the
 * operator cleanup task can report progress.
 */
export interface RefreshChainPruneResult {
  /**
   * refresh_chain_links rows removed (older than the refresh-token lifetime
   * cutoff). The matching refresh_chain_links_by_root / _by_child index
   * entries are removed with them.
   */
  chainLinks: number;
  /** refresh_chain_access_tokens rows removed (refresh-token lifetime). */
  chainAccessTokens: number;
  /** revoked_refresh_roots rows removed (refresh-token lifetime). */
  revokedRoots: number;
  /** consumed_authorization_codes rows removed (auth-code lifetime). */
  consumedCodes: number;
  /** auth_code_token_links rows removed (auth-code lifetime). */
  authCodeTokenLinks: number;
}

/**
 * Thrown by `AccountsStore.saveLedgerAccount` (in-memory / Postgres / D1) when
 * the caller attempts to bind an existing accountId to a different
 * `legalOwnerSubject` than the row already records. The application-layer
 * guard in `installation-lifecycle-routes.ts` should reject this case before
 * it reaches the store, but every store re-checks for defense-in-depth and
 * rejects identically (rather than one throwing, one silently no-op'ing, and
 * one overwriting).
 */
export class LedgerAccountOwnershipConflictError extends Error {
  readonly accountId: string;
  readonly existingLegalOwnerSubject: string;
  readonly attemptedLegalOwnerSubject: string;

  constructor(
    accountId: string,
    existingLegalOwnerSubject: string,
    attemptedLegalOwnerSubject: string,
  ) {
    super(
      `ledger account ${accountId} already owned by a different Takosumi subject`,
    );
    this.name = "LedgerAccountOwnershipConflictError";
    this.accountId = accountId;
    this.existingLegalOwnerSubject = existingLegalOwnerSubject;
    this.attemptedLegalOwnerSubject = attemptedLegalOwnerSubject;
  }
}

export type OidcClientAuthMethod =
  | "client_secret_basic"
  | "client_secret_post"
  | "none";

export interface OidcClientRecord {
  clientId: string;
  capsuleId: string;
  namespacePath: string;
  issuerUrl: string;
  redirectUris: readonly string[];
  allowedScopes: readonly string[];
  subjectMode: "pairwise";
  tokenEndpointAuthMethod: OidcClientAuthMethod;
  clientSecretHash?: string;
  createdAt: number;
  updatedAt: number;
}

export type BillingAccountProvider = "stripe" | "manual";
export type BillingAccountStatus =
  | "active"
  | "trialing"
  | "incomplete"
  | "incomplete_expired"
  | "past_due"
  | "unpaid"
  | "canceled"
  | "paused"
  // `disputed` is not a Stripe Subscription status. We assign it locally when a
  // chargeback (`charge.dispute.created`) opens, suspending entitlements until
  // the dispute resolves (`charge.dispute.closed`).
  | "disputed";

export interface BillingAccountRecord {
  billingAccountId: string;
  subject: TakosumiSubject;
  provider: BillingAccountProvider;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  stripePriceId?: string;
  stripeDefaultPaymentMethodId?: string;
  planCode?: string;
  currentPeriodEndUnix?: number;
  lastInvoiceId?: string;
  dunningStartedAt?: number;
  nextPaymentAttemptUnix?: number;
  dunningAttemptCount?: number;
  dunningAction?: "retry_scheduled" | "marked_uncollectible";
  dunningExhaustedAt?: number;
  lastCreditEventId?: string;
  lastCreditKind?: "refund" | "credit_note";
  lastCreditId?: string;
  lastCreditAmount?: number;
  lastCreditCurrency?: string;
  lastPlanTransitionEventId?: string;
  lastPlanFromCode?: string;
  lastPlanToCode?: string;
  lastPlanTransitionedAt?: number;
  lastTaxEventId?: string;
  taxPolicyRef?: string;
  taxJurisdiction?: string;
  taxAutomaticStatus?: string;
  /**
   * Last cancellation context captured from `customer.subscription.deleted`.
   * Used by support / churn analytics; not consulted for entitlement decisions.
   */
  lastCancellation?: BillingCancellationRecord;
  /**
   * Active chargeback / dispute context. Set when `charge.dispute.created`
   * fires; cleared when `charge.dispute.closed` resolves the dispute and the
   * pre-dispute status is restored.
   */
  activeDispute?: BillingDisputeRecord;
  /**
   * Status prior to entering `disputed`. Restored when the dispute closes in
   * the merchant's favour (or `lost` is observed and we keep `disputed` if
   * no other event has updated the subscription state since).
   */
  preDisputeStatus?: BillingAccountStatus;
  status: BillingAccountStatus;
  /**
   * G15 fix: optimistic-concurrency token. Monotonically increasing with
   * every persisted mutation. `saveBillingAccountIfVersion` only writes when
   * the stored row still carries `expectedVersion`, which lets two concurrent
   * Stripe webhook deliveries for the same customer (e.g.
   * `subscription.updated` + `invoice.payment_failed`) serialize their
   * read-modify-write instead of clobbering each other's field updates
   * (lost update). A record persisted before this field existed reads back
   * with `version` absent; treat absent as `0` for comparison purposes and
   * `saveBillingAccount` initializes it to `1`.
   */
  version?: number;
  createdAt: number;
  updatedAt: number;
}

export interface BillingCancellationRecord {
  canceledAt?: number;
  reason?: string;
  feedback?: string;
  comment?: string;
}

export interface BillingDisputeRecord {
  disputeId: string;
  chargeId?: string;
  reason?: string;
  status?: string;
  openedAt: number;
  closedAt?: number;
}

export type BillingWebhookEventStatus =
  | "received"
  | "processed"
  | "skipped"
  | "failed";

export interface BillingWebhookEventRecord {
  eventId: string;
  eventType: string;
  status: BillingWebhookEventStatus;
  receivedAt: number;
  updatedAt: number;
  errorMessage?: string;
}

export type BillingWebhookEventClaimResult =
  | { inserted: true }
  | { inserted: false; existing: BillingWebhookEventRecord };

export interface BillingUsageRecord {
  usageReportId: string;
  capsuleId: string;
  billingAccountId: string;
  meter: string;
  quantity: number;
  unit: string;
  periodStart?: number;
  periodEnd?: number;
  idempotencyKey?: string;
  requestDigest: string;
  metadata: Record<string, unknown>;
  reportedBySubject?: TakosumiSubject;
  reportedAt: number;
  billingExportProvider?: string;
  billingExportId?: string;
  billingExportReference?: string;
  billingExportedAt?: number;
}

export interface BillingUsageExportMark {
  billingAccountId: string;
  usageReportIds: readonly string[];
  provider: string;
  exportId: string;
  exportReference: string;
  exportedAt: number;
}

export type PrivacyRequestKind = "export" | "delete";
export type PrivacyRequestStatus =
  | "received"
  | "processing"
  | "exported"
  | "login_disabled"
  | "deleted"
  | "rejected";

export interface PrivacyRequestRecord {
  requestId: string;
  subject: TakosumiSubject;
  kind: PrivacyRequestKind;
  status: PrivacyRequestStatus;
  retentionRecordId: string;
  policyRef: string;
  requestSummary?: string;
  exportRef?: string;
  completedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface AccountsStore extends AppCapsuleLedgerStore {
  saveAccount(record: TakosumiAccountRecord): void | Promise<void>;
  findAccount(
    subject: TakosumiSubject,
  ):
    | TakosumiAccountRecord
    | undefined
    | Promise<TakosumiAccountRecord | undefined>;
  findAccountByVerifiedEmail(
    email: string,
  ):
    | TakosumiAccountRecord
    | undefined
    | Promise<TakosumiAccountRecord | undefined>;
  linkUpstreamIdentity(record: UpstreamIdentityRecord): void | Promise<void>;
  findUpstreamIdentity(input: {
    providerId: string;
    upstreamIssuer: string;
    upstreamSubject: string;
  }):
    | UpstreamIdentityRecord
    | undefined
    | Promise<UpstreamIdentityRecord | undefined>;
  savePasskeyCredential(record: PasskeyCredentialRecord): void | Promise<void>;
  findPasskeyCredential(
    credentialId: string,
  ):
    | PasskeyCredentialRecord
    | undefined
    | Promise<PasskeyCredentialRecord | undefined>;
  listPasskeyCredentialsForSubject(
    subject: TakosumiSubject,
  ):
    | readonly PasskeyCredentialRecord[]
    | Promise<readonly PasskeyCredentialRecord[]>;
  saveAccountSession(record: AccountSessionRecord): void | Promise<void>;
  findAccountSession(
    sessionId: string,
  ):
    | AccountSessionRecord
    | undefined
    | Promise<AccountSessionRecord | undefined>;
  deleteAccountSession(sessionId: string): void | Promise<void>;
  saveBillingAccount(record: BillingAccountRecord): void | Promise<void>;
  /**
   * G15 fix: conditional (compare-and-swap) billing-account write. Persists
   * `record` only when the currently stored row's `version` equals
   * `expectedVersion` (an absent stored version compares as `0`). On success
   * the row is written with `version = expectedVersion + 1` and the method
   * returns `true`. On a version mismatch (a concurrent writer advanced the
   * row) nothing is written and the method returns `false`, signalling the
   * caller to re-read and re-apply its mutation against the fresh record.
   *
   * Backends MUST implement this as a single conditional statement
   * (Postgres `UPDATE ... WHERE version = $expected`, D1 / SQLite CAS on the
   * stored document, in-memory compare-then-set inside one synchronous turn)
   * so two concurrent webhook applies cannot both observe the same version
   * and both write.
   */
  saveBillingAccountIfVersion(
    record: BillingAccountRecord,
    expectedVersion: number,
  ): boolean | Promise<boolean>;
  findBillingAccount(
    billingAccountId: string,
  ):
    | BillingAccountRecord
    | undefined
    | Promise<BillingAccountRecord | undefined>;
  findBillingAccountForSubject(
    subject: TakosumiSubject,
  ):
    | BillingAccountRecord
    | undefined
    | Promise<BillingAccountRecord | undefined>;
  findBillingAccountByStripeCustomerId(
    stripeCustomerId: string,
  ):
    | BillingAccountRecord
    | undefined
    | Promise<BillingAccountRecord | undefined>;
  saveBillingWebhookEvent(
    record: BillingWebhookEventRecord,
  ): void | Promise<void>;
  findBillingWebhookEvent(
    eventId: string,
  ):
    | BillingWebhookEventRecord
    | undefined
    | Promise<BillingWebhookEventRecord | undefined>;
  /**
   * Atomically reserve a Stripe webhook event id for processing.
   *
   * Returns `{ inserted: true }` if this caller is the first one to record
   * the event id (the row is now persisted with the provided `received` state),
   * or `{ inserted: false, existing }` if the id was already recorded.
   *
   * Backends MUST implement this with a single statement that does not allow
   * a race window (Postgres `INSERT ... ON CONFLICT DO NOTHING RETURNING ...`,
   * D1 / SQLite `INSERT OR IGNORE`, in-memory `Map.has`-then-set inside the
   * same synchronous turn). A `findBillingWebhookEvent` + `saveBillingWebhookEvent`
   * sequence is NOT a valid implementation because two concurrent webhook
   * deliveries can both observe "not found" and double-process the event.
   */
  claimBillingWebhookEvent(
    record: BillingWebhookEventRecord,
  ): BillingWebhookEventClaimResult | Promise<BillingWebhookEventClaimResult>;
  saveBillingUsageRecord(record: BillingUsageRecord): void | Promise<void>;
  findBillingUsageRecord(
    usageReportId: string,
  ): BillingUsageRecord | undefined | Promise<BillingUsageRecord | undefined>;
  listBillingUsageRecordsForCapsule(
    capsuleId: string,
  ): readonly BillingUsageRecord[] | Promise<readonly BillingUsageRecord[]>;
  listBillingUsageRecordsForBillingAccount(
    billingAccountId: string,
  ): readonly BillingUsageRecord[] | Promise<readonly BillingUsageRecord[]>;
  markBillingUsageRecordsExported(
    mark: BillingUsageExportMark,
  ): void | Promise<void>;
  savePrivacyRequest(record: PrivacyRequestRecord): void | Promise<void>;
  findPrivacyRequest(
    requestId: string,
  ):
    | PrivacyRequestRecord
    | undefined
    | Promise<PrivacyRequestRecord | undefined>;
  listPrivacyRequestsForSubject(
    subject: TakosumiSubject,
  ): readonly PrivacyRequestRecord[] | Promise<readonly PrivacyRequestRecord[]>;
  saveAuthorizationCode(
    code: string,
    record: AuthorizationCodeRecord,
  ): void | Promise<void>;
  consumeAuthorizationCode(
    code: string,
  ):
    | AuthorizationCodeRecord
    | undefined
    | Promise<AuthorizationCodeRecord | undefined>;
  saveAccessToken(token: string, record: TokenRecord): void | Promise<void>;
  findAccessToken(
    token: string,
  ): TokenRecord | undefined | Promise<TokenRecord | undefined>;
  saveRefreshToken(token: string, record: TokenRecord): void | Promise<void>;
  findRefreshToken(
    token: string,
  ): TokenRecord | undefined | Promise<TokenRecord | undefined>;
  deleteToken(token: string): void | Promise<void>;
  savePersonalAccessToken(
    token: string,
    record: PersonalAccessTokenRecord,
  ): void | Promise<void>;
  findPersonalAccessToken(
    token: string,
  ):
    | PersonalAccessTokenRecord
    | undefined
    | Promise<PersonalAccessTokenRecord | undefined>;
  listPersonalAccessTokensForSubject(
    subject: TakosumiSubject,
  ):
    | readonly PersonalAccessTokenRecord[]
    | Promise<readonly PersonalAccessTokenRecord[]>;
  revokePersonalAccessToken(input: {
    subject: TakosumiSubject;
    tokenId: string;
    revokedAt: number;
  }):
    | PersonalAccessTokenRecord
    | undefined
    | Promise<PersonalAccessTokenRecord | undefined>;
  recordPersonalAccessTokenUsed(
    tokenId: string,
    lastUsedAt: number,
  ): void | Promise<void>;
  consumeLaunchTokenJti(
    record: LaunchTokenConsumptionRecord,
  ): boolean | Promise<boolean>;
  saveLaunchToken(record: LaunchTokenRecord): void | Promise<void>;
  consumeLaunchToken(input: {
    tokenHash: string;
    capsuleId: string;
    redirectUri: string;
    consumedAt: number;
  }): LaunchTokenConsumeResult | Promise<LaunchTokenConsumeResult>;
  pruneLaunchTokens(input: {
    expiredBefore: number;
    usedBefore: number;
  }): LaunchTokenPruneResult | Promise<LaunchTokenPruneResult>;
  saveOidcClient(record: OidcClientRecord): void | Promise<void>;
  findOidcClient(
    clientId: string,
  ): OidcClientRecord | undefined | Promise<OidcClientRecord | undefined>;
  findOidcClientForCapsule(
    capsuleId: string,
  ): OidcClientRecord | undefined | Promise<OidcClientRecord | undefined>;
  /**
   * F30 fix: persistent refresh-token rotation chain links. The OIDC
   * token endpoint records the parent->child rotation so a subsequent
   * presentation of the parent (rotated-out) token can be detected as
   * refresh-token reuse (RFC 6749 §10.4 / OAuth 2.1 §4.3.1). The chain
   * also carries the root token across all descendants so a cascade
   * revoke can be issued against the entire issuance chain.
   *
   * Implementations MUST persist the link so that multiple operator
   * replicas observe the same chain state; in-process maps are not
   * sufficient because two replicas may both treat a rotated-out token
   * as still-valid.
   *
   * G6 fix: this is the ATOMIC rotation claim. The link insert MUST be
   * conflict-detecting on `parentToken`: it returns `true` only when this
   * call inserted the link, and `false` when a link for `parentToken`
   * already existed. A `false` result means the parent token was already
   * rotated (possibly by a concurrent presentation of the same valid
   * refresh token), so the caller MUST treat it as reuse and revoke the
   * chain rather than minting a second child family (double-spend).
   */
  addRefreshChainLink(
    parentToken: string,
    childToken: string,
  ): boolean | Promise<boolean>;
  /**
   * Returns a value indicating whether a rotation child of the given refresh
   * token is recorded (`undefined` = no child). Used by `handleRefreshToken`
   * to detect reuse of a rotated-out token.
   *
   * The returned string is an OPAQUE presence signal whose representation
   * differs per backend (the in-memory store returns the raw child token; the
   * Postgres and D1 stores return the child token's `sha256:` hash). Callers
   * MUST treat it as presence-only (`!== undefined`) and MUST NOT compare it,
   * re-present it to the token endpoint, or pass it to `deleteToken`.
   */
  getRefreshChainChild(
    token: string,
  ): string | undefined | Promise<string | undefined>;
  /**
   * Revokes the entire refresh chain rooted at `rootToken`. The store
   * performs the cascade delete INTERNALLY: it deletes every refresh token in
   * the chain (and every access token minted by a chain rotation) before
   * returning.
   *
   * The returned array carries OPAQUE diagnostic identifiers for the revoked
   * chain (raw tokens on the in-memory store; `sha256:` hashes on the
   * Postgres and D1 stores), for test assertions / bookkeeping only. Callers
   * MUST NOT pass these back to `deleteToken` (on durable backends they are
   * hashes, which `deleteToken` would hash again and never match) — the
   * deletion has already happened inside this method.
   */
  revokeRefreshChain(
    rootToken: string,
  ): readonly string[] | Promise<readonly string[]>;
  /**
   * Marks the authorization code (one-shot) as consumed. Used by the
   * token endpoint to detect authorization-code reuse and cascade-revoke
   * the tokens issued from the first exchange (OAuth 2.1 §4.1.4).
   */
  markAuthorizationCodeConsumed(code: string): void | Promise<void>;
  /**
   * Returns true if the authorization code has already been marked as
   * consumed by `markAuthorizationCodeConsumed`.
   */
  isAuthorizationCodeConsumed(code: string): boolean | Promise<boolean>;
  /**
   * Records the access token (and optionally the refresh-chain root)
   * that was issued by exchanging the given authorization code. The
   * tokens recorded here are revoked by
   * `revokeTokensIssuedFromCode` when the code is replayed.
   */
  linkAccessTokenToAuthCode(
    code: string,
    accessToken: string,
    refreshTokenRoot?: string,
  ): void | Promise<void>;
  /**
   * Records that the access token was minted by a rotation in the
   * refresh chain rooted at `refreshTokenRoot`. `revokeRefreshChain`
   * deletes every access token linked here so a refresh-token replay
   * cascade also invalidates outstanding access tokens minted by chain
   * rotations.
   */
  linkAccessTokenToRefreshChain(
    refreshTokenRoot: string,
    accessToken: string,
  ): void | Promise<void>;
  /**
   * Returns the access and refresh root tokens that were issued by
   * exchanging the given authorization code. The caller is responsible
   * for cascading the refresh chain revocations.
   */
  revokeTokensIssuedFromCode(code: string):
    | {
        access: readonly string[];
        refresh: readonly string[];
      }
    | Promise<{ access: readonly string[]; refresh: readonly string[] }>;
  /**
   * Retention cleanup for the refresh-chain / authorization-code tracking
   * tables (migrations 019 / 021). These tables append a row on every
   * auth-code exchange and every refresh-token rotation and are never deleted
   * by the lifecycle paths (the only chain deletes are the security-driven
   * cascade-revoke on reuse detection), so without this they grow forever.
   *
   * Operators MUST run this on a schedule (the same scheduled path that runs
   * {@link pruneLaunchTokens}) — see the operator cleanup task documented in
   * migrations/019_refresh_chain.sql. `chainBefore` should be the
   * refresh-token lifetime cutoff (default 30 days ago) and
   * `consumedCodeBefore` the authorization-code lifetime cutoff (default 5
   * minutes ago); rows with `created_at <= cutoff` are removed.
   *
   * This is retention only: it must never remove a row whose token/code is
   * still within its lifetime, so the reuse-detection guards are unaffected.
   */
  pruneRefreshChain(input: {
    chainBefore: number;
    consumedCodeBefore: number;
  }): RefreshChainPruneResult | Promise<RefreshChainPruneResult>;
  /**
   * Returns true if the refresh-chain root resolved from `token` (the root of
   * whichever chain `token` belongs to) has been recorded as revoked by
   * {@link revokeRefreshChain}. Defense in depth on the refresh path: the
   * primary revocation guarantee is that revokeRefreshChain physically
   * deletes every chain refresh-token row, but this lets the token endpoint
   * also reject any token whose resolved root is revoked even if a row
   * survived a partial cascade. Implemented identically across all backends.
   */
  isRefreshRootRevoked(token: string): boolean | Promise<boolean>;
  /**
   * Persists a WebAuthn ceremony challenge under `key` with an absolute
   * `expiresAt` (ms-since-epoch). Backs store-based challenge storage so the
   * WebAuthn options -> complete round trip works across multiple
   * isolates/replicas (e.g. the Cloudflare Workers reference distribution),
   * where a module-local Map breaks: the isolate serving /options may differ
   * from the one serving /complete. `key` is opaque (the caller composes it,
   * e.g. subject + intent). Overwrites any existing value for the same key.
   */
  savePasskeyChallenge(
    key: string,
    challenge: string,
    expiresAt: number,
  ): void | Promise<void>;
  /**
   * Single-shot consume: returns the stored challenge for `key` and deletes
   * it atomically (delete-on-read) so a challenge can be used at most once,
   * preserving the WebAuthn single-use replay guarantee across replicas.
   * Returns `undefined` if no challenge is stored or it has expired (in which
   * case the expired row is also removed).
   */
  consumePasskeyChallenge(
    key: string,
    now: number,
  ): string | undefined | Promise<string | undefined>;
}

export class InMemoryAccountsStore implements AccountsStore {
  readonly #accounts = new Map<TakosumiSubject, TakosumiAccountRecord>();
  readonly #ledgerAccounts = new Map<string, LedgerAccountRecord>();
  readonly #spaces = new Map<string, WorkspaceRecord>();
  readonly #installations = new Map<string, CapsuleRecord>();
  readonly #runtimeBindings = new Map<string, RuntimeBindingRecord>();
  readonly #serviceBindingMaterials = new Map<
    string,
    ServiceBindingMaterialRecord
  >();
  readonly #installationEvents = new Map<string, CapsuleEventRecord[]>();
  readonly #upstreamIdentities = new Map<string, UpstreamIdentityRecord>();
  readonly #passkeyCredentials = new Map<string, PasskeyCredentialRecord>();
  readonly #accountSessions = new Map<string, AccountSessionRecord>();
  readonly #billingAccounts = new Map<string, BillingAccountRecord>();
  readonly #billingAccountsBySubject = new Map<TakosumiSubject, string>();
  readonly #billingAccountsByStripeCustomerId = new Map<string, string>();
  readonly #billingWebhookEvents = new Map<string, BillingWebhookEventRecord>();
  readonly #billingUsageRecords = new Map<string, BillingUsageRecord>();
  readonly #privacyRequests = new Map<string, PrivacyRequestRecord>();
  readonly #privacyRequestsBySubject = new Map<TakosumiSubject, Set<string>>();
  readonly #authorizationCodes = new Map<string, AuthorizationCodeRecord>();
  readonly #accessTokens = new Map<string, TokenRecord>();
  readonly #refreshTokens = new Map<string, TokenRecord>();
  readonly #personalAccessTokens = new Map<string, PersonalAccessTokenRecord>();
  readonly #personalAccessTokenIdsBySecret = new Map<string, string>();
  readonly #launchTokenConsumptions = new Map<
    string,
    LaunchTokenConsumptionRecord
  >();
  readonly #launchTokens = new Map<string, LaunchTokenRecord>();
  readonly #oidcClients = new Map<string, OidcClientRecord>();
  readonly #oidcClientsByCapsule = new Map<string, string>();
  // F30: persistent refresh-token rotation chain state. Each Map / Set
  // is the in-memory analogue of the corresponding accounts_v1 table the
  // production migration adds (refresh_chain_links / revoked_refresh_roots
  // / consumed_authorization_codes / auth_code_token_links).
  readonly #refreshChainChildren = new Map<string, string>();
  readonly #refreshChainRoots = new Map<string, string>();
  // revoked-root -> revokedAt ms. Read by isRefreshRootRevoked (defense in
  // depth on the refresh path) and pruned by pruneRefreshChain.
  readonly #revokedRefreshChainRoots = new Map<string, number>();
  // code -> consumedAt ms, for time-based retention.
  readonly #consumedAuthorizationCodes = new Map<string, number>();
  readonly #authorizationCodeTokens = new Map<
    string,
    { access: Set<string>; refresh: Set<string>; createdAt: number }
  >();
  readonly #refreshChainAccessTokens = new Map<string, Set<string>>();
  // parent-token -> createdAt ms for refresh_chain_links retention.
  readonly #refreshChainLinkCreatedAt = new Map<string, number>();
  // WebAuthn challenge store: key -> { challenge, expiresAt }. Single-shot
  // delete-on-read via consumePasskeyChallenge.
  readonly #passkeyChallenges = new Map<
    string,
    { challenge: string; expiresAt: number }
  >();

  saveAccount(record: TakosumiAccountRecord): void {
    const existing = this.#accounts.get(record.subject);
    this.#accounts.set(record.subject, {
      ...existing,
      ...record,
      emailVerified: record.emailVerified ?? existing?.emailVerified,
      termsVersion: record.termsVersion ?? existing?.termsVersion,
      termsAcceptedAt: record.termsAcceptedAt ?? existing?.termsAcceptedAt,
      termsAcceptedSource:
        record.termsAcceptedSource ?? existing?.termsAcceptedSource,
    });
  }

  findAccount(subject: TakosumiSubject): TakosumiAccountRecord | undefined {
    return this.#accounts.get(subject);
  }

  findAccountByVerifiedEmail(email: string): TakosumiAccountRecord | undefined {
    const normalized = normalizeAccountEmail(email);
    if (!normalized) return undefined;
    for (const account of this.#accounts.values()) {
      if (
        account.emailVerified === true &&
        normalizeAccountEmail(account.email) === normalized
      ) {
        return account;
      }
    }
    return undefined;
  }

  saveLedgerAccount(record: LedgerAccountRecord): void {
    // Defense-in-depth ownership guard, identical to the D1 and Postgres
    // stores: refuse to re-bind an existing accountId to a different
    // legalOwnerSubject. Previously the in-memory store overwrote
    // unconditionally (the only one of the three with no guard), so a caller
    // bypassing the route-layer check could silently steal an account here.
    const existing = this.#ledgerAccounts.get(record.accountId);
    if (existing && existing.legalOwnerSubject !== record.legalOwnerSubject) {
      throw new LedgerAccountOwnershipConflictError(
        record.accountId,
        existing.legalOwnerSubject,
        record.legalOwnerSubject,
      );
    }
    this.#ledgerAccounts.set(record.accountId, record);
  }

  findLedgerAccount(accountId: string): LedgerAccountRecord | undefined {
    return this.#ledgerAccounts.get(accountId);
  }

  saveWorkspace(record: WorkspaceRecord): void {
    this.#spaces.set(record.workspaceId, record);
  }

  findWorkspace(workspaceId: string): WorkspaceRecord | undefined {
    return this.#spaces.get(workspaceId);
  }

  listWorkspacesForAccount(accountId: string): readonly WorkspaceRecord[] {
    return [...this.#spaces.values()].filter(
      (space) => space.accountId === accountId,
    );
  }

  listWorkspacesForOwner(subject: TakosumiSubject): readonly WorkspaceRecord[] {
    const ownedAccountIds = new Set<string>();
    for (const account of this.#ledgerAccounts.values()) {
      if (account.legalOwnerSubject === subject) {
        ownedAccountIds.add(account.accountId);
      }
    }
    return [...this.#spaces.values()].filter((space) =>
      ownedAccountIds.has(space.accountId),
    );
  }

  saveAppCapsule(record: CapsuleRecord): void {
    this.#installations.set(record.capsuleId, record);
  }

  findAppCapsule(capsuleId: string): CapsuleRecord | undefined {
    return this.#installations.get(capsuleId);
  }

  listAppCapsulesForWorkspace(workspaceId: string): readonly CapsuleRecord[] {
    return [...this.#installations.values()].filter(
      (installation) => installation.workspaceId === workspaceId,
    );
  }

  listAppCapsulesForBillingAccount(
    billingAccountId: string,
  ): readonly CapsuleRecord[] {
    return [...this.#installations.values()].filter(
      (installation) => installation.billingAccountId === billingAccountId,
    );
  }

  saveRuntimeBinding(record: RuntimeBindingRecord): void {
    this.#runtimeBindings.set(record.runtimeBindingId, record);
  }

  findRuntimeBinding(
    runtimeBindingId: string,
  ): RuntimeBindingRecord | undefined {
    return this.#runtimeBindings.get(runtimeBindingId);
  }

  saveServiceBindingMaterial(record: ServiceBindingMaterialRecord): void {
    assertValidServiceBindingMaterialRecord(record);
    this.#serviceBindingMaterials.set(record.bindingId, record);
  }

  listServiceBindingMaterialsForCapsule(
    capsuleId: string,
  ): readonly ServiceBindingMaterialRecord[] {
    return [...this.#serviceBindingMaterials.values()].filter(
      (binding) => binding.capsuleId === capsuleId,
    );
  }

  saveServiceGrantMaterial(record: ServiceGrantMaterialRecord): void {
    assertValidServiceGrantMaterialRecord(record);
    void record;
  }

  findServiceGrantMaterial(
    grantId: string,
  ): ServiceGrantMaterialRecord | undefined {
    void grantId;
    return undefined;
  }

  listServiceGrantMaterialsForCapsule(
    capsuleId: string,
  ): readonly ServiceGrantMaterialRecord[] {
    void capsuleId;
    return [];
  }

  appendCapsuleEvent(record: CapsuleEventRecord): void {
    const events = this.#installationEvents.get(record.capsuleId) ?? [];
    this.#installationEvents.set(record.capsuleId, [...events, record]);
  }

  listCapsuleEvents(
    capsuleId: string,
  ): readonly CapsuleEventRecord[] {
    return this.#installationEvents.get(capsuleId) ?? [];
  }

  linkUpstreamIdentity(record: UpstreamIdentityRecord): void {
    this.#upstreamIdentities.set(upstreamIdentityKey(record), record);
  }

  findUpstreamIdentity(input: {
    providerId: string;
    upstreamIssuer: string;
    upstreamSubject: string;
  }): UpstreamIdentityRecord | undefined {
    return this.#upstreamIdentities.get(upstreamIdentityKey(input));
  }

  savePasskeyCredential(record: PasskeyCredentialRecord): void {
    this.#passkeyCredentials.set(record.credentialId, record);
  }

  findPasskeyCredential(
    credentialId: string,
  ): PasskeyCredentialRecord | undefined {
    return this.#passkeyCredentials.get(credentialId);
  }

  listPasskeyCredentialsForSubject(
    subject: TakosumiSubject,
  ): readonly PasskeyCredentialRecord[] {
    return [...this.#passkeyCredentials.values()].filter(
      (credential) => credential.subject === subject,
    );
  }

  saveAccountSession(record: AccountSessionRecord): void {
    this.#accountSessions.set(record.sessionId, record);
  }

  findAccountSession(sessionId: string): AccountSessionRecord | undefined {
    return this.#accountSessions.get(sessionId);
  }

  deleteAccountSession(sessionId: string): void {
    this.#accountSessions.delete(sessionId);
  }

  saveBillingAccount(record: BillingAccountRecord): void {
    this.#writeBillingAccount({
      ...record,
      version: record.version ?? 1,
    });
  }

  saveBillingAccountIfVersion(
    record: BillingAccountRecord,
    expectedVersion: number,
  ): boolean {
    const current = this.#billingAccounts.get(record.billingAccountId);
    const currentVersion = current?.version ?? 0;
    if (currentVersion !== expectedVersion) return false;
    this.#writeBillingAccount({ ...record, version: expectedVersion + 1 });
    return true;
  }

  #writeBillingAccount(record: BillingAccountRecord): void {
    const existing = this.#billingAccounts.get(record.billingAccountId);
    if (existing?.stripeCustomerId) {
      this.#billingAccountsByStripeCustomerId.delete(existing.stripeCustomerId);
    }

    this.#billingAccounts.set(record.billingAccountId, record);
    this.#billingAccountsBySubject.set(record.subject, record.billingAccountId);
    if (record.stripeCustomerId) {
      this.#billingAccountsByStripeCustomerId.set(
        record.stripeCustomerId,
        record.billingAccountId,
      );
    }
  }

  findBillingAccount(
    billingAccountId: string,
  ): BillingAccountRecord | undefined {
    return this.#billingAccounts.get(billingAccountId);
  }

  findBillingAccountForSubject(
    subject: TakosumiSubject,
  ): BillingAccountRecord | undefined {
    const billingAccountId = this.#billingAccountsBySubject.get(subject);
    return billingAccountId
      ? this.#billingAccounts.get(billingAccountId)
      : undefined;
  }

  findBillingAccountByStripeCustomerId(
    stripeCustomerId: string,
  ): BillingAccountRecord | undefined {
    const billingAccountId =
      this.#billingAccountsByStripeCustomerId.get(stripeCustomerId);
    return billingAccountId
      ? this.#billingAccounts.get(billingAccountId)
      : undefined;
  }

  saveBillingWebhookEvent(record: BillingWebhookEventRecord): void {
    this.#billingWebhookEvents.set(record.eventId, record);
  }

  findBillingWebhookEvent(
    eventId: string,
  ): BillingWebhookEventRecord | undefined {
    return this.#billingWebhookEvents.get(eventId);
  }

  claimBillingWebhookEvent(
    record: BillingWebhookEventRecord,
  ): BillingWebhookEventClaimResult {
    const existing = this.#billingWebhookEvents.get(record.eventId);
    if (existing) {
      return { inserted: false, existing };
    }
    this.#billingWebhookEvents.set(record.eventId, record);
    return { inserted: true };
  }

  saveBillingUsageRecord(record: BillingUsageRecord): void {
    this.#billingUsageRecords.set(record.usageReportId, record);
  }

  findBillingUsageRecord(
    usageReportId: string,
  ): BillingUsageRecord | undefined {
    return this.#billingUsageRecords.get(usageReportId);
  }

  listBillingUsageRecordsForCapsule(
    capsuleId: string,
  ): readonly BillingUsageRecord[] {
    return billingUsageRecordsSorted(
      [...this.#billingUsageRecords.values()].filter(
        (record) => record.capsuleId === capsuleId,
      ),
    );
  }

  listBillingUsageRecordsForBillingAccount(
    billingAccountId: string,
  ): readonly BillingUsageRecord[] {
    return billingUsageRecordsSorted(
      [...this.#billingUsageRecords.values()].filter(
        (record) => record.billingAccountId === billingAccountId,
      ),
    );
  }

  markBillingUsageRecordsExported(mark: BillingUsageExportMark): void {
    for (const usageReportId of mark.usageReportIds) {
      const existing = this.#billingUsageRecords.get(usageReportId);
      if (!existing) {
        throw new TypeError("billing usage report was not found");
      }
      if (existing.billingAccountId !== mark.billingAccountId) {
        throw new TypeError(
          "billing usage report is owned by another billing account",
        );
      }
      if (
        existing.billingExportId &&
        (existing.billingExportProvider !== mark.provider ||
          existing.billingExportId !== mark.exportId ||
          existing.billingExportReference !== mark.exportReference)
      ) {
        throw new TypeError("billing usage report was already exported");
      }
      this.#billingUsageRecords.set(usageReportId, {
        ...existing,
        billingExportProvider: mark.provider,
        billingExportId: mark.exportId,
        billingExportReference: mark.exportReference,
        billingExportedAt: mark.exportedAt,
      });
    }
  }

  savePrivacyRequest(record: PrivacyRequestRecord): void {
    const existing = this.#privacyRequests.get(record.requestId);
    if (existing && existing.subject !== record.subject) {
      throw new TypeError(
        "privacy request id is already owned by another subject",
      );
    }
    this.#privacyRequests.set(record.requestId, record);
    const ids =
      this.#privacyRequestsBySubject.get(record.subject) ?? new Set<string>();
    ids.add(record.requestId);
    this.#privacyRequestsBySubject.set(record.subject, ids);
  }

  findPrivacyRequest(requestId: string): PrivacyRequestRecord | undefined {
    return this.#privacyRequests.get(requestId);
  }

  listPrivacyRequestsForSubject(
    subject: TakosumiSubject,
  ): readonly PrivacyRequestRecord[] {
    const ids = this.#privacyRequestsBySubject.get(subject);
    if (!ids) return [];
    return [...ids]
      .flatMap((id) => {
        const record = this.#privacyRequests.get(id);
        return record ? [record] : [];
      })
      .sort(
        (a, b) =>
          b.createdAt - a.createdAt || a.requestId.localeCompare(b.requestId),
      );
  }

  saveAuthorizationCode(code: string, record: AuthorizationCodeRecord): void {
    this.#authorizationCodes.set(code, record);
  }

  consumeAuthorizationCode(code: string): AuthorizationCodeRecord | undefined {
    const record = this.#authorizationCodes.get(code);
    this.#authorizationCodes.delete(code);
    return record;
  }

  saveAccessToken(token: string, record: TokenRecord): void {
    this.#accessTokens.set(token, record);
  }

  findAccessToken(token: string): TokenRecord | undefined {
    return this.#accessTokens.get(token);
  }

  saveRefreshToken(token: string, record: TokenRecord): void {
    this.#refreshTokens.set(token, record);
  }

  findRefreshToken(token: string): TokenRecord | undefined {
    return this.#refreshTokens.get(token);
  }

  deleteToken(token: string): void {
    this.#accessTokens.delete(token);
    this.#refreshTokens.delete(token);
  }

  savePersonalAccessToken(
    token: string,
    record: PersonalAccessTokenRecord,
  ): void {
    this.#personalAccessTokens.set(record.tokenId, { ...record });
    this.#personalAccessTokenIdsBySecret.set(token, record.tokenId);
  }

  findPersonalAccessToken(
    token: string,
  ): PersonalAccessTokenRecord | undefined {
    const tokenId = this.#personalAccessTokenIdsBySecret.get(token);
    const record = tokenId
      ? this.#personalAccessTokens.get(tokenId)
      : undefined;
    return record ? { ...record } : undefined;
  }

  listPersonalAccessTokensForSubject(
    subject: TakosumiSubject,
  ): readonly PersonalAccessTokenRecord[] {
    return [...this.#personalAccessTokens.values()]
      .filter((record) => record.subject === subject)
      .sort((left, right) => left.createdAt - right.createdAt)
      .map((record) => ({ ...record }));
  }

  revokePersonalAccessToken(input: {
    subject: TakosumiSubject;
    tokenId: string;
    revokedAt: number;
  }): PersonalAccessTokenRecord | undefined {
    const record = this.#personalAccessTokens.get(input.tokenId);
    if (!record || record.subject !== input.subject) return undefined;
    const updated = { ...record, revokedAt: input.revokedAt };
    this.#personalAccessTokens.set(input.tokenId, updated);
    return { ...updated };
  }

  recordPersonalAccessTokenUsed(tokenId: string, lastUsedAt: number): void {
    const record = this.#personalAccessTokens.get(tokenId);
    if (!record) return;
    this.#personalAccessTokens.set(tokenId, { ...record, lastUsedAt });
  }

  consumeLaunchTokenJti(record: LaunchTokenConsumptionRecord): boolean {
    if (this.#launchTokenConsumptions.has(record.jti)) return false;
    this.#launchTokenConsumptions.set(record.jti, record);
    return true;
  }

  saveLaunchToken(record: LaunchTokenRecord): void {
    for (const [tokenHash, existing] of this.#launchTokens) {
      if (
        existing.capsuleId === record.capsuleId &&
        existing.usedAt === undefined &&
        existing.expiresAt > record.createdAt
      ) {
        this.#launchTokens.set(tokenHash, {
          ...existing,
          usedAt: record.createdAt,
        });
      }
    }
    this.#launchTokens.set(record.tokenHash, { ...record });
  }

  consumeLaunchToken(input: {
    tokenHash: string;
    capsuleId: string;
    redirectUri: string;
    consumedAt: number;
  }): LaunchTokenConsumeResult {
    const record = this.#launchTokens.get(input.tokenHash);
    if (!record || record.capsuleId !== input.capsuleId) {
      return { ok: false, reason: "not_found" };
    }
    if (record.redirectUri !== input.redirectUri) {
      return { ok: false, reason: "redirect_mismatch" };
    }
    if (record.expiresAt <= input.consumedAt) {
      return { ok: false, reason: "expired" };
    }
    if (record.usedAt !== undefined) {
      return { ok: false, reason: "used" };
    }
    const consumed = { ...record, usedAt: input.consumedAt };
    this.#launchTokens.set(record.tokenHash, consumed);
    return { ok: true, record: { ...consumed } };
  }

  pruneLaunchTokens(input: {
    expiredBefore: number;
    usedBefore: number;
  }): LaunchTokenPruneResult {
    let expired = 0;
    let used = 0;
    for (const [tokenHash, record] of this.#launchTokens) {
      if (record.usedAt !== undefined && record.usedAt <= input.usedBefore) {
        this.#launchTokens.delete(tokenHash);
        used += 1;
        continue;
      }
      if (record.expiresAt <= input.expiredBefore) {
        this.#launchTokens.delete(tokenHash);
        expired += 1;
      }
    }
    return { deleted: expired + used, expired, used };
  }

  saveOidcClient(record: OidcClientRecord): void {
    const existing = this.#oidcClients.get(record.clientId);
    if (existing) {
      this.#oidcClientsByCapsule.delete(existing.capsuleId);
    }
    this.#oidcClients.set(record.clientId, record);
    this.#oidcClientsByCapsule.set(record.capsuleId, record.clientId);
  }

  findOidcClient(clientId: string): OidcClientRecord | undefined {
    return this.#oidcClients.get(clientId);
  }

  findOidcClientForCapsule(
    capsuleId: string,
  ): OidcClientRecord | undefined {
    const clientId = this.#oidcClientsByCapsule.get(capsuleId);
    return clientId ? this.#oidcClients.get(clientId) : undefined;
  }

  addRefreshChainLink(parentToken: string, childToken: string): boolean {
    // G6 fix: atomic check-and-set. If a link for this parent already
    // exists, the token was already rotated (concurrent or sequential);
    // report the conflict so the caller can treat it as reuse instead of
    // minting a second child family.
    if (this.#refreshChainChildren.has(parentToken)) return false;
    this.#refreshChainChildren.set(parentToken, childToken);
    this.#refreshChainLinkCreatedAt.set(parentToken, Date.now());
    const root = this.#refreshChainRoots.get(parentToken) ?? parentToken;
    this.#refreshChainRoots.set(parentToken, root);
    this.#refreshChainRoots.set(childToken, root);
    return true;
  }

  getRefreshChainChild(token: string): string | undefined {
    return this.#refreshChainChildren.get(token);
  }

  revokeRefreshChain(rootToken: string): readonly string[] {
    const root = this.#refreshChainRoots.get(rootToken) ?? rootToken;
    this.#revokedRefreshChainRoots.set(root, Date.now());
    const tokens = new Set<string>();
    let cursor: string | undefined = root;
    while (cursor) {
      tokens.add(cursor);
      cursor = this.#refreshChainChildren.get(cursor);
    }
    tokens.add(rootToken);
    // Cascade-delete every refresh token in the chain. Mirrors the
    // postgres path which deletes the matching oauth_refresh_tokens
    // rows by hash.
    for (const token of tokens) {
      this.#refreshTokens.delete(token);
    }
    // Cascade-delete access tokens minted by any rotation in the
    // chain. Symmetric to the in-process behavior.
    const linkedAccessTokens = this.#refreshChainAccessTokens.get(root);
    if (linkedAccessTokens) {
      for (const accessToken of linkedAccessTokens) {
        this.#accessTokens.delete(accessToken);
      }
      linkedAccessTokens.clear();
    }
    return [...tokens];
  }

  markAuthorizationCodeConsumed(code: string): void {
    this.#consumedAuthorizationCodes.set(code, Date.now());
    if (!this.#authorizationCodeTokens.has(code)) {
      this.#authorizationCodeTokens.set(code, {
        access: new Set(),
        refresh: new Set(),
        createdAt: Date.now(),
      });
    }
  }

  isAuthorizationCodeConsumed(code: string): boolean {
    return this.#consumedAuthorizationCodes.has(code);
  }

  linkAccessTokenToAuthCode(
    code: string,
    accessToken: string,
    refreshTokenRoot?: string,
  ): void {
    let entry = this.#authorizationCodeTokens.get(code);
    if (!entry) {
      entry = { access: new Set(), refresh: new Set(), createdAt: Date.now() };
      this.#authorizationCodeTokens.set(code, entry);
    }
    entry.access.add(accessToken);
    if (refreshTokenRoot) entry.refresh.add(refreshTokenRoot);
  }

  linkAccessTokenToRefreshChain(
    refreshTokenRoot: string,
    accessToken: string,
  ): void {
    const root =
      this.#refreshChainRoots.get(refreshTokenRoot) ?? refreshTokenRoot;
    let set = this.#refreshChainAccessTokens.get(root);
    if (!set) {
      set = new Set();
      this.#refreshChainAccessTokens.set(root, set);
    }
    set.add(accessToken);
  }

  revokeTokensIssuedFromCode(code: string): {
    access: readonly string[];
    refresh: readonly string[];
  } {
    const entry = this.#authorizationCodeTokens.get(code);
    if (!entry) return { access: [], refresh: [] };
    // Cascade-delete the access tokens issued from this code, then
    // cascade-revoke every refresh chain that was rooted by this code.
    for (const accessToken of entry.access) {
      this.#accessTokens.delete(accessToken);
    }
    const accessOut = [...entry.access];
    const refreshOut = [...entry.refresh];
    for (const refreshRoot of entry.refresh) {
      this.revokeRefreshChain(refreshRoot);
    }
    return { access: accessOut, refresh: refreshOut };
  }

  isRefreshRootRevoked(token: string): boolean {
    const root = this.#refreshChainRoots.get(token) ?? token;
    return this.#revokedRefreshChainRoots.has(root);
  }

  pruneRefreshChain(input: {
    chainBefore: number;
    consumedCodeBefore: number;
  }): RefreshChainPruneResult {
    let chainLinks = 0;
    let chainAccessTokens = 0;
    let revokedRoots = 0;
    let consumedCodes = 0;
    let authCodeTokenLinks = 0;
    // refresh_chain_links + their root mappings (refresh-token lifetime).
    for (const [parent, createdAt] of [...this.#refreshChainLinkCreatedAt]) {
      if (createdAt > input.chainBefore) continue;
      const child = this.#refreshChainChildren.get(parent);
      this.#refreshChainChildren.delete(parent);
      this.#refreshChainLinkCreatedAt.delete(parent);
      this.#refreshChainRoots.delete(parent);
      if (child !== undefined) this.#refreshChainRoots.delete(child);
      chainLinks += 1;
    }
    // revoked_refresh_roots + refresh_chain_access_tokens have no independent
    // timestamp on a per-access-token basis in memory; the revoked-root and
    // the access-token set are tied to a root, so prune them once the root's
    // chain links are gone (best-effort, bounded by the chain cutoff).
    for (const [root, revokedAt] of [...this.#revokedRefreshChainRoots]) {
      if (revokedAt > input.chainBefore) continue;
      this.#revokedRefreshChainRoots.delete(root);
      revokedRoots += 1;
    }
    for (const [root, set] of [...this.#refreshChainAccessTokens]) {
      // The access-token link set is created at rotation time; drop empty or
      // fully-revoked sets and any whose root is no longer referenced.
      if (set.size === 0 || !this.#refreshChainRoots.has(root)) {
        const removed = set.size;
        this.#refreshChainAccessTokens.delete(root);
        chainAccessTokens += removed;
      }
    }
    // consumed_authorization_codes + auth_code_token_links (auth-code
    // lifetime). The link entry carries createdAt; the consumed marker carries
    // consumedAt.
    for (const [code, consumedAt] of [...this.#consumedAuthorizationCodes]) {
      if (consumedAt > input.consumedCodeBefore) continue;
      this.#consumedAuthorizationCodes.delete(code);
      consumedCodes += 1;
    }
    for (const [code, entry] of [...this.#authorizationCodeTokens]) {
      if (entry.createdAt > input.consumedCodeBefore) continue;
      this.#authorizationCodeTokens.delete(code);
      authCodeTokenLinks += 1;
    }
    return {
      chainLinks,
      chainAccessTokens,
      revokedRoots,
      consumedCodes,
      authCodeTokenLinks,
    };
  }

  savePasskeyChallenge(
    key: string,
    challenge: string,
    expiresAt: number,
  ): void {
    this.#passkeyChallenges.set(key, { challenge, expiresAt });
  }

  consumePasskeyChallenge(key: string, now: number): string | undefined {
    const entry = this.#passkeyChallenges.get(key);
    if (entry === undefined) return undefined;
    // Single-shot: delete regardless of expiry so an expired challenge cannot
    // be replayed and stale rows do not accumulate.
    this.#passkeyChallenges.delete(key);
    if (entry.expiresAt <= now) return undefined;
    return entry.challenge;
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

function normalizeAccountEmail(email: string | undefined): string | undefined {
  const trimmed = email?.trim().toLowerCase();
  return trimmed ? trimmed : undefined;
}

function billingUsageRecordsSorted(
  records: readonly BillingUsageRecord[],
): readonly BillingUsageRecord[] {
  return [...records].sort(
    (left, right) =>
      left.reportedAt - right.reportedAt ||
      left.usageReportId.localeCompare(right.usageReportId),
  );
}
