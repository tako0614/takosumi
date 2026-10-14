import {
  TAKOSUMI_ACCOUNTS_CAPSULE_OAUTH_SCOPES,
  type TakosumiSubject,
} from "@takosjp/takosumi-accounts-contract";
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
  readFormUrlEncoded,
  takosumiSubjectValue,
  withOAuthNoStoreHeaders,
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
import type { SharedHostedSessionContext } from "./shared-account-workspace.ts";
import { requireAccountSession } from "./account-session.ts";
import { HOSTED_CODE_TTL_MS, HOSTED_TOKEN_TTL_SECONDS, HOSTED_REFRESH_IDLE_MS, HOSTED_REFRESH_ABSOLUTE_MS, HOSTED_OIDC_SCOPES, hostedGrantIsActive, hostedIssuerSessionId, hostedOpaqueId } from "./hosted-oidc-profile.ts";
import { findActiveAccessToken } from "./access-token-activity.ts";
import type { InterfaceOAuthActivityValidator } from "./access-token-activity.ts";
import type {
  ControlPlaneOperations,
  ControlWorkspaceRole,
} from "./control-operations.ts";

type ResolveControlPlaneOperations = () => Promise<
  ControlPlaneOperations | undefined
>;

async function operationsForLiveGrant(input: {
  readonly operations: ControlPlaneOperations | undefined;
  readonly resolveOperations: ResolveControlPlaneOperations | undefined;
  readonly required: boolean;
}): Promise<ControlPlaneOperations | undefined> {
  if (!input.required || input.operations) return input.operations;
  return await input.resolveOperations?.();
}
import {
  validateOidcLiveGrant,
  type OidcLiveGrantFailureReason,
} from "./oidc-live-grant.ts";
import {
  accountMatchesLoginAllowlist,
  type LoginEmailAllowlist,
} from "./login-email-allowlist.ts";

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
  profile?: "shared-account";
  enabled?: boolean;
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
    if (staticClient.profile === "shared-account") {
      if (staticClient.enabled !== true) {
        await input.store.revokeHostedOidcClientGrants?.(staticClient.clientId,Date.now());
        return undefined;
      }
      if (!input.store.isHostedOidcClientRevoked || await input.store.isHostedOidcClientRevoked(staticClient.clientId)) return undefined;
    }
    return {
      clientId: staticClient.clientId,
      profile: staticClient.profile,
      enabled: staticClient.enabled,
      clientSecretHash: staticClient.clientSecretHash,
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
): { clientId?: string; secret?: string; method: "basic" | "post" | "conflicting" } {
  const basic = basicClientCredentials(request.headers.get("authorization"));
  if (basic) return {...basic, method: params.has("client_secret") ? "conflicting" : "basic"};
  return {
    method: "post",
    clientId: params.get("client_id") ?? undefined,
    secret: params.get("client_secret") ?? undefined,
  };
}

type OidcTokenDenialStage =
  | "authorization_code_missing"
  | "authorization_code_reused"
  | "authorization_code_unknown_or_expired"
  | "client_id_mismatch"
  | "client_registration_missing"
  | "client_authentication_failed"
  | "redirect_uri_mismatch"
  | "pkce_verification_failed"
  | `live_grant_${OidcLiveGrantFailureReason}`;

function oidcTokenDenial(
  stage: OidcTokenDenialStage,
  error: "invalid_client" | "invalid_grant",
  status: 400 | 401 = 400,
): Response {
  // OAuth responses deliberately stay coarse so callers cannot probe code or
  // client validity. The server log contains only a closed reason label: no
  // code, client id, redirect URI, subject, or credential is emitted.
  console.warn(JSON.stringify({ event: "oidc_token_denied", stage }));
  return json({ error }, status);
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
  method?: "basic" | "post" | "conflicting",
): Promise<boolean> {
  if (client.profile === "shared-account" && (client.enabled !== true || method !== "basic")) return false;
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
  method?: "basic" | "post" | "conflicting";
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
  if (!(await validateOidcClientSecret(client, input.secret, input.method))) {
    return { ok: false, error: "invalid_client", status: 401 };
  }
  return { ok: true, client };
}

