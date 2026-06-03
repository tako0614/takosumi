import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";
import { type AppGrantCapability, isAppGrantCapability } from "./ledger.ts";
import type {
  AccountsStore,
  AuthorizationCodeRecord,
  OidcClientAuthMethod,
  TakosumiAccountRecord,
  TokenRecord,
} from "./store.ts";
import { derivePairwiseSubject } from "./subject.ts";
import {
  base64UrlEncodeBytes,
  constantTimeEqual,
  sha256Text,
} from "./encoding.ts";
import {
  bearerChallenge,
  bearerToken,
  json,
 takosumiSubjectValue,
} from "./http-helpers.ts";
import {
  personalAccessTokenIntrospectionBody,
  personalAccessTokenIsActive,
} from "./pat-routes.ts";
import type {
  OidcAuthorizationCodeFlow,
  OidcClientRegistration,
} from "./mod.ts";
import { readEnvVar } from "./read-env.ts";

// OIDC token / code lifetimes. These have safe production defaults and are
// operator-configurable via env (mirroring how passkey/session TTLs are
// configurable). Values are read once at module load. On Cloudflare Workers
// process env is not visible, so the defaults apply there unless the env is
// surfaced into the process; this only ever shortens or lengthens lifetimes,
// never disables a security check.
function readTtlMsEnv(name: string, fallbackMs: number): number {
  const raw = readEnvVar(name);
  if (raw === undefined) return fallbackMs;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallbackMs;
  return Math.floor(parsed);
}

/** Authorization-code lifetime (default 5 minutes). */
const AUTHORIZATION_CODE_TTL_MS = readTtlMsEnv(
  "TAKOSUMI_ACCOUNTS_AUTH_CODE_TTL_MS",
  5 * 60 * 1000,
);
/** Access-token lifetime in seconds (default 5 minutes). */
const ACCESS_TOKEN_TTL_SECONDS = Math.max(
  1,
  Math.floor(
    readTtlMsEnv("TAKOSUMI_ACCOUNTS_ACCESS_TOKEN_TTL_MS", 5 * 60 * 1000) / 1000,
  ),
);
/** Refresh-token lifetime (default 30 days). Deduplicated single source. */
const REFRESH_TOKEN_TTL_MS = readTtlMsEnv(
  "TAKOSUMI_ACCOUNTS_REFRESH_TOKEN_TTL_MS",
  30 * 24 * 60 * 60 * 1000,
);

/**
 * Generate an opaque access token. 32 bytes of entropy, prefixed `takat_`.
 * The previous `dev-${randomUUID()}` prefix was misleading: it shipped in
 * production Authorization headers / logs / introspection responses and read
 * like a dev placeholder, plus UUIDv4 has less entropy than 32 random bytes.
 */
function generateAccessToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `takat_${base64UrlEncodeBytes(bytes)}`;
}

/** Generate an opaque refresh token. 32 bytes of entropy, prefixed `takrt_`. */
function generateRefreshToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `takrt_${base64UrlEncodeBytes(bytes)}`;
}

// F30 fix: refresh-token rotation chains and authorization-code reuse
// cascades are now persisted in the `AccountsStore` (see migration
// 019_refresh_chain.sql). Each operator replica therefore observes the
// same chain state, and the state survives restarts. The previous
// in-process Maps/Sets lived in this file as a best-effort approximation;
// they have been replaced by store calls. Reuse detection is fully
// store-backed: `isAuthorizationCodeConsumed` + `consumeAuthorizationCode`
// (single-shot delete) cover replay across replicas, so there is no
// remaining in-process reuse state to keep here.

type ResolvedOidcClient = {
  clientId: string;
  installationId?: string;
  issuerUrl?: string;
  redirectUris: readonly string[];
  allowedScopes?: readonly string[];
  subjectMode?: "pairwise";
  tokenEndpointAuthMethod: OidcClientAuthMethod;
  clientSecret?: string;
  clientSecretHash?: string;
};

async function resolveOidcClient(input: {
  clientId: string;
  clients: ReadonlyMap<string, OidcClientRegistration>;
  store: AccountsStore;
}): Promise<ResolvedOidcClient | undefined> {
  const staticClient = input.clients.get(input.clientId);
  if (staticClient) {
    return {
      clientId: staticClient.clientId,
      redirectUris: staticClient.redirectUris,
      tokenEndpointAuthMethod: staticClient.tokenEndpointAuthMethod ??
        (staticClient.clientSecret ? "client_secret_post" : "none"),
      clientSecret: staticClient.clientSecret,
    };
  }
  const dynamicClient = await input.store.findOidcClient(input.clientId);
  if (!dynamicClient) return undefined;
  return {
    clientId: dynamicClient.clientId,
    installationId: dynamicClient.installationId,
    issuerUrl: dynamicClient.issuerUrl,
    redirectUris: dynamicClient.redirectUris,
    allowedScopes: dynamicClient.allowedScopes,
    subjectMode: dynamicClient.subjectMode,
    tokenEndpointAuthMethod: dynamicClient.tokenEndpointAuthMethod,
    clientSecretHash: dynamicClient.clientSecretHash,
  };
}

