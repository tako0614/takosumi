import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";
import { deriveTakosumiSubject } from "./subject.ts";

export interface UpstreamOAuthProvider {
  id: string;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  userInfoEndpoint: string;
  defaultScopes: readonly string[];
  subjectClaim: string;
}

export interface CustomOidcOAuthProviderInput {
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
}

export interface UpstreamAuthorizationCodeExchangeInput {
  provider: UpstreamOAuthProvider;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  code: string;
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
}

/** Optional endpoint overrides. Used by local-substrate tests to point the
 *  builtin provider definitions at a mock OAuth server (avoiding outbound
 *  traffic to real Google). Production leaves all overrides unset
 *  and gets the real endpoints. */
export type BuiltinUpstreamProviderOverrides = Partial<
  Pick<
    UpstreamOAuthProvider,
    "issuer" | "authorizationEndpoint" | "tokenEndpoint" | "userInfoEndpoint"
  >
>;

export function googleOAuthProvider(
  overrides: BuiltinUpstreamProviderOverrides = {},
): UpstreamOAuthProvider {
  return {
    id: "google",
    issuer: overrides.issuer ?? "https://accounts.google.com",
    authorizationEndpoint:
      overrides.authorizationEndpoint ??
      "https://accounts.google.com/o/oauth2/v2/auth",
    tokenEndpoint:
      overrides.tokenEndpoint ?? "https://oauth2.googleapis.com/token",
    userInfoEndpoint:
      overrides.userInfoEndpoint ??
      "https://openidconnect.googleapis.com/v1/userinfo",
    defaultScopes: ["openid", "profile", "email"],
    subjectClaim: "sub",
  };
}

export function customOidcOAuthProvider(
  input: CustomOidcOAuthProviderInput,
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
  return url;
}

export async function exchangeUpstreamAuthorizationCode(
  input: UpstreamAuthorizationCodeExchangeInput,
): Promise<UpstreamAuthorizationCodeExchangeResult> {
  const fetchImpl = input.fetch ?? fetch;
  const tokenResponse = await postTokenRequest(input, fetchImpl);
  const accessToken = tokenResponse.access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new TypeError(
      "upstream OAuth token response did not include access_token",
    );
  }

  const userInfo = await fetchUserInfo(input.provider, accessToken, fetchImpl);
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
  if (input.clientSecret) body.set("client_secret", input.clientSecret);

  const response = await fetchImpl(input.provider.tokenEndpoint, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!response.ok) {
    throw new Error(
      `upstream OAuth token exchange failed with status ${response.status}`,
    );
  }
  const responseBody = await response.json();
  if (!isJsonRecord(responseBody)) {
    throw new TypeError("upstream OAuth token response was not a JSON object");
  }
  return responseBody;
}

async function fetchUserInfo(
  provider: UpstreamOAuthProvider,
  accessToken: string,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  const response = await fetchImpl(provider.userInfoEndpoint, {
    method: "GET",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${accessToken}`,
    },
  });
  if (!response.ok) {
    throw new Error(
      `upstream OAuth userinfo failed with status ${response.status}`,
    );
  }
  const body = await response.json();
  if (!isJsonRecord(body)) {
    throw new TypeError(
      "upstream OAuth userinfo response was not a JSON object",
    );
  }
  return body;
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
