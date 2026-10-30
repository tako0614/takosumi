import type {
  TakosumiAccountsPatScope,
  TakosumiSubject,
} from "@takosjp/takosumi-accounts-contract";
import type { CapsuleUninstallRequester } from "takosumi-contract/capsules";
import { appActionAllowed, type AppAccess, type AppAccessResolver, type AppAction } from "../../../contract/app-access.ts";
import type { AccountsStore, AccountSessionRecord } from "./store.ts";
import { hostedIssuerSessionId, hostedOpaqueId, HOSTED_SESSION_IDLE_MS, HOSTED_SESSION_ABSOLUTE_MS } from "./hosted-oidc-profile.ts";
import {
  errorJson,
  bearerChallenge,
  bearerToken,
  json,
} from "./http-helpers.ts";
// Shared PAT-activity predicate. Imported (not re-declared) so the activity
// rule has a single owner and cannot drift between the two call sites.
import { personalAccessTokenAppIdsAreWellFormed, personalAccessTokenIsActive } from "./pat-routes.ts";
import { sha256Text } from "./encoding.ts";
import { reportLegacyWorkspaceClaim } from "./legacy-workspace-telemetry.ts";
import {
  findActiveAccessToken,
  validateActiveAccessTokenRecord,
} from "./access-token-activity.ts";

export const TAKOSUMI_ACCOUNTS_SESSION_ME_PATH = "/api/v1/account/session/me";

export type AccountsBearerRequiredScope = TakosumiAccountsPatScope;

