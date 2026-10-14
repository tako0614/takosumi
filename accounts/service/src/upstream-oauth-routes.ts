import { resolveUpstreamAccount } from "./identity.ts";
import type { AccountsStore, UpstreamLoginTransactionRecord } from "./store.ts";
import { base64UrlEncodeBytes, sha256Text } from "./encoding.ts";
import { assertVerifiedSocialProvider, assertSocialLoginScopes } from "./upstream-verification.ts";
import { validateUpstreamOperationProof, completeUpstreamOperationProof } from "./upstream-operation-proof.ts";
import { validateUpstreamUnlinkProof, completeUpstreamUnlinkProof } from "./upstream-unlink-proof.ts";
import {
  buildUpstreamAuthorizationUrl,
  exchangeUpstreamAuthorizationCode,
  type UpstreamOAuthProvider,
} from "./upstream.ts";
import type {
  PasskeyHttpOptions,
  UpstreamOAuthClientRegistration,
  UpstreamOAuthOptions,
} from "./mod.ts";
import type {
  TakosumiAccountsAuthProvider,
  TakosumiAccountsAuthProvidersResponse,
} from "@takosjp/takosumi-accounts-contract";
import {
  json,
  stringValue,
  withOAuthNoStoreHeaders,
} from "./http-helpers.ts";
import {
  extractAccountSessionId,
  rotateAccountSession,
  serializeAccountSessionCookie,
} from "./account-session.ts";
import {
  type LoginEmailAllowlist,
  loginEmailIsAllowed,
  upstreamLoginNotAllowedResponse,
} from "./login-email-allowlist.ts";

const upstreamOAuthStateCookie = "takosumi_oauth_state";
const hostedUpstreamOAuthStateCookie = "__Host-takosumi_upstream";
const hostedUpstreamTransactionTtlMs = 5 * 60_000;
const upstreamOAuthStateCookieMaxAgeSeconds = 10 * 60;
const publicAuthProviderTokenPattern = /^[a-z][a-z0-9._-]{0,127}$/u;
const passkeyAuthProviderId = "passkey";

export function upstreamOAuthNotConfigured(): Response {
  return json(
    {
      error: "feature_unavailable",
      error_description: "Sign-in is temporarily unavailable.",
    },
    503,
  );
}

/**
 * GET /api/v1/auth/providers — public, unauthenticated read of which sign-in
 * methods the operator actually configured on this worker. The sign-in screen
 * reads this so it only offers methods the backend can honour. Every configured
 * upstream registration is represented by a generic non-secret descriptor;
 * clients must branch on `protocol`, never on provider ids or deployment host.
 * Client ids, secrets, endpoints, scopes, and redirect URIs are never exposed.
 */
export function handleAuthProvidersRequest(input: {
  upstreamOAuth?: UpstreamOAuthOptions;
  passkeys?: PasskeyHttpOptions;
}): Response {
  try {
    const providers = buildPublicAuthProviderDescriptors(input);
    const body: TakosumiAccountsAuthProvidersResponse = { providers };
    return json(body, 200, { "cache-control": "no-store" });
  } catch {
    // This endpoint is public. A malformed in-process registration must not
    // be silently omitted (which can make a broken sign-in deployment look
    // healthy), and its potentially sensitive runtime detail must not be
    // reflected to an unauthenticated caller.
    return authProviderConfigurationInvalidResponse();
  }
}

/** Generic public failure used when host configuration cannot be projected. */
export function authProviderConfigurationInvalidResponse(): Response {
  return json(
    {
      error: "auth_provider_configuration_invalid",
      error_description: "Sign-in provider configuration is invalid.",
    },
    503,
    { "cache-control": "no-store" },
  );
}

function buildPublicAuthProviderDescriptors(input: {
  upstreamOAuth?: UpstreamOAuthOptions;
  passkeys?: PasskeyHttpOptions;
}): readonly TakosumiAccountsAuthProvider[] {
  const providers: TakosumiAccountsAuthProvider[] = [];
  const seen = new Set<string>();
  for (const registration of input.upstreamOAuth?.providers ?? []) {
    if (!registration || typeof registration !== "object") {
      throw new TypeError(
        "upstream auth provider registration must be an object",
      );
    }
    const id = normalizePublicAuthProviderToken(
      registration.providerId,
      "provider id",
    );
    if (id === passkeyAuthProviderId) {
      throw new TypeError("passkey is reserved for the WebAuthn provider");
    }
    if (seen.has(id)) {
      throw new TypeError("auth provider ids must be unique");
    }
    if (!isUsableUpstreamProvider(registration.provider, id)) {
      throw new TypeError("upstream auth provider is not usable");
    }
    const label = normalizePublicAuthProviderLabel(registration.label);
    const protocol = normalizePublicAuthProviderToken(
      registration.protocol ?? "oidc",
      "provider protocol",
    );
    seen.add(id);
    providers.push({ id, enabled: true, label, protocol });
  }
  if (input.passkeys !== undefined) {
    providers.push({
      id: passkeyAuthProviderId,
      enabled: true,
      label: "Passkey",
      protocol: "webauthn",
    });
  }
  return providers;
}

