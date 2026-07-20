import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";
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
import { requireAccountSession } from "./account-session.ts";
import { findActiveAccessToken } from "./access-token-activity.ts";
import type { InterfaceOAuthActivityValidator } from "./access-token-activity.ts";
import type { ControlPlaneOperations } from "./control-operations.ts";

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

async function observeSlowOidcRefreshStage<T>(
  stage: string,
  operation: () => T | Promise<T>,
): Promise<T> {
  const timer = setTimeout(() => {
    console.warn(
      JSON.stringify({
        event: "oidc_refresh_stage_slow",
        stage,
        thresholdMs: 2_000,
      }),
    );
  }, 2_000);
  try {
    return await operation();
  } finally {
    clearTimeout(timer);
  }
}

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
  capsuleId?: string;
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
      allowedScopes: staticClient.allowedScopes,
      tokenEndpointAuthMethod:
        staticClient.tokenEndpointAuthMethod ??
        (staticClient.clientSecret ? "client_secret_post" : "none"),
      clientSecret: staticClient.clientSecret,
    };
  }
  const dynamicClient = await input.store.findOidcClient(input.clientId);
  if (!dynamicClient) return undefined;
  return {
    clientId: dynamicClient.clientId,
    capsuleId: dynamicClient.capsuleId,
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
  /** Introspection is confidential-client only; revocation also permits public clients. */
  requireConfidential: boolean;
}): Promise<
  | { ok: true; client: ResolvedOidcClient }
  | { ok: false; error: "invalid_client"; status: 401 }
> {
  if (!input.clientId) {
    return { ok: false, error: "invalid_client", status: 401 };
  }
  const client = await resolveOidcClient({
    clientId: input.clientId,
    clients: input.clients,
    store: input.store,
  });
  if (!client) {
    return { ok: false, error: "invalid_client", status: 401 };
  }
  if (input.requireConfidential && client.tokenEndpointAuthMethod === "none") {
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
  sessionSubject: TakosumiSubject;
  store: AccountsStore;
  operations?: ControlPlaneOperations;
}): Promise<
  | {
      ok: true;
      record: {
        subject: string;
        takosumiSubject?: TakosumiSubject;
        capsuleId?: string;
        workspaceId?: string;
        role?: string;
      };
    }
  | { ok: false; status: number; error: string; errorDescription: string }
> {
  if (!input.client?.capsuleId) {
    return {
      ok: true,
      record: {
        subject: input.sessionSubject,
        takosumiSubject: input.sessionSubject,
      },
    };
  }
  if (!input.flow.pairwiseSubjectSecret) {
    return {
      ok: false,
      status: 500,
      error: "server_error",
      errorDescription: "Capsule OIDC clients require pairwiseSubjectSecret",
    };
  }
  if (!input.operations) {
    return {
      ok: false,
      status: 400,
      error: "unauthorized_client",
      errorDescription: "OIDC client Capsule authority is not available",
    };
  }
  let capsule;
  try {
    capsule = await input.operations.capsules.getCapsule(
      input.client.capsuleId,
    );
  } catch {
    return {
      ok: false,
      status: 400,
      error: "unauthorized_client",
      errorDescription: "OIDC client Capsule was not found",
    };
  }
  const member = input.operations.members.getMember
    ? await input.operations.members.getMember(
        capsule.workspaceId,
        input.sessionSubject,
      )
    : (await input.operations.members.listMembers(capsule.workspaceId)).find(
        (candidate) => candidate.accountId === input.sessionSubject,
      );
  if (!member || member.status !== "active") {
    return {
      ok: false,
      status: 403,
      error: "access_denied",
      errorDescription: "the account cannot access this Capsule Workspace",
    };
  }
  const pairwiseSubject = await derivePairwiseSubject({
    secret: input.flow.pairwiseSubjectSecret,
    takosumiSubject: input.sessionSubject,
    clientId: `${capsule.name}:${capsule.id}:${input.client.clientId}`,
  });
  return {
    ok: true,
    record: {
      subject: pairwiseSubject,
      takosumiSubject: input.sessionSubject,
      capsuleId: capsule.id,
      workspaceId: capsule.workspaceId,
      role: preferredWorkspaceRole(member.roles),
    },
  };
}

