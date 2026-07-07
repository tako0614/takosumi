import type {
  TakosumiAccountsPatScope,
  TakosumiSubject,
} from "@takosjp/takosumi-accounts-contract";
import type { AccountsStore } from "./store.ts";
import {
  errorJson,
  bearerChallenge,
  bearerToken,
  json,
} from "./http-helpers.ts";
// Shared PAT-activity predicate. Imported (not re-declared) so the activity
// rule has a single owner and cannot drift between the two call sites.
import { personalAccessTokenIsActive } from "./pat-routes.ts";

export const TAKOSUMI_ACCOUNTS_SESSION_ME_PATH = "/v1/account/session/me";

export type AccountsBearerRequiredScope = "read" | "write" | "admin";

export type AccountsBearerSubject = {
  readonly subject: TakosumiSubject;
  readonly credential: "session" | "personal-access-token";
};

export async function requireAccountSession(input: {
  request: Request;
  store: AccountsStore;
}): Promise<
  | { ok: true; subject: TakosumiSubject; sessionId: string }
  | { ok: false; response: Response }
> {
  const sessionId = extractAccountSessionId(input.request);
  if (!sessionId || !sessionId.startsWith("sess_")) {
    return { ok: false, response: bearerChallenge("invalid_session") };
  }
  const session = await input.store.findAccountSession(sessionId);
  if (!session || session.expiresAt < Date.now()) {
    if (session) await input.store.deleteAccountSession(sessionId);
    return { ok: false, response: bearerChallenge("invalid_session") };
  }
  const account = await input.store.findAccount(session.subject);
  if (!account) {
    await input.store.deleteAccountSession(sessionId);
    return { ok: false, response: bearerChallenge("invalid_session") };
  }
  return { ok: true, subject: session.subject, sessionId };
}

/**
 * Extract the bearer session_id from a request. Accepts (in order):
 *   1. The `Authorization: Bearer ...` header (compat with PAT callers).
 *   2. The `x-takosumi-account-session` header (compat with non-cookie clients).
 *   3. The `takosumi_session` HttpOnly cookie (Set by the server on
 *      OAuth callback / passkey complete — the canonical browser path).
 *
 * Cookie sources are preferred for new browser flows because the cookie
 * is `HttpOnly` / `Secure` / `SameSite=Lax`; clients must not write
 * to `localStorage` (Agent 6 item 7). Lax is required for Takosumi Accounts
 * to act as an OIDC issuer for apps on other origins: the browser must send
 * the account session on the top-level `/oauth/authorize` navigation.
 */
export function extractAccountSessionId(request: Request): string | null {
  const bearer = bearerToken(request.headers.get("authorization"));
  if (bearer) return bearer;
  const headerSession = request.headers.get("x-takosumi-account-session");
  if (headerSession) return headerSession;
  return readSessionCookie(request.headers.get("cookie"));
}

export const ACCOUNT_SESSION_COOKIE_NAME = "takosumi_session";

