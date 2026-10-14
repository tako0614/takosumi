import type { UpstreamOAuthProvider } from "./upstream.ts";
import { fetchUpstreamJson, isUpstreamJsonRecord } from "./upstream-http.ts";

const googleIssuer = "https://accounts.google.com";
const googleJwks = "https://www.googleapis.com/oauth2/v3/certs";
const githubIssuer = "https://github.com";

/** Explicit operator-selected profiles; provider IDs never select behavior. */
export function verifiedSocialOAuthProvider(input: {
  id: string;
  profile: "google-oidc" | "github-oauth";
}): UpstreamOAuthProvider {
  return input.profile === "google-oidc"
    ? {
      id: input.id,
      verificationProfile: input.profile,
      issuer: googleIssuer,
      authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenEndpoint: "https://oauth2.googleapis.com/token",
      userInfoEndpoint: "https://openidconnect.googleapis.com/v1/userinfo",
      defaultScopes: ["openid", "email"],
      subjectClaim: "sub",
    }
    : {
      id: input.id,
      verificationProfile: input.profile,
      issuer: githubIssuer,
      authorizationEndpoint: "https://github.com/login/oauth/authorize",
      tokenEndpoint: "https://github.com/login/oauth/access_token",
      userInfoEndpoint: "https://api.github.com/user",
      defaultScopes: ["read:user", "user:email"],
      subjectClaim: "id",
    };
}

export function assertVerifiedSocialProvider(provider: UpstreamOAuthProvider): void {
  if (provider.verificationProfile !== "google-oidc" && provider.verificationProfile !== "github-oauth") {
    throw new TypeError("hosted login requires an explicit verified upstream profile");
  }
  const expected = verifiedSocialOAuthProvider({ id: provider.id, profile: provider.verificationProfile });
  for (const key of ["issuer", "authorizationEndpoint", "tokenEndpoint", "userInfoEndpoint", "subjectClaim"] as const) {
    if (provider[key] !== expected[key]) throw new TypeError("verified upstream endpoints do not match profile");
  }
}

export function assertSocialLoginScopes(provider: UpstreamOAuthProvider, scopes: readonly string[]): void {
  const allowed = provider.verificationProfile === "google-oidc"
    ? ["openid", "email", "profile"]
    : ["read:user", "user:email"];
  const required = provider.verificationProfile === "google-oidc" ? ["openid", "email"] : ["user:email"];
  if (scopes.some((scope) => !allowed.includes(scope)) || required.some((scope) => !scopes.includes(scope))) {
    throw new TypeError("upstream login scopes exceed the identity profile");
  }
}

export async function verifyGoogleIdToken(input: {
  token: unknown;
  clientId: string;
  nonce: string | undefined;
  fetch: typeof fetch;
  now: number;
  freshSince?: number;
}): Promise<Record<string, unknown>> {
  if (typeof input.token !== "string" || input.token.length > 32 * 1024 || !input.nonce) {
    throw new TypeError("Google ID token or nonce is missing");
  }
  const parts = input.token.split(".");
  if (parts.length !== 3) throw new TypeError("invalid Google ID token");
  const header = decodeJson(parts[0]!);
  const claims = decodeJson(parts[1]!);
  if (header.alg !== "RS256" || typeof header.kid !== "string" || header.kid.length > 256 || header.crit !== undefined) {
    throw new TypeError("invalid Google ID token signing header");
  }
  // Key retrieval is pinned, bounded and performed once per callback. No jku,
  // token issuer URL, stale cached keys or unbounded kid refresh is accepted.
  const { value: jwks } = await fetchUpstreamJson(input.fetch, googleJwks, { headers: { accept: "application/json" } });
  if (!isUpstreamJsonRecord(jwks) || !Array.isArray(jwks.keys) || jwks.keys.length > 32) {
    throw new TypeError("invalid Google signing keys");
  }
  const matching = jwks.keys.filter((key) => isUpstreamJsonRecord(key) && key.kid === header.kid);
  if (matching.length !== 1) throw new TypeError("Google signing key unavailable");
  const jwk = matching[0] as JsonWebKey;
  if (jwk.kty !== "RSA" || jwk.alg !== "RS256" || jwk.use !== "sig" || jwk.d !== undefined || !jwk.n || decodeBytes(jwk.n).length < 256 || decodeBytes(jwk.n).length > 512 || jwk.e !== "AQAB") {
    throw new TypeError("invalid Google signing key");
  }
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, decodeBytes(parts[2]!), new TextEncoder().encode(`${parts[0]}.${parts[1]}`)))) {
    throw new TypeError("invalid Google ID token signature");
  }
  const nowSeconds = Math.floor(input.now / 1000);
  if ((claims.iss !== googleIssuer && claims.iss !== "accounts.google.com") ||
    claims.aud !== input.clientId || (claims.azp !== undefined && claims.azp !== input.clientId) ||
    typeof claims.sub !== "string" || !/^[\x21-\x7e]{1,255}$/u.test(claims.sub) ||
    claims.nonce !== input.nonce ||
    !Number.isSafeInteger(claims.exp) || (claims.exp as number) <= nowSeconds - 60 ||
    !Number.isSafeInteger(claims.iat) || (claims.iat as number) > nowSeconds + 60 ||
    (claims.iat as number) < nowSeconds - 10 * 60 || (claims.exp as number) <= (claims.iat as number)) {
    throw new TypeError("invalid Google ID token claims");
  }
  if (input.freshSince !== undefined && (!Number.isSafeInteger(claims.auth_time) ||
    (claims.auth_time as number) * 1000 < input.freshSince - 60_000 ||
    (claims.auth_time as number) > nowSeconds + 60)) {
    throw new TypeError("fresh Google authentication is required");
  }
  return claims;
}

