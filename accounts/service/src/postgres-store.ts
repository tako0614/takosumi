import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";
import type {
  ServiceBindingMaterialRecord,
  ServiceGrantMaterialRecord,
  InstallationEventRecord,
  InstallationRecord,
  LedgerAccountRecord,
  RuntimeBindingRecord,
  SpaceRecord,
} from "./ledger.ts";
import type {
  AccountSessionRecord,
  AccountsStore,
  AuthorizationCodeRecord,
  BillingAccountRecord,
  BillingUsageRecord,
  BillingWebhookEventClaimResult,
  BillingWebhookEventRecord,
  LaunchTokenConsumeResult,
  LaunchTokenConsumptionRecord,
  LaunchTokenPruneResult,
  LaunchTokenRecord,
  OidcClientRecord,
  PasskeyCredentialRecord,
  PersonalAccessTokenRecord,
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
import * as billing from "./postgres/billing.ts";
import * as installations from "./postgres/installations.ts";
import * as launchTokens from "./postgres/launch-tokens.ts";
import * as oidc from "./postgres/oidc.ts";
import * as passkeys from "./postgres/passkeys.ts";
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

  saveBillingAccount(record: BillingAccountRecord): Promise<void> {
    return billing.saveBillingAccount(this.#client, record);
  }

  saveBillingAccountIfVersion(
    record: BillingAccountRecord,
    expectedVersion: number,
  ): Promise<boolean> {
    return billing.saveBillingAccountIfVersion(
      this.#client,
      record,
      expectedVersion,
    );
  }

  findBillingAccount(
    billingAccountId: string,
  ): Promise<BillingAccountRecord | undefined> {
    return billing.findBillingAccount(this.#client, billingAccountId);
  }

  findBillingAccountForSubject(
    subject: TakosumiSubject,
  ): Promise<BillingAccountRecord | undefined> {
    return billing.findBillingAccountForSubject(this.#client, subject);
  }

  findBillingAccountByStripeCustomerId(
    stripeCustomerId: string,
  ): Promise<BillingAccountRecord | undefined> {
    return billing.findBillingAccountByStripeCustomerId(
      this.#client,
      stripeCustomerId,
    );
  }

  saveBillingWebhookEvent(record: BillingWebhookEventRecord): Promise<void> {
    return billing.saveBillingWebhookEvent(this.#client, record);
  }

  findBillingWebhookEvent(
    eventId: string,
  ): Promise<BillingWebhookEventRecord | undefined> {
    return billing.findBillingWebhookEvent(this.#client, eventId);
  }

  claimBillingWebhookEvent(
    record: BillingWebhookEventRecord,
  ): Promise<BillingWebhookEventClaimResult> {
    return billing.claimBillingWebhookEvent(this.#client, record);
  }

  saveBillingUsageRecord(record: BillingUsageRecord): Promise<void> {
    return billing.saveBillingUsageRecord(this.#client, record);
  }

  findBillingUsageRecord(
    usageReportId: string,
  ): Promise<BillingUsageRecord | undefined> {
    return billing.findBillingUsageRecord(this.#client, usageReportId);
  }

  listBillingUsageRecordsForInstallation(
    installationId: string,
  ): Promise<readonly BillingUsageRecord[]> {
    return billing.listBillingUsageRecordsForInstallation(
      this.#client,
      installationId,
    );
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

  consumeLaunchTokenJti(
    record: LaunchTokenConsumptionRecord,
  ): Promise<boolean> {
    return launchTokens.consumeLaunchTokenJti(this.#client, record);
  }

  saveLaunchToken(record: LaunchTokenRecord): Promise<void> {
    return launchTokens.saveLaunchToken(this.#client, record);
  }

  consumeLaunchToken(input: {
    tokenHash: string;
    installationId: string;
    redirectUri: string;
    consumedAt: number;
  }): Promise<LaunchTokenConsumeResult> {
    return launchTokens.consumeLaunchToken(this.#client, input);
  }

  pruneLaunchTokens(input: {
    expiredBefore: number;
    usedBefore: number;
  }): Promise<LaunchTokenPruneResult> {
    return launchTokens.pruneLaunchTokens(this.#client, input);
  }

  saveOidcClient(record: OidcClientRecord): Promise<void> {
    return oidc.saveOidcClient(this.#client, record);
  }

  findOidcClient(clientId: string): Promise<OidcClientRecord | undefined> {
    return oidc.findOidcClient(this.#client, clientId);
  }

  findOidcClientForInstallation(
    installationId: string,
  ): Promise<OidcClientRecord | undefined> {
    return oidc.findOidcClientForInstallation(this.#client, installationId);
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

  saveLedgerAccount(record: LedgerAccountRecord): Promise<void> {
    return installations.saveLedgerAccount(this.#client, record);
  }

  findLedgerAccount(
    accountId: string,
  ): Promise<LedgerAccountRecord | undefined> {
    return installations.findLedgerAccount(this.#client, accountId);
  }

  saveSpace(record: SpaceRecord): Promise<void> {
    return installations.saveSpace(this.#client, record);
  }

  findSpace(spaceId: string): Promise<SpaceRecord | undefined> {
    return installations.findSpace(this.#client, spaceId);
  }

  listSpacesForAccount(accountId: string): Promise<readonly SpaceRecord[]> {
    return installations.listSpacesForAccount(this.#client, accountId);
  }

  listSpacesForOwner(
    subject: TakosumiSubject,
  ): Promise<readonly SpaceRecord[]> {
    return installations.listSpacesForOwner(this.#client, subject);
  }

  saveAppInstallation(record: InstallationRecord): Promise<void> {
    return installations.saveAppInstallation(this.#client, record);
  }

  findAppInstallation(
    installationId: string,
  ): Promise<InstallationRecord | undefined> {
    return installations.findAppInstallation(this.#client, installationId);
  }

  listAppInstallationsForSpace(
    spaceId: string,
  ): Promise<readonly InstallationRecord[]> {
    return installations.listAppInstallationsForSpace(this.#client, spaceId);
  }

  listAppInstallationsForBillingAccount(
    billingAccountId: string,
  ): Promise<readonly InstallationRecord[]> {
    return installations.listAppInstallationsForBillingAccount(
      this.#client,
      billingAccountId,
    );
  }

  saveRuntimeBinding(record: RuntimeBindingRecord): Promise<void> {
    return installations.saveRuntimeBinding(this.#client, record);
  }

  findRuntimeBinding(
    runtimeBindingId: string,
  ): Promise<RuntimeBindingRecord | undefined> {
    return installations.findRuntimeBinding(this.#client, runtimeBindingId);
  }

  saveServiceBindingMaterial(
    record: ServiceBindingMaterialRecord,
  ): Promise<void> {
    return installations.saveServiceBindingMaterial(this.#client, record);
  }

  listServiceBindingMaterialsForInstallation(
    installationId: string,
  ): Promise<readonly ServiceBindingMaterialRecord[]> {
    return installations.listServiceBindingMaterialsForInstallation(
      this.#client,
      installationId,
    );
  }

  saveServiceGrantMaterial(record: ServiceGrantMaterialRecord): Promise<void> {
    return installations.saveServiceGrantMaterial(this.#client, record);
  }

  findServiceGrantMaterial(
    grantId: string,
  ): Promise<ServiceGrantMaterialRecord | undefined> {
    return installations.findServiceGrantMaterial(this.#client, grantId);
  }

  listServiceGrantMaterialsForInstallation(
    installationId: string,
  ): Promise<readonly ServiceGrantMaterialRecord[]> {
    return installations.listServiceGrantMaterialsForInstallation(
      this.#client,
      installationId,
    );
  }

  appendInstallationEvent(record: InstallationEventRecord): Promise<void> {
    return installations.appendInstallationEvent(this.#client, record);
  }

  listInstallationEvents(
    installationId: string,
  ): Promise<readonly InstallationEventRecord[]> {
    return installations.listInstallationEvents(this.#client, installationId);
  }
}