function readSessionCookie(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    if (name !== ACCOUNT_SESSION_COOKIE_NAME) continue;
    const rawValue = part.slice(idx + 1).trim();
    try {
      return decodeURIComponent(rawValue);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Mint a fresh opaque session id (`sess_<uuid>`). Use this for every
 * successful authentication so previously-leaked session ids are useless.
 */
export function mintAccountSessionId(): string {
  return `sess_${crypto.randomUUID()}`;
}

/**
 * Rotate an account session: persist a new session_id mapped to `subject`
 * with the same TTL, then delete the old session_id (single-use). Returns
 * the new session_id. If `oldSessionId` is undefined or unknown, only the
 * new session is created.
 *
 * Per Agent 6 item 8, every successful authentication (passkey complete,
 * OAuth callback) must mint a new session_id, even if the caller already
 * had a prior session.
 */
export async function rotateAccountSession(input: {
  store: AccountsStore;
  oldSessionId?: string | null;
  subject: TakosumiSubject;
  now: number;
  ttlMs: number;
}): Promise<{ sessionId: string; expiresAt: number }> {
  const sessionId = mintAccountSessionId();
  const expiresAt = input.now + input.ttlMs;
  await input.store.saveAccountSession({
    sessionId,
    subject: input.subject,
    createdAt: input.now,
    expiresAt,
  });
  if (input.oldSessionId && input.oldSessionId !== sessionId) {
    try {
      await input.store.deleteAccountSession(input.oldSessionId);
    } catch {
      // Best-effort revoke; the new session_id is already persisted.
    }
  }
  return { sessionId, expiresAt };
}

export interface AccountSessionCookieOptions {
  readonly secure: boolean;
  readonly maxAgeSeconds: number;
  readonly path?: string;
}

export function serializeAccountSessionCookie(
  sessionId: string,
  options: AccountSessionCookieOptions,
): string {
  return [
    `${ACCOUNT_SESSION_COOKIE_NAME}=${encodeURIComponent(sessionId)}`,
    `Path=${options.path ?? "/"}`,
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${options.maxAgeSeconds}`,
    options.secure ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

export function clearAccountSessionCookie(secure: boolean): string {
  return [
    `${ACCOUNT_SESSION_COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
    secure ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

export interface AccountSessionMeResponse {
  readonly subject?: TakosumiSubject;
  readonly expiresAt?: number;
  readonly primaryAccountId?: string;
  readonly session?: null;
}

/**
 * GET /v1/account/session/me — return the session subject for the
 * cookie/bearer-presenting browser. Used by the dashboard SPA to
 * mirror the HttpOnly session cookie into its local cache without
 * exposing the raw session id to JavaScript.
 *
 * Returns 200 with `{ subject, expiresAt, primaryAccountId? }` on
 * success. Returns 200 with `{ session: null }` when the cookie /
 * bearer is absent or no longer valid. This route is a public session
 * mirror for the browser shell; protected account/control routes still
 * return 401 through `requireAccountSession` / `requireAccountsBearer`.
 * `primaryAccountId` is omitted when the operator cannot resolve a
 * single primary owning account for this subject.
 */
export async function handleAccountSessionMeGet(input: {
  request: Request;
  store: AccountsStore;
  resolvePrimaryAccountId?: (
    subject: TakosumiSubject,
  ) => Promise<string | undefined> | string | undefined;
}): Promise<Response> {
  const session = await requireAccountSession({
    request: input.request,
    store: input.store,
  });
  if (!session.ok) {
    return json({ session: null }, 200, { "cache-control": "no-store" });
  }
  const record = await input.store.findAccountSession(session.sessionId);
  // The session existed when requireAccountSession resolved (we re-fetch only
  // to surface expiresAt without re-running the full guard).
  const expiresAt = record?.expiresAt ?? 0;
  const primaryAccountId = input.resolvePrimaryAccountId
    ? await input.resolvePrimaryAccountId(session.subject)
    : undefined;
  const body: AccountSessionMeResponse =
    primaryAccountId !== undefined
      ? {
          subject: session.subject,
          expiresAt,
          primaryAccountId,
        }
      : {
          subject: session.subject,
          expiresAt,
        };
  return json(body, 200, { "cache-control": "no-store" });
}

/**
 * DELETE /v1/account/session/me — clear the HttpOnly session cookie
 * and revoke the server-side session record. Returns 204 on success.
 *
 * Idempotent: if no session is presented, we still emit the
 * `Max-Age=0` Set-Cookie header so the browser drops any stale cookie
 * that might still be sitting around.
 */
export async function handleAccountSessionMeDelete(input: {
  request: Request;
  store: AccountsStore;
  secureCookie: boolean;
}): Promise<Response> {
  const sessionId = extractAccountSessionId(input.request);
  if (sessionId && sessionId.startsWith("sess_")) {
    try {
      await input.store.deleteAccountSession(sessionId);
    } catch {
      // Best-effort: clearing the cookie below is the user-visible
      // contract; a store error must not leave the cookie set.
    }
  }
  const cookie = clearAccountSessionCookie(input.secureCookie);
  return new Response(null, {
    status: 204,
    headers: {
      "set-cookie": cookie,
      "cache-control": "no-store",
    },
  });
}

export async function requireAccountsBearer(input: {
  request: Request;
  store: AccountsStore;
  scope: AccountsBearerRequiredScope;
}): Promise<
  { ok: true; auth: AccountsBearerSubject } | { ok: false; response: Response }
> {
  // PAT callers send the secret in the Authorization header; session
  // callers may send the session_id in the header OR the takosumi_session
  // HttpOnly cookie. Look at the Authorization header first because it is
  // the only place a PAT secret can arrive.
  const headerToken =
    bearerToken(input.request.headers.get("authorization")) ??
    input.request.headers.get("x-takosumi-account-session");
  const token = headerToken ?? extractAccountSessionId(input.request);
  if (!token) {
    return { ok: false, response: bearerChallenge("invalid_token") };
  }
  if (token.startsWith("sess_")) {
    const session = await requireAccountSession(input);
    if (!session.ok) return session;
    return {
      ok: true,
      auth: { subject: session.subject, credential: "session" },
    };
  }
  if (!token.startsWith("takpat_")) {
    return { ok: false, response: bearerChallenge("invalid_token") };
  }
  const record = await input.store.findPersonalAccessToken(token);
  if (!record || !personalAccessTokenIsActive(record, Date.now())) {
    return { ok: false, response: bearerChallenge("invalid_token") };
  }
  if (!personalAccessTokenHasScope(record.scopes, input.scope)) {
    return {
      ok: false,
      response: errorJson(
        "insufficient_scope",
        "insufficient scope",
        403,
        undefined,
        {
          "www-authenticate": `Bearer error="insufficient_scope", scope="${input.scope}"`,
        },
      ),
    };
  }
  await input.store.recordPersonalAccessTokenUsed(record.tokenId, Date.now());
  return {
    ok: true,
    auth: {
      subject: record.subject,
      credential: "personal-access-token",
    },
  };
}

function personalAccessTokenHasScope(
  scopes: readonly TakosumiAccountsPatScope[],
  required: AccountsBearerRequiredScope,
): boolean {
  if (scopes.includes("admin")) return true;
  if (required === "admin") return false;
  return scopes.includes(required);
}
