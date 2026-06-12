/**
 * Auth flows for the account-plane RPC client: upstream OAuth (Google/GitHub),
 * navigation-based. (Passkey/WebAuthn client code returns together with an
 * actual passkey sign-in UI — the API stays on the backend.)
 */
import { apiFetch, qs } from "./http.ts";
import * as paths from "./paths.ts";
import type { SessionRecord } from "./session.ts";
import type { TakosumiAccountsAuthProvidersResponse } from "@takosjp/takosumi-accounts-contract";

const STATE_KEY = "tg_oauth_state";
const RETURN_KEY = "tg_oauth_return";
const PROVIDER_KEY = "tg_oauth_provider";

type Provider = "google" | "github";

/**
 * Read which sign-in methods the operator configured on this worker. Public +
 * unauthenticated (the sign-in screen runs before any session exists), so it
 * goes through {@link apiFetch} with `auth: false`. The body carries provider
 * ids + enabled flags only — never any credential — so the panel can disable
 * buttons that would otherwise hit a 503 on click.
 */
export async function listAuthProviders(): Promise<
  TakosumiAccountsAuthProvidersResponse
> {
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

export function startUpstreamOAuth(provider: "google" | "github"): void {
  if (typeof window === "undefined") return;
  const state = randomState();
  sessionStorage.setItem(STATE_KEY, state);
  // Upstream OAuth providers don't echo back which provider was used in the
  // callback URL — stash it here so /sign-in/callback can recover it.
  sessionStorage.setItem(PROVIDER_KEY, provider);
  // Preserve intended return URL (e.g. user landed on /apps unauth and was
  // bounced to /sign-in; after auth we want to send them back to /apps).
  const url = new URL(location.href);
  const intended = url.searchParams.get("return") ?? "/";
  sessionStorage.setItem(RETURN_KEY, intended);

  location.assign(
    paths.UPSTREAM_AUTHORIZE +
      qs({
        provider,
        state,
        redirect_uri: location.origin + "/sign-in/callback",
      }),
  );
}

export function recallOAuthProvider(): "google" | "github" | null {
  if (typeof sessionStorage === "undefined") return null;
  const v = sessionStorage.getItem(PROVIDER_KEY);
  return v === "google" || v === "github" ? v : null;
}

export interface CallbackResult {
  readonly session: SessionRecord;
  readonly returnTo: string;
}

interface CallbackResponse {
  readonly subject: string;
  readonly session_id: string;
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
  if (!expected || expected !== state) {
    throw new Error("oauth state mismatch — possible CSRF or stale tab");
  }
  sessionStorage.removeItem(STATE_KEY);
  sessionStorage.removeItem(PROVIDER_KEY);
  const returnTo = sessionStorage.getItem(RETURN_KEY) ?? "/";
  sessionStorage.removeItem(RETURN_KEY);

  // The worker's /v1/auth/upstream/callback handler only accepts GET with
  // query params (it was originally designed as the direct upstream redirect
  // target). Calling via GET with code/state/provider in the URL keeps the
  // SPA out of the redirect chain while still using the documented contract.
  const body: CallbackResponse = await apiFetch(
    paths.UPSTREAM_CALLBACK + qs({ code, state, provider }),
    { method: "GET", auth: false },
  );
  return {
    session: {
      subject: body.subject,
      sessionId: body.session_id,
      // expires_at is epoch ms (worker passes Date.now() + ttl).
      expiresAt: body.expires_at,
      provider,
      ...(body.display_name ? { displayName: body.display_name } : {}),
      ...(body.email ? { email: body.email } : {}),
    },
    returnTo,
  };
}
