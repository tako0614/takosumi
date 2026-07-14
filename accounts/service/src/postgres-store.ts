import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";
import type {
  AccountSessionRecord,
  AccountsStore,
  AuthorizationCodeRecord,
  OidcClientRecord,
  PasskeyCredentialRecord,
  PersonalAccessTokenRecord,
  PrivacyRequestRecord,
  RefreshChainPruneResult,
  TakosumiAccountRecord,
  TokenRecord,
  UpstreamIdentityRecord,
} from "./store.ts";
import type {
  PostgresQueryClient,
  PostgresQueryResult,
} from "./postgres/internal.ts";
import * as accounts from "./postgres/accounts.ts";
import * as oidc from "./postgres/oidc.ts";
import * as passkeys from "./postgres/passkeys.ts";
import * as privacy from "./postgres/privacy.ts";
import * as refreshChain from "./postgres/refresh-chain.ts";
import * as sessions from "./postgres/sessions.ts";
import * as tokens from "./postgres/tokens.ts";

export type { PostgresQueryClient, PostgresQueryResult };

export class PostgresAccountsStore implements AccountsStore {
  readonly #client: PostgresQueryClient;

  constructor(client: PostgresQueryClient) {
    this.#client = client;
  }

  saveAccount(record: TakosumiAccountRecord): Promise<void> {
    return accounts.saveAccount(this.#client, record);
  }

  findAccount(
    subject: TakosumiSubject,
  ): Promise<TakosumiAccountRecord | undefined> {
    return accounts.findAccount(this.#client, subject);
  }

  findAccountByVerifiedEmail(
    email: string,
  ): Promise<TakosumiAccountRecord | undefined> {
    return accounts.findAccountByVerifiedEmail(this.#client, email);
  }

  linkUpstreamIdentity(record: UpstreamIdentityRecord): Promise<void> {
    return accounts.linkUpstreamIdentity(this.#client, record);
  }

  findUpstreamIdentity(input: {
    providerId: string;
    upstreamIssuer: string;
    upstreamSubject: string;
  }): Promise<UpstreamIdentityRecord | undefined> {
    return accounts.findUpstreamIdentity(this.#client, input);
  }

  savePasskeyCredential(record: PasskeyCredentialRecord): Promise<void> {
    return passkeys.savePasskeyCredential(this.#client, record);
  }

  findPasskeyCredential(
    credentialId: string,
  ): Promise<PasskeyCredentialRecord | undefined> {
    return passkeys.findPasskeyCredential(this.#client, credentialId);
  }

  listPasskeyCredentialsForSubject(
    subject: TakosumiSubject,
  ): Promise<readonly PasskeyCredentialRecord[]> {
    return passkeys.listPasskeyCredentialsForSubject(this.#client, subject);
  }

  savePasskeyChallenge(
    key: string,
    challenge: string,
    expiresAt: number,
  ): Promise<void> {
    return passkeys.savePasskeyChallenge(
      this.#client,
      key,
      challenge,
      expiresAt,
    );
  }

  consumePasskeyChallenge(
    key: string,
    now: number,
  ): Promise<string | undefined> {
    return passkeys.consumePasskeyChallenge(this.#client, key, now);
  }

  saveAccountSession(record: AccountSessionRecord): Promise<void> {
    return sessions.saveAccountSession(this.#client, record);
  }

  findAccountSession(
    sessionId: string,
  ): Promise<AccountSessionRecord | undefined> {
    return sessions.findAccountSession(this.#client, sessionId);
  }

  deleteAccountSession(sessionId: string): Promise<void> {
    return sessions.deleteAccountSession(this.#client, sessionId);
  }

  savePrivacyRequest(record: PrivacyRequestRecord): Promise<void> {
    return privacy.savePrivacyRequest(this.#client, record);
  }

  findPrivacyRequest(
    requestId: string,
  ): Promise<PrivacyRequestRecord | undefined> {
    return privacy.findPrivacyRequest(this.#client, requestId);
  }

  listPrivacyRequestsForSubject(
    subject: TakosumiSubject,
  ): Promise<readonly PrivacyRequestRecord[]> {
    return privacy.listPrivacyRequestsForSubject(this.#client, subject);
  }

  saveAuthorizationCode(
    code: string,
    record: AuthorizationCodeRecord,
  ): Promise<void> {
    return tokens.saveAuthorizationCode(this.#client, code, record);
  }

  consumeAuthorizationCode(
    code: string,
  ): Promise<AuthorizationCodeRecord | undefined> {
    return tokens.consumeAuthorizationCode(this.#client, code);
  }

  saveAccessToken(token: string, record: TokenRecord): Promise<void> {
    return tokens.saveOAuthToken(
      this.#client,
      "oauth_access_tokens",
      token,
      record,
    );
  }

  findAccessToken(token: string): Promise<TokenRecord | undefined> {
    return tokens.findOAuthToken(this.#client, "oauth_access_tokens", token);
  }

  saveRefreshToken(token: string, record: TokenRecord): Promise<void> {
    return tokens.saveOAuthToken(
      this.#client,
      "oauth_refresh_tokens",
      token,
      record,
    );
  }

  findRefreshToken(token: string): Promise<TokenRecord | undefined> {
    return tokens.findOAuthToken(this.#client, "oauth_refresh_tokens", token);
  }

  deleteToken(token: string): Promise<void> {
    return tokens.deleteOAuthToken(this.#client, token);
  }

  savePersonalAccessToken(
    token: string,
    record: PersonalAccessTokenRecord,
  ): Promise<void> {
    return tokens.savePersonalAccessToken(this.#client, token, record);
  }

  findPersonalAccessToken(
    token: string,
  ): Promise<PersonalAccessTokenRecord | undefined> {
    return tokens.findPersonalAccessToken(this.#client, token);
  }

  listPersonalAccessTokensForSubject(
    subject: TakosumiSubject,
  ): Promise<readonly PersonalAccessTokenRecord[]> {
    return tokens.listPersonalAccessTokensForSubject(this.#client, subject);
  }

  revokePersonalAccessToken(input: {
    subject: TakosumiSubject;
    tokenId: string;
    revokedAt: number;
  }): Promise<PersonalAccessTokenRecord | undefined> {
    return tokens.revokePersonalAccessToken(this.#client, input);
  }

  recordPersonalAccessTokenUsed(
    tokenId: string,
    lastUsedAt: number,
  ): Promise<void> {
    return tokens.recordPersonalAccessTokenUsed(
      this.#client,
      tokenId,
      lastUsedAt,
    );
  }

  saveOidcClient(record: OidcClientRecord): Promise<void> {
    return oidc.saveOidcClient(this.#client, record);
  }

  findOidcClient(clientId: string): Promise<OidcClientRecord | undefined> {
    return oidc.findOidcClient(this.#client, clientId);
  }

  findOidcClientForCapsule(
    capsuleId: string,
  ): Promise<OidcClientRecord | undefined> {
    return oidc.findOidcClientForCapsule(this.#client, capsuleId);
  }

  addRefreshChainLink(
    parentToken: string,
    childToken: string,
  ): Promise<boolean> {
    return refreshChain.addRefreshChainLink(
      this.#client,
      parentToken,
      childToken,
    );
  }

  getRefreshChainChild(token: string): Promise<string | undefined> {
    return refreshChain.getRefreshChainChild(this.#client, token);
  }

  revokeRefreshChain(rootToken: string): Promise<readonly string[]> {
    return refreshChain.revokeRefreshChain(this.#client, rootToken);
  }

  markAuthorizationCodeConsumed(code: string): Promise<void> {
    return refreshChain.markAuthorizationCodeConsumed(this.#client, code);
  }

  isAuthorizationCodeConsumed(code: string): Promise<boolean> {
    return refreshChain.isAuthorizationCodeConsumed(this.#client, code);
  }

  linkAccessTokenToAuthCode(
    code: string,
    accessToken: string,
    refreshTokenRoot?: string,
  ): Promise<void> {
    return refreshChain.linkAccessTokenToAuthCode(
      this.#client,
      code,
      accessToken,
      refreshTokenRoot,
    );
  }

  linkAccessTokenToRefreshChain(
    refreshTokenRoot: string,
    accessToken: string,
  ): Promise<void> {
    return refreshChain.linkAccessTokenToRefreshChain(
      this.#client,
      refreshTokenRoot,
      accessToken,
    );
  }

  revokeTokensIssuedFromCode(
    code: string,
  ): Promise<{ access: readonly string[]; refresh: readonly string[] }> {
    return refreshChain.revokeTokensIssuedFromCode(this.#client, code);
  }

  pruneRefreshChain(input: {
    chainBefore: number;
    consumedCodeBefore: number;
  }): Promise<RefreshChainPruneResult> {
    return refreshChain.pruneRefreshChain(this.#client, input);
  }

  isRefreshRootRevoked(token: string): Promise<boolean> {
    return refreshChain.isRefreshRootRevoked(this.#client, token);
  }
}
