import { hashSessionId } from "./session-hash-salt.ts";
import { HostedIdentityRecords } from "./hosted-identity-records.ts";
import type { IdentityOperationReceiptRecord, AccountEmailProofRecord, HostedOidcGrantRecord, IdentityMergeMutation, IdentityMergeOperation, UnlinkUpstreamIdentityInput, UpstreamIdentityStatusRecord, UpstreamLoginTransactionRecord } from "./identity-state.ts";
import { PostgresIdentityRecordRepository } from "./postgres/identity-records.ts";
import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";
import type {
  AccountSessionRecord,
  AccountsStore,
  AuthorizationCodeRecord,
  OidcClientRecord,
  PasskeyCredentialRecord,
  PersonalAccessTokenInventoryPage,
  PersonalAccessTokenInventoryPageInput,
  PersonalAccessTokenRecord,
  PrivacyRequestRecord,
  TakosumiAccountRecord,
  TokenRecord,
  UpstreamIdentityRecord,
} from "./store.ts";
import type {
  RefreshChainRetentionPageInput,
  RefreshChainRetentionPageResult,
} from "./refresh-chain-retention.ts";
import type {
  PostgresQueryClient,
  PostgresQueryResult,
} from "./postgres/internal.ts";
import * as accounts from "./postgres/accounts.ts";
import * as bearer from "./postgres/bearer.ts";
import * as oidc from "./postgres/oidc.ts";
import * as passkeys from "./postgres/passkeys.ts";
import * as privacy from "./postgres/privacy.ts";
import * as refreshChain from "./postgres/refresh-chain.ts";
import * as sessions from "./postgres/sessions.ts";
import * as tokens from "./postgres/tokens.ts";

export type { PostgresQueryClient, PostgresQueryResult };

export class PostgresAccountsStore implements AccountsStore {
  readonly #client: PostgresQueryClient;
  readonly #hosted: HostedIdentityRecords;

  constructor(client: PostgresQueryClient) {
    this.#client = client;
    this.#hosted = new HostedIdentityRecords(new PostgresIdentityRecordRepository(client), this);
  }