function oidcTokenClientCredentials(
  request: Request,
  params: URLSearchParams,
): { clientId?: string; secret?: string } {
  const basic = basicClientCredentials(request.headers.get("authorization"));
  if (basic) return basic;
  return {
    clientId: params.get("client_id") ?? undefined,
    secret: params.get("client_secret") ?? undefined,
  };
}

function basicClientCredentials(
  authorization: string | null,
): { clientId: string; secret: string } | undefined {
  if (!authorization?.startsWith("Basic ")) return undefined;
  try {
    const decoded = atob(authorization.slice("Basic ".length).trim());
    const separator = decoded.indexOf(":");
    if (separator <= 0) return undefined;
    return {
      clientId: decodeURIComponent(decoded.slice(0, separator)),
      secret: decodeURIComponent(decoded.slice(separator + 1)),
    };
  } catch {
    return undefined;
  }
}

async function validateOidcClientSecret(
  client: ResolvedOidcClient,
  secret: string | undefined,
): Promise<boolean> {
  if (client.tokenEndpointAuthMethod === "none") return true;
  if (!secret) return false;
  if (client.clientSecret !== undefined) {
    return constantTimeEqual(secret, client.clientSecret);
  }
  if (!client.clientSecretHash) return false;
  const candidateHash = await sha256Text(`takosumi-oidc-client:${secret}`);
  return constantTimeEqual(candidateHash, client.clientSecretHash);
}

async function authenticateOidcClient(input: {
  clientId: string | undefined;
  secret: string | undefined;
  clients: ReadonlyMap<string, OidcClientRegistration>;
  store: AccountsStore;
  /**
   * When the host wiring did not supply a `clients` map (clientsSupplied =
   * false) and no static or dynamic client is known yet, the handler runs in
   * a transitional degraded mode: requests without a `client_id` are
   * accepted only in degraded mode. Once the host wires `clients` (or
   * any dynamic registration exists), strict RFC 7009 §2.1 / RFC 7662 §2.1
   * client authentication is enforced.
   */
  clientsSupplied: boolean;
}): Promise<
  | { ok: true; client: ResolvedOidcClient | undefined }
  | { ok: false; error: "invalid_client"; status: 401 }
> {
  if (!input.clientId) {
    if (!input.clientsSupplied && input.clients.size === 0) {
      // Degraded mode: no static clients wired. Accept the
      // anonymous request to preserve transitional compatibility. Once
      // mod.ts wires `clients` through (Agent 7 follow-up), this branch
      // becomes unreachable for production deployments.
      return { ok: true, client: undefined };
    }
    return { ok: false, error: "invalid_client", status: 401 };
  }
  const client = await resolveOidcClient({
    clientId: input.clientId,
    clients: input.clients,
    store: input.store,
  });
  if (!client) {
    // Unknown client_id is always rejected regardless of degraded mode.
    return { ok: false, error: "invalid_client", status: 401 };
  }
  if (!(await validateOidcClientSecret(client, input.secret))) {
    return { ok: false, error: "invalid_client", status: 401 };
  }
  return { ok: true, client };
}

async function resolveOidcAuthorizationSubject(input: {
  client: ResolvedOidcClient | undefined;
  flow: OidcAuthorizationCodeFlow;
  store: AccountsStore;
}): Promise<
  | {
    ok: true;
    record: {
      subject: string;
     takosumiSubject?: TakosumiSubject;
      installationId?: string;
      appId?: string;
      spaceId?: string;
      role?: string;
    };
  }
  | { ok: false; status: number; error: string; errorDescription: string }
