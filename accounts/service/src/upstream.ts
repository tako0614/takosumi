import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";
import { deriveTakosumiSubject } from "./subject.ts";
import type { AccountProfileInput } from "./identity.ts";
import { fetchUpstreamJson, isUpstreamJsonRecord } from "./upstream-http.ts";
import {
  assertVerifiedSocialProvider,
  fetchGithubIdentity,
  verifyGoogleIdToken,
} from "./upstream-verification.ts";

export interface UpstreamOAuthProvider {
  id: string;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  userInfoEndpoint: string;
  defaultScopes: readonly string[];
  subjectClaim: string;
  verificationProfile?: "google-oidc" | "github-oauth";
}

export interface OidcOAuthProviderInput {
  id: string;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  userInfoEndpoint: string;
  defaultScopes?: readonly string[];
  subjectClaim?: string;
}

export interface UpstreamAuthorizationUrlInput {
  provider: UpstreamOAuthProvider;
  clientId: string;
  redirectUri: string;
  state: string;
  scopes?: readonly string[];
  codeChallenge?: string;
  codeChallengeMethod?: "plain" | "S256";
  nonce?: string;
  freshAuthentication?: boolean;
}

export interface UpstreamAuthorizationCodeExchangeInput {
  provider: UpstreamOAuthProvider;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  code: string;
  codeVerifier?: string;
  nonce?: string;
  freshSince?: number;
  now?: number;
  subjectSecret: string | Uint8Array | CryptoKey;
  fetch?: typeof fetch;
}

export interface UpstreamAuthorizationCodeExchangeResult {
  providerId: string;
  upstreamIssuer: string;
  upstreamSubject: string;
  takosumiSubject: TakosumiSubject;
  tokenResponse: Record<string, unknown>;
  userInfo: Record<string, unknown>;
  profile?: AccountProfileInput;
  authenticationTime?: number;
  freshlyAuthenticatedAt?: number;
}

export function oidcOAuthProvider(
  input: OidcOAuthProviderInput,
): UpstreamOAuthProvider {
  return {
    id: input.id,
    issuer: input.issuer,
    authorizationEndpoint: input.authorizationEndpoint,
    tokenEndpoint: input.tokenEndpoint,
    userInfoEndpoint: input.userInfoEndpoint,
    defaultScopes: input.defaultScopes ?? ["openid", "profile", "email"],
    subjectClaim: input.subjectClaim ?? "sub",
  };
}

