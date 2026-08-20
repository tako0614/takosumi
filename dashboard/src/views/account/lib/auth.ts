/**
 * Auth flows for the account-plane RPC client: generic upstream OAuth/OIDC,
 * navigation-based. (Passkey/WebAuthn client code returns together with an
 * actual passkey sign-in UI — the API stays on the backend.)
 */
import { apiFetch, qs } from "./http.ts";
import * as paths from "./paths.ts";
import type { TakosumiAccountsAuthProvidersResponse } from "@takosjp/takosumi-accounts-contract";

const STATE_KEY = "tg_oauth_state";
const RETURN_KEY = "tg_oauth_return";
const PROVIDER_KEY = "tg_oauth_provider";
const PKCE_VERIFIER_KEY = "tg_oauth_pkce_verifier";

type Provider = string;

/**
 * Read which sign-in methods the operator configured on this worker. Public +
 * unauthenticated (the sign-in screen runs before any session exists), so it
 * goes through {@link apiFetch} with `auth: false`. The body carries only the
 * non-secret id, enabled flag, display label, and protocol — never a client
 * identifier, endpoint, redirect URI, scope, or credential.
 */
export async function listAuthProviders(): Promise<TakosumiAccountsAuthProvidersResponse> {
  return await apiFetch<TakosumiAccountsAuthProvidersResponse>(
    paths.AUTH_PROVIDERS,
    { method: "GET", auth: false },
  );
}

function randomState(): string {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function startUpstreamOAuth(provider: Provider): Promise<void> {
  if (typeof window === "undefined") return;
  const state = randomState();
  const codeVerifier = randomCodeVerifier();
  const codeChallenge = await pkceChallenge(codeVerifier);
  sessionStorage.setItem(STATE_KEY, state);
  sessionStorage.setItem(PKCE_VERIFIER_KEY, codeVerifier);
  // Upstream OAuth providers don't echo back which provider was used in the
  // callback URL — stash it here so /sign-in/callback can recover it.
  sessionStorage.setItem(PROVIDER_KEY, provider);
  // Preserve intended return URL (e.g. user landed on /capsules unauth
  // and was bounced to /sign-in; after auth we want to send them back there).
  const url = new URL(location.href);
  const returnParam = url.searchParams.get("return");
  const legacyReturnToParam = url.searchParams.get("return_to");
  const intended = safeOAuthReturnTo(
    returnParam && returnParam.trim() ? returnParam : legacyReturnToParam,
  );
  sessionStorage.setItem(RETURN_KEY, intended);

  location.assign(
    paths.UPSTREAM_AUTHORIZE +
      qs({
        provider,
        state,
        redirect_uri: location.origin + "/sign-in/callback",
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
      }),
  );
}

export function recallOAuthProvider(): Provider | null {
  if (typeof sessionStorage === "undefined") return null;
  return safeProviderId(sessionStorage.getItem(PROVIDER_KEY));
}

export function recallOAuthReturnTo(): string {
  if (typeof sessionStorage === "undefined") return "/";
  return safeOAuthReturnTo(sessionStorage.getItem(RETURN_KEY));
}

export interface CallbackResult {
  readonly returnTo: string;
}

interface CallbackResponse {
  readonly subject: string;
  readonly expires_at: number;
  readonly provider_id?: string;
  readonly display_name?: string;
  readonly email?: string;
}

export async function completeUpstreamOAuth(
  code: string,
  state: string,
  provider: Provider,
): Promise<CallbackResult> {
  const expected = sessionStorage.getItem(STATE_KEY);
  const codeVerifier = sessionStorage.getItem(PKCE_VERIFIER_KEY);
  if (!expected || expected !== state || !codeVerifier) {
    throw new Error("oauth flow was not started in this tab");
  }
  const returnTo = recallOAuthReturnTo();

  // The worker's /v1/auth/upstream/callback handler only accepts GET with
  // query params (it was originally designed as the direct upstream redirect
  // target). Calling via GET with code/state/provider in the URL keeps the
  // SPA out of the redirect chain while still using the documented contract.
  await apiFetch<CallbackResponse>(
    paths.UPSTREAM_CALLBACK +
      qs({ code, state, provider, code_verifier: codeVerifier }),
    { method: "GET", auth: false },
  );
  sessionStorage.removeItem(STATE_KEY);
  sessionStorage.removeItem(PROVIDER_KEY);
  sessionStorage.removeItem(PKCE_VERIFIER_KEY);
  sessionStorage.removeItem(RETURN_KEY);
  return {
    returnTo,
  };
}

function randomCodeVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return base64Url(new Uint8Array(digest));
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/=/gu, "")
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_");
}

export function safeOAuthReturnTo(value: string | null | undefined): string {
  const raw = value?.trim();
  if (!raw || raw.startsWith("//") || !raw.startsWith("/")) return "/";
  if (/[\r\n\0]/.test(raw)) return "/";
  try {
    const base = "https://takosumi.invalid";
    const parsed = new URL(raw, base);
    if (parsed.origin !== base) return "/";
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return "/";
  }
}

function safeProviderId(value: string | null | undefined): string | null {
  const provider = value?.trim();
  return provider && /^[a-z0-9][a-z0-9._:-]{0,127}$/iu.test(provider)
    ? provider
    : null;
}