> {
  if (!input.client?.installationId) {
    return { ok: true, record: { subject: input.flow.subject } };
  }
  const takosumiSubject = takosumiSubjectValue(input.flow.subject);
  if (!takosumiSubject) {
    return {
      ok: false,
      status: 500,
      error: "server_error",
      errorDescription:
        "per-installation OIDC clients require a Takosumi subject",
    };
  }
  if (!input.flow.pairwiseSubjectSecret) {
    return {
      ok: false,
      status: 500,
      error: "server_error",
      errorDescription:
        "per-installation OIDC clients require pairwiseSubjectSecret",
    };
  }
  const installation = await input.store.findAppInstallation(
    input.client.installationId,
  );
  if (!installation) {
    return {
      ok: false,
      status: 400,
      error: "unauthorized_client",
      errorDescription: "OIDC client installation was not found",
    };
  }
  const pairwiseSubject = await derivePairwiseSubject({
    secret: input.flow.pairwiseSubjectSecret,
   takosumiSubject,
    clientId:
      `${installation.appId}:${installation.installationId}:${input.client.clientId}`,
  });
  return {
    ok: true,
    record: {
      subject: pairwiseSubject,
     takosumiSubject,
      installationId: installation.installationId,
      appId: installation.appId,
      spaceId: installation.spaceId,
      role: installation.createdBySubject === takosumiSubject
        ? "owner"
        : "member",
    },
  };
}

function scopeIsAllowed(
  requestedScope: string,
  allowedScopes: readonly string[],
): boolean {
  const allowed = new Set(allowedScopes);
  const requested = requestedScope.trim().split(/\s+/).filter(Boolean);
  return requested.length > 0 && requested.every((scope) => allowed.has(scope));
}

export async function handleAuthorize(input: {
  url: URL;
  flow: OidcAuthorizationCodeFlow;
  clients: ReadonlyMap<string, OidcClientRegistration>;
  store: AccountsStore;
}): Promise<Response> {
  const responseType = input.url.searchParams.get("response_type");
  const clientId = input.url.searchParams.get("client_id");
  const redirectUri = input.url.searchParams.get("redirect_uri");
  if (responseType !== "code" || !clientId || !redirectUri) {
    return json({
      error: "invalid_request",
      error_description:
        "response_type=code, client_id, and redirect_uri are required",
    }, 400);
  }
  const client = await resolveOidcClient({
    clientId,
    clients: input.clients,
    store: input.store,
  });
  if (!client) {
    // Reject any client_id that is neither a configured static client nor a
    // dynamic registration. Falling through would issue an unauthenticated
    // anonymous code, which is unsafe for OIDC.
    return json({ error: "unauthorized_client" }, 400);
  }
  if (!client.redirectUris.includes(redirectUri)) {
    return json({
      error: "invalid_request",
      error_description: "redirect_uri is not registered for this client",
    }, 400);
  }
  // PKCE is mandatory for the authorization-code flow per current OAuth 2.1 /
  // OIDC security profile. Only the S256 transformation is accepted; plain is
  // explicitly forbidden.
  const codeChallenge = input.url.searchParams.get("code_challenge");
  const codeChallengeMethod =
    input.url.searchParams.get("code_challenge_method") ?? "S256";
  if (!codeChallenge) {
    return json({
      error: "invalid_request",
      error_description: "code_challenge is required (PKCE is mandatory)",
    }, 400);
  }
  if (codeChallengeMethod !== "S256") {
    return json({
      error: "invalid_request",
      error_description: "code_challenge_method must be S256",
    }, 400);
  }
  const scope = input.url.searchParams.get("scope") ?? "openid";
  if (client?.allowedScopes && !scopeIsAllowed(scope, client.allowedScopes)) {
    return json({
      error: "invalid_scope",
      error_description: "requested scope is outside the installation grant",
    }, 400);
  }
  const subject = await resolveOidcAuthorizationSubject({
    client,
    flow: input.flow,
    store: input.store,
  });
  if (!subject.ok) {
    return json({
      error: subject.error,
      error_description: subject.errorDescription,
    }, subject.status);
  }

  const code = crypto.randomUUID();
  await input.store.saveAuthorizationCode(code, {
    clientId,
    redirectUri,
    scope,
    subject: subject.record.subject,
   takosumiSubject: subject.record.takosumiSubject,
    installationId: subject.record.installationId,
    appId: subject.record.appId,
    spaceId: subject.record.spaceId,
    role: subject.record.role,
    nonce: input.url.searchParams.get("nonce") ?? undefined,
    codeChallenge,
    codeChallengeMethod,
    expiresAt: Date.now() + AUTHORIZATION_CODE_TTL_MS,
  });

  const redirect = new URL(redirectUri);
  redirect.searchParams.set("code", code);
  const state = input.url.searchParams.get("state");
  if (state) redirect.searchParams.set("state", state);
  return Response.redirect(redirect, 302);
}

