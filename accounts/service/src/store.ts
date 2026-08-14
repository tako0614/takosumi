import type {
  TakosumiAccountsPatScope,
  TakosumiSubject,
} from "@takosjp/takosumi-accounts-contract";
import type {
  RefreshChainRetentionPageInput,
  RefreshChainRetentionPageResult,
  RefreshChainRetentionPhase,
} from "./refresh-chain-retention.ts";

export interface AuthorizationCodeRecord {
  clientId: string;
  redirectUri: string;
  scope: string;
  subject: string;
  takosumiSubject?: TakosumiSubject;
  capsuleId?: string;
  workspaceId?: string;
  role?: string;
  nonce?: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  expiresAt: number;
}

export interface TokenRecord {
  clientId: string;
  /** Invocation-time OAuth audience. Absent on ordinary client tokens. */
  audience?: string;
  scope: string;
  subject: string;
  takosumiSubject?: TakosumiSubject;
  capsuleId?: string;
  workspaceId?: string;
  role?: string;
  /** Interface evidence carried only by short-lived interface OAuth tokens. */
  interfaceId?: string;
  interfaceBindingId?: string;
  interfaceResolvedRevision?: number;
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

export const PERSONAL_ACCESS_TOKEN_INVENTORY_MAX_LIMIT = 100;

export interface PersonalAccessTokenInventoryCursor {
  readonly createdAt: number;
  readonly tokenId: string;
}

export interface PersonalAccessTokenInventoryPageInput {
  readonly subject: TakosumiSubject;
  /** Public page size. Stores read one additional row as the truncation probe. */
  readonly limit: number;
  readonly cursor?: PersonalAccessTokenInventoryCursor;
}

export interface PersonalAccessTokenInventoryPage {
  /** At most `input.limit + 1` rows, in canonical ascending tuple order. */
  readonly items: readonly PersonalAccessTokenRecord[];
  /** All active and revoked PATs currently owned by `input.subject`. */
  readonly total: number;
  /** False only when a supplied cursor tuple is no longer subject-owned. */
  readonly cursorValid: boolean;
}

export function assertPersonalAccessTokenInventoryPageInput(
  input: PersonalAccessTokenInventoryPageInput,
): void {
  if (
    !Number.isInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > PERSONAL_ACCESS_TOKEN_INVENTORY_MAX_LIMIT
  ) {
    throw new TypeError(
      `PAT inventory limit must be between 1 and ${PERSONAL_ACCESS_TOKEN_INVENTORY_MAX_LIMIT}`,
    );
  }
  if (
    input.cursor &&
    (!Number.isSafeInteger(input.cursor.createdAt) ||
      input.cursor.createdAt < 0 ||
      typeof input.cursor.tokenId !== "string" ||
      input.cursor.tokenId.length === 0 ||
      input.cursor.tokenId.length > 256)
  ) {
    throw new TypeError("PAT inventory cursor tuple is invalid");
  }
}

function comparePersonalAccessTokenInventoryTuple(
  left: PersonalAccessTokenRecord,
  right: PersonalAccessTokenRecord,
): number {
  return (
    left.createdAt - right.createdAt ||
    (left.tokenId < right.tokenId ? -1 : left.tokenId > right.tokenId ? 1 : 0)
  );
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
  /** Optional upstream profile image URL exposed through OIDC UserInfo. */
  picture?: string;
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

/**
 * Exact records matching one opaque account-plane bearer value. Durable stores
 * may resolve these together so collision rejection does not require one
 * database round trip per credential kind. The records remain candidates only;
 * expiry, audience, scope, account existence, and collision checks stay in the
 * service authorization layer.
 */
export interface AccountsBearerCredentialCandidates {
  readonly session?: AccountSessionRecord;
  readonly sessionAccount?: TakosumiAccountRecord;
  readonly accessToken?: TokenRecord;
  readonly personalAccessToken?: PersonalAccessTokenRecord;
}

/**
 * Result of {@link AccountsStore.pruneRefreshChainPage}. Counts the rows deleted
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

export type OidcClientAuthMethod =
  "client_secret_basic" | "client_secret_post" | "none";

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

export interface AccountsStore {
  /**
   * Optional bounded lookup for all credential kinds sharing one opaque token.
   * Implementations must use exact indexed keys and must not select a winner.
   */
  resolveAccountsBearerCandidates?(
    token: string,
  ):
    | AccountsBearerCredentialCandidates
    | Promise<AccountsBearerCredentialCandidates>;
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
  /**
   * Atomically persist `next` and revoke `previousSessionId`. Stores that do
   * not expose this port cannot safely rotate an already-presented session;
   * callers must fail closed instead of accepting a partial two-write result.
   */
  replaceAccountSession?(
    previousSessionId: string,
    next: AccountSessionRecord,
  ): boolean | Promise<boolean>;
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
  /** Atomic metadata count + keyset page read for the versioned inventory. */
  listPersonalAccessTokenInventoryPage(
    input: PersonalAccessTokenInventoryPageInput,
  ):
    | PersonalAccessTokenInventoryPage
    | Promise<PersonalAccessTokenInventoryPage>;
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
  saveOidcClient(record: OidcClientRecord): void | Promise<void>;
  findOidcClient(
    clientId: string,
  ): OidcClientRecord | undefined | Promise<OidcClientRecord | undefined>;
  findOidcClientForCapsule(
    capsuleId: string,
  ): OidcClientRecord | undefined | Promise<OidcClientRecord | undefined>;
  /**
   * Authoritatively removes one dynamic OIDC client registration. Tokens and
   * codes may remain for audit/reuse detection, but every authority-bearing
   * OIDC path must resolve the live registration, so deletion makes them inert.
   */
  revokeOidcClient(clientId: string): void | Promise<void>;
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
   * Bounded retention page for refresh-chain / authorization-code tracking
   * state. The timestamp+primary-key cursor and limit are mandatory so no
   * operator tick can materialize or delete an unbounded set.
   */
  pruneRefreshChainPage(
    input: RefreshChainRetentionPageInput,
  ): RefreshChainRetentionPageResult | Promise<RefreshChainRetentionPageResult>;
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
  readonly #upstreamIdentities = new Map<string, UpstreamIdentityRecord>();
  readonly #passkeyCredentials = new Map<string, PasskeyCredentialRecord>();
  readonly #accountSessions = new Map<string, AccountSessionRecord>();
  readonly #privacyRequests = new Map<string, PrivacyRequestRecord>();
  readonly #privacyRequestsBySubject = new Map<TakosumiSubject, Set<string>>();
  readonly #authorizationCodes = new Map<string, AuthorizationCodeRecord>();
  readonly #accessTokens = new Map<string, TokenRecord>();
  readonly #refreshTokens = new Map<string, TokenRecord>();
  readonly #personalAccessTokens = new Map<string, PersonalAccessTokenRecord>();
  readonly #personalAccessTokenIdsBySecret = new Map<string, string>();
  readonly #oidcClients = new Map<string, OidcClientRecord>();
  readonly #oidcClientsByCapsule = new Map<string, string>();
  // F30: persistent refresh-token rotation chain state. Each Map / Set
  // is the in-memory analogue of the corresponding accounts_v1 table the
  // production migration adds (refresh_chain_links / revoked_refresh_roots
  // / consumed_authorization_codes / auth_code_token_links).
  readonly #refreshChainChildren = new Map<string, string>();
  readonly #refreshChainRoots = new Map<string, string>();
  // revoked-root -> revokedAt ms. Read by isRefreshRootRevoked (defense in
  // depth on the refresh path) and pruned by pruneRefreshChainPage.
  readonly #revokedRefreshChainRoots = new Map<string, number>();
  // code -> consumedAt ms, for time-based retention.
  readonly #consumedAuthorizationCodes = new Map<string, number>();
  readonly #authorizationCodeTokens = new Map<
    string,
    { access: Set<string>; refresh: Set<string>; createdAt: number }
  >();
  readonly #refreshChainAccessTokens = new Map<string, Set<string>>();
  // `${root}\n${access}` -> createdAt ms. This mirrors the durable
  // refresh_chain_access_tokens row timestamp so the in-memory reference
  // adapter can exercise the same bounded retention cursor contract.
  readonly #refreshChainAccessTokenCreatedAt = new Map<string, number>();
  // parent-token -> createdAt ms for refresh_chain_links retention.
  readonly #refreshChainLinkCreatedAt = new Map<string, number>();
  readonly #refreshChainRetentionIndexes = new Map<
    RefreshChainRetentionPhase,
    Array<{ readonly at: number; readonly key: string }>
  >([
    ["chain_links", []],
    ["chain_access_tokens", []],
    ["revoked_roots", []],
    ["consumed_codes", []],
    ["auth_code_token_links", []],
  ]);
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

  replaceAccountSession(
    previousSessionId: string,
    next: AccountSessionRecord,
  ): boolean {
    if (
      !this.#accountSessions.has(previousSessionId) ||
      this.#accountSessions.has(next.sessionId)
    ) {
      return false;
    }
    this.#accountSessions.set(next.sessionId, structuredClone(next));
    this.#accountSessions.delete(previousSessionId);
    return true;
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

  listPersonalAccessTokenInventoryPage(
    input: PersonalAccessTokenInventoryPageInput,
  ): PersonalAccessTokenInventoryPage {
    assertPersonalAccessTokenInventoryPageInput(input);
    const records = [...this.#personalAccessTokens.values()]
      .filter((record) => record.subject === input.subject)
      .sort(comparePersonalAccessTokenInventoryTuple);
    const cursorValid = input.cursor
      ? records.some(
          (record) =>
            record.createdAt === input.cursor!.createdAt &&
            record.tokenId === input.cursor!.tokenId,
        )
      : true;
    const after = input.cursor
      ? records.filter(
          (record) =>
            record.createdAt > input.cursor!.createdAt ||
            (record.createdAt === input.cursor!.createdAt &&
              record.tokenId > input.cursor!.tokenId),
        )
      : records;
    return {
      items: after
        .slice(0, input.limit + 1)
        .map((record) => ({ ...record })),
      total: records.length,
      cursorValid,
    };
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

  saveOidcClient(record: OidcClientRecord): void {
    const existing = this.#oidcClients.get(record.clientId);
    if (existing && existing.capsuleId !== record.capsuleId) {
      throw new Error(
        `OIDC client ${record.clientId} is already bound to another Capsule`,
      );
    }
    const existingClientId = this.#oidcClientsByCapsule.get(record.capsuleId);
    if (existingClientId && existingClientId !== record.clientId) {
      throw new Error(
        `Capsule ${record.capsuleId} already has another OIDC client`,
      );
    }
    this.#oidcClients.set(record.clientId, record);
    this.#oidcClientsByCapsule.set(record.capsuleId, record.clientId);
  }

  findOidcClient(clientId: string): OidcClientRecord | undefined {
    return this.#oidcClients.get(clientId);
  }

  findOidcClientForCapsule(capsuleId: string): OidcClientRecord | undefined {
    const clientId = this.#oidcClientsByCapsule.get(capsuleId);
    return clientId ? this.#oidcClients.get(clientId) : undefined;
  }

  revokeOidcClient(clientId: string): void {
    const existing = this.#oidcClients.get(clientId);
    if (!existing) return;
    this.#oidcClients.delete(clientId);
    if (this.#oidcClientsByCapsule.get(existing.capsuleId) === clientId) {
      this.#oidcClientsByCapsule.delete(existing.capsuleId);
    }
  }

  addRefreshChainLink(parentToken: string, childToken: string): boolean {
    // G6 fix: atomic check-and-set. If a link for this parent already
    // exists, the token was already rotated (concurrent or sequential);
    // report the conflict so the caller can treat it as reuse instead of
    // minting a second child family.
    if (this.#refreshChainChildren.has(parentToken)) return false;
    this.#refreshChainChildren.set(parentToken, childToken);
    const createdAt = Date.now();
    this.#refreshChainLinkCreatedAt.set(parentToken, createdAt);
    this.#upsertRefreshChainRetentionCandidate(
      "chain_links",
      parentToken,
      createdAt,
    );
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
    const revokedAt = Date.now();
    this.#revokedRefreshChainRoots.set(root, revokedAt);
    this.#upsertRefreshChainRetentionCandidate(
      "revoked_roots",
      root,
      revokedAt,
    );
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
    }
    return [...tokens];
  }

  markAuthorizationCodeConsumed(code: string): void {
    const consumedAt = Date.now();
    this.#consumedAuthorizationCodes.set(code, consumedAt);
    this.#upsertRefreshChainRetentionCandidate(
      "consumed_codes",
      code,
      consumedAt,
    );
    if (!this.#authorizationCodeTokens.has(code)) {
      this.#authorizationCodeTokens.set(code, {
        access: new Set(),
        refresh: new Set(),
        createdAt: consumedAt,
      });
      this.#upsertRefreshChainRetentionCandidate(
        "auth_code_token_links",
        code,
        consumedAt,
      );
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
      this.#upsertRefreshChainRetentionCandidate(
        "auth_code_token_links",
        code,
        entry.createdAt,
      );
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
    const key = `${root}\n${accessToken}`;
    if (!this.#refreshChainAccessTokenCreatedAt.has(key)) {
      const createdAt = Date.now();
      this.#refreshChainAccessTokenCreatedAt.set(key, createdAt);
      this.#upsertRefreshChainRetentionCandidate(
        "chain_access_tokens",
        key,
        createdAt,
      );
    }
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

  pruneRefreshChainPage(
    input: RefreshChainRetentionPageInput,
  ): RefreshChainRetentionPageResult {
    assertInMemoryRetentionInput(input);
    const phase = input.cursor?.phase ?? "chain_links";
    const cursor = decodeInMemoryRetentionCursor(input.cursor?.after);
    const cutoff =
      phase === "consumed_codes" || phase === "auth_code_token_links"
        ? input.consumedCodeBefore
        : input.chainBefore;
    const candidates = this.#refreshChainRetentionCandidatesAfter(
      phase,
      cursor,
      cutoff,
      input.limit,
    );
    const counts: RefreshChainPruneResult = {
      chainLinks: 0,
      chainAccessTokens: 0,
      revokedRoots: 0,
      consumedCodes: 0,
      authCodeTokenLinks: 0,
    };
    for (const candidate of candidates) {
      if (phase === "chain_links") {
        const child = this.#refreshChainChildren.get(candidate.key);
        this.#refreshChainChildren.delete(candidate.key);
        this.#refreshChainLinkCreatedAt.delete(candidate.key);
        this.#removeRefreshChainRetentionCandidate(
          "chain_links",
          candidate.key,
        );
        this.#refreshChainRoots.delete(candidate.key);
        if (child !== undefined) this.#refreshChainRoots.delete(child);
        counts.chainLinks += 1;
      } else if (phase === "chain_access_tokens") {
        const [root, accessToken] = splitRefreshChainAccessKey(candidate.key);
        this.#refreshChainAccessTokenCreatedAt.delete(candidate.key);
        this.#removeRefreshChainRetentionCandidate(
          "chain_access_tokens",
          candidate.key,
        );
        const set = this.#refreshChainAccessTokens.get(root);
        set?.delete(accessToken);
        if (set?.size === 0) this.#refreshChainAccessTokens.delete(root);
        counts.chainAccessTokens += 1;
      } else if (phase === "revoked_roots") {
        this.#revokedRefreshChainRoots.delete(candidate.key);
        this.#removeRefreshChainRetentionCandidate(
          "revoked_roots",
          candidate.key,
        );
        counts.revokedRoots += 1;
      } else if (phase === "consumed_codes") {
        this.#consumedAuthorizationCodes.delete(candidate.key);
        this.#removeRefreshChainRetentionCandidate(
          "consumed_codes",
          candidate.key,
        );
        counts.consumedCodes += 1;
      } else {
        this.#authorizationCodeTokens.delete(candidate.key);
        this.#removeRefreshChainRetentionCandidate(
          "auth_code_token_links",
          candidate.key,
        );
        counts.authCodeTokenLinks += 1;
      }
    }
    const last = candidates.at(-1);
    if (candidates.length === input.limit && last) {
      return {
        ...counts,
        scanned: candidates.length,
        done: false,
        cursor: {
          phase,
          after: JSON.stringify([last.at, last.key]),
        },
      };
    }
    const nextPhase = nextInMemoryRetentionPhase(phase);
    return {
      ...counts,
      scanned: candidates.length,
      done: nextPhase === undefined,
      ...(nextPhase ? { cursor: { phase: nextPhase } } : {}),
    };
  }

  #refreshChainRetentionCandidatesAfter(
    phase: RefreshChainRetentionPhase,
    cursor: { readonly at: number; readonly key: string },
    cutoff: number,
    limit: number,
  ): Array<{ readonly at: number; readonly key: string }> {
    const index = this.#refreshChainRetentionIndexes.get(phase);
    if (!index) return [];
    let low = 0;
    let high = index.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = index[middle]!;
      if (
        candidate.at < cursor.at ||
        (candidate.at === cursor.at && candidate.key <= cursor.key)
      ) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    const candidates: Array<{ readonly at: number; readonly key: string }> = [];
    for (
      let position = low;
      position < index.length && candidates.length < limit;
      position += 1
    ) {
      const candidate = index[position]!;
      if (candidate.at > cutoff) break;
      candidates.push(candidate);
    }
    return candidates;
  }

  #upsertRefreshChainRetentionCandidate(
    phase: RefreshChainRetentionPhase,
    key: string,
    at: number,
  ): void {
    this.#removeRefreshChainRetentionCandidate(phase, key);
    const index = this.#refreshChainRetentionIndexes.get(phase)!;
    let low = 0;
    let high = index.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = index[middle]!;
      if (candidate.at < at || (candidate.at === at && candidate.key < key)) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    index.splice(low, 0, { at, key });
  }

  #removeRefreshChainRetentionCandidate(
    phase: RefreshChainRetentionPhase,
    key: string,
  ): void {
    const index = this.#refreshChainRetentionIndexes.get(phase);
    if (!index) return;
    const position = index.findIndex((candidate) => candidate.key === key);
    if (position >= 0) index.splice(position, 1);
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

const IN_MEMORY_RETENTION_PHASES: readonly RefreshChainRetentionPhase[] = [
  "chain_links",
  "chain_access_tokens",
  "revoked_roots",
  "consumed_codes",
  "auth_code_token_links",
];

function nextInMemoryRetentionPhase(
  phase: RefreshChainRetentionPhase,
): RefreshChainRetentionPhase | undefined {
  const index = IN_MEMORY_RETENTION_PHASES.indexOf(phase);
  return IN_MEMORY_RETENTION_PHASES[index + 1];
}

function decodeInMemoryRetentionCursor(
  value: string | undefined,
): { readonly at: number; readonly key: string } {
  if (value === undefined) return { at: -1, key: "" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new TypeError("invalid in-memory refresh-chain retention cursor");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    !Number.isFinite(parsed[0]) ||
    typeof parsed[1] !== "string"
  ) {
    throw new TypeError("invalid in-memory refresh-chain retention cursor");
  }
  return { at: Number(parsed[0]), key: parsed[1] };
}

function assertInMemoryRetentionInput(
  input: RefreshChainRetentionPageInput,
): void {
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit <= 0 ||
    input.limit > 1_000
  ) {
    throw new TypeError(
      "refresh-chain retention limit must be between 1 and 1000",
    );
  }
  if (
    !Number.isFinite(input.chainBefore) ||
    !Number.isFinite(input.consumedCodeBefore)
  ) {
    throw new TypeError("refresh-chain retention cutoffs must be finite");
  }
  if (!IN_MEMORY_RETENTION_PHASES.includes(input.cursor?.phase ?? "chain_links")) {
    throw new TypeError("invalid in-memory refresh-chain retention phase");
  }
}

function splitRefreshChainAccessKey(
  key: string,
): readonly [root: string, accessToken: string] {
  const separator = key.indexOf("\n");
  if (separator < 0) {
    throw new TypeError("invalid in-memory refresh-chain access key");
  }
  return [key.slice(0, separator), key.slice(separator + 1)];
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