/** A verified primary private address is valid; /user.email is never proof. */
export async function fetchGithubIdentity(input: {
  provider: UpstreamOAuthProvider;
  accessToken: string;
  fetch: typeof fetch;
}): Promise<Record<string, unknown>> {
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${input.accessToken}`,
    "x-github-api-version": "2022-11-28",
    "user-agent": "Takosumi-Accounts",
  };
  const { value: user } = await fetchUpstreamJson(input.fetch, input.provider.userInfoEndpoint, { headers });
  if (!isUpstreamJsonRecord(user) || !Number.isSafeInteger(user.id) || (user.id as number) <= 0) {
    throw new TypeError("GitHub authenticated numeric identity is missing");
  }
  const emails: Record<string, unknown>[] = [];
  for (let page = 1; page <= 5; page++) {
    const url = `https://api.github.com/user/emails?per_page=100&page=${page}`;
    const { value, headers: responseHeaders } = await fetchUpstreamJson(input.fetch, url, { headers });
    if (!Array.isArray(value) || value.length > 100 || value.some((entry) => !isUpstreamJsonRecord(entry) ||
      typeof entry.email !== "string" || entry.email.length > 320 || typeof entry.primary !== "boolean" || typeof entry.verified !== "boolean")) {
      throw new TypeError("GitHub email inventory is invalid");
    }
    emails.push(...value as Record<string, unknown>[]);
    const linkHeader = responseHeaders.get("link");
    if (linkHeader && (linkHeader.length > 4096 || linkHeader.split(",").length > 10)) {
      throw new TypeError("GitHub email pagination is invalid");
    }
    const nextLinks = linkHeader?.split(",").filter((link) => /;\s*rel="(?:[^"]*\s)?next(?:\s[^"]*)?"(?:\s*;|\s*$)/u.test(link)) ?? [];
    if (nextLinks.length > 1) throw new TypeError("GitHub email pagination conflicts");
    const next = nextLinks[0];
    if (!next) break;
    const nextUrl = next.match(/^\s*<([^>]+)>/u)?.[1];
    const expected = new URL(`https://api.github.com/user/emails?per_page=100&page=${page + 1}`);
    const actual = nextUrl ? new URL(nextUrl) : undefined;
    if (page === 5 || !actual || actual.origin !== expected.origin || actual.pathname !== expected.pathname ||
      actual.searchParams.get("page") !== String(page + 1) || actual.searchParams.get("per_page") !== "100" ||
      [...actual.searchParams.keys()].some((key) => key !== "page" && key !== "per_page") || actual.hash || actual.username || actual.password) {
      throw new TypeError("GitHub email inventory is incomplete");
    }
  }
  const primary = emails.filter((email) => email.primary === true);
  if (primary.length > 1) throw new TypeError("GitHub email inventory has conflicting primary addresses");
  const selected = primary.find((email) => email.verified === true);
  return {
    id: user.id,
    login: user.login,
    name: user.name,
    avatar_url: user.avatar_url,
    ...(selected ? { email: selected.email, email_verified: true } : {}),
  };
}

function decodeJson(value: string): Record<string, unknown> {
  const decoded: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decodeBytes(value)));
  if (!isUpstreamJsonRecord(decoded)) throw new TypeError("invalid JWT object");
  return decoded;
}

function decodeBytes(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new TypeError("invalid JWT encoding");
  const decoded = atob(value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - value.length % 4) % 4));
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}