export async function handleToken(input: {
  issuer: string;
  request: Request;
  store: AccountsStore;
  flow: OidcAuthorizationCodeFlow;
  clients: ReadonlyMap<string, OidcClientRegistration>;
}): Promise<Response> {
  const params = new URLSearchParams(await input.request.text());
  const grantType = params.get("grant_type");
  if (grantType === "refresh_token") {
    return await handleRefreshToken({
      issuer: input.issuer,
      request: input.request,
      params,
      store: input.store,
      flow: input.flow,
      clients: input.clients,
    });
  }
  if (grantType !== "authorization_code") {
    return json({ error: "unsupported_grant_type" }, 400);
  }

  const code = params.get("code");
  if (!code) return json({ error: "invalid_grant" }, 400);

  // Detect authorization-code reuse before consuming. consumeAuthorizationCode
  // is single-shot, but a second attempt may legitimately race or maliciously
  // replay the code. If the code was already consumed once, cascade-revoke any
  // tokens that were issued from the original exchange and permanently fail
  // subsequent retries.
  if (await input.store.isAuthorizationCodeConsumed(code)) {
    await cascadeRevokeAuthorizationCode(code, input.store);
    return json({ error: "invalid_grant" }, 400);
  }
  const record = await input.store.consumeAuthorizationCode(code);
  if (!record || record.expiresAt < Date.now()) {
    return json({ error: "invalid_grant" }, 400);
  }
  if (!await tokenScopesRemainGranted({ store: input.store, record })) {
    return json({ error: "invalid_grant" }, 400);
  }

  const credentials = oidcTokenClientCredentials(input.request, params);
  if (credentials.clientId !== record.clientId) {
    return json({ error: "invalid_grant" }, 400);
  }
  const client = await resolveOidcClient({
    clientId: record.clientId,
    clients: input.clients,
    store: input.store,
  });
  if (input.clients.size > 0 && !client) {
    return json({ error: "invalid_grant" }, 400);
  }
  if (
    client && !(await validateOidcClientSecret(client, credentials.secret))
  ) {
    return json({ error: "invalid_client" }, 401);
  }
  if (params.get("redirect_uri") !== record.redirectUri) {
    return json({ error: "invalid_grant" }, 400);
  }
  if (!(await isPkceVerifierValid(record, params.get("code_verifier")))) {
    return json({ error: "invalid_grant" }, 400);
  }

  // Mark this code as consumed and start tracking the tokens issued through
  // it so a reuse attempt can cascade-revoke the descendants.
  await input.store.markAuthorizationCodeConsumed(code);

  const refreshToken = includesScope(record.scope, "offline_access")
    ? generateRefreshToken()
    : undefined;
  if (refreshToken) {
    await input.store.saveRefreshToken(refreshToken, {
      clientId: record.clientId,
      scope: record.scope,
      subject: record.subject,
     takosumiSubject: record.takosumiSubject,
      installationId: record.installationId,
      appId: record.appId,
      spaceId: record.spaceId,
      role: record.role,
      expiresAt: Date.now() + REFRESH_TOKEN_TTL_MS,
    });
    // The refresh token at chain creation is by definition its own
    // root; no parent link is recorded yet. `addRefreshChainLink` is
    // called on subsequent rotations.
  }

  return await issueTokenResponse({
    issuer: input.issuer,
    store: input.store,
    flow: input.flow,
    clientId: record.clientId,
    scope: record.scope,
    subject: record.subject,
   takosumiSubject: record.takosumiSubject,
    installationId: record.installationId,
    appId: record.appId,
    spaceId: record.spaceId,
    role: record.role,
    nonce: record.nonce,
    refreshToken,
    chainRefreshToken: refreshToken,
    authorizationCode: code,
  });
}

