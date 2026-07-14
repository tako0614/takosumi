import type {
  TakosumiAccountsPatScope,
  TakosumiSubject,
} from "@takosjp/takosumi-accounts-contract";
import { TAKOSUMI_ACCOUNTS_CAPSULE_OAUTH_SCOPES } from "@takosjp/takosumi-accounts-contract";
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
import { findActiveAccessToken } from "./access-token-activity.ts";

export const TAKOSUMI_ACCOUNTS_SESSION_ME_PATH = "/v1/account/session/me";

export type AccountsBearerRequiredScope = "read" | "write" | "admin";

export type AccountsBearerSubject = {
  readonly subject: TakosumiSubject;
  /**
   * OIDC client-local subject (`sub`) carried by an OAuth access token.
   * This is the subject an InterfaceBinding targets. It is intentionally
   * distinct from the stable Takosumi account subject used for account-plane
   * authorization.
   */
  readonly principalSubject?: string;
  readonly credential:
    "session" | "personal-access-token" | "oauth-access-token";
  readonly workspaceId?: string;
};

export async function requireAccountSession(input: {
  request: Request;
  store: AccountsStore;
}): Promise<
  | { ok: true; subject: TakosumiSubject; sessionId: string }
  | { ok: false; response: Response }
> {
  const sessionId = extractAccountSessionId(input.request);
  // This guard accepts sessions only, so the lexical check validates the
  // canonical format minted by this service; it does not route among
  // credential kinds. Multi-kind account/control authentication resolves
  // exact persisted records in requireAccountsBearer instead.
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
 *   1. The `Authorization: Bearer ...` header (non-cookie session clients).
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
  // Non-session credentials arrive in the Authorization header. Sessions may
  // also arrive in that header, the explicit session header, or the HttpOnly
  // cookie. An explicit header always wins over a cookie so a stale browser
  // session cannot override the caller's selected credential.
  const headerToken =
    bearerToken(input.request.headers.get("authorization")) ??
    input.request.headers.get("x-takosumi-account-session");
  const token = headerToken ?? extractAccountSessionId(input.request);
  if (!token) {
    return { ok: false, response: bearerChallenge("invalid_token") };
  }

  // Token prefixes are generation/display formatting only. Resolve the same
  // opaque value against every credential store so authorization follows the
  // authenticated persisted record rather than caller-controlled spelling.
  // Parallel exact lookups also avoid a prefix-dependent fast path and keep
  // durable stores free to hash lookup keys internally.
  const now = Date.now();
  const [sessionRecord, accessRecord, personalAccessTokenRecord] =
    await Promise.all([
      input.store.findAccountSession(token),
      findActiveAccessToken({ store: input.store, token, now }),
      input.store.findPersonalAccessToken(token),
    ]);

  let sessionSubject: TakosumiSubject | undefined;
  if (sessionRecord) {
    if (sessionRecord.expiresAt <= now) {
      await input.store.deleteAccountSession(token);
    } else {
      const account = await input.store.findAccount(sessionRecord.subject);
      if (account) {
        sessionSubject = sessionRecord.subject;
      } else {
        await input.store.deleteAccountSession(token);
      }
    }
  }

  const interfaceOAuth = accessRecord?.role === "interface-runtime";
  const oauthAccessTokenCandidate =
    accessRecord?.takosumiSubject && !interfaceOAuth
      ? {
          record: accessRecord,
          takosumiSubject: accessRecord.takosumiSubject,
        }
      : undefined;
  const activePersonalAccessTokenRecord =
    personalAccessTokenRecord &&
    personalAccessTokenIsActive(personalAccessTokenRecord, now)
      ? personalAccessTokenRecord
      : undefined;
  const candidateCount =
    Number(sessionSubject !== undefined) +
    Number(oauthAccessTokenCandidate !== undefined) +
    Number(activePersonalAccessTokenRecord !== undefined);

  // Interface OAuth is audience-bound invocation authority, never an
  // account/control-plane credential. Any cross-store collision is likewise
  // rejected rather than choosing an order-dependent principal.
  if (interfaceOAuth || candidateCount !== 1) {
    return { ok: false, response: bearerChallenge("invalid_token") };
  }

  if (sessionSubject) {
    return {
      ok: true,
      auth: { subject: sessionSubject, credential: "session" },
    };
  }

  if (oauthAccessTokenCandidate) {
    const { record, takosumiSubject } = oauthAccessTokenCandidate;
    if (!oauthAccessTokenHasScope(record.scope, input.scope)) {
      return {
        ok: false,
        response: errorJson(
          "insufficient_scope",
          "insufficient scope",
          403,
          undefined,
          {
            "www-authenticate": `Bearer error="insufficient_scope", scope="${oauthScopeForRequiredAccess(input.scope)}"`,
          },
        ),
      };
    }
    return {
      ok: true,
      auth: {
        subject: takosumiSubject,
        principalSubject: record.subject,
        credential: "oauth-access-token",
        ...(record.workspaceId ? { workspaceId: record.workspaceId } : {}),
      },
    };
  }

  // candidateCount === 1 guarantees this record exists after the two branches
  // above. Keep the guard explicit so future candidate kinds remain fail-closed.
  if (!activePersonalAccessTokenRecord) {
    return { ok: false, response: bearerChallenge("invalid_token") };
  }
  if (
    !personalAccessTokenHasScope(
      activePersonalAccessTokenRecord.scopes,
      input.scope,
    )
  ) {
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
  await input.store.recordPersonalAccessTokenUsed(
    activePersonalAccessTokenRecord.tokenId,
    now,
  );
  return {
    ok: true,
    auth: {
      subject: activePersonalAccessTokenRecord.subject,
      credential: "personal-access-token",
      ...(activePersonalAccessTokenRecord.workspaceId
        ? { workspaceId: activePersonalAccessTokenRecord.workspaceId }
        : {}),
    },
  };
}

function oauthScopeForRequiredAccess(
  required: AccountsBearerRequiredScope,
): (typeof TAKOSUMI_ACCOUNTS_CAPSULE_OAUTH_SCOPES)[number] {
  return required === "read" ? "capsules:read" : "capsules:write";
}

function oauthAccessTokenHasScope(
  scope: string,
  required: AccountsBearerRequiredScope,
): boolean {
  if (required === "admin") return false;
  const scopes = new Set(scope.split(/\s+/u).filter(Boolean));
  if (scopes.has("capsules:write")) return true;
  return required === "read" && scopes.has("capsules:read");
}

export function bearerWorkspaceAllows(
  auth: AccountsBearerSubject,
  workspaceId: string,
): boolean {
  return !auth.workspaceId || auth.workspaceId === workspaceId;
}

function personalAccessTokenHasScope(
  scopes: readonly TakosumiAccountsPatScope[],
  required: AccountsBearerRequiredScope,
): boolean {
  if (scopes.includes("admin")) return true;
  if (required === "admin") return false;
  return scopes.includes(required);
}