export function buildUpstreamAuthorizationUrl(
  input: UpstreamAuthorizationUrlInput,
): URL {
  const url = new URL(input.provider.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set(
    "scope",
    (input.scopes ?? input.provider.defaultScopes).join(" "),
  );
  url.searchParams.set("state", input.state);
  if (input.codeChallenge) {
    url.searchParams.set("code_challenge", input.codeChallenge);
    url.searchParams.set(
      "code_challenge_method",
      input.codeChallengeMethod ?? "S256",
    );
  }
  if (input.nonce) url.searchParams.set("nonce", input.nonce);
  if (input.provider.verificationProfile) {
    url.searchParams.set("prompt", "select_account");
  }
  if (input.freshAuthentication && input.provider.verificationProfile === "google-oidc") {
    url.searchParams.set("max_age", "0");
    url.searchParams.set("claims", JSON.stringify({ id_token: { auth_time: { essential: true } } }));
  }
  return url;
}

export async function exchangeUpstreamAuthorizationCode(
  input: UpstreamAuthorizationCodeExchangeInput,
): Promise<UpstreamAuthorizationCodeExchangeResult> {
  const fetchImpl = input.fetch ?? fetch;
  if (input.provider.verificationProfile) {
    assertVerifiedSocialProvider(input.provider);
    if (!input.codeVerifier || !/^[A-Za-z0-9._~-]{43,128}$/u.test(input.codeVerifier)) {
      throw new TypeError("verified upstream requires server PKCE");
    }
  }
  const tokenResponse = await postTokenRequest(input, fetchImpl);
  const accessToken = tokenResponse.access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0 || accessToken.length > 16 * 1024 ||
    (input.provider.verificationProfile && (typeof tokenResponse.token_type !== "string" || tokenResponse.token_type.toLowerCase() !== "bearer"))) {
    throw new TypeError(
      "upstream OAuth token response did not include access_token",
    );
  }

  const now = input.now ?? Date.now();
  let userInfo: Record<string, unknown>;
  let verifiedClaims: Record<string, unknown> | undefined;
  if (input.provider.verificationProfile === "google-oidc") {
    verifiedClaims = await verifyGoogleIdToken({
      token: tokenResponse.id_token,
      clientId: input.clientId,
      nonce: input.nonce,
      fetch: fetchImpl,
      now,
      freshSince: input.freshSince,
    });
    const fetched = await fetchUserInfo(input.provider, accessToken, fetchImpl);
    if (fetched.sub !== verifiedClaims.sub) throw new TypeError("Google UserInfo subject does not match ID token");
    // Only signed identity/address assertions supply proof. UserInfo may add
    // display fields, never replace subject, address or verification claims.
    userInfo = {
      name: fetched.name,
      picture: fetched.picture,
      ...verifiedClaims,
    };
  } else if (input.provider.verificationProfile === "github-oauth") {
    if (input.freshSince !== undefined) throw new TypeError("GitHub OAuth cannot prove fresh credential authentication");
    userInfo = await fetchGithubIdentity({ provider: input.provider, accessToken, fetch: fetchImpl });
  } else {
    userInfo = await fetchUserInfo(input.provider, accessToken, fetchImpl);
  }
  const upstreamSubject = userInfo[input.provider.subjectClaim];
  if (
    typeof upstreamSubject !== "string" &&
    typeof upstreamSubject !== "number"
  ) {
    throw new TypeError(
      `upstream OAuth userinfo did not include subject claim '${input.provider.subjectClaim}'`,
    );
  }
  const normalizedSubject = String(upstreamSubject);
  if (!normalizedSubject || normalizedSubject.length > 255) throw new TypeError("upstream subject is invalid");
  const takosumiSubject = await deriveTakosumiSubject({
    secret: input.subjectSecret,
    upstreamIssuer: input.provider.issuer,
    upstreamSubject: normalizedSubject,
  });

  return {
    providerId: input.provider.id,
    upstreamIssuer: input.provider.issuer,
    upstreamSubject: normalizedSubject,
    takosumiSubject,
    tokenResponse,
    userInfo,
    ...(verifiedClaims && Number.isSafeInteger(verifiedClaims.auth_time) && (verifiedClaims.auth_time as number) <= Math.floor(now / 1000) + 60
      ? { authenticationTime: verifiedClaims.auth_time as number,
        ...(input.freshSince !== undefined ? { freshlyAuthenticatedAt: verifiedClaims.auth_time as number } : {}) }
      : {}),
    ...(input.provider.verificationProfile ? {
      profile: socialProfile(input.provider, normalizedSubject, userInfo, now),
    } : {}),
  };
}

async function postTokenRequest(
  input: UpstreamAuthorizationCodeExchangeInput,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
  });
  if (input.codeVerifier) body.set("code_verifier", input.codeVerifier);
  if (input.clientSecret) body.set("client_secret", input.clientSecret);

  const { value: responseBody } = await fetchUpstreamJson(fetchImpl, input.provider.tokenEndpoint, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!isUpstreamJsonRecord(responseBody)) {
    throw new TypeError("upstream OAuth token response was not a JSON object");
  }
  return responseBody;
}

async function fetchUserInfo(
  provider: UpstreamOAuthProvider,
  accessToken: string,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  const { value: body } = await fetchUpstreamJson(fetchImpl, provider.userInfoEndpoint, {
    method: "GET",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${accessToken}`,
    },
  });
  if (!isUpstreamJsonRecord(body)) {
    throw new TypeError("upstream OAuth userinfo response was not a JSON object");
  }
  return body;
}

function socialProfile(
  provider: UpstreamOAuthProvider,
  upstreamSubject: string,
  userInfo: Record<string, unknown>,
  now: number,
): AccountProfileInput {
  const email = typeof userInfo.email === "string" ? userInfo.email : undefined;
  const verified = typeof userInfo.email_verified === "boolean" ? userInfo.email_verified : undefined;
  const authoritative = provider.verificationProfile === "github-oauth" ||
    (verified === true && (!!email?.toLowerCase().endsWith("@gmail.com") ||
      (typeof userInfo.hd === "string" && userInfo.hd.length > 0)));
  return {
    email,
    emailVerified: verified,
    displayName: typeof userInfo.name === "string" ? userInfo.name :
      typeof userInfo.login === "string" ? userInfo.login : undefined,
    picture: typeof userInfo.picture === "string" ? userInfo.picture :
      typeof userInfo.avatar_url === "string" ? userInfo.avatar_url : undefined,
    ...(email && verified === true ? {
      emailProof: {
        address: email,
        providerId: provider.id,
        upstreamIssuer: provider.issuer,
        upstreamSubject,
        verification: "provider" as const,
        authoritative,
        observedAt: now,
        validUntil: now + 5 * 60_000,
      },
    } : {}),
  };
}