async function handleRefreshToken(input: {
  issuer: string;
  request: Request;
  params: URLSearchParams;
  store: AccountsStore;
  flow: OidcAuthorizationCodeFlow;
  clients: ReadonlyMap<string, OidcClientRegistration>;
}): Promise<Response> {
  const refreshToken = input.params.get("refresh_token");
  if (!refreshToken) return json({ error: "invalid_grant" }, 400);

  // Refresh-token reuse detection (RFC 6749 §10.4 / OAuth 2.1 §4.3.1).
  // If a refresh token has already been rotated (i.e. it has a registered
  // child token) but the caller is presenting the old token, that indicates
  // either a replay attack or a leaked token. Revoke the entire chain — all
  // refresh tokens and any access tokens minted through it — and reject.
  const child = await input.store.getRefreshChainChild(refreshToken);
  if (child !== undefined) {
    await input.store.revokeRefreshChain(refreshToken);
    return json({ error: "invalid_grant" }, 400);
  }

  const record = await input.store.findRefreshToken(refreshToken);
  if (!record || record.expiresAt < Date.now()) {
    if (record) await input.store.deleteToken(refreshToken);
    return json({ error: "invalid_grant" }, 400);
  }
  // Defense in depth on the refresh path: even when the token row survived a
  // partial cascade delete (e.g. a `revokeRefreshChain` that physically
  // removed some but not all chain rows), reject any token whose resolved
  // refresh-chain root has been recorded revoked. A freshly issued or rotated
  // valid token's root is never in `revoked_refresh_roots`, so this never
  // rejects a legitimate grant.
  if (await input.store.isRefreshRootRevoked(refreshToken)) {
    await input.store.deleteToken(refreshToken);
    return json({ error: "invalid_grant" }, 400);
  }
  if (!await tokenScopesRemainGranted({ store: input.store, record })) {
    await input.store.deleteToken(refreshToken);
    return json({ error: "invalid_grant" }, 400);
  }
  const credentials = oidcTokenClientCredentials(input.request, input.params);
  if (credentials.clientId && credentials.clientId !== record.clientId) {
    return json({ error: "invalid_grant" }, 400);
  }
  const client = await resolveOidcClient({
    clientId: record.clientId,
    clients: input.clients,
    store: input.store,
  });
  if (input.clients.size > 0 && !client) {
    return json({ error: "invalid_grant" }, 400);
  }
  if (
    client && !(await validateOidcClientSecret(client, credentials.secret))
  ) {
    return json({ error: "invalid_client" }, 401);
  }

  // Rotate: mint a brand-new refresh token, invalidate the old one, and
  // remember the parent/child link so a future presentation of the old token
  // is treated as reuse.
  const newRefreshToken = generateRefreshToken();

  // G6 fix: claim the rotation ATOMICALLY before minting anything. The
  // chain-link insert is conflict-detecting on the parent (old) token:
  // it returns true only when this request inserted the link. The
  // sequential reuse check above (getRefreshChainChild) closes the
  // post-rotation replay window, but it is a read-then-write that two
  // concurrent presentations of the SAME valid refresh token can both
  // pass (both see child === undefined). Without an atomic claim both
  // would mint independent child families (double-spend). Performing the
  // link insert first turns the parent token into a single-winner claim:
  // the loser gets `false` and is treated as reuse — revoke the chain and
  // reject — rather than minting a second family.
  const linked = await input.store.addRefreshChainLink(
    refreshToken,
    newRefreshToken,
  );
  if (!linked) {
    await input.store.revokeRefreshChain(refreshToken);
    return json({ error: "invalid_grant" }, 400);
  }

  await input.store.saveRefreshToken(newRefreshToken, {
    clientId: record.clientId,
    scope: record.scope,
    subject: record.subject,
   takosumiSubject: record.takosumiSubject,
    installationId: record.installationId,
    appId: record.appId,
    spaceId: record.spaceId,
    role: record.role,
    expiresAt: Date.now() + REFRESH_TOKEN_TTL_MS,
  });
  await input.store.deleteToken(refreshToken);

  return await issueTokenResponse({
    issuer: input.issuer,
    store: input.store,
    flow: input.flow,
    clientId: record.clientId,
    scope: record.scope,
    subject: record.subject,
   takosumiSubject: record.takosumiSubject,
    installationId: record.installationId,
    appId: record.appId,
    spaceId: record.spaceId,
    role: record.role,
    refreshToken: newRefreshToken,
    chainRefreshToken: newRefreshToken,
  });
}

async function cascadeRevokeAuthorizationCode(
  code: string,
  store: AccountsStore,
): Promise<void> {
  // The store-side cascade deletes every access token issued from this
  // code AND every refresh chain rooted by it (including all rotations
  // and the access tokens those rotations minted). No further work is
  // required on the route layer.
  await store.revokeTokensIssuedFromCode(code);
}