async function resolveOidcAuthorizationSubject(input: {
  client: ResolvedOidcClient | undefined;
  flow: OidcAuthorizationCodeFlow;
  sessionSubject: TakosumiSubject;
  scope: string;
  requestedWorkspaceId?: string;
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
  if (!input.client) {
    return {
      ok: false,
      status: 400,
      error: "unauthorized_client",
      errorDescription: "OIDC client registration was not found",
    };
  }
  if (input.client.profile === "shared-account") {
    if (input.client.enabled !== true || input.requestedWorkspaceId !== undefined || !scopeIsAllowed(input.scope, HOSTED_OIDC_SCOPES)) {
      return {ok:false, status:400, error:"unauthorized_client", errorDescription:"shared-account identity-only policy denied"};
    }
    const account = input.store.findCanonicalAccount ? await input.store.findCanonicalAccount(input.sessionSubject) : await input.store.findAccount(input.sessionSubject);
    if (!account || account.subject !== input.sessionSubject || (await input.store.isAccountAuthenticationFenced?.(account.subject))) {
      return {ok:false, status:403, error:"access_denied", errorDescription:"account login is unavailable"};
    }
    return {ok:true, record:{subject: account.subject, takosumiSubject:account.subject}};
  }
  const liveGrant = await validateOidcLiveGrant({
    store: input.store,
    operations: input.operations,
    client: input.client,
    scope: input.scope,
    takosumiSubject: input.sessionSubject,
    capsuleId: input.client.capsuleId,
    workspaceId: input.requestedWorkspaceId,
  });
  if (!liveGrant.ok) {
    return oidcAuthorizationGrantFailure(liveGrant.reason);
  }
  if (!liveGrant.capsuleId) {
    return {
      ok: true,
      record: {
        subject: input.sessionSubject,
        takosumiSubject: input.sessionSubject,
        ...(liveGrant.workspaceId
          ? { workspaceId: liveGrant.workspaceId }
          : {}),
        ...(liveGrant.role ? { role: liveGrant.role } : {}),
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
  const pairwiseSubject = await derivePairwiseSubject({
    secret: input.flow.pairwiseSubjectSecret,
    takosumiSubject: input.sessionSubject,
    clientId: `${liveGrant.capsuleName ?? liveGrant.capsuleId}:${
      liveGrant.capsuleId
    }:${input.client.clientId}`,
  });
  try {
    const capsule = await input.operations.capsules.getCapsule(
      liveGrant.capsuleId,
    );
    const installConfig = await input.operations.capsules.getInstallConfig(
      capsule.installConfigId,
    );
    if ((installConfig.requiredInterfaces?.length ?? 0) > 0) {
      const ensureRequiredInterfaces =
        input.operations.interfaces?.ensureCapsuleRequiredInterfaces;
      if (!ensureRequiredInterfaces) {
        return {
          ok: false,
          status: 503,
          error: "temporarily_unavailable",
          errorDescription:
            "Capsule required Interface authorization is unavailable",
        };
      }
      await ensureRequiredInterfaces.call(input.operations.interfaces, {
        workspaceId: liveGrant.workspaceId!,
        capsuleId: liveGrant.capsuleId,
        principalId: pairwiseSubject,
        requirements: installConfig.requiredInterfaces!,
      });
    }
  } catch {
    return {
      ok: false,
      status: 503,
      error: "temporarily_unavailable",
      errorDescription:
        "Capsule required Interface authorization could not be established",
    };
  }
  return {
    ok: true,
    record: {
      subject: pairwiseSubject,
      takosumiSubject: input.sessionSubject,
      capsuleId: liveGrant.capsuleId,
      workspaceId: liveGrant.workspaceId,
      role: liveGrant.role,
    },
  };
}

function oidcAuthorizationGrantFailure(reason: OidcLiveGrantFailureReason): {
  ok: false;
  status: number;
  error: string;
  errorDescription: string;
} {
  if (reason === "workspace_membership_inactive") {
    return {
      ok: false,
      status: 403,
      error: "access_denied",
      errorDescription: "the account cannot access this Capsule Workspace",
    };
  }
  if (reason === "scope_not_granted") {
    return {
      ok: false,
      status: 400,
      error: "invalid_scope",
      errorDescription: "requested scope is outside the current Capsule grant",
    };
  }
  return {
    ok: false,
    status: 400,
    error: "unauthorized_client",
    errorDescription: "OIDC client Capsule grant is not active",
  };
}

export function scopeIsAllowed(
  requestedScope: string,
  allowedScopes: readonly string[],
): boolean {
  const allowed = new Set(allowedScopes);
  const requested = requestedScope.trim().split(/\s+/).filter(Boolean);
  return requested.length > 0 && requested.every((scope) => allowed.has(scope));
}

/**
 * Control-plane delegation scopes are never implied by a registration. A client
 * that does not name them in `allowedScopes` has no declared authority over
 * Workspaces, Capsules, or Runs, so an SSO-only registration cannot widen
 * itself into deploy control by editing its own authorize URL. Every other
 * scope — `profile`, `email`, `offline_access`, product scopes — is untouched
 * by this check, and a registration that does declare a delegation scope keeps
 * it.
 */
function undeclaredDelegationScopes(
  requestedScope: string,
  allowedScopes: readonly string[] | undefined,
): string[] {
  const declared = new Set(allowedScopes ?? []);
  const delegation = new Set<string>(TAKOSUMI_ACCOUNTS_CAPSULE_OAUTH_SCOPES);
  return requestedScope
    .trim()
    .split(/\s+/)
    .filter((scope) => delegation.has(scope) && !declared.has(scope));
}

export async function handleAuthorize(input: {
  issuer?: string;
  request: Request;
  url: URL;
  flow: OidcAuthorizationCodeFlow;
  clients: ReadonlyMap<string, OidcClientRegistration>;
  store: AccountsStore;
  operations?: ControlPlaneOperations;
  resolveOperations?: ResolveControlPlaneOperations;
}): Promise<Response> {
  const response = withOAuthNoStoreHeaders(
    await handleAuthorizeUncached(input),
  );
  // Authorize branches on the presented session cookie and fetch destination;
  // no-store is the primary cache guard, while Vary documents those inputs
  // for intermediaries that inspect the response metadata.
  const vary = response.headers.get("vary");
  response.headers.set(
    "vary",
    vary ? `${vary}, Cookie, Sec-Fetch-Dest` : "Cookie, Sec-Fetch-Dest",
  );
  return response;
}

async function handleAuthorizeUncached(input: {
  issuer?: string;
  request: Request;
  url: URL;
  flow: OidcAuthorizationCodeFlow;
  clients: ReadonlyMap<string, OidcClientRegistration>;
  store: AccountsStore;
  operations?: ControlPlaneOperations;
  resolveOperations?: ResolveControlPlaneOperations;
}): Promise<Response> {
  // OAuth authorization is a top-level navigation. A subresource request can
  // carry the account session cookie without any user interaction and follow
  // the code redirect to the registered client (for example via <img>).
  // Non-browser callers omit Sec-Fetch-Dest, so only an explicitly non-document
  // browser destination is rejected.
  const fetchDest = input.request.headers.get("sec-fetch-dest");
  if (fetchDest !== null && fetchDest !== "document") {
    return json(
      {
        error: "invalid_request",
        error_description: "authorize must be a top-level navigation",
      },
      400,
    );
  }
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
  if (client.profile === "shared-account" && client.enabled !== true) return json({error:"unauthorized_client"},400);
  if (client.profile === "shared-account" && input.issuer) {
    // Reverse proxies/workerd transports may use an internal HTTP URL. Public
    // Origin and sign-in redirects are anchored to the configured issuer.
    input.url = new URL(input.url.pathname + input.url.search, input.issuer);
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
  const requestedScope = input.url.searchParams.get("scope") ?? "openid";
  const scope = client.profile === "shared-account" ? [...new Set(requestedScope.trim().split(/\s+/u).filter(Boolean))].join(" ") : requestedScope;
  if (client?.allowedScopes && !scopeIsAllowed(scope, client.allowedScopes)) {
    return json(
      {
        error: "invalid_scope",
        error_description: "requested scope is outside the Capsule grant",
      },
      400,
    );
  }
  // Minting gate only: a code/token already issued under an undeclared
  // delegation scope keeps working, so this cannot break an existing refresh
  // chain. It refuses the scope up front, before any grant is created.
  const undeclaredDelegation = undeclaredDelegationScopes(
    scope,
    client.allowedScopes,
  );
  if (undeclaredDelegation.length > 0) {
    return json(
      {
        error: "invalid_scope",
        error_description:
          "control-plane delegation scope is not declared by this client registration: " +
          undeclaredDelegation.join(" "),
      },
      400,
    );
  }
  if (client.profile === "shared-account") {
    const parameters = input.url.searchParams;
    if (!includesScope(scope,"openid") || !scopeIsAllowed(scope,HOSTED_OIDC_SCOPES)) return json({error:"invalid_scope"},400);
    if (!parameters.get("nonce") || parameters.get("nonce")!.length > 512 || !parameters.get("state") || parameters.get("state")!.length > 512 || requestedScope.length > 2048 || !/^[A-Za-z0-9_-]{43}$/u.test(codeChallenge) || !parameters.has("code_challenge_method") ||
      ["response_mode","request","request_uri","claims","workspace_id","resource","audience"].some((name) => parameters.has(name) && !(name === "response_mode" && parameters.get(name) === "query")) ||
      ["response_type","client_id","redirect_uri","scope","nonce","state","code_challenge","code_challenge_method","prompt","max_age"].some((name) => parameters.getAll(name).length > 1)) return json({error:"invalid_request"},400);
    const prompts = (parameters.get("prompt") ?? "").split(/\s+/u).filter(Boolean);
    if (prompts.some((prompt) => !["none","login","consent"].includes(prompt)) || (prompts.includes("none") && prompts.length > 1)) return json({error:"invalid_request"},400);
    const maxAge = parameters.get("max_age");
    if (maxAge !== null && (!/^\d+$/u.test(maxAge) || !Number.isSafeInteger(Number(maxAge)))) return json({error:"invalid_request"},400);
  } else if (input.request.method !== "GET") return json({error:"invalid_request"},400);
  const session = await requireAccountSession({
    request: input.request,
    store: input.store,
  });
  if (!session.ok) return client.profile === "shared-account" && input.url.searchParams.get("prompt") === "none"
    ? hostedAuthorizeError(redirectUri,input.url.searchParams.get("state"),"login_required") : authorizeSignInRedirect(input.url);
  const sessionRecord = await input.store.findAccountSession(session.sessionId);
  if (client.profile === "shared-account") {
    if (sessionRecord?.policy !== "hosted" || !Number.isSafeInteger(sessionRecord.authTime)) return authorizeSignInRedirect(input.url);
    const prompt = input.url.searchParams.get("prompt") ?? "";
    const maxAge = input.url.searchParams.get("max_age");
    const authAge = Math.floor(Date.now()/1000) - sessionRecord.authTime!;
    // A prompt=login request must observe a newly rotated issuer session. Bind
    // that checkpoint in a short server transaction, never trust a URL flag.
    if (input.request.method === "GET" && (prompt.split(/\s+/u).includes("login") || maxAge === "0")) {
      const proof = input.url.searchParams.get("reauth");
      const proved = proof?.startsWith("hreauth_") ? await input.store.consumeAuthorizationCode(proof) : undefined;
      if (prompt === "none" && !proved) return hostedAuthorizeError(redirectUri,input.url.searchParams.get("state"),"login_required");
      if (!proved || proved.expiresAt <= Date.now() || proved.clientId !== client.clientId || proved.redirectUri !== redirectUri || proved.nonce !== input.url.searchParams.get("nonce") || proved.codeChallenge !== codeChallenge || proved.scope !== scope || proved.issuerSessionId === await hostedIssuerSessionId(session.sessionId) || sessionRecord.createdAt < proved.familyStartedAt! || (!sessionRecord.reauthenticatedAt || sessionRecord.reauthenticatedAt < Math.floor(proved.familyStartedAt!/1000))) {
        const challenge = hostedOpaqueId("hreauth_");
        await input.store.saveAuthorizationCode(challenge,{clientId,redirectUri,scope,subject:session.subject,nonce:input.url.searchParams.get("nonce")!,codeChallenge,issuerSessionId:await hostedIssuerSessionId(session.sessionId),familyStartedAt:Date.now(),expiresAt:Date.now()+300_000});
        const next = new URL(input.url); next.searchParams.set("reauth",challenge);
        return authorizeSignInRedirect(next, true);
      }
    }
    if (input.request.method === "GET" && maxAge !== null && Number(maxAge) > 0 && authAge > Number(maxAge)) {
      if (prompt === "none") return hostedAuthorizeError(redirectUri,input.url.searchParams.get("state"),"login_required");
      return authorizeSignInRedirect(input.url, true);
    }
  }
  const requestedWorkspaceValues = input.url.searchParams.getAll("workspace_id");
  const requestedWorkspaceId =
    requestedWorkspaceValues.length === 0
      ? undefined
      : requestedWorkspaceValues.length === 1
        ? boundedAuthorizeWorkspaceId(requestedWorkspaceValues[0])
        : undefined;
  if (
    requestedWorkspaceValues.length > 0 &&
    requestedWorkspaceId === undefined
  ) {
    return json(
      {
        error: "invalid_request",
        error_description:
          "workspace_id must contain one valid Workspace identifier",
      },
      400,
    );
  }
  const operations = await operationsForLiveGrant({
    operations: input.operations,
    resolveOperations: input.resolveOperations,
    required:
      client.capsuleId !== undefined || requestedWorkspaceId !== undefined,
  });
  const subject = await resolveOidcAuthorizationSubject({
    client,
    flow: input.flow,
    sessionSubject: session.subject,
    scope,
    requestedWorkspaceId,
    store: input.store,
    operations,
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

  const now = Date.now();
  let hostedMetadata: Partial<AuthorizationCodeRecord> = {};
  const code = client.profile === "shared-account" ? hostedOpaqueId("hcode_") : crypto.randomUUID();
  if (client.profile === "shared-account") {
    const issuerSessionId = sessionRecord!.issuerSessionId ?? await hostedIssuerSessionId(session.sessionId);
    const existing = await input.store.findHostedOidcGrantForSession?.({issuerSessionId,clientId,subject:session.subject});
    const alreadyConsented = existing && existing.revokedAt === undefined && existing.absoluteExpiresAt > now && scopeIsAllowed(scope, existing.scope.split(/\s+/u));
    const consentRequired = !alreadyConsented || (input.url.searchParams.get("prompt") ?? "").split(/\s+/u).includes("consent");
    if (consentRequired && input.request.method !== "POST") {
      if (input.url.searchParams.get("prompt") === "none") return hostedAuthorizeError(redirectUri,input.url.searchParams.get("state"),"consent_required");
      const transaction = hostedOpaqueId("hcons_");
      await input.store.saveAuthorizationCode(transaction,{clientId,redirectUri,scope,subject:session.subject,nonce:input.url.searchParams.get("nonce")!,codeChallenge,codeChallengeMethod,issuerSessionId,expiresAt:now+300_000});
      return hostedConsentPage(input.url,transaction,clientId,scope);
    }
    if (input.request.method === "POST") {
      if (input.request.headers.get("origin") !== input.url.origin) return json({error:"invalid_request"},403);
      const form = await readFormUrlEncoded(input.request);
      const transaction = form.get("consent_transaction");
      const consent = transaction?.startsWith("hcons_") ? await input.store.consumeAuthorizationCode(transaction) : undefined;
      if (form.get("approve") !== "yes" || !consent || consent.expiresAt <= now || consent.clientId !== clientId || consent.redirectUri !== redirectUri || consent.scope !== scope || consent.subject !== session.subject || consent.nonce !== input.url.searchParams.get("nonce") || consent.codeChallenge !== codeChallenge || consent.issuerSessionId !== issuerSessionId) return json({error:"invalid_request"},400);
    }
    if (!input.store.saveHostedOidcGrant) return json({error:"temporarily_unavailable"},503);
    const sid = hostedOpaqueId("hsid_");
    const authTime = sessionRecord!.authTime!;
    await input.store.saveHostedOidcGrant({issuer:input.issuer ?? input.url.origin,identityGeneration:sessionRecord!.identityGeneration ?? 0,sid,issuerSessionId,clientId,subject:session.subject,scope,authTime,createdAt:now,absoluteExpiresAt:now+HOSTED_REFRESH_ABSOLUTE_MS,authorizationCodeHash:await sha256Text(`takosumi-hosted-code:${code}`)});
    hostedMetadata = {issuer:input.issuer ?? input.url.origin,identityGeneration:sessionRecord!.identityGeneration ?? 0,oidcProfile:"shared-account",sid,issuerSessionId,authTime,familyStartedAt:now,familyExpiresAt:now+HOSTED_REFRESH_ABSOLUTE_MS};
  }
  await input.store.saveAuthorizationCode(code, {
    ...hostedMetadata,
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
    expiresAt: now + (client.profile === "shared-account" ? HOSTED_CODE_TTL_MS : AUTHORIZATION_CODE_TTL_MS),
  });

  const redirect = new URL(redirectUri);
  redirect.searchParams.set("code", code);
  const state = input.url.searchParams.get("state");
  if (state) redirect.searchParams.set("state", state);
  return Response.redirect(redirect, 302);
}

function boundedAuthorizeWorkspaceId(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 &&
    trimmed.length <= 256 &&
    !/[\u0000-\u001f\u007f]/u.test(trimmed)
    ? trimmed
    : undefined;
}

function authorizeSignInRedirect(authorizeUrl: URL, fresh = false): Response {
  const signInUrl = new URL("/sign-in", authorizeUrl.origin);
  if (fresh) {signInUrl.searchParams.set("prompt", "login"); signInUrl.searchParams.set("max_age", "0");}
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
  operations?: ControlPlaneOperations;
  resolveOperations?: ResolveControlPlaneOperations;
  loginEmailAllowlist?: LoginEmailAllowlist;
}): Promise<Response> {
  return withOAuthNoStoreHeaders(await handleTokenUncached(input));
}

async function handleTokenUncached(input: {
  issuer: string;
  request: Request;
  store: AccountsStore;
  flow: OidcAuthorizationCodeFlow;
  clients: ReadonlyMap<string, OidcClientRegistration>;
  operations?: ControlPlaneOperations;
  resolveOperations?: ResolveControlPlaneOperations;
  loginEmailAllowlist?: LoginEmailAllowlist;
}): Promise<Response> {
  const params = await readFormUrlEncoded(input.request);
  const grantType = params.get("grant_type");
  if (grantType === "refresh_token") {
    return await handleRefreshToken({
      issuer: input.issuer,
      request: input.request,
      params,
      store: input.store,
      flow: input.flow,
      clients: input.clients,
      operations: input.operations,
      resolveOperations: input.resolveOperations,
      loginEmailAllowlist: input.loginEmailAllowlist,
    });
  }
  if (grantType !== "authorization_code") {
    return json({ error: "unsupported_grant_type" }, 400);
  }

  const code = params.get("code");
  if (!code)
    return oidcTokenDenial("authorization_code_missing", "invalid_grant");

  const credentials = oidcTokenClientCredentials(input.request, params);
  const hostedCode = code.startsWith("hcode_");
  let hostedAuthorizationSid: string | undefined;
  if (hostedCode) {
    const clientAuth = await authenticateOidcClient({clientId:credentials.clientId,secret:credentials.secret,method:credentials.method,clients:input.clients,store:input.store,requireConfidential:true});
    if (!clientAuth.ok || clientAuth.client.profile !== "shared-account") return json({error:"invalid_client"},401);
    const grant = await input.store.findHostedOidcGrantForCode?.(await sha256Text(`takosumi-hosted-code:${code}`));
    if (!grant || grant.clientId !== clientAuth.client.clientId) return json({error:"invalid_grant"},400);
    hostedAuthorizationSid = grant.sid;
    if (await input.store.isAuthorizationCodeConsumed(code)) {
      await input.store.revokeHostedOidcGrant?.(grant.sid,Date.now());
      await cascadeRevokeAuthorizationCode(code,input.store);
      return oidcTokenDenial("authorization_code_reused","invalid_grant");
    }
  } else if (await input.store.isAuthorizationCodeConsumed(code)) {
    await cascadeRevokeAuthorizationCode(code, input.store);
    return oidcTokenDenial("authorization_code_reused", "invalid_grant");
  }
  const record = await input.store.consumeAuthorizationCode(code);
  if (!record || record.expiresAt <= Date.now()) {
    // Grant-owned code evidence outlives the short generic code tombstone.
    // Replay still revokes the SID after generic retention has pruned its row.
    if (hostedAuthorizationSid) {
      await input.store.revokeHostedOidcGrant?.(hostedAuthorizationSid,Date.now());
      await cascadeRevokeAuthorizationCode(code,input.store);
    }
    return oidcTokenDenial(
      "authorization_code_unknown_or_expired",
      "invalid_grant",
    );
  }

  if (credentials.clientId !== record.clientId) {
    return oidcTokenDenial("client_id_mismatch", "invalid_grant");
  }
  const client = await resolveOidcClient({
    clientId: record.clientId,
    clients: input.clients,
    store: input.store,
  });
  if (!client) {
    return oidcTokenDenial("client_registration_missing", "invalid_grant");
  }
  if (!(await validateOidcClientSecret(client, credentials.secret, credentials.method))) {
    return oidcTokenDenial(
      "client_authentication_failed",
      "invalid_client",
      401,
    );
  }
  if (params.get("redirect_uri") !== record.redirectUri) {
    return oidcTokenDenial("redirect_uri_mismatch", "invalid_grant");
  }
  if (record.oidcProfile === "shared-account" && (!hostedCode || !record.nonce || !/^[A-Za-z0-9._~-]{43,128}$/u.test(params.get("code_verifier") ?? "") || !(await hostedGrantIsActive({store:input.store,client,record,issuer:input.issuer})))) return json({error:"invalid_grant"},400);
  if (record.oidcProfile !== "shared-account" && client.profile === "shared-account") return json({error:"invalid_grant"},400);
  if (!(await isPkceVerifierValid(record, params.get("code_verifier")))) {
    return oidcTokenDenial("pkce_verification_failed", "invalid_grant");
  }
  const operations = await operationsForLiveGrant({
    operations: input.operations,
    resolveOperations: input.resolveOperations,
    required:
      client.capsuleId !== undefined || record.workspaceId !== undefined,
  });
  const liveGrant = await validateOidcLiveGrant({
    store: input.store,
    operations,
    client,
    scope: record.scope,
    takosumiSubject: record.takosumiSubject,
    capsuleId: record.capsuleId,
    workspaceId: record.workspaceId,
  });
  if (!liveGrant.ok) {
    return oidcTokenDenial(`live_grant_${liveGrant.reason}`, "invalid_grant");
  }

  // Mark this code as consumed and start tracking the tokens issued through
  // it so a reuse attempt can cascade-revoke the descendants.
  await input.store.markAuthorizationCodeConsumed(code);

  const refreshToken = includesScope(record.scope, "offline_access")
    ? (record.oidcProfile === "shared-account" ? hostedOpaqueId("hrt_") : generateRefreshToken())
    : undefined;
  if (refreshToken) {
    await input.store.saveRefreshToken(refreshToken, {
      ...hostedRecordMetadata(record),
      clientId: record.clientId,
      scope: record.scope,
      subject: record.subject,
      takosumiSubject: record.takosumiSubject,
      capsuleId: liveGrant.capsuleId,
      workspaceId: liveGrant.workspaceId,
      role: liveGrant.role,
      expiresAt: record.oidcProfile === "shared-account" ? Math.min(Date.now()+HOSTED_REFRESH_IDLE_MS,record.familyExpiresAt!) : Date.now() + REFRESH_TOKEN_TTL_MS,
    });
    // The refresh token at chain creation is by definition its own
    // root; no parent link is recorded yet. `addRefreshChainLink` is
    // called on subsequent rotations.
  }

  return await issueTokenResponse({
    ...hostedRecordMetadata(record),
    issuer: input.issuer,
    store: input.store,
    flow: input.flow,
    clientId: record.clientId,
    scope: record.scope,
    subject: record.subject,
    takosumiSubject: record.takosumiSubject,
    capsuleId: liveGrant.capsuleId,
    workspaceId: liveGrant.workspaceId,
    role: liveGrant.role,
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
  operations?: ControlPlaneOperations;
  resolveOperations?: ResolveControlPlaneOperations;
  loginEmailAllowlist?: LoginEmailAllowlist;
}): Promise<Response> {
  const refreshToken = input.params.get("refresh_token");
  if (!refreshToken) return json({ error: "invalid_grant" }, 400);

  // Refresh-token reuse detection (RFC 6749 §10.4 / OAuth 2.1 §4.3.1).
  // If a refresh token has already been rotated (i.e. it has a registered
  // child token) but the caller is presenting the old token, that indicates
  // either a replay attack or a leaked token. Revoke the entire chain — all
  // refresh tokens and any access tokens minted through it — and reject.
  const hostedRefresh = refreshToken.startsWith("hrt_");
  const child = hostedRefresh ? undefined : await observeSlowOidcRefreshStage("reuse_check", () =>
    input.store.getRefreshChainChild(refreshToken),
  );
  if (child !== undefined) {
    await input.store.revokeRefreshChain(refreshToken);
    return json({ error: "invalid_grant" }, 400);
  }

  const record = await observeSlowOidcRefreshStage("token_load", () =>
    input.store.findRefreshToken(refreshToken),
  );
  if (!record || (!hostedRefresh && record.expiresAt <= Date.now())) {
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
  if (!client) {
    return json({ error: "invalid_grant" }, 400);
  }
  if (
    !(await observeSlowOidcRefreshStage("client_auth", () =>
      validateOidcClientSecret(client, credentials.secret, credentials.method),
    ))
  ) {
    return json({ error: "invalid_client" }, 401);
  }
  if (record.oidcProfile === "shared-account") {
    if (!hostedRefresh || credentials.clientId !== record.clientId) return json({error:"invalid_grant"},400);
    if (await input.store.getRefreshChainChild(refreshToken) !== undefined) {
      await input.store.revokeHostedOidcGrant?.(record.sid!,Date.now());
      await input.store.revokeRefreshChain(refreshToken);
      return json({error:"invalid_grant"},400);
    }
    if (record.expiresAt <= Date.now() || !record.familyStartedAt || !record.familyExpiresAt || record.familyExpiresAt <= Date.now() || record.familyExpiresAt > record.familyStartedAt+HOSTED_REFRESH_ABSOLUTE_MS || !(await hostedGrantIsActive({store:input.store,client,record,issuer:input.issuer}))) {
      await input.store.revokeHostedOidcGrant?.(record.sid!,Date.now());
      await input.store.revokeRefreshChain(refreshToken);
      return json({error:"invalid_grant"},400);
    }
    const requestedScope = input.params.get("scope");
    if (requestedScope !== null && requestedScope !== record.scope) return json({error:"invalid_scope"},400);
  } else if (hostedRefresh || client.profile === "shared-account") return json({error:"invalid_grant"},400);
  const operations = await operationsForLiveGrant({
    operations: input.operations,
    resolveOperations: input.resolveOperations,
    required:
      client.capsuleId !== undefined || record.workspaceId !== undefined,
  });
  const liveGrant = await observeSlowOidcRefreshStage("live_grant", () =>
    validateOidcLiveGrant({
      store: input.store,
      operations,
      client,
      scope: record.scope,
      takosumiSubject: record.takosumiSubject,
      capsuleId: record.capsuleId,
      workspaceId: record.workspaceId,
    }),
  );
  if (!liveGrant.ok) {
    await input.store.revokeRefreshChain(refreshToken);
    return json({ error: "invalid_grant" }, 400);
  }

  // The deployment login allowlist governs continued authority, not only the
  // initial sign-in: a subject that is no longer allowed must not be able to
  // renew OAuth access indefinitely through refresh-token rotation. The token
  // row is left in place so restoring the address restores the grant; only the
  // renewal is refused. Deployments without an allowlist do no lookup here.
  const refreshSubject = record.takosumiSubject;
  if (input.loginEmailAllowlist && refreshSubject) {
    const account = await observeSlowOidcRefreshStage("login_allowlist", () =>
      input.store.findAccount(refreshSubject),
    );
    if (
      !account ||
      !accountMatchesLoginAllowlist(account, input.loginEmailAllowlist)
    ) {
      return json({ error: "invalid_grant" }, 400);
    }
  }

  // Rotate: mint a brand-new refresh token, invalidate the old one, and
  // remember the parent/child link so a future presentation of the old token
  // is treated as reuse.
  const newRefreshToken = record.oidcProfile === "shared-account" ? hostedOpaqueId("hrt_") : generateRefreshToken();

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
    if (record.oidcProfile === "shared-account") await input.store.revokeHostedOidcGrant?.(record.sid!,Date.now());
    await input.store.revokeRefreshChain(refreshToken);
    return json({ error: "invalid_grant" }, 400);
  }

  await observeSlowOidcRefreshStage("rotation_write", async () => {
    await input.store.saveRefreshToken(newRefreshToken, {
      ...hostedRecordMetadata(record),
      clientId: record.clientId,
      scope: record.scope,
      subject: record.subject,
      takosumiSubject: record.takosumiSubject,
      capsuleId: liveGrant.capsuleId,
      workspaceId: liveGrant.workspaceId,
      role: liveGrant.role,
      expiresAt: record.oidcProfile === "shared-account" ? Math.min(Date.now()+HOSTED_REFRESH_IDLE_MS,record.familyExpiresAt!) : Date.now() + REFRESH_TOKEN_TTL_MS,
    });
    if (record.oidcProfile !== "shared-account") await input.store.deleteToken(refreshToken);
  });

  return await observeSlowOidcRefreshStage("token_issue", () =>
    issueTokenResponse({
      ...hostedRecordMetadata(record),
      issuer: input.issuer,
      store: input.store,
      flow: input.flow,
      clientId: record.clientId,
      scope: record.scope,
      subject: record.subject,
      takosumiSubject: record.takosumiSubject,
      capsuleId: liveGrant.capsuleId,
      workspaceId: liveGrant.workspaceId,
      role: liveGrant.role,
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
  identityGeneration?: number;
  oidcProfile?: "shared-account";
  authTime?: number;
  sid?: string;
  issuerSessionId?: string;
  familyStartedAt?: number;
  familyExpiresAt?: number;
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
  const expiresIn = input.oidcProfile === "shared-account" ? HOSTED_TOKEN_TTL_SECONDS : ACCESS_TOKEN_TTL_SECONDS;
  const account = input.takosumiSubject
    ? await input.store.findAccount(input.takosumiSubject)
    : undefined;
  // The live-grant validator is the authority for both Capsule and
  // Workspace-bound composition tokens. A Workspace-only grant deliberately
  // has no capsule_id, but still needs the verified Workspace and current role
  // projected into the ID token.
  const takosumiClaims =
    input.capsuleId !== undefined || input.workspaceId !== undefined
      ? {
          ...(input.capsuleId ? { capsule_id: input.capsuleId } : {}),
          ...(input.workspaceId ? { workspace_id: input.workspaceId } : {}),
          ...(input.role ? { role: input.role } : {}),
        }
      : undefined;
  // email_verified reflects the upstream identity provider's assertion,
  // carried onto the account record by `resolveUpstreamAccount`. When the
  // value is genuinely unknown (provider omitted it, or the store has not
  // persisted it yet) we default to false rather than silently asserting
  // verification.
  const emailVerified = input.oidcProfile === "shared-account" ? await hostedEmailVerified(input.store,account) : readAccountEmailVerified(account);
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
    ...(input.oidcProfile === "shared-account" ? {auth_time:input.authTime,sid:input.sid} : {}),
    iat: issuedAt,
    exp: issuedAt + expiresIn,
  });
  const accessToken = input.oidcProfile === "shared-account" ? hostedOpaqueId("hat_") : generateAccessToken();
  await input.store.saveAccessToken(accessToken, {
    ...hostedRecordMetadata(input),
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
  if (input.oidcProfile === "shared-account") {
    const grant = await input.store.findHostedOidcGrant?.(input.sid!);
    if (!grant || grant.revokedAt !== undefined || grant.absoluteExpiresAt <= Date.now() || !input.store.isHostedOidcClientRevoked || await input.store.isHostedOidcClientRevoked(input.clientId) || !input.store.getAccountAuthenticationGeneration || (input.identityGeneration ?? 0) !== await input.store.getAccountAuthenticationGeneration(input.takosumiSubject!) || !input.store.isHostedOidcSessionRevoked || await input.store.isHostedOidcSessionRevoked(input.issuerSessionId!) || (input.chainRefreshToken && await input.store.isRefreshRootRevoked(input.chainRefreshToken))) {
      await input.store.deleteToken(accessToken);
      if (input.refreshToken) await input.store.revokeRefreshChain(input.refreshToken);
      return json({error:"invalid_grant"},400);
    }
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
  issuer?: string;
  request: Request;
  store: AccountsStore;
  /** Static OIDC clients supplied by the Accounts composition root. */
  clients: ReadonlyMap<string, OidcClientRegistration>;
  operations?: ControlPlaneOperations;
  resolveOperations?: ResolveControlPlaneOperations;
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
  return withOAuthNoStoreHeaders(await handleUserInfoUncached(input));
}

async function handleUserInfoUncached(input: {
  issuer?: string;
  request: Request;
  store: AccountsStore;
  clients: ReadonlyMap<string, OidcClientRegistration>;
  operations?: ControlPlaneOperations;
  resolveOperations?: ResolveControlPlaneOperations;
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
    const client = await resolveOidcClient({
      clientId: record.clientId,
      clients: input.clients,
      store: input.store,
    });
    if (!client) return bearerChallenge("invalid_token");
    if (!(await hostedGrantIsActive({store:input.store,record,client,issuer:input.issuer}))) return bearerChallenge("invalid_token");
    const operations = await operationsForLiveGrant({
      operations: input.operations,
      resolveOperations: input.resolveOperations,
      required:
        client.capsuleId !== undefined || record.workspaceId !== undefined,
    });
    const liveGrant = await validateOidcLiveGrant({
      store: input.store,
      operations,
      client,
      scope: record.scope,
      takosumiSubject: record.takosumiSubject,
      capsuleId: record.capsuleId,
      workspaceId: record.workspaceId,
    });
    if (!liveGrant.ok) return bearerChallenge("invalid_token");

    // The live-grant validator has already proved this Workspace binding and
    // current membership. Composition clients may be Workspace-bound without
    // belonging to a Capsule, so do not gate the claims on capsuleId.
    if (liveGrant.capsuleId || liveGrant.workspaceId) {
      body.takosumi = {
        ...(liveGrant.capsuleId
          ? { capsule_id: liveGrant.capsuleId }
          : {}),
        ...(liveGrant.workspaceId
          ? { workspace_id: liveGrant.workspaceId }
          : {}),
        ...(liveGrant.role ? { role: liveGrant.role } : {}),
      };
      // Emit a flat `workspace_memberships` claim that installable apps, including
      // Installed Capsule surfaces read directly for their
      // membership checks. The token record binds a single accessible
      // Workspace, so the claim is a one-element array derived from it.
      if (liveGrant.workspaceId) {
        body.workspace_memberships = [liveGrant.workspaceId];
      }
    }
    const account = record.takosumiSubject
      ? await input.store.findAccount(record.takosumiSubject)
      : undefined;
    if (includesScope(record.scope, "email")) {
      if (account?.email) body.email = account.email;
      if (account) body.email_verified = record.oidcProfile === "shared-account" ? await hostedEmailVerified(input.store,account) : readAccountEmailVerified(account);
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
  return withOAuthNoStoreHeaders(await handleRevokeUncached(input));
}

async function handleRevokeUncached(input: {
  request: Request;
  store: AccountsStore;
  clients: ReadonlyMap<string, OidcClientRegistration>;
}): Promise<Response> {
  const params = await readFormUrlEncoded(input.request);
  // RFC 7009 §2.1: the authorization server MUST require client
  // authentication for confidential clients and MUST authenticate clients
  // that issued access/refresh tokens. We honor that universally for the
  // reference implementation.
  const credentials = oidcTokenClientCredentials(input.request, params);
  const auth = await authenticateOidcClient({
    clientId: credentials.clientId,
    secret: credentials.secret,
    method: credentials.method,
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
    if (accessRecord.oidcProfile === "shared-account") await input.store.revokeHostedOidcGrant?.(accessRecord.sid!,Date.now());
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
    if (refreshRecord.oidcProfile === "shared-account") {
      await input.store.revokeHostedOidcGrant?.(refreshRecord.sid!,Date.now());
      await input.store.revokeRefreshChain(token);
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
  operations?: ControlPlaneOperations;
  resolveOperations?: ResolveControlPlaneOperations;
}): Promise<Response> {
  return withOAuthNoStoreHeaders(await handleIntrospectUncached(input));
}

async function handleIntrospectUncached(input: {
  issuer: string;
  request: Request;
  store: AccountsStore;
  clients: ReadonlyMap<string, OidcClientRegistration>;
  interfaceOAuthActivityValidator?: InterfaceOAuthActivityValidator;
  operations?: ControlPlaneOperations;
  resolveOperations?: ResolveControlPlaneOperations;
}): Promise<Response> {
  const params = await readFormUrlEncoded(input.request);
  // RFC 7662 §2.1: the introspection endpoint MUST require client
  // authentication for any introspection request. Reject unauthenticated
  // calls with 401 invalid_client.
  const credentials = oidcTokenClientCredentials(input.request, params);
  const auth = await authenticateOidcClient({
    clientId: credentials.clientId,
    secret: credentials.secret,
    method: credentials.method,
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
    if (auth.client.profile === "shared-account" && accessRecord.oidcProfile !== "shared-account") return json({active:false});
    if (!(await hostedGrantIsActive({store:input.store,record:accessRecord,client:auth.client,issuer:input.issuer}))) return json({active:false});
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
    let liveRole: ControlWorkspaceRole | undefined;
    if (!interfaceOAuth) {
      const operations = await operationsForLiveGrant({
        operations: input.operations,
        resolveOperations: input.resolveOperations,
        required:
          auth.client.capsuleId !== undefined ||
          accessRecord.workspaceId !== undefined,
      });
      const liveGrant = await validateOidcLiveGrant({
        store: input.store,
        operations,
        client: auth.client,
        scope: accessRecord.scope,
        takosumiSubject: accessRecord.takosumiSubject,
        capsuleId: accessRecord.capsuleId,
        workspaceId: accessRecord.workspaceId,
      });
      if (!liveGrant.ok) return json({ active: false });
      liveRole = liveGrant.role;
    }
    return json(introspectionBody(accessRecord, "oauth_access", liveRole));
  }
  const refreshRecord = await input.store.findRefreshToken(token);
  if (refreshRecord) {
    if (refreshRecord.clientId !== authenticatedClientId) {
      return json({ active: false });
    }
    if (!(await hostedGrantIsActive({store:input.store,record:refreshRecord,client:auth.client,issuer:input.issuer})) || refreshRecord.expiresAt <= Date.now() || (refreshRecord.oidcProfile === "shared-account" && (await input.store.getRefreshChainChild(token) !== undefined || await input.store.isRefreshRootRevoked(token)))) return json({active:false});
    const operations = await operationsForLiveGrant({
      operations: input.operations,
      resolveOperations: input.resolveOperations,
      required:
        auth.client.capsuleId !== undefined ||
        refreshRecord.workspaceId !== undefined,
    });
    const liveGrant = await validateOidcLiveGrant({
      store: input.store,
      operations,
      client: auth.client,
      scope: refreshRecord.scope,
      takosumiSubject: refreshRecord.takosumiSubject,
      capsuleId: refreshRecord.capsuleId,
      workspaceId: refreshRecord.workspaceId,
    });
    if (!liveGrant.ok) return json({ active: false });
    return json(
      introspectionBody(refreshRecord, "refresh_token", liveGrant.role),
    );
  }
  if (auth.client.profile === "shared-account") return json({active:false});
  const patRecord = await input.store.findPersonalAccessToken(token);
  if (patRecord) {
    if (!personalAccessTokenIsActive(patRecord, Date.now())) {
      return json({ active: false });
    }
    await input.store.recordPersonalAccessTokenUsed(
      patRecord.tokenId,
      Date.now(),
    );
    const operations = await operationsForLiveGrant({
      operations: input.operations,
      resolveOperations: input.resolveOperations,
      required: patRecord.workspaceId !== undefined,
    });
    const liveRole = await introspectionWorkspaceRole(
      operations,
      patRecord.workspaceId,
      patRecord.subject,
    );
    if (patRecord.workspaceId !== undefined && !liveRole) {
      return json({ active: false });
    }
    return json(
      personalAccessTokenIntrospectionBody(patRecord, input.issuer, liveRole),
    );
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
  workspaceRole?: string,
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
      : record.capsuleId || record.workspaceId || workspaceRole
        ? {
            takosumi: {
              ...(record.capsuleId ? { capsule_id: record.capsuleId } : {}),
              ...(record.workspaceId
                ? { workspace_id: record.workspaceId }
                : {}),
              ...((workspaceRole ?? record.role)
                ? { role: workspaceRole ?? record.role }
                : {}),
            },
          }
        : {}),
    exp: Math.floor(record.expiresAt / 1000),
  };
}

async function introspectionWorkspaceRole(
  operations: ControlPlaneOperations | undefined,
  workspaceId: string | undefined,
  subject: string | undefined,
): Promise<string | undefined> {
  if (!operations || !workspaceId || !subject) return undefined;
  try {
    const workspace = await operations.workspaces.getWorkspace(workspaceId);
    if (workspace.ownerUserId === subject) return "owner";
    const member = (await operations.members.listMembers(workspaceId)).find(
      (candidate) =>
        candidate.accountId === subject && candidate.status === "active",
    );
    if (!member) return undefined;
    const recognizedRoles = [
      "owner",
      "admin",
      "member",
      "viewer",
    ] as const satisfies readonly ControlWorkspaceRole[];
    return recognizedRoles.find((role) => member.roles.includes(role));
  } catch {
    return undefined;
  }
}

function hostedAuthorizeError(redirectUri: string,state: string|null,error: string): Response {
  const url = new URL(redirectUri); url.searchParams.set("error",error);
  if (state) url.searchParams.set("state",state);
  return Response.redirect(url,302);
}
function hostedConsentPage(url: URL, transaction: string, clientId: string, scope: string): Response {
  const escape = (value: string) => value.replace(/[&<>"']/gu,(char) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]!));
  return new Response(`<!doctype html><html><head><meta charset="utf-8"><title>Continue sign-in</title></head><body><main><h1>Continue sign-in</h1><p>Allow ${escape(clientId)} to receive your account identity (${escape(scope)})?</p><form method="post" action="${escape(url.pathname+url.search)}"><input type="hidden" name="consent_transaction" value="${escape(transaction)}"><button name="approve" value="yes">Continue</button></form></main></body></html>`,{headers:{"content-type":"text/html; charset=utf-8","cache-control":"no-store","content-security-policy":"default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'","referrer-policy":"no-referrer"}});
}

function hostedRecordMetadata(record: {
  identityGeneration?: number; issuer?: string; oidcProfile?: "shared-account"; authTime?: number; sid?: string; issuerSessionId?: string; nonce?: string; familyStartedAt?: number; familyExpiresAt?: number;
}): Partial<TokenRecord> {
  return record.oidcProfile === "shared-account" ? {identityGeneration:record.identityGeneration,issuer:record.issuer,oidcProfile:record.oidcProfile,authTime:record.authTime,sid:record.sid,issuerSessionId:record.issuerSessionId,nonce:record.nonce,familyStartedAt:record.familyStartedAt,familyExpiresAt:record.familyExpiresAt} : {};
}
async function hostedEmailVerified(store: AccountsStore, account: TakosumiAccountRecord|undefined): Promise<boolean> {
  if (!account?.email || account.emailVerified !== true) return false;
  const proof = await store.findAccountEmailProof?.(account.subject);
  return !!proof && proof.address === account.email && proof.observedAt <= Date.now() && proof.validUntil > Date.now();
}

/** Dedicated shared directory grant: never an account/control bearer promotion. */
export async function resolveSharedAccountGrantSession(input: {
  issuer?: string;
  request: Request;
  store: AccountsStore;
  clients: ReadonlyMap<string, OidcClientRegistration>;
}): Promise<{ok:true;session:SharedHostedSessionContext}|{ok:false;response:Response}> {
  const token = bearerToken(input.request.headers.get("authorization"));
  if (!token) return {ok:false,response:bearerChallenge("invalid_token")};
  const load = async () => {
    const record = await findActiveAccessToken({store:input.store,token});
    if (!record || record.oidcProfile !== "shared-account") return undefined;
    const client = await resolveOidcClient({clientId:record.clientId,clients:input.clients,store:input.store});
    return client?.profile === "shared-account" && await hostedGrantIsActive({store:input.store,client,record,issuer:input.issuer}) ? record : undefined;
  };
  const record = await load();
  if (!record?.takosumiSubject) return {ok:false,response:bearerChallenge("invalid_token")};
  return {ok:true,session:{kind:"shared-hosted-session",canonicalAccountId:record.takosumiSubject,assertCurrentGrant:async()=>{
    const current = await load();
    return current?.subject === record.subject && current.sid === record.sid;
  }}};
}