  async findHostedAccountSessionAnchor(sessionId: string): Promise<string|undefined> { return this.#hosted.findHostedAccountSessionAnchor(await hashSessionId(sessionId)); }
  createCredentialUnlinkIntent(record: import("./identity-unlink-state.ts").CredentialUnlinkIntent): Promise<boolean> { return this.#hosted.createCredentialUnlinkIntent(record); }
  findCredentialUnlinkIntent(id: string): Promise<import("./identity-unlink-state.ts").CredentialUnlinkIntent | undefined> { return this.#hosted.findCredentialUnlinkIntent(id); }
  createCredentialUnlinkReceipt(record: import("./identity-unlink-state.ts").CredentialUnlinkReceipt): Promise<boolean> { return this.#hosted.createCredentialUnlinkReceipt(record); }
  findCredentialUnlinkReceipt(id: string): Promise<import("./identity-unlink-state.ts").CredentialUnlinkReceipt | undefined> { return this.#hosted.findCredentialUnlinkReceipt(id); }
  completeCredentialUnlink(input: import("./identity-unlink-state.ts").CredentialUnlinkMutation): Promise<boolean> { return this.#hosted.completeCredentialUnlink(input); }
  listIdentityMergeOperations(input: {after?:string;limit:number}): Promise<import("./identity-state.ts").IdentityMergeRetryPage> { return this.#hosted.listIdentityMergeOperations(input); }
  findIdentityMergeRetryCheckpoint(key:string):Promise<import("./identity-state.ts").IdentityMergeRetryCheckpoint|undefined>{return this.#hosted.findIdentityMergeRetryCheckpoint(key);}
  compareAndSetIdentityMergeRetryCheckpoint(input:import("./identity-state.ts").IdentityMergeRetryCheckpointMutation):Promise<boolean>{return this.#hosted.compareAndSetIdentityMergeRetryCheckpoint(input);}
  createIdentityOperationReceipt(record: IdentityOperationReceiptRecord): Promise<boolean> { return this.#hosted.createIdentityOperationReceipt(record); }
  findIdentityOperationReceipt(receiptId: string): Promise<IdentityOperationReceiptRecord | undefined> { return this.#hosted.findIdentityOperationReceipt(receiptId); }
  isHostedOidcSessionHashRevoked(issuerSessionHash: string): Promise<boolean> { return this.#hosted.isHostedOidcSessionHashRevoked(issuerSessionHash); }
  listCanonicalUpstreamIdentities(subject: TakosumiSubject): Promise<readonly UpstreamIdentityRecord[]> { return this.#hosted.listCanonicalUpstreamIdentities(subject); }
  getAccountAuthenticationGeneration(subject: TakosumiSubject): Promise<number> { return this.#hosted.getAccountAuthenticationGeneration(subject); }
  hashAccountSessionId(sessionId: string): Promise<string> { return hashSessionId(sessionId); }
  isHostedOidcClientRevoked(clientId: string): Promise<boolean> { return this.#hosted.isHostedOidcClientRevoked(clientId); }
  isHostedOidcSessionRevoked(issuerSessionId: string): Promise<boolean> { return this.#hosted.isHostedOidcSessionRevoked(issuerSessionId); }
  saveAccountEmailProof(record: AccountEmailProofRecord): Promise<void> { return this.#hosted.saveAccountEmailProof(record); }
  findAccountEmailProof(subject: TakosumiSubject): Promise<AccountEmailProofRecord | undefined> { return this.#hosted.findAccountEmailProof(subject); }
  findAccountsByEmailCandidate(address: string): Promise<readonly TakosumiAccountRecord[]> { return this.#hosted.findAccountsByEmailCandidate(address); }
  findCanonicalAccount(subject: TakosumiSubject): Promise<TakosumiAccountRecord | undefined> { return this.#hosted.findCanonicalAccount(subject); }
  isAccountAuthenticationFenced(subject: TakosumiSubject): Promise<boolean> { return this.#hosted.isAccountAuthenticationFenced(subject); }
  findUpstreamIdentityStatus(identity: Pick<UpstreamIdentityRecord, "providerId" | "upstreamIssuer" | "upstreamSubject">): Promise<UpstreamIdentityStatusRecord | undefined> { return this.#hosted.findUpstreamIdentityStatus(identity); }
  saveUpstreamLoginTransaction(record: UpstreamLoginTransactionRecord): Promise<void> { return this.#hosted.saveUpstreamLoginTransaction(record); }
  consumeUpstreamLoginTransaction(id: string, browserBindingHash: string, now: number): Promise<UpstreamLoginTransactionRecord | undefined> { return this.#hosted.consumeUpstreamLoginTransaction(id, browserBindingHash, now); }
  saveHostedOidcGrant(record: HostedOidcGrantRecord): Promise<void> { return this.#hosted.saveHostedOidcGrant(record); }
  findHostedOidcGrant(sid: string): Promise<HostedOidcGrantRecord | undefined> { return this.#hosted.findHostedOidcGrant(sid); }
  findHostedOidcGrantForSession(input: {issuerSessionId: string; clientId: string; subject: TakosumiSubject}): Promise<HostedOidcGrantRecord | undefined> { return this.#hosted.findHostedOidcGrantForSession(input); }
  findHostedOidcGrantForCode(authorizationCodeHash: string): Promise<HostedOidcGrantRecord | undefined> { return this.#hosted.findHostedOidcGrantForCode(authorizationCodeHash); }
  revokeHostedOidcGrant(sid: string, now: number): Promise<void> { return this.#hosted.revokeHostedOidcGrant(sid, now); }
  revokeHostedOidcSessionGrants(issuerSessionId: string, now: number): Promise<void> { return this.#hosted.revokeHostedOidcSessionGrants(issuerSessionId, now); }
  revokeHostedOidcClientGrants(clientId: string, now: number): Promise<void> { return this.#hosted.revokeHostedOidcClientGrants(clientId, now); }
  touchHostedAccountSession(sessionId: string, now: number, idleExpiresAt: number): Promise<boolean> { return this.#hosted.touchHostedAccountSession(sessionId, now, idleExpiresAt); }
  createIdentityMergeOperation(record: IdentityMergeOperation): Promise<boolean> { return this.#hosted.createIdentityMergeOperation(record); }
  findIdentityMergeOperation(operationId: string): Promise<IdentityMergeOperation | undefined> { return this.#hosted.findIdentityMergeOperation(operationId); }
  compareAndSetIdentityMerge(input: IdentityMergeMutation): Promise<boolean> { return this.#hosted.compareAndSetIdentityMerge(input); }
  unlinkCanonicalUpstreamIdentity(input: UnlinkUpstreamIdentityInput): Promise<boolean> { return this.#hosted.unlinkCanonicalUpstreamIdentity(input); }

  resolveAccountsBearerCandidates(
    token: string,
  ): Promise<import("./store.ts").AccountsBearerCredentialCandidates> {
    return bearer.resolveAccountsBearerCandidates(this.#client, token);
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

  linkUpstreamIdentityIfAbsent(record: UpstreamIdentityRecord): Promise<boolean> { return accounts.linkUpstreamIdentityIfAbsent(this.#client, record); }

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

  async saveAccountSession(record: AccountSessionRecord): Promise<void> {
    if(record.policy==="hosted")await this.#hosted.rememberHostedAccountSessionAnchor(await hashSessionId(record.sessionId),record);
    await sessions.saveAccountSession(this.#client, record);
  }

  findAccountSession(
    sessionId: string,
  ): Promise<AccountSessionRecord | undefined> {
    return sessions.findAccountSession(this.#client, sessionId);
  }

  deleteAccountSession(sessionId: string): Promise<void> {
    return sessions.deleteAccountSession(this.#client, sessionId);
  }

  async replaceAccountSession(
    previousSessionId: string,
    next: AccountSessionRecord,
  ): Promise<boolean> {
    if(next.policy==="hosted")await this.#hosted.rememberHostedAccountSessionAnchor(await hashSessionId(next.sessionId),next);
    return sessions.replaceAccountSession(
      this.#client,
      previousSessionId,
      next,
    );
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

  findAccessTokenByHash(tokenHash: string): Promise<TokenRecord | undefined> {
    return tokens.findAccessTokenByHash(this.#client, tokenHash);
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

  findPersonalAccessTokenById(
    subject: TakosumiSubject,
    tokenId: string,
  ): Promise<PersonalAccessTokenRecord | undefined> {
    return tokens.findPersonalAccessTokenById(this.#client, subject, tokenId);
  }

  listPersonalAccessTokensForSubject(
    subject: TakosumiSubject,
  ): Promise<readonly PersonalAccessTokenRecord[]> {
    return tokens.listPersonalAccessTokensForSubject(this.#client, subject);
  }

  listPersonalAccessTokenInventoryPage(
    input: PersonalAccessTokenInventoryPageInput,
  ): Promise<PersonalAccessTokenInventoryPage> {
    return tokens.listPersonalAccessTokenInventoryPage(this.#client, input);
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

  revokeOidcClient(clientId: string): Promise<void> {
    return oidc.revokeOidcClient(this.#client, clientId);
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

  pruneRefreshChainPage(
    input: RefreshChainRetentionPageInput,
  ): Promise<RefreshChainRetentionPageResult> {
    return refreshChain.pruneRefreshChainPage(this.#client, input);
  }

  isRefreshRootRevoked(token: string): Promise<boolean> {
    return refreshChain.isRefreshRootRevoked(this.#client, token);
  }
}