async function issueTokenResponse(input: {
  issuer: string;
  store: AccountsStore;
  flow: OidcAuthorizationCodeFlow;
  clientId: string;
  scope: string;
  subject: string;
 takosumiSubject?: TakosumiSubject;
  installationId?: string;
  appId?: string;
  spaceId?: string;
  role?: string;
  nonce?: string;
  refreshToken?: string;
  /** New or rotated refresh token whose chain root tracks issued access tokens. */
  chainRefreshToken?: string;
  /** Authorization code that produced this access token, for reuse cascade. */
  authorizationCode?: string;
}): Promise<Response> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresIn = ACCESS_TOKEN_TTL_SECONDS;
  const account = input.takosumiSubject
    ? await input.store.findAccount(input.takosumiSubject)
    : undefined;
  const takosumiClaims = input.installationId
    ? {
      installation_id: input.installationId,
      ...(input.appId ? { app_id: input.appId } : {}),
      ...(input.spaceId ? { space_id: input.spaceId } : {}),
      ...(input.role ? { role: input.role } : {}),
    }
    : undefined;
  // email_verified reflects the upstream identity provider's assertion,
  // carried onto the account record by `resolveUpstreamAccount`. When the
  // value is genuinely unknown (provider omitted it, or the store has not
  // persisted it yet) we default to false rather than silently asserting
  // verification.
  const emailVerified = readAccountEmailVerified(account);
  const idToken = await input.flow.issueIdToken({
    iss: input.issuer,
    sub: input.subject,
    aud: input.clientId,
    ...(account?.email
      ? { email: account.email, email_verified: emailVerified }
      : {}),
    ...(account?.displayName ? { name: account.displayName } : {}),
    ...(takosumiClaims ? { takosumi: takosumiClaims } : {}),
    ...(input.nonce ? { nonce: input.nonce } : {}),
    iat: issuedAt,
    exp: issuedAt + expiresIn,
  });
  const accessToken = generateAccessToken();
  await input.store.saveAccessToken(accessToken, {
    clientId: input.clientId,
    scope: input.scope,
    subject: input.subject,
   takosumiSubject: input.takosumiSubject,
    installationId: input.installationId,
    appId: input.appId,
    spaceId: input.spaceId,
    role: input.role,
    expiresAt: (issuedAt + expiresIn) * 1000,
  });
  if (input.chainRefreshToken) {
    await input.store.linkAccessTokenToRefreshChain(
      input.chainRefreshToken,
      accessToken,
    );
  }
  if (input.authorizationCode) {
    await input.store.linkAccessTokenToAuthCode(
      input.authorizationCode,
      accessToken,
      input.refreshToken,
    );
  }
  const body: Record<string, unknown> = {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: expiresIn,
    scope: input.scope,
    id_token: idToken,
  };
  if (input.refreshToken) {
    body.refresh_token = input.refreshToken;
  }

  return json(body);
}

function readAccountEmailVerified(
  account: TakosumiAccountRecord | undefined,
): boolean {
  // `emailVerified` is set from the upstream IdP's `email_verified` claim in
  // `resolveUpstreamAccount` (carried via `AccountProfileInput.emailVerified`)
  // and is now persisted end to end (Postgres `accounts.email_verified`,
  // D1/in-memory document), so the re-read at token issuance preserves it. We
  // only emit `email_verified: true` when the upstream provider actually
  // asserted it, and default to false when genuinely unknown.
  return account?.emailVerified === true;
}

export async function handleUserInfo(input: {
  request: Request;
  store: AccountsStore;
  /**
   * Optional expected audience for the access token. When provided, the
   * access token's recorded clientId must match. When not provided, the
   * UserInfo endpoint accepts any audience the access token already binds
   * to — RFC 7662 §2.2 leaves audience enforcement to the issuer. Callers
   * that need strict per-client audience enforcement should pass
   * expectedAudience to confine the response to a single client surface.
   */
  expectedAudience?: string;
}): Promise<Response> {
  const accessToken = bearerToken(input.request.headers.get("authorization"));
  if (!accessToken) return bearerChallenge("invalid_token");

  const record = await input.store.findAccessToken(accessToken);
  if (record?.expiresAt !== undefined && record.expiresAt < Date.now()) {
    await input.store.deleteToken(accessToken);
    return bearerChallenge("invalid_token");
  }
  if (record) {
    if (!await tokenScopesRemainGranted({ store: input.store, record })) {
      await input.store.deleteToken(accessToken);
      return bearerChallenge("invalid_token");
    }
    // Audience enforcement: the access token records the clientId it was
    // issued for. If the caller declared an expected audience, reject any
    // access token whose recorded audience does not match.
    if (
      input.expectedAudience !== undefined &&
      record.clientId !== input.expectedAudience
    ) {
      return bearerChallenge("invalid_token");
    }

    const body: Record<string, unknown> = {
      sub: record.subject,
      aud: record.clientId,
      scope: record.scope,
    };
    if (record.installationId) {
      body.takosumi = {
        installation_id: record.installationId,
        ...(record.appId ? { app_id: record.appId } : {}),
        ...(record.spaceId ? { space_id: record.spaceId } : {}),
        ...(record.role ? { role: record.role } : {}),
      };
      // Emit a flat `space_memberships` claim that bundled apps
      // (takos-docs / takos-slide / takos-excel) read directly for their
      // membership checks. The token record binds a single accessible
      // space, so the claim is a one-element array derived from it. Apps
      // keep reading the nested `takosumi.space_id` as a fallback.
      if (record.spaceId) {
        body.space_memberships = [record.spaceId];
      }
    }
    return json(body);
  }

  const patRecord = await input.store.findPersonalAccessToken(accessToken);
  if (!patRecord || !personalAccessTokenIsActive(patRecord, Date.now())) {
    return bearerChallenge("invalid_token");
  }
  await input.store.recordPersonalAccessTokenUsed(
    patRecord.tokenId,
    Date.now(),
  );
  return json({
    sub: patRecord.subject,
    scope: patRecord.scopes.join(" "),
  });
}

