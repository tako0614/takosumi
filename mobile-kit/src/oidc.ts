import type {
  FetchLike,
  OidcAuthorizationUrlInput,
  OidcCallbackResult,
  OidcMetadata,
  OidcTokenExchangeInput,
  OidcTokenResponse,
  PkcePair,
} from "./types.ts";
import { hostEndpoint } from "./url.ts";

const verifierAlphabet =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";

export async function createPkcePair(
  cryptoSource: Crypto = globalThis.crypto,
): Promise<PkcePair> {
  const codeVerifier = createRandomVerifier(cryptoSource);
  const data = new TextEncoder().encode(codeVerifier);
  const digest = await cryptoSource.subtle.digest("SHA-256", data);
  return {
    codeVerifier,
    codeChallenge: base64UrlEncode(new Uint8Array(digest)),
    codeChallengeMethod: "S256",
  };
}

export function createRandomState(
  cryptoSource: Crypto = globalThis.crypto,
): string {
  return createRandomVerifier(cryptoSource, 32);
}

export async function fetchOidcMetadata(input: {
  readonly issuer: string;
  readonly fetch?: FetchLike;
}): Promise<OidcMetadata> {
  const fetcher = input.fetch ?? globalThis.fetch.bind(globalThis);
  const response = await fetcher(
    hostEndpoint(input.issuer, "/.well-known/openid-configuration"),
    { headers: { accept: "application/json" } },
  );
  if (!response.ok) {
    throw new Error(`OIDC discovery failed: ${response.status}`);
  }
  return (await response.json()) as OidcMetadata;
}

export function createOidcAuthorizationUrl(
  input: OidcAuthorizationUrlInput,
): string {
  const url = new URL(input.metadata.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", input.scope ?? "openid profile offline_access");
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export function parseOidcCallback(
  callbackUrl: string,
  expectedState: string,
): OidcCallbackResult {
  const url = new URL(callbackUrl);
  const error = url.searchParams.get("error");
  if (error) throw new Error(`OIDC callback failed: ${error}`);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code) throw new Error("OIDC callback is missing code.");
  if (!state) throw new Error("OIDC callback is missing state.");
  if (state !== expectedState) throw new Error("OIDC callback state mismatch.");
  return { code, state };
}

export async function exchangeOidcCode(
  input: OidcTokenExchangeInput,
): Promise<OidcTokenResponse> {
  if (!input.metadata.token_endpoint) {
    throw new Error("OIDC metadata is missing token endpoint.");
  }
  const fetcher = input.fetch ?? globalThis.fetch.bind(globalThis);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    code: input.code,
    code_verifier: input.codeVerifier,
  });
  const response = await fetcher(input.metadata.token_endpoint, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!response.ok) {
    throw new Error(`OIDC token exchange failed: ${response.status}`);
  }
  const token = (await response.json()) as OidcTokenResponse;
  if (!token.access_token) {
    throw new Error("OIDC token response is missing access token.");
  }
  if (!token.token_type) {
    throw new Error("OIDC token response is missing token type.");
  }
  return token;
}

function createRandomVerifier(cryptoSource: Crypto, length = 64): string {
  const bytes = new Uint8Array(length);
  cryptoSource.getRandomValues(bytes);
  let verifier = "";
  for (const byte of bytes) {
    verifier += verifierAlphabet[byte % verifierAlphabet.length];
  }
  return verifier;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}