export type AccountsBearerSubject = {
  readonly subject: TakosumiSubject;
  /** Server-derived, value-free evidence for deadline reauthorization. */
  readonly uninstallRequester: CapsuleUninstallRequester;
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
  readonly appIds?: readonly string[];
  /** Registered OAuth client of an OAuth access token; telemetry only. */
  readonly oauthClientId?: string;
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
  if (!session || session.expiresAt <= Date.now() || (session.policy === "hosted" && (!session.absoluteExpiresAt || session.absoluteExpiresAt <= Date.now() || !Number.isSafeInteger(session.authTime)))) {
    if (session) await input.store.deleteAccountSession(sessionId);
    return { ok: false, response: bearerChallenge("invalid_session") };
  }
  const account = await input.store.findAccount(session.subject);
  if (!account) {
    await input.store.deleteAccountSession(sessionId);
    return { ok: false, response: bearerChallenge("invalid_session") };
  }
  if (session.policy === "hosted") {
    const now = Date.now();
    if (!(await hostedSessionIsCurrent(input.store,session,now))) return {ok:false,response:bearerChallenge("invalid_session")};
    if (!input.store.touchHostedAccountSession || !(await input.store.touchHostedAccountSession(sessionId, now, Math.min(now + HOSTED_SESSION_IDLE_MS, session.absoluteExpiresAt!)))) {
      return { ok: false, response: bearerChallenge("invalid_session") };
    }
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
export const HOSTED_ACCOUNT_SESSION_COOKIE_NAME = "__Host-takosumi_session";

function readSessionCookie(header: string | null): string | null {
  if (!header) return null;
  for (const expected of [HOSTED_ACCOUNT_SESSION_COOKIE_NAME, ACCOUNT_SESSION_COOKIE_NAME]) {
    for (const part of header.split(";")) {
      const idx = part.indexOf("=");
      if (idx === -1 || part.slice(0,idx).trim() !== expected) continue;
      try { return decodeURIComponent(part.slice(idx+1).trim()); } catch { return null; }
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
 * Rotate an account session. When a prior id is presented and still exists,
 * the store must atomically persist the new record and revoke the old id;
 * stores without that aggregate port fail closed. A stale cookie whose session
 * is no longer present (for example after a database restore or blue/green
 * cutover) is treated like no prior session, so it cannot permanently lock the
 * browser out of sign-in. Returns the new session id and expiry.
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
  hostedPolicy?: boolean;
  authenticationTime?: number;
  freshlyAuthenticatedAt?: number;
}): Promise<{ sessionId: string; expiresAt: number }> {
  if (input.hostedPolicy && [input.authenticationTime,input.freshlyAuthenticatedAt].some((value)=>value !== undefined && (!Number.isSafeInteger(value) || value < 0 || value > Math.floor(input.now/1000)+60))) {
    throw new TypeError("hosted authentication times must be verified integer timestamps");
  }
  if (input.hostedPolicy) {
    const account = await input.store.findCanonicalAccount?.(input.subject);
    if (!account || account.subject !== input.subject || await input.store.isAccountAuthenticationFenced?.(input.subject)) throw new Error("hosted account authentication is unavailable");
  }
  const identityGeneration = input.hostedPolicy ? await input.store.getAccountAuthenticationGeneration?.(input.subject) : undefined;
  const sessionId = input.hostedPolicy ? hostedOpaqueId("sess_h_") : mintAccountSessionId();
  const expiresAt = input.now + (input.hostedPolicy ? HOSTED_SESSION_IDLE_MS : input.ttlMs);
  const previous = input.oldSessionId ? await input.store.findAccountSession(input.oldSessionId) : undefined;
  let issuerSessionId: string | undefined;
  if (input.hostedPolicy) {
    issuerSessionId = await hostedIssuerSessionId(sessionId);
    if (previous?.policy === "hosted") {
      const previousAnchor = previous.issuerSessionId ?? await hostedIssuerSessionId(input.oldSessionId!);
      const previousGeneration = await input.store.getAccountAuthenticationGeneration?.(previous.subject);
      if (/^sha256:[A-Za-z0-9_-]{43}$/u.test(previousAnchor) &&
        (previous.identityGeneration ?? 0) === previousGeneration &&
        !(await input.store.isAccountAuthenticationFenced?.(previous.subject)) &&
        input.store.isHostedOidcSessionRevoked && !(await input.store.isHostedOidcSessionRevoked(previousAnchor))) {
        issuerSessionId = previousAnchor;
      }
    }
  }
  const next = {
    sessionId,
    subject: input.subject,
    createdAt: input.now,
    expiresAt,
    ...(input.hostedPolicy ? {
      policy: "hosted" as const,
      issuerSessionId,
      identityGeneration,
      authTime: input.authenticationTime ?? Math.floor(input.now / 1000),
      ...(input.freshlyAuthenticatedAt !== undefined ? {reauthenticatedAt:input.freshlyAuthenticatedAt} : {}),
      absoluteExpiresAt: input.now + HOSTED_SESSION_ABSOLUTE_MS,
    } : {}),
  };
  if (input.oldSessionId && input.oldSessionId !== sessionId) {
    if (previous) {
      if (!input.store.replaceAccountSession) {
        throw new Error(
          "account session rotation requires atomic replaceAccountSession store support",
        );
      }
      const replaced = await input.store.replaceAccountSession(
        input.oldSessionId,
        next,
      );
      if (!replaced) {
        throw new Error(
          "account session rotation lost the durable replacement race",
        );
      }
    } else {
      await input.store.saveAccountSession(next);
    }
  } else {
    await input.store.saveAccountSession(next);
  }
  return { sessionId, expiresAt };
}

export interface AccountSessionCookieOptions {
  readonly secure: boolean;
  readonly maxAgeSeconds: number;
  readonly path?: string;
  readonly hostedPolicy?: boolean;
}

export function serializeAccountSessionCookie(
  sessionId: string,
  options: AccountSessionCookieOptions,
): string {
  const hosted = options.hostedPolicy || sessionId.startsWith("sess_h_");
  if (hosted && (!options.secure || (options.path !== undefined && options.path !== "/"))) {
    throw new TypeError("hosted issuer cookies require Secure and Path=/");
  }
  return [
    `${hosted ? HOSTED_ACCOUNT_SESSION_COOKIE_NAME : ACCOUNT_SESSION_COOKIE_NAME}=${encodeURIComponent(sessionId)}`,
    `Path=${options.path ?? "/"}`,
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${hosted ? Math.min(options.maxAgeSeconds, HOSTED_SESSION_ABSOLUTE_MS / 1000) : options.maxAgeSeconds}`,
    options.secure ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

export function clearAccountSessionCookie(secure: boolean, hostedPolicy = false): string {
  return [
    `${hostedPolicy ? HOSTED_ACCOUNT_SESSION_COOKIE_NAME : ACCOUNT_SESSION_COOKIE_NAME}=`,
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
  readonly createdAt?: number;
  readonly expiresAt?: number;
  readonly primaryAccountId?: string;
  readonly session?: null;
}

/**
 * GET /api/v1/account/session/me — return the session subject for the
 * cookie/bearer-presenting browser. Used by the dashboard SPA to
 * mirror the HttpOnly session cookie into its local cache without
 * exposing the raw session id to JavaScript.
 *
 * Returns 200 with `{ subject, createdAt, expiresAt, primaryAccountId? }` on
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
  const createdAt = record?.createdAt ?? 0;
  const primaryAccountId = input.resolvePrimaryAccountId
    ? await input.resolvePrimaryAccountId(session.subject)
    : undefined;
  const body: AccountSessionMeResponse =
    primaryAccountId !== undefined
      ? {
          subject: session.subject,
          createdAt,
          expiresAt,
          primaryAccountId,
        }
      : {
          subject: session.subject,
          createdAt,
          expiresAt,
        };
  return json(body, 200, { "cache-control": "no-store" });
}

/**
 * DELETE /api/v1/account/session/me — clear the HttpOnly session cookie
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
  hostedPolicy?: boolean;
}): Promise<Response> {
  const sessionId = extractAccountSessionId(input.request);
  if (sessionId && sessionId.startsWith("sess_")) {
    try {
      const session = await input.store.findAccountSession(sessionId);
      if (session?.policy === "hosted" || sessionId.startsWith("sess_h_")) {
        if (!input.store.revokeHostedOidcSessionGrants) throw new Error("hosted session revocation unavailable");
        const anchor = await resolveHostedSessionAnchor(input.store,sessionId,session);
        if (anchor) await input.store.revokeHostedOidcSessionGrants(anchor,Date.now());
      }
      await input.store.deleteAccountSession(sessionId);
    } catch {
      return errorJson(
        "session_revocation_unavailable",
        "The session could not be revoked. Try again.",
        503,
        input.request,
        { "cache-control": "no-store" },
      );
    }
  }
  const cookie = clearAccountSessionCookie(input.secureCookie, input.hostedPolicy || sessionId?.startsWith("sess_h_"));
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
  readonly assertActive?: () => void;
  /**
   * True when the same request already authenticated this credential and this
   * call only re-checks it; the Workspace-binding telemetry is then not
   * written a second time.
   */
  readonly recheck?: boolean;
}): Promise<
  { ok: true; auth: AccountsBearerSubject } | { ok: false; response: Response }
> {
  const assertActive = input.assertActive;
  assertActive?.();
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
  // Durable stores may coalesce the exact lookups into one bounded statement;
  // the service still evaluates every candidate and rejects collisions.
  const now = Date.now();
  const resolved = input.store.resolveAccountsBearerCandidates
    ? await input.store.resolveAccountsBearerCandidates(token)
    : undefined;
  assertActive?.();
  const bearerCandidates = resolved
    ? ([
        resolved.session,
        await validateActiveAccessTokenRecord({
          store: input.store,
          token,
          record: resolved.accessToken,
          now,
          ...(assertActive ? { assertActive } : {}),
        }),
        resolved.personalAccessToken,
      ] as const)
    : await Promise.all([
        input.store.findAccountSession(token),
        findActiveAccessToken({ store: input.store, token, now, ...(assertActive ? { assertActive } : {}) }),
        input.store.findPersonalAccessToken(token),
      ]);
  assertActive?.();
  const [sessionRecord, accessRecord, personalAccessTokenRecord] =
    bearerCandidates;

  let sessionSubject: TakosumiSubject | undefined;
  if (sessionRecord) {
    if (sessionRecord.expiresAt <= now || (sessionRecord.policy === "hosted" && (!sessionRecord.absoluteExpiresAt || sessionRecord.absoluteExpiresAt <= now || !Number.isSafeInteger(sessionRecord.authTime)))) {
      assertActive?.();
      await input.store.deleteAccountSession(token);
      assertActive?.();
    } else {
      const account = resolved
        ? resolved.sessionAccount
        : await input.store.findAccount(sessionRecord.subject);
      assertActive?.();
      let current = Boolean(account) && sessionRecord.policy !== "hosted";
      if (account && sessionRecord.policy === "hosted" &&
        await hostedSessionIsCurrent(input.store, sessionRecord, now, assertActive)) {
        assertActive?.();
        if (input.store.touchHostedAccountSession) {
          current = await input.store.touchHostedAccountSession(token, now, Math.min(now + HOSTED_SESSION_IDLE_MS, sessionRecord.absoluteExpiresAt!));
          assertActive?.();
        }
      }
      if (current) {
        sessionSubject = sessionRecord.subject;
      } else {
        assertActive?.();
        await input.store.deleteAccountSession(token);
        assertActive?.();
      }
    }
  }

  const interfaceOAuth = accessRecord?.role === "interface-runtime" || accessRecord?.oidcProfile === "shared-account";
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
    && personalAccessTokenAppIdsAreWellFormed(personalAccessTokenRecord.appIds)
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
      auth: {
        subject: sessionSubject,
        uninstallRequester: { subject: sessionSubject },
        credential: "session",
      },
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
    const tokenHash = await sha256Text(token);
    assertActive?.();
    return {
      ok: true,
      auth: {
        subject: takosumiSubject,
        uninstallRequester: {
          subject: takosumiSubject,
          grant: {
            kind: "oauth-access-token",
            tokenHash,
          },
        },
        principalSubject: record.subject,
        credential: "oauth-access-token",
        oauthClientId: record.clientId,
        // A Capsule OIDC token is for that installed app, even when its user
        // has no Workspace membership and the live grant omits workspaceId.
        ...(record.capsuleId !== undefined ? { appIds: [record.capsuleId] } : {}),
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
  assertActive?.();
  await input.store.recordPersonalAccessTokenUsed(
    activePersonalAccessTokenRecord.tokenId,
    now,
  );
  assertActive?.();
  if (
    !input.recheck &&
    activePersonalAccessTokenRecord.workspaceId &&
    activePersonalAccessTokenRecord.appIds === undefined
  ) {
    // TASK-0118 Phase 9: a PAT bound only to a Workspace fences every route it
    // calls by that Workspace, successor routes included, and stage 9.4
    // refuses it. Count each use, whatever route it reaches.
    reportLegacyWorkspaceClaim({
      surface: "personal_access_bearer",
      capsuleBound: false,
      appRole: false,
      memberships: false,
    });
  }
  return {
    ok: true,
    auth: {
      subject: activePersonalAccessTokenRecord.subject,
      uninstallRequester: {
        subject: activePersonalAccessTokenRecord.subject,
        grant: {
          kind: "personal-access-token",
          tokenId: activePersonalAccessTokenRecord.tokenId,
        },
      },
      credential: "personal-access-token",
      ...(activePersonalAccessTokenRecord.workspaceId
        ? { workspaceId: activePersonalAccessTokenRecord.workspaceId }
        : {}),
      ...(activePersonalAccessTokenRecord.appIds !== undefined
        ? { appIds: activePersonalAccessTokenRecord.appIds }
        : {}),
    },
  };
}

function oauthScopeForRequiredAccess(
  required: AccountsBearerRequiredScope,
): string {
  if (
    required === "resources:read" ||
    required === "ai.models.read" ||
    required === "ai.chat" ||
    required === "ai.embeddings"
  ) {
    return required;
  }
  return required === "read" ? "capsules:read" : "capsules:write";
}

export function oauthAccessTokenHasScope(
  scope: string,
  required: AccountsBearerRequiredScope,
): boolean {
  if (required === "admin") return false;
  const scopes = new Set(scope.split(/\s+/u).filter(Boolean));
  if (
    required === "resources:read" ||
    required === "ai.models.read" ||
    required === "ai.chat" ||
    required === "ai.embeddings"
  ) {
    return scopes.has(required);
  }
  if (scopes.has("capsules:write")) return true;
  return required === "read" && scopes.has("capsules:read");
}

/**
 * True when a credential may act on `workspaceId`. Workspace-unrestricted
 * credentials (browser sessions, account-wide PATs) pass; a restricted one
 * passes only for its own Workspace. This is a fence, not an authorization —
 * membership is still checked separately.
 */
export function bearerWorkspaceAllows(
  auth: Pick<AccountsBearerSubject, "workspaceId">,
  workspaceId: string,
): boolean {
  return !auth.workspaceId || auth.workspaceId === workspaceId;
}

/** PAT app fence only. Callers must also resolve live AppAccess and action role. */
export function bearerAppAllows(
  auth: Pick<AccountsBearerSubject, "appIds">,
  capsuleId: string,
): boolean {
  return auth.appIds === undefined ||
    (personalAccessTokenAppIdsAreWellFormed(auth.appIds) && auth.appIds.includes(capsuleId));
}

/** Re-evaluate every app request against the token fence and live role. */
export async function resolveBearerAppAccess(input: {
  auth: Pick<AccountsBearerSubject, "subject" | "workspaceId" | "appIds">;
  capsuleId: string;
  action: AppAction;
  resolver: AppAccessResolver | undefined;
  /** Required whenever a legacy Workspace-bound credential is presented. */
  capsuleWorkspaceId?: string;
}): Promise<AppAccess | undefined> {
  if (!bearerAppAllows(input.auth, input.capsuleId) ||
    (input.auth.workspaceId !== undefined &&
      input.auth.workspaceId !== input.capsuleWorkspaceId)) return undefined;
  const access = await input.resolver?.resolveAppAccess(input.auth.subject, input.capsuleId);
  return access?.capsuleId === input.capsuleId &&
    (access.role === "owner" || access.role === "member") &&
    appActionAllowed(access.role, input.action)
    ? access
    : undefined;
}

export function personalAccessTokenHasScope(
  scopes: readonly TakosumiAccountsPatScope[],
  required: AccountsBearerRequiredScope,
): boolean {
  if (scopes.includes("admin")) return true;
  if (required === "admin") return false;
  return scopes.includes(required);
}

export async function handleHostedGlobalLogout(input: {
  request: Request;
  store: AccountsStore;
  issuer: string;
}): Promise<Response> {
  if (input.request.headers.get("origin") !== new URL(input.issuer).origin) {
    return errorJson("csrf_failed", "Origin must exactly match the Accounts issuer.", 403, input.request);
  }
  const sessionId = extractAccountSessionId(input.request);
  if (sessionId && sessionId.startsWith("sess_h_")) {
    if (!input.store.revokeHostedOidcSessionGrants) return errorJson("session_revocation_unavailable", "Session revocation unavailable.", 503, input.request);
    const anchor = await resolveHostedSessionAnchor(input.store,sessionId);
    if (anchor) await input.store.revokeHostedOidcSessionGrants(anchor, Date.now());
    await input.store.deleteAccountSession(sessionId);
  }
  return new Response(null, { status: 204, headers: {
    "set-cookie": clearAccountSessionCookie(true, true), "cache-control": "no-store",
  } });
}

async function hostedSessionIsCurrent(store: AccountsStore, session: AccountSessionRecord, now: number, assertActive?: () => void): Promise<boolean> {
  assertActive?.();
  if (!store.getAccountAuthenticationGeneration || !store.findCanonicalAccount || !store.isAccountAuthenticationFenced ||
    !Number.isSafeInteger(session.authTime) || session.authTime! < 0 || session.authTime! > Math.floor(now/1000)+60 ||
    !session.absoluteExpiresAt || session.absoluteExpiresAt > session.createdAt+HOSTED_SESSION_ABSOLUTE_MS || session.expiresAt > session.absoluteExpiresAt) return false;
  const generation = await store.getAccountAuthenticationGeneration(session.subject);
  assertActive?.();
  if ((session.identityGeneration ?? 0) !== generation) return false;
  const fenced = await store.isAccountAuthenticationFenced(session.subject);
  assertActive?.();
  if (fenced) return false;
  const issuerSessionId = session.issuerSessionId ?? await hostedIssuerSessionId(session.sessionId);
  assertActive?.();
  if (!/^sha256:[A-Za-z0-9_-]{43}$/u.test(issuerSessionId) || !store.isHostedOidcSessionRevoked) return false;
  const revoked = await store.isHostedOidcSessionRevoked(issuerSessionId);
  assertActive?.();
  if (revoked) return false;
  const account = await store.findCanonicalAccount(session.subject);
  assertActive?.();
  return account?.subject === session.subject;
}

async function resolveHostedSessionAnchor(store: AccountsStore, sessionId: string, session?: AccountSessionRecord): Promise<string | undefined> {
  const current = session ?? await store.findAccountSession(sessionId);
  const anchor = current?.issuerSessionId ?? await store.findHostedAccountSessionAnchor?.(sessionId) ??
    (current?.policy === "hosted" ? await hostedIssuerSessionId(sessionId) : undefined);
  // Unknown cookies must not mint arbitrary durable revocation records.
  if (anchor !== undefined && !/^sha256:[A-Za-z0-9_-]{43}$/u.test(anchor)) throw new Error("hosted session anchor is invalid");
  return anchor;
}