export async function handleRevoke(input: {
  request: Request;
  store: AccountsStore;
  /**
   * Static OIDC client registrations. Required for RFC 7009 §2.1 client
   * authentication on the revoke endpoint. When omitted, the handler runs
   * in transitional degraded mode (see authenticateOidcClient): anonymous
   * revoke is accepted only when neither static nor dynamic clients exist.
   * Wiring `clients` from the host accounts handler is the Agent 7
   * follow-up that engages strict spec compliance for confidential clients.
   */
  clients?: ReadonlyMap<string, OidcClientRegistration>;
}): Promise<Response> {
  const params = new URLSearchParams(await input.request.text());
  const clientsSupplied = input.clients !== undefined;
  const clients = input.clients ?? new Map<string, OidcClientRegistration>();
  // RFC 7009 §2.1: the authorization server MUST require client
  // authentication for confidential clients and MUST authenticate clients
  // that issued access/refresh tokens. We honor that universally for the
  // reference implementation.
  const credentials = oidcTokenClientCredentials(input.request, params);
  const auth = await authenticateOidcClient({
    clientId: credentials.clientId,
    secret: credentials.secret,
    clients,
    store: input.store,
    clientsSupplied,
  });
  if (!auth.ok) {
    return json({ error: auth.error }, auth.status);
  }
  const token = params.get("token");
  if (!token) {
    return new Response(null, { status: 200 });
  }
  const authenticatedClientId = auth.client?.clientId;
  // Only revoke tokens that were issued for the authenticated client. This
  // protects against a malicious client revoking another client's tokens.
  // In degraded mode (no static clients wired) the caller is unauthenticated
  // and we fall back to delete-by-token behavior.
  const accessRecord = await input.store.findAccessToken(token);
  if (accessRecord) {
    if (
      authenticatedClientId !== undefined &&
      accessRecord.clientId !== authenticatedClientId
    ) {
      // RFC 7009 §2.2 allows the server to return 200 for unknown tokens or
      // tokens owned by another client to avoid leaking information.
      return new Response(null, { status: 200 });
    }
    await input.store.deleteToken(token);
    return new Response(null, { status: 200 });
  }
  const refreshRecord = await input.store.findRefreshToken(token);
  if (refreshRecord) {
    if (
      authenticatedClientId !== undefined &&
      refreshRecord.clientId !== authenticatedClientId
    ) {
      return new Response(null, { status: 200 });
    }
    await input.store.deleteToken(token);
    return new Response(null, { status: 200 });
  }
  const patRecord = await input.store.findPersonalAccessToken(token);
  if (patRecord) {
    // Personal access tokens are not OIDC-client-scoped; only the owning
    // subject can revoke them through the PAT endpoint. The OIDC /revoke
    // endpoint must not be a back door, so refuse to revoke PATs here.
    return new Response(null, { status: 200 });
  }
  return new Response(null, { status: 200 });
}