function preferredWorkspaceRole(roles: readonly string[]): string {
  for (const role of ["owner", "admin", "member", "viewer"] as const) {
    if (roles.includes(role)) return role;
  }
  return "member";
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
  request: Request;
  url: URL;
  flow: OidcAuthorizationCodeFlow;
  clients: ReadonlyMap<string, OidcClientRegistration>;
  store: AccountsStore;
  operations?: ControlPlaneOperations;
}): Promise<Response> {
  const responseType = input.url.searchParams.get("response_type");
  const clientId = input.url.searchParams.get("client_id");
  const redirectUri = input.url.searchParams.get("redirect_uri");
  if (responseType !== "code" || !clientId || !redirectUri) {
    return json(
      {
        error: "invalid_request",
        error_description:
          "response_type=code, client_id, and redirect_uri are required",
      },
      400,
    );
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
    return json(
      {
        error: "invalid_request",
        error_description: "redirect_uri is not registered for this client",
      },
      400,
    );
  }
  // PKCE is mandatory for the authorization-code flow per current OAuth 2.1 /
  // OIDC security profile. Only the S256 transformation is accepted; plain is
  // explicitly forbidden.
  const codeChallenge = input.url.searchParams.get("code_challenge");
  const codeChallengeMethod =
    input.url.searchParams.get("code_challenge_method") ?? "S256";
  if (!codeChallenge) {
    return json(
      {
        error: "invalid_request",
        error_description: "code_challenge is required (PKCE is mandatory)",
      },
      400,
    );
  }
  if (codeChallengeMethod !== "S256") {
    return json(
      {
        error: "invalid_request",
        error_description: "code_challenge_method must be S256",
      },
      400,
    );
  }
  const scope = input.url.searchParams.get("scope") ?? "openid";
  if (client?.allowedScopes && !scopeIsAllowed(scope, client.allowedScopes)) {
    return json(
      {
        error: "invalid_scope",
        error_description: "requested scope is outside the Capsule grant",
      },
      400,
    );
  }
  const session = await requireAccountSession({
    request: input.request,
    store: input.store,
  });
  if (!session.ok) return authorizeSignInRedirect(input.url);
  const subject = await resolveOidcAuthorizationSubject({
    client,
    flow: input.flow,
    sessionSubject: session.subject,
    store: input.store,
    operations: input.operations,
  });
  if (!subject.ok) {
    return json(
      {
        error: subject.error,
        error_description: subject.errorDescription,
      },
      subject.status,
    );
  }

  const code = crypto.randomUUID();
  await input.store.saveAuthorizationCode(code, {
    clientId,
    redirectUri,
    scope,
    subject: subject.record.subject,
    takosumiSubject: subject.record.takosumiSubject,
    capsuleId: subject.record.capsuleId,
    workspaceId: subject.record.workspaceId,
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

function authorizeSignInRedirect(authorizeUrl: URL): Response {
  const signInUrl = new URL("/sign-in", authorizeUrl.origin);
  signInUrl.searchParams.set(
    "return",
    `${authorizeUrl.pathname}${authorizeUrl.search}`,
  );
  return Response.redirect(signInUrl, 302);
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
  if (client && !(await validateOidcClientSecret(client, credentials.secret))) {
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
      capsuleId: record.capsuleId,
      workspaceId: record.workspaceId,
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
    capsuleId: record.capsuleId,
    workspaceId: record.workspaceId,
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
  const child = await observeSlowOidcRefreshStage("reuse_check", () =>
    input.store.getRefreshChainChild(refreshToken),
  );
  if (child !== undefined) {
    await input.store.revokeRefreshChain(refreshToken);
    return json({ error: "invalid_grant" }, 400);
  }

  const record = await observeSlowOidcRefreshStage("token_load", () =>
    input.store.findRefreshToken(refreshToken),
  );
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
  if (
    await observeSlowOidcRefreshStage("revocation_check", () =>
      input.store.isRefreshRootRevoked(refreshToken),
    )
  ) {
    await input.store.deleteToken(refreshToken);
    return json({ error: "invalid_grant" }, 400);
  }
  const credentials = oidcTokenClientCredentials(input.request, input.params);
  if (credentials.clientId && credentials.clientId !== record.clientId) {
    return json({ error: "invalid_grant" }, 400);
  }
  const client = await observeSlowOidcRefreshStage("client_lookup", () =>
    resolveOidcClient({
      clientId: record.clientId,
      clients: input.clients,
      store: input.store,
    }),
  );
  if (input.clients.size > 0 && !client) {
    return json({ error: "invalid_grant" }, 400);
  }
  if (
    client &&
    !(await observeSlowOidcRefreshStage("client_auth", () =>
      validateOidcClientSecret(client, credentials.secret),
    ))
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
  const linked = await observeSlowOidcRefreshStage("rotation_claim", () =>
    input.store.addRefreshChainLink(refreshToken, newRefreshToken),
  );
  if (!linked) {
    await input.store.revokeRefreshChain(refreshToken);
    return json({ error: "invalid_grant" }, 400);
  }

  await observeSlowOidcRefreshStage("rotation_write", async () => {
    await input.store.saveRefreshToken(newRefreshToken, {
      clientId: record.clientId,
      scope: record.scope,
      subject: record.subject,
      takosumiSubject: record.takosumiSubject,
      capsuleId: record.capsuleId,
      workspaceId: record.workspaceId,
      role: record.role,
      expiresAt: Date.now() + REFRESH_TOKEN_TTL_MS,
    });
    await input.store.deleteToken(refreshToken);
  });

  return await observeSlowOidcRefreshStage("token_issue", () =>
    issueTokenResponse({
      issuer: input.issuer,
      store: input.store,
      flow: input.flow,
      clientId: record.clientId,
      scope: record.scope,
      subject: record.subject,
      takosumiSubject: record.takosumiSubject,
      capsuleId: record.capsuleId,
      workspaceId: record.workspaceId,
      role: record.role,
      refreshToken: newRefreshToken,
      chainRefreshToken: newRefreshToken,
    }),
  );
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
  capsuleId?: string;
  workspaceId?: string;
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
  const takosumiClaims = input.capsuleId
    ? {
        capsule_id: input.capsuleId,
        ...(input.workspaceId ? { workspace_id: input.workspaceId } : {}),
        ...(input.role ? { role: input.role } : {}),
      }
    : undefined;
  // email_verified reflects the upstream identity provider's assertion,
  // carried onto the account record by `resolveUpstreamAccount`. When the
  // value is genuinely unknown (provider omitted it, or the store has not
  // persisted it yet) we default to false rather than silently asserting
  // verification.
  const emailVerified = readAccountEmailVerified(account);
  const includesEmailClaims = includesScope(input.scope, "email");
  const includesProfileClaims = includesScope(input.scope, "profile");
  const idToken = await input.flow.issueIdToken({
    iss: input.issuer,
    sub: input.subject,
    aud: input.clientId,
    ...(includesEmailClaims && account?.email
      ? { email: account.email, email_verified: emailVerified }
      : {}),
    ...(includesProfileClaims && account?.displayName
      ? { name: account.displayName }
      : {}),
    ...(includesProfileClaims && account?.picture
      ? { picture: account.picture }
      : {}),
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
    capsuleId: input.capsuleId,
    workspaceId: input.workspaceId,
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
   * access token's recorded audience (or ordinary-token clientId fallback)
   * must match. When not provided, the UserInfo endpoint accepts any audience
   * the access token already binds to — RFC 7662 §2.2 leaves audience
   * enforcement to the issuer. Callers that need strict per-resource audience
   * enforcement should pass expectedAudience.
   */
  expectedAudience?: string;
  interfaceOAuthActivityValidator?: InterfaceOAuthActivityValidator;
}): Promise<Response> {
  const accessToken = bearerToken(input.request.headers.get("authorization"));
  if (!accessToken) return bearerChallenge("invalid_token");

  const record = await findActiveAccessToken({
    store: input.store,
    token: accessToken,
    ...(input.interfaceOAuthActivityValidator
      ? {
          interfaceOAuthActivityValidator:
            input.interfaceOAuthActivityValidator,
        }
      : {}),
  });
  if (record) {
    const audience = record.audience ?? record.clientId;
    // Interface OAuth tokens bind directly to a resolved resource URI;
    // ordinary OAuth tokens retain the OIDC clientId audience fallback.
    if (
      input.expectedAudience !== undefined &&
      audience !== input.expectedAudience
    ) {
      return bearerChallenge("invalid_token");
    }

    const body: Record<string, unknown> = {
      sub: record.subject,
      aud: audience,
      scope: record.scope,
    };
    if (record.role === "interface-runtime") {
      body.token_use = "interface_oauth";
      body.takosumi = {
        workspace_id: record.workspaceId,
        ...(record.capsuleId ? { capsule_id: record.capsuleId } : {}),
        interface_id: record.interfaceId,
        interface_binding_id: record.interfaceBindingId,
        interface_resolved_revision: record.interfaceResolvedRevision,
      };
      return json(body, 200, {
        "cache-control": "no-store",
        pragma: "no-cache",
      });
    }
    if (record.capsuleId) {
      body.takosumi = {
        capsule_id: record.capsuleId,
        ...(record.workspaceId ? { workspace_id: record.workspaceId } : {}),
        ...(record.role ? { role: record.role } : {}),
      };
      // Emit a flat `workspace_memberships` claim that installable apps, including
      // Installed Capsule surfaces read directly for their
      // membership checks. The token record binds a single accessible
      // Workspace, so the claim is a one-element array derived from it.
      if (record.workspaceId) {
        body.workspace_memberships = [record.workspaceId];
      }
    }
    const account = record.takosumiSubject
      ? await input.store.findAccount(record.takosumiSubject)
      : undefined;
    if (includesScope(record.scope, "email")) {
      if (account?.email) body.email = account.email;
      if (account) body.email_verified = readAccountEmailVerified(account);
    }
    if (includesScope(record.scope, "profile")) {
      if (account?.displayName) body.name = account.displayName;
      if (account?.picture) body.picture = account.picture;
    }
    return json(body, 200, {
      "cache-control": "no-store",
      pragma: "no-cache",
    });
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
  /** Static OIDC clients are always supplied by the Accounts composition root. */
  clients: ReadonlyMap<string, OidcClientRegistration>;
}): Promise<Response> {
  const params = new URLSearchParams(await input.request.text());
  // RFC 7009 §2.1: the authorization server MUST require client
  // authentication for confidential clients and MUST authenticate clients
  // that issued access/refresh tokens. We honor that universally for the
  // reference implementation.
  const credentials = oidcTokenClientCredentials(input.request, params);
  const auth = await authenticateOidcClient({
    clientId: credentials.clientId,
    secret: credentials.secret,
    clients: input.clients,
    store: input.store,
    requireConfidential: false,
  });
  if (!auth.ok) {
    return json({ error: auth.error }, auth.status);
  }
  const token = params.get("token");
  if (!token) {
    return new Response(null, { status: 200 });
  }
  const authenticatedClientId = auth.client.clientId;
  // Only revoke tokens that were issued for the authenticated client. This
  // protects against a malicious client revoking another client's tokens.
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
  /** Static OIDC clients are always supplied by the Accounts composition root. */
  clients: ReadonlyMap<string, OidcClientRegistration>;
  interfaceOAuthActivityValidator?: InterfaceOAuthActivityValidator;
}): Promise<Response> {
  const params = new URLSearchParams(await input.request.text());
  // RFC 7662 §2.1: the introspection endpoint MUST require client
  // authentication for any introspection request. Reject unauthenticated
  // calls with 401 invalid_client.
  const credentials = oidcTokenClientCredentials(input.request, params);
  const auth = await authenticateOidcClient({
    clientId: credentials.clientId,
    secret: credentials.secret,
    clients: input.clients,
    store: input.store,
    requireConfidential: true,
  });
  if (!auth.ok) {
    // RFC 7662 §2.2 allows responding with `{ active: false }` when the
    // request fails authentication so that introspection cannot be used as
    // a token-existence oracle. We still set 401 because the caller did not
    // authenticate. OAuth access, Interface OAuth, refresh, and personal
    // access credentials all remain undiscoverable to anonymous callers.
    return json({ error: auth.error }, auth.status);
  }
  const token = params.get("token");
  if (!token) return json({ active: false });
  const authenticatedClientId = auth.client.clientId;
  const requestedResource = params.get("resource");

  const accessRecord = await findActiveAccessToken({
    store: input.store,
    token,
    ...(input.interfaceOAuthActivityValidator
      ? {
          interfaceOAuthActivityValidator:
            input.interfaceOAuthActivityValidator,
        }
      : {}),
  });
  if (accessRecord) {
    const interfaceOAuth = accessRecord.role === "interface-runtime";
    // Ordinary OAuth tokens remain client-owned. Interface invocation tokens
    // are resource-owned: a confidential Accounts client may introspect them
    // only when it supplies the exact resource audience it is serving.
    if (interfaceOAuth) {
      if (
        !requestedResource ||
        !accessRecord.audience ||
        requestedResource !== accessRecord.audience
      ) {
        return json({ active: false });
      }
    } else if (accessRecord.clientId !== authenticatedClientId) {
      return json({ active: false });
    }
    return json(introspectionBody(accessRecord, "oauth_access"));
  }
  const refreshRecord = await input.store.findRefreshToken(token);
  if (refreshRecord) {
    if (refreshRecord.clientId !== authenticatedClientId) {
      return json({ active: false });
    }
    return json(introspectionBody(refreshRecord, "refresh_token"));
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
  ordinaryTokenUse: "oauth_access" | "refresh_token",
): Record<string, unknown> {
  if (record.expiresAt < Date.now()) {
    return { active: false };
  }
  const interfaceOAuth = record.role === "interface-runtime";
  return {
    active: true,
    token_use: interfaceOAuth ? "interface_oauth" : ordinaryTokenUse,
    client_id: record.clientId,
    sub: record.subject,
    aud: record.audience ?? record.clientId,
    scope: record.scope,
    ...(interfaceOAuth
      ? {
          takosumi: {
            workspace_id: record.workspaceId,
            ...(record.capsuleId ? { capsule_id: record.capsuleId } : {}),
            interface_id: record.interfaceId,
            interface_binding_id: record.interfaceBindingId,
            interface_resolved_revision: record.interfaceResolvedRevision,
          },
        }
      : record.capsuleId
        ? {
            takosumi: {
              capsule_id: record.capsuleId,
              ...(record.workspaceId
                ? { workspace_id: record.workspaceId }
                : {}),
              ...(record.role ? { role: record.role } : {}),
            },
          }
        : {}),
    exp: Math.floor(record.expiresAt / 1000),
  };
}