function normalizePublicAuthProviderLabel(value: unknown): string {
  if (value === undefined) return "Single sign-on";
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError("provider label must be a non-empty string");
  }
  return value.trim();
}

function normalizePublicAuthProviderToken(
  value: unknown,
  label: string,
): string {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string`);
  }
  const normalized = value.trim().toLowerCase();
  if (!publicAuthProviderTokenPattern.test(normalized)) {
    throw new TypeError(`${label} must be a lowercase provider token`);
  }
  return normalized;
}

export function handleUpstreamAuthorizeRequest(input: {
  request?: Request;
  store?: AccountsStore;
  url: URL;
  upstreamOAuth: UpstreamOAuthOptions;
  secureCookie: boolean;
}): Response | Promise<Response> {
  if (input.upstreamOAuth.hostedSessionPolicy || resolveUpstreamClient(input.upstreamOAuth, input.url.searchParams.get("provider"))?.provider.verificationProfile) {
    return handleHostedUpstreamAuthorizeRequest(input).then(withOAuthNoStoreHeaders);
  }
  return withOAuthNoStoreHeaders(handleUpstreamAuthorizeRequestUncached(input));
}

async function handleHostedUpstreamAuthorizeRequest(input: {
  request?: Request;
  store?: AccountsStore;
  url: URL;
  upstreamOAuth: UpstreamOAuthOptions;
  secureCookie: boolean;
}): Promise<Response> {
  const resolved = resolveUpstreamClient(input.upstreamOAuth, input.url.searchParams.get("provider"));
  if (!resolved) return json({ error: "unknown_provider" }, 400);
  if (!input.secureCookie || !input.store?.saveUpstreamLoginTransaction || !input.store.consumeUpstreamLoginTransaction) {
    return authProviderConfigurationInvalidResponse();
  }
  if (["provider", "prompt", "max_age", "state", "return_to"].some((key) => input.url.searchParams.getAll(key).length > 1)) {
    return json({ error: "invalid_request" }, 400);
  }
  const prompt = input.url.searchParams.get("prompt");
  const maxAge = input.url.searchParams.get("max_age");
  if ((prompt !== null && prompt !== "login") ||
    (maxAge !== null && (!/^\d{1,8}$/u.test(maxAge) || Number(maxAge) > 7 * 24 * 60 * 60))) {
    return json({ error: "invalid_request" }, 400);
  }
  const freshAuthentication = prompt === "login" || maxAge !== null;
  if (freshAuthentication && resolved.provider.verificationProfile === "github-oauth") {
    // The GitHub account picker cannot attest when credentials were entered.
    return json({ error: "interaction_required", error_description: "Use an issuer credential to prove fresh authentication." }, 400);
  }
  try {
    assertVerifiedSocialProvider(resolved.provider);
    assertSocialLoginScopes(resolved.provider, resolved.client.scopes ?? resolved.provider.defaultScopes);
    const redirect = new URL(resolved.client.redirectUri);
    if (redirect.origin !== input.url.origin || redirect.username || redirect.password || redirect.hash) {
      throw new TypeError("hosted callback must use the issuer origin");
    }
    const requestedReturn = input.url.searchParams.get("return_to");
    let returnTo: string | undefined;
    if (requestedReturn !== null) {
      const target = new URL(requestedReturn, input.url.origin);
      if (target.origin !== input.url.origin || target.pathname !== "/oauth/authorize" || target.username || target.password || target.hash) {
        throw new TypeError("hosted continuation must be an issuer authorization request");
      }
      returnTo = target.pathname + target.search;
    }
    const state = mintUpstreamOAuthServerState();
    const browserBinding = mintUpstreamOAuthServerState();
    const codeVerifier = base64UrlEncodeBytes(crypto.getRandomValues(new Uint8Array(32)));
    const nonce = mintUpstreamOAuthServerState();
    const now = Date.now();
    const transaction: UpstreamLoginTransactionRecord = {
      id: state,
      providerId: resolved.client.providerId,
      browserBindingHash: await sha256Text(browserBinding),
      codeVerifier,
      nonce,
      redirectUri: resolved.client.redirectUri,
      createdAt: now,
      expiresAt: now + hostedUpstreamTransactionTtlMs,
      ...(returnTo ? { returnTo } : {}),
      ...(freshAuthentication ? { prompt: "login" as const, maxAgeSeconds: maxAge === null ? 0 : Number(maxAge) } : {}),
    };
    await input.store.saveUpstreamLoginTransaction(transaction);
    const challenge = (await sha256Text(codeVerifier)).slice("sha256:".length);
    const authorizationUrl = buildUpstreamAuthorizationUrl({
      provider: resolved.provider,
      clientId: resolved.client.clientId,
      redirectUri: resolved.client.redirectUri,
      state,
      scopes: resolved.client.scopes,
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
      nonce: resolved.provider.verificationProfile === "google-oidc" ? nonce : undefined,
      freshAuthentication,
    });
    return new Response(null, {
      status: 302,
      headers: {
        location: authorizationUrl.toString(),
        "set-cookie": serializeHostedUpstreamStateCookie(`${resolved.client.providerId}:${state}:${browserBinding}`),
      },
    });
  } catch {
    return authProviderConfigurationInvalidResponse();
  }
}

function handleUpstreamAuthorizeRequestUncached(input: {
  url: URL;
  upstreamOAuth: UpstreamOAuthOptions;
  secureCookie: boolean;
}): Response {
  const resolved = resolveUpstreamClient(
    input.upstreamOAuth,
    input.url.searchParams.get("provider"),
  );
  if (!resolved) return json({ error: "unknown_provider" }, 400);
  const clientState = input.url.searchParams.get("state");
  if (!clientState) {
    return json(
      {
        error: "invalid_request",
        error_description: "state is required",
      },
      400,
    );
  }
  const state = mintUpstreamOAuthServerState();
  const codeChallenge =
    input.url.searchParams.get("code_challenge") ?? undefined;
  const codeChallengeMethod = input.url.searchParams.get(
    "code_challenge_method",
  );
  if (
    codeChallengeMethod !== null &&
    codeChallengeMethod !== "plain" &&
    codeChallengeMethod !== "S256"
  ) {
    return json({ error: "invalid_request" }, 400);
  }

  const authorizationUrl = buildUpstreamAuthorizationUrl({
    provider: resolved.provider,
    clientId: resolved.client.clientId,
    redirectUri: resolved.client.redirectUri,
    state,
    scopes: resolved.client.scopes,
    codeChallenge,
    codeChallengeMethod: codeChallengeMethod ?? undefined,
  });
  return new Response(null, {
    status: 302,
    headers: {
      location: authorizationUrl.toString(),
      "set-cookie": serializeUpstreamOAuthStateCookie(
        resolved.client.providerId,
        state,
        input.secureCookie,
      ),
    },
  });
}

export async function handleUpstreamCallbackRequest(input: {
  request: Request;
  url: URL;
  store: AccountsStore;
  upstreamOAuth: UpstreamOAuthOptions;
  secureCookie: boolean;
  loginEmailAllowlist?: LoginEmailAllowlist;
}): Promise<Response> {
  return withOAuthNoStoreHeaders(
    await handleUpstreamCallbackRequestUncached(input),
  );
}

async function handleUpstreamCallbackRequestUncached(input: {
  request: Request;
  url: URL;
  store: AccountsStore;
  upstreamOAuth: UpstreamOAuthOptions;
  secureCookie: boolean;
  loginEmailAllowlist?: LoginEmailAllowlist;
}): Promise<Response> {
  const selectedProviderId = input.url.searchParams.get("provider");
  const selectedClient = resolveUpstreamClient(input.upstreamOAuth, selectedProviderId);
  const hostedState = readHostedUpstreamOAuthStateCookie(input.request.headers.get("cookie"));
  const cookieClient = hostedState
    ? resolveUpstreamClient(input.upstreamOAuth, hostedState.providerId)
    : null;
  // The registered callback URI does not need a provider selector. Only the
  // host-only cookie plus its server transaction select a verified provider.
  // Explicit legacy providers retain their existing callback contract.
  const verifiedUpstreamFlow = input.upstreamOAuth.hostedSessionPolicy ||
    selectedClient?.provider.verificationProfile !== undefined ||
    (selectedProviderId === null && cookieClient?.provider.verificationProfile !== undefined);
  const resolved = verifiedUpstreamFlow ? cookieClient : selectedClient;
  if (!resolved) return json({ error: verifiedUpstreamFlow ? "invalid_state" : "unknown_provider" }, 400);
  const code = input.url.searchParams.get("code");
  if (!code) {
    return json(
      {
        error: "invalid_request",
        error_description: "code is required",
      },
      400,
    );
  }
  const state = input.url.searchParams.get("state");
  if (!state) {
    return json(
      {
        error: "invalid_state",
        error_description: "state is required",
      },
      400,
    );
  }
  let codeVerifier: string | undefined;
  let transaction: UpstreamLoginTransactionRecord | undefined;
  if (verifiedUpstreamFlow) {
    const providerSelectors = input.url.searchParams.getAll("provider");
    if (!input.secureCookie || !input.store.consumeUpstreamLoginTransaction ||
      ["code", "state"].some((key) => input.url.searchParams.getAll(key).length !== 1) ||
      !hostedState || hostedState.providerId !== resolved.client.providerId || hostedState.state !== state ||
      providerSelectors.length > 1 || (providerSelectors.length === 1 && providerSelectors[0] !== hostedState.providerId)) {
      return json({ error: "invalid_state" }, 400);
    }
    try {
      transaction = await input.store.consumeUpstreamLoginTransaction(state, await sha256Text(hostedState.browserBinding), Date.now());
      if (!transaction || transaction.id !== state || transaction.providerId !== resolved.client.providerId ||
        transaction.redirectUri !== resolved.client.redirectUri || transaction.expiresAt <= Date.now() ||
        transaction.createdAt > Date.now() || transaction.expiresAt - transaction.createdAt > hostedUpstreamTransactionTtlMs) {
        return json({ error: "invalid_state" }, 400);
      }
      if ((transaction.operationProof || transaction.unlinkProof) &&
        (!input.upstreamOAuth.hostedSessionPolicy || (transaction.operationProof && transaction.unlinkProof))) {
        throw new TypeError("invalid upstream operation context");
      }
      assertVerifiedSocialProvider(resolved.provider);
      assertSocialLoginScopes(resolved.provider, resolved.client.scopes ?? resolved.provider.defaultScopes);
      codeVerifier = transaction.codeVerifier;
    } catch {
      return json({ error: "invalid_state" }, 400);
    }
  } else {
    codeVerifier = input.url.searchParams.get("code_verifier") ?? undefined;
    if (!codeVerifier || !/^[A-Za-z0-9._~-]{43,128}$/u.test(codeVerifier)) {
      return json(
        {
          error: "invalid_request",
          error_description: "code_verifier is required",
        },
        400,
      );
    }
    const cookieState = readUpstreamOAuthStateCookie(
      input.request.headers.get("cookie"),
    );
    if (
      !cookieState ||
      cookieState.providerId !== resolved.client.providerId ||
      cookieState.state !== state
    ) {
      return json(
        {
          error: "invalid_state",
          error_description: "OAuth state cookie does not match callback state",
        },
        400,
      );
    }

  }

  try {
    const previousSessionId = extractAccountSessionId(input.request);
    const exchange = await exchangeUpstreamAuthorizationCode({
      provider: resolved.provider,
      clientId: resolved.client.clientId,
      clientSecret: resolved.client.clientSecret,
      redirectUri: resolved.client.redirectUri,
      code,
      codeVerifier,
      nonce: transaction?.nonce,
      freshSince: transaction?.prompt === "login" ? transaction.createdAt : undefined,
      subjectSecret: input.upstreamOAuth.subjectSecret,
      fetch: input.upstreamOAuth.fetch,
    });
    if (transaction?.operationProof) {
      await validateUpstreamOperationProof({ request: input.request, store: input.store, transaction, exchange, now: Date.now() });
    }
    if (transaction?.unlinkProof) {
      await validateUpstreamUnlinkProof({ request: input.request, store: input.store, transaction, exchange, now: Date.now() });
    }
    const profile = exchange.profile ?? profileFromUpstreamUserInfo(exchange.userInfo);
    if (
      !loginEmailIsAllowed(
        { email: profile.email, emailVerified: profile.emailVerified },
        input.loginEmailAllowlist,
      )
    ) {
      if (previousSessionId?.startsWith("sess_")) {
        await input.store.deleteAccountSession(previousSessionId);
      }
      return upstreamLoginNotAllowedResponse(input.secureCookie);
    }
    const account = await resolveUpstreamAccount({
      store: input.store,
      subjectSecret: input.upstreamOAuth.subjectSecret,
      providerId: exchange.providerId,
      upstreamIssuer: exchange.upstreamIssuer,
      upstreamSubject: exchange.upstreamSubject,
      profile,
      hostedPolicy: input.upstreamOAuth.hostedSessionPolicy,
    });
    const now = Date.now();
    const receipt = transaction?.operationProof
      ? await completeUpstreamOperationProof({ request: input.request, store: input.store, transaction, exchange, now })
      : undefined;
    const unlinkReceipt = transaction?.unlinkProof
      ? await completeUpstreamUnlinkProof({ request: input.request, store: input.store, transaction, exchange, now })
      : undefined;
    const ttlMs = input.upstreamOAuth.sessionTtlMs ?? 30 * 24 * 60 * 60 * 1000;

    // Agent 6 item 6 + 8: rotate-on-login. If the caller already has a
    // session_id cookie (refreshing or re-linking an account in the same
    // browser), revoke it and mint a new id. Do NOT return the session
    // id in the JSON body; the browser's HttpOnly cookie is the only
    // delivery channel.
    const rotated = await rotateAccountSession({
      store: input.store,
      oldSessionId: previousSessionId,
      subject: account.subject,
      now,
      ttlMs,
      hostedPolicy: input.upstreamOAuth.hostedSessionPolicy,
      authenticationTime: exchange.authenticationTime,
      freshlyAuthenticatedAt: exchange.freshlyAuthenticatedAt,
    });

    const sessionCookie = serializeAccountSessionCookie(rotated.sessionId, {
      secure: input.secureCookie,
      maxAgeSeconds: Math.max(1, Math.floor((rotated.expiresAt - now) / 1000)),
      hostedPolicy: input.upstreamOAuth.hostedSessionPolicy,
    });
    // Build a single set-cookie header value that clears the previous state
    // cookie and sets the new session cookie. `Response` headers can hold
    // multiple Set-Cookie entries, but `json()` accepts a flat record;
    // serialize both into one comma-separated value via the Headers API.
    const headers = new Headers({
      "content-type": "application/json; charset=utf-8",
    });
    headers.append(
      "set-cookie",
      verifiedUpstreamFlow
        ? serializeHostedUpstreamStateCookie("", true)
        : clearUpstreamOAuthStateCookie(input.secureCookie),
    );
    headers.append("set-cookie", sessionCookie);
    if (transaction?.returnTo) {
      const target = new URL(transaction.returnTo, input.url.origin);
      if (target.origin !== input.url.origin || target.pathname !== "/oauth/authorize" || target.username || target.password || target.hash) {
        throw new TypeError("invalid hosted continuation");
      }
      headers.set("location", target.pathname + target.search);
      headers.delete("content-type");
      return new Response(null, { status: 302, headers });
    }
    return new Response(
      JSON.stringify({
        subject: account.subject,
        expires_at: rotated.expiresAt,
        provider_id: exchange.providerId,
        ...(receipt ? { proof_receipt: receipt.receiptId, operation_id: receipt.operationId } : {}),
        ...(unlinkReceipt ? { proof_receipt: unlinkReceipt.receiptId, unlink_intent_id: unlinkReceipt.operationId } : {}),
      }),
      { status: 200, headers },
    );
  } catch {
    // Do not reflect the thrown error's message to the (unauthenticated)
    // browser: it can carry upstream token/userinfo endpoint detail, a failed
    // status line, or — for a network failure — an internal host/IP. This
    // matches the Cloudflare credential-OAuth callback (which never surfaces
    // upstream/state failure detail) and the `upstreamOAuthNotConfigured`
    // posture. The typed `upstream_oauth_failed` code is preserved for callers.
    return json(
      {
        error: "upstream_oauth_failed",
        error_description: "Sign-in could not be completed. Please try again.",
      },
      502,
    );
  }
}

function readHostedUpstreamOAuthStateCookie(header: string | null): {
  providerId: string;
  state: string;
  browserBinding: string;
} | undefined {
  const values = (header ?? "").split(";").map((value) => value.trim())
    .filter((value) => value.startsWith(`${hostedUpstreamOAuthStateCookie}=`));
  if (values.length !== 1) return undefined;
  try {
    const parts = decodeURIComponent(values[0]!.slice(hostedUpstreamOAuthStateCookie.length + 1)).split(":");
    if (parts.length !== 3 || !publicAuthProviderTokenPattern.test(parts[0]!) ||
      !/^[a-f0-9]{64}$/u.test(parts[1]!) || !/^[a-f0-9]{64}$/u.test(parts[2]!)) return undefined;
    return { providerId: parts[0]!, state: parts[1]!, browserBinding: parts[2]! };
  } catch {
    return undefined;
  }
}

function serializeHostedUpstreamStateCookie(value: string, clear = false): string {
  return `${hostedUpstreamOAuthStateCookie}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${clear ? 0 : hostedUpstreamTransactionTtlMs / 1000}`;
}

function serializeUpstreamOAuthStateCookie(
  providerId: string,
  state: string,
  secure: boolean,
): string {
  return [
    `${upstreamOAuthStateCookie}=${encodeURIComponent(
      `${providerId}:${state}`,
    )}`,
    "Path=/oauth/upstream/callback",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${upstreamOAuthStateCookieMaxAgeSeconds}`,
    secure ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

function mintUpstreamOAuthServerState(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function clearUpstreamOAuthStateCookie(secure: boolean): string {
  return [
    `${upstreamOAuthStateCookie}=`,
    "Path=/oauth/upstream/callback",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
    secure ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

function parseCookie(header: string | null): Record<string, string> {
  const output: Record<string, string> = {};
  if (!header) return output;
  for (const part of header.split(";")) {
    const [rawName, ...rawValueParts] = part.trim().split("=");
    if (!rawName || rawValueParts.length === 0) continue;
    try {
      output[rawName] = decodeURIComponent(rawValueParts.join("="));
    } catch {
      continue;
    }
  }
  return output;
}

function readUpstreamOAuthStateCookie(
  header: string | null,
): { providerId: string; state: string } | null {
  const value = parseCookie(header)[upstreamOAuthStateCookie];
  if (!value) return null;
  const separator = value.indexOf(":");
  if (separator <= 0 || separator === value.length - 1) return null;
  return {
    providerId: value.slice(0, separator),
    state: value.slice(separator + 1),
  };
}

function resolveUpstreamClient(
  options: UpstreamOAuthOptions,
  providerId: string | null,
): {
  client: UpstreamOAuthClientRegistration;
  provider: UpstreamOAuthProvider;
} | null {
  const client = options.providers.find(
    (candidate) => candidate.providerId === providerId,
  );
  if (!client) return null;
  if (!isUsableUpstreamProvider(client.provider, client.providerId)) {
    return null;
  }
  return {
    client,
    provider: client.provider,
  };
}

function isUsableUpstreamProvider(
  provider: unknown,
  providerId: string,
): provider is UpstreamOAuthProvider {
  if (!provider || typeof provider !== "object") return false;
  const candidate = provider as Partial<UpstreamOAuthProvider>;
  if (
    candidate.id !== providerId ||
    typeof candidate.issuer !== "string" ||
    typeof candidate.authorizationEndpoint !== "string" ||
    typeof candidate.tokenEndpoint !== "string" ||
    typeof candidate.userInfoEndpoint !== "string" ||
    typeof candidate.subjectClaim !== "string" ||
    !Array.isArray(candidate.defaultScopes)
  ) {
    return false;
  }
  return [
    candidate.issuer,
    candidate.authorizationEndpoint,
    candidate.tokenEndpoint,
    candidate.userInfoEndpoint,
  ].every((value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === "https:" ||
        (url.protocol === "http:" &&
          (url.hostname === "localhost" ||
            url.hostname === "127.0.0.1" ||
            url.hostname === "[::1]"))
      );
    } catch {
      return false;
    }
  });
}

function profileFromUpstreamUserInfo(userInfo: Record<string, unknown>): {
  email?: string;
  displayName?: string;
  picture?: string;
  emailVerified?: boolean;
} {
  return {
    email: stringValue(userInfo.email),
    displayName: stringValue(userInfo.name) ?? stringValue(userInfo.login),
    picture: stringValue(userInfo.picture) ?? stringValue(userInfo.avatar_url),
    // Carry the upstream IdP's email_verified assertion through to the ID
    // token. OIDC providers can return a boolean `email_verified`
    // claim; providers that omit it leave this undefined (genuinely unknown),
    // and we never coerce unknown to true. A non-boolean value is ignored.
    emailVerified:
      typeof userInfo.email_verified === "boolean"
        ? userInfo.email_verified
        : undefined,
  };
}
