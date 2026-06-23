import { resolveUpstreamAccount } from "./identity.ts";
import type { AccountsStore } from "./store.ts";
import {
  buildUpstreamAuthorizationUrl,
  exchangeUpstreamAuthorizationCode,
  googleOAuthProvider,
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
import { json, stringValue } from "./http-helpers.ts";
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
const upstreamOAuthStateCookieMaxAgeSeconds = 10 * 60;
const retiredUpstreamOAuthProviderIds = new Set(["github"]);

export function isRetiredUpstreamOAuthProviderId(providerId: string): boolean {
  return retiredUpstreamOAuthProviderIds.has(providerId.trim().toLowerCase());
}

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
 * GET /v1/auth/providers — public, unauthenticated read of which sign-in
 * methods the operator actually configured on this worker. The sign-in screen
 * reads this so it only enables buttons the backend can honour (clicking an
 * unconfigured provider otherwise hits a 503). Exposes provider ids + enabled
 * flags only — never client ids, secrets, or redirect URIs.
 *
 * Hosted Takosumi Cloud sign-in is intentionally Google-only for now. The
 * endpoint still reports passkey as disabled/enabled for future UI wiring, but
 * custom upstream IdP ids are not public dashboard login methods.
 */
export function handleAuthProvidersRequest(input: {
  upstreamOAuth?: UpstreamOAuthOptions;
  passkeys?: PasskeyHttpOptions;
}): Response {
  const configuredUpstream = new Set(
    (input.upstreamOAuth?.providers ?? []).map((p) => p.providerId),
  );
  const providers: TakosumiAccountsAuthProvider[] = [];
  // Built-in methods the sign-in screen always renders (enabled or disabled).
  for (const id of ["google"] as const) {
    providers.push({ id, enabled: configuredUpstream.has(id) });
  }
  providers.push({ id: "passkey", enabled: input.passkeys !== undefined });
  const body: TakosumiAccountsAuthProvidersResponse = { providers };
  return json(body, 200, { "cache-control": "no-store" });
}

export function handleUpstreamAuthorizeRequest(input: {
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
  const resolved = resolveUpstreamClient(
    input.upstreamOAuth,
    input.url.searchParams.get("provider"),
  );
  if (!resolved) return json({ error: "unknown_provider" }, 400);
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

  try {
    const previousSessionId = extractAccountSessionId(input.request);
    const exchange = await exchangeUpstreamAuthorizationCode({
      provider: resolved.provider,
      clientId: resolved.client.clientId,
      clientSecret: resolved.client.clientSecret,
      redirectUri: resolved.client.redirectUri,
      code,
      subjectSecret: input.upstreamOAuth.subjectSecret,
      fetch: input.upstreamOAuth.fetch,
    });
    const profile = profileFromUpstreamUserInfo(exchange.userInfo);
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
    });
    const now = Date.now();
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
    });

    const sessionCookie = serializeAccountSessionCookie(rotated.sessionId, {
      secure: input.secureCookie,
      maxAgeSeconds: Math.max(1, Math.floor(ttlMs / 1000)),
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
      clearUpstreamOAuthStateCookie(input.secureCookie),
    );
    headers.append("set-cookie", sessionCookie);
    return new Response(
      JSON.stringify({
        subject: account.subject,
        expires_at: rotated.expiresAt,
        provider_id: exchange.providerId,
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

function serializeUpstreamOAuthStateCookie(
  providerId: string,
  state: string,
  secure: boolean,
): string {
  return [
    `${upstreamOAuthStateCookie}=${encodeURIComponent(
      `${providerId}:${state}`,
    )}`,
    "Path=/v1/auth/upstream/callback",
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
    "Path=/v1/auth/upstream/callback",
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
  if (isRetiredUpstreamOAuthProviderId(client.providerId)) return null;
  const provider =
    client.provider ?? builtinUpstreamOAuthProvider(client.providerId);
  if (!provider) return null;
  return {
    client,
    provider,
  };
}

function builtinUpstreamOAuthProvider(
  providerId: string,
): UpstreamOAuthProvider | undefined {
  if (providerId === "google") return googleOAuthProvider();
  return undefined;
}

function profileFromUpstreamUserInfo(userInfo: Record<string, unknown>): {
  email?: string;
  displayName?: string;
  emailVerified?: boolean;
} {
  return {
    email: stringValue(userInfo.email),
    displayName: stringValue(userInfo.name) ?? stringValue(userInfo.login),
    // Carry the upstream IdP's email_verified assertion through to the ID
    // token. OIDC providers (e.g. Google) return a boolean `email_verified`
    // claim; providers that omit it leave this undefined (genuinely unknown),
    // and we never coerce unknown to true. A non-boolean value is ignored.
    emailVerified:
      typeof userInfo.email_verified === "boolean"
        ? userInfo.email_verified
        : undefined,
  };
}