export async function handleIntrospect(input: {
  issuer: string;
  request: Request;
  store: AccountsStore;
  /**
   * Static OIDC client registrations. Required for RFC 7662 §2.1 client
   * authentication on the introspect endpoint. When omitted, the handler
   * runs in transitional degraded mode (see authenticateOidcClient):
   * anonymous introspect is accepted only when neither static nor dynamic
   * clients exist. Wiring `clients` from the host accounts handler is the
   * Agent 7 follow-up that engages strict spec compliance.
   */
  clients?: ReadonlyMap<string, OidcClientRegistration>;
}): Promise<Response> {
  const params = new URLSearchParams(await input.request.text());
  // RFC 7662 §2.1: the introspection endpoint MUST require client
  // authentication for any introspection request. Reject unauthenticated
  // calls with 401 invalid_client.
  const clientsSupplied = input.clients !== undefined;
  const clients = input.clients ?? new Map<string, OidcClientRegistration>();
  const credentials = oidcTokenClientCredentials(input.request, params);
  const auth = await authenticateOidcClient({
    clientId: credentials.clientId,
    secret: credentials.secret,
    clients,
    store: input.store,
    clientsSupplied,
  });
  if (!auth.ok) {
    // RFC 7662 §2.2 allows responding with `{ active: false }` when the
    // request fails authentication so that introspection cannot be used as
    // a token-existence oracle. We still set 401 because the caller did not
    // authenticate. PAT tokens are out of scope of OIDC client auth — they
    // are introspected through dedicated PAT routes — so an unauthenticated
    // OIDC client cannot use this endpoint at all.
    return json({ error: auth.error }, auth.status);
  }
  const token = params.get("token");
  if (!token) return json({ active: false });
  const authenticatedClientId = auth.client?.clientId;

  const accessRecord = await input.store.findAccessToken(token);
  if (accessRecord) {
    if (
      !await tokenScopesRemainGranted({
        store: input.store,
        record: accessRecord,
      })
    ) {
      await input.store.deleteToken(token);
      return json({ active: false });
    }
    // Only reveal token contents to the client that owns the token. In
    // degraded mode (no static clients wired) the delete-by-token behavior is kept.
    if (
      authenticatedClientId !== undefined &&
      accessRecord.clientId !== authenticatedClientId
    ) {
      return json({ active: false });
    }
    return json(introspectionBody(accessRecord));
  }
  const refreshRecord = await input.store.findRefreshToken(token);
  if (refreshRecord) {
    if (
      !await tokenScopesRemainGranted({
        store: input.store,
        record: refreshRecord,
      })
    ) {
      await input.store.deleteToken(token);
      return json({ active: false });
    }
    if (
      authenticatedClientId !== undefined &&
      refreshRecord.clientId !== authenticatedClientId
    ) {
      return json({ active: false });
    }
    return json(introspectionBody(refreshRecord));
  }
  const patRecord = await input.store.findPersonalAccessToken(token);
  if (patRecord) {
    if (!personalAccessTokenIsActive(patRecord, Date.now())) {
      return json({ active: false });
    }
    await input.store.recordPersonalAccessTokenUsed(
      patRecord.tokenId,
      Date.now(),
    );
    return json(personalAccessTokenIntrospectionBody(patRecord, input.issuer));
  }
  return json({ active: false });
}

export async function tokenScopesRemainGranted(input: {
  store: AccountsStore;
  record: Pick<TokenRecord, "installationId" | "scope">;
}): Promise<boolean> {
  if (!input.record.installationId) return true;
  const requiredCapabilities = tokenAppGrantCapabilities(input.record.scope);
  if (requiredCapabilities.length === 0) return true;

  const grants = await input.store.listAppGrantsForInstallation(
    input.record.installationId,
  );
  const activeCapabilities = new Set(
    grants
      .filter((grant) => !grant.revokedAt)
      .map((grant) => grant.capability),
  );
  return requiredCapabilities.every((capability) =>
    activeCapabilities.has(capability)
  );
}

function tokenAppGrantCapabilities(
  scope: string,
): readonly AppGrantCapability[] {
  return scope
    .split(/\s+/)
    .filter((value) => value.length > 0)
    .filter(isAppGrantCapability);
}

export function includesScope(scope: string, required: string): boolean {
  return scope.split(/\s+/).includes(required);
}

async function isPkceVerifierValid(
  record: AuthorizationCodeRecord,
  verifier: string | null,
): Promise<boolean> {
  if (!record.codeChallenge) return false;
  if (!verifier) return false;
  // Only S256 is supported. Plain (and any other method) is rejected
  // explicitly as defense-in-depth even if a migrated record still
  // carries it.
  if (record.codeChallengeMethod !== "S256") return false;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return constantTimeEqual(
    base64UrlEncodeBytes(new Uint8Array(digest)),
    record.codeChallenge,
  );
}

function introspectionBody(
  record: TokenRecord,
): Record<string, unknown> {
  if (record.expiresAt < Date.now()) {
    return { active: false };
  }
  return {
    active: true,
    client_id: record.clientId,
    sub: record.subject,
    scope: record.scope,
    ...(record.installationId
      ? {
       takosumi: {
          installation_id: record.installationId,
          ...(record.appId ? { app_id: record.appId } : {}),
          ...(record.spaceId ? { space_id: record.spaceId } : {}),
          ...(record.role ? { role: record.role } : {}),
        },
      }
      : {}),
    exp: Math.floor(record.expiresAt / 1000),
  };
}
