import { resolveUpstreamAccount } from "./identity.ts";
import type { AccountsStore } from "./store.ts";
import {
  buildUpstreamAuthorizationUrl,
  exchangeUpstreamAuthorizationCode,
  githubOAuthProvider,
  googleOAuthProvider,
  type UpstreamOAuthProvider,
} from "./upstream.ts";
import type {
  UpstreamOAuthClientRegistration,
  UpstreamOAuthOptions,
} from "./mod.ts";
import { json, stringValue } from "./http-helpers.ts";
import {
  extractAccountSessionId,
  rotateAccountSession,
  serializeAccountSessionCookie,
} from "./account-session.ts";

const upstreamOAuthStateCookie = "takosumi_oauth_state";
const upstreamOAuthStateCookieMaxAgeSeconds = 10 * 60;

export function upstreamOAuthNotConfigured(): Response {
  return json({
    error: "feature_unavailable",
    error_description: "Sign-in is temporarily unavailable.",
  }, 503);
}

export function handleUpstreamAuthorizeRequest(input: {
  url: URL;
  upstreamOAuth: UpstreamOAuthOptions;
}): Response {
  const resolved = resolveUpstreamClient(
    input.upstreamOAuth,
    input.url.searchParams.get("provider"),
  );
  if (!resolved) return json({ error: "unknown_provider" }, 400);
  const state = input.url.searchParams.get("state");
  if (!state) {
    return json({
      error: "invalid_request",
      error_description: "state is required",
    }, 400);
  }
  const codeChallenge = input.url.searchParams.get("code_challenge") ??
    undefined;
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
        state,
        input.url.protocol === "https:",
      ),
    },
  });
}

export async function handleUpstreamCallbackRequest(input: {
  request: Request;
  url: URL;
  store: AccountsStore;
  upstreamOAuth: UpstreamOAuthOptions;
}): Promise<Response> {
  const resolved = resolveUpstreamClient(
    input.upstreamOAuth,
    input.url.searchParams.get("provider"),
  );
  if (!resolved) return json({ error: "unknown_provider" }, 400);
  const code = input.url.searchParams.get("code");
  if (!code) {
    return json({
      error: "invalid_request",
      error_description: "code is required",
    }, 400);
  }
  const state = input.url.searchParams.get("state");
  if (!state) {
    return json({
      error: "invalid_state",
      error_description: "state is required",
    }, 400);
  }
  const cookieState = parseCookie(input.request.headers.get("cookie"))[
    upstreamOAuthStateCookie
  ];
  if (cookieState !== state) {
    return json({
      error: "invalid_state",
      error_description: "OAuth state cookie does not match callback state",
    }, 400);
  }

  try {
    const exchange = await exchangeUpstreamAuthorizationCode({
      provider: resolved.provider,
      clientId: resolved.client.clientId,
      clientSecret: resolved.client.clientSecret,
      redirectUri: resolved.client.redirectUri,
      code,
      subjectSecret: input.upstreamOAuth.subjectSecret,
      fetch: input.upstreamOAuth.fetch,
    });
    const account = await resolveUpstreamAccount({
      store: input.store,
      subjectSecret: input.upstreamOAuth.subjectSecret,
      providerId: exchange.providerId,
      upstreamIssuer: exchange.upstreamIssuer,
      upstreamSubject: exchange.upstreamSubject,
      profile: profileFromUpstreamUserInfo(exchange.userInfo),
    });
    const now = Date.now();
    const ttlMs = input.upstreamOAuth.sessionTtlMs ?? 30 * 24 * 60 * 60 * 1000;

    // Agent 6 item 6 + 8: rotate-on-login. If the caller already has a
    // session_id cookie (refreshing or re-linking an account in the same
    // browser), revoke it and mint a new id. Do NOT return the session
    // id in the JSON body; the browser's HttpOnly cookie is the only
    // delivery channel.
    const previousSessionId = extractAccountSessionId(input.request);
    const rotated = await rotateAccountSession({
      store: input.store,
      oldSessionId: previousSessionId,
      subject: account.subject,
      now,
      ttlMs,
    });

    const secure = input.url.protocol === "https:";
    const sessionCookie = serializeAccountSessionCookie(rotated.sessionId, {
      secure,
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
      clearUpstreamOAuthStateCookie(secure),
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
  } catch (error) {
    return json({
      error: "upstream_oauth_failed",
      error_description: error instanceof Error ? error.message : String(error),
    }, 502);
  }
}

function serializeUpstreamOAuthStateCookie(
  state: string,
  secure: boolean,
): string {
  return [
    `${upstreamOAuthStateCookie}=${encodeURIComponent(state)}`,
    "Path=/v1/auth/upstream/callback",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${upstreamOAuthStateCookieMaxAgeSeconds}`,
    secure ? "Secure" : "",
  ].filter(Boolean).join("; ");
}

function clearUpstreamOAuthStateCookie(secure: boolean): string {
  return [
    `${upstreamOAuthStateCookie}=`,
    "Path=/v1/auth/upstream/callback",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
    secure ? "Secure" : "",
  ].filter(Boolean).join("; ");
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

function resolveUpstreamClient(
  options: UpstreamOAuthOptions,
  providerId: string | null,
): {
  client: UpstreamOAuthClientRegistration;
  provider: UpstreamOAuthProvider;
} | null {
  const client = options.providers.find((candidate) =>
    candidate.providerId === providerId
  );
  if (!client) return null;
  const provider = client.provider ?? builtinUpstreamOAuthProvider(
    client.providerId,
  );
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
  if (providerId === "github") return githubOAuthProvider();
  return undefined;
}

function profileFromUpstreamUserInfo(
  userInfo: Record<string, unknown>,
): { email?: string; displayName?: string; emailVerified?: boolean } {
  return {
    email: stringValue(userInfo.email),
    displayName: stringValue(userInfo.name) ?? stringValue(userInfo.login),
    // Carry the upstream IdP's email_verified assertion through to the ID
    // token. OIDC providers (e.g. Google) return a boolean `email_verified`
    // claim; providers that omit it leave this undefined (genuinely unknown),
    // and we never coerce unknown to true. A non-boolean value is ignored.
    emailVerified: typeof userInfo.email_verified === "boolean"
      ? userInfo.email_verified
      : undefined,
  };
}
