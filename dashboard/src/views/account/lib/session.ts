/**
 * Account-plane session state mirror. Source of truth is the
 * `takosumi_session` HttpOnly cookie set by the in-process account plane
 * (mounted at the worker origin root: `/v1/account/session/me`) on passkey
 * complete / OAuth callback.
 *
 * The cookie is `HttpOnly` so JavaScript cannot read or write it; we
 * therefore mirror it through fetch(`/v1/account/session/me`) which
 * returns the session subject when the cookie is valid, or
 * `{ session: null }` when it's missing / expired. Callers use the cached
 * value via `readSession()` and react to changes via `onSessionChange()`.
 *
 * NOTE: account screens use THIS cookie session (account-plane issuer),
 * which is distinct from the takos product `useAuth()` session. In the
 * merged single-origin world they may converge; keep them separate to
 * start. Ported from takosumi dashboard-ui/src/lib/session.ts.
 *
 * The module keeps a short (30s) TTL on the cached result so the SPA
 * doesn't fire a /me request on every render but still notices a
 * server-side revocation within a reasonable window.
 */
import {
  clearWorkspaceListCache,
  primeWorkspaceListCache,
} from "../../../lib/workspace-list.ts";
import {
  fetchDashboardBootstrap,
  fetchDashboardWorkspaceBootstrap,
  DashboardBootstrapError,
  dashboardFailureKind,
  dashboardResponseErrorDetails,
  type DashboardBootstrapResponse,
} from "../../../lib/dashboard-bootstrap.ts";

export interface SessionRecord {
  readonly subject: string;
  readonly expiresAt: number; // epoch ms; 0 means "server didn't tell us"
  readonly provider?: string;
  readonly displayName?: string;
  readonly email?: string;
  readonly primaryAccountId?: string;
}

export type SessionFailureKind = "maintenance" | "error";

/** A typed failure at the account/session boundary. */
export class SessionError extends Error {
  constructor(
    readonly kind: SessionFailureKind,
    readonly status: number,
    readonly headers: Headers,
    readonly body: unknown,
    message: string,
    readonly code?: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "SessionError";
  }

  get isMaintenance(): boolean {
    return this.kind === "maintenance";
  }
}

export type SessionState =
  | { readonly kind: "loading" }
  | { readonly kind: "authenticated"; readonly session: SessionRecord }
  | { readonly kind: "unauthenticated" }
  | { readonly kind: "maintenance"; readonly error: SessionError }
  | { readonly kind: "error"; readonly error: SessionError };

const SESSION_ME_PATH = "/v1/account/session/me";
const CACHE_TTL_MS = 30_000;

const listeners = new Set<(s: SessionRecord | null) => void>();
const stateListeners = new Set<(state: SessionState) => void>();
let cachedSession: SessionRecord | null = null;
let cachedError: SessionError | null = null;
let cachedAt = 0;
let initialized = false;
let inflight: Promise<SessionRecord | null> | null = null;

function notify(s: SessionRecord | null): void {
  for (const l of listeners) l(s);
}

function notifyState(state: SessionState): void {
  for (const l of stateListeners) l(state);
}

interface SessionMeResponse {
  readonly subject?: string;
  readonly expiresAt?: number;
  readonly primaryAccountId?: string;
  readonly provider?: string;
  readonly displayName?: string;
  readonly email?: string;
  readonly session?: {
    readonly subject: string;
    readonly expiresAt?: number;
    readonly primaryAccountId?: string;
    readonly provider?: string;
    readonly displayName?: string;
    readonly email?: string;
  } | null;
}

function pickResponseRecord(data: SessionMeResponse): SessionRecord | null {
  // `/v1/account/session/me` uses the top-level shape, while the dashboard
  // bootstrap intentionally nests the same canonical fields under `session`.
  if (typeof data?.subject === "string" && data.subject.length > 0) {
    return {
      subject: data.subject,
      expiresAt: data.expiresAt ?? 0,
      provider: data.provider,
      displayName: data.displayName,
      email: data.email,
      primaryAccountId: data.primaryAccountId,
    };
  }
  const nested = data?.session;
  if (nested && typeof nested.subject === "string" && nested.subject) {
    return {
      subject: nested.subject,
      expiresAt: nested.expiresAt ?? 0,
      provider: nested.provider,
      displayName: nested.displayName,
      email: nested.email,
      primaryAccountId: nested.primaryAccountId,
    };
  }
  return null;
}

function isExplicitUnauthenticatedSession(data: unknown): boolean {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return false;
  }
  return (
    Object.prototype.hasOwnProperty.call(data, "session") &&
    (data as { readonly session?: unknown }).session === null
  );
}

interface SessionRefreshOptions {
  /**
   * The authenticated shell always needs the Workspace switcher. Asking the
   * dashboard bootstrap for both records lets that first render share one
   * request with `listWorkspacesCached()` instead of serially fetching a
   * session-only bootstrap and then the Workspace bootstrap.
   */
  readonly includeWorkspaces?: boolean;
}

async function fetchSessionMe(
  options: SessionRefreshOptions = {},
): Promise<SessionRecord | null> {
  if (typeof fetch === "undefined") {
    throw new SessionError(
      "error",
      0,
      new Headers(),
      undefined,
      "Session transport is unavailable.",
    );
  }
  try {
    const data = options.includeWorkspaces
      ? await fetchDashboardWorkspaceBootstrap()
      : await fetchDashboardBootstrap();
    if (!data) return await fetchAccountSessionMe();
    if (Array.isArray(data.workspaces)) {
      primeWorkspaceListCache(data.workspaces);
    }
    const session = pickResponseRecord(data);
    if (!session) {
      throw new SessionError(
        "error",
        200,
        new Headers(),
        data,
        "Dashboard bootstrap response did not contain a session.",
      );
    }
    return session;
  } catch (error) {
    if (error instanceof DashboardBootstrapError) {
      // A non-authentication response is authoritative for this probe. Do not
      // turn a maintenance/error response into a second probe that can produce
      // a misleading empty session (or lose the original headers/body).
      throw new SessionError(
        error.kind,
        error.status,
        error.headers,
        error.body,
        error.message,
        error.code,
        error,
      );
    }
    if (error instanceof SessionError) throw error;
    throw sessionErrorFromUnknown(error);
  }
}

async function fetchAccountSessionMe(): Promise<SessionRecord | null> {
  try {
    const res = await fetch(SESSION_ME_PATH, {
      method: "GET",
      headers: { accept: "application/json" },
      credentials: "include",
    });
    if (res.status === 401 || res.status === 404) return null;
    const body = await readResponseBody(res);
    if (!res.ok) throw sessionErrorFromResponse(res, body);
    const session = pickResponseRecord(body as SessionMeResponse);
    if (!session) {
      if (isExplicitUnauthenticatedSession(body)) return null;
      throw new SessionError(
        "error",
        res.status,
        new Headers(res.headers),
        body,
        "Account session response did not contain a session.",
      );
    }
    return session;
  } catch (error) {
    if (error instanceof SessionError) throw error;
    throw sessionErrorFromUnknown(error);
  }
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => "");
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function sessionErrorFromResponse(
  response: Response,
  body: unknown,
): SessionError {
  const details = dashboardResponseErrorDetails(
    body,
    response.status,
    response.statusText,
  );
  const headers = new Headers(response.headers);
  return new SessionError(
    dashboardFailureKind(response.status, headers, body, details.code),
    response.status,
    headers,
    body,
    details.message,
    details.code,
  );
}

function sessionErrorFromUnknown(error: unknown): SessionError {
  return new SessionError(
    "error",
    0,
    new Headers(),
    undefined,
    error instanceof Error && error.message
      ? error.message
      : "Session transport failed.",
    undefined,
    error,
  );
}

function sessionStateFromError(error: SessionError): SessionState {
  return error.kind === "maintenance"
    ? { kind: "maintenance", error }
    : { kind: "error", error };
}

/**
 * Trigger a server roundtrip to refresh the cached session. Resolves
 * with the latest known session record (or null). Subsequent calls
 * while a refresh is inflight return the same promise.
 */
export function refreshSession(
  options: SessionRefreshOptions = {},
): Promise<SessionRecord | null> {
  if (inflight) return inflight;
  const request = fetchSessionMe(options)
    .then((s) => {
      cachedSession = s;
      cachedError = null;
      cachedAt = Date.now();
      initialized = true;
      if (!s) clearWorkspaceListCache();
      notify(s);
      notifyState(
        s ? { kind: "authenticated", session: s } : { kind: "unauthenticated" },
      );
      return s;
    })
    .catch((error) => {
      const typed =
        error instanceof SessionError ? error : sessionErrorFromUnknown(error);
      cachedSession = null;
      cachedError = typed;
      cachedAt = Date.now();
      initialized = true;
      notifyState(sessionStateFromError(typed));
      throw typed;
    })
    .finally(() => {
      if (inflight === request) inflight = null;
    });
  inflight = request;
  return request;
}

/** Resolve the session probe into an explicit auth/maintenance state. */
export async function refreshSessionState(
  options: SessionRefreshOptions = {},
): Promise<SessionState> {
  try {
    const session = await refreshSession(options);
    return session
      ? { kind: "authenticated", session }
      : { kind: "unauthenticated" };
  } catch (error) {
    const typed =
      error instanceof SessionError ? error : sessionErrorFromUnknown(error);
    return sessionStateFromError(typed);
  }
}

function cacheIsFresh(): boolean {
  if (!initialized) return false;
  if (cachedAt === 0) return false;
  return Date.now() - cachedAt < CACHE_TTL_MS;
}

/**
 * Synchronous accessor for the cached session. Returns null until the
 * first `refreshSession()` resolves. Callers that need a guaranteed
 * up-to-date answer should `await refreshSession()` instead.
 *
 * Calling `readSession()` for the first time triggers a background
 * refresh so the next render has a value. If the cached result is
 * older than `CACHE_TTL_MS` we also kick off a background refresh
 * (but still return the cached value synchronously so the UI doesn't
 * flicker).
 */
export function readSession(
  options: SessionRefreshOptions = {},
): SessionRecord | null {
  const state = readSessionState(options);
  return state.kind === "authenticated" ? state.session : null;
}

/** Synchronous session/auth state mirror for guards and shell composition. */
export function readSessionState(
  options: SessionRefreshOptions = {},
): SessionState {
  if (!initialized && !inflight) {
    // Fire-and-forget; listeners will get notified when it resolves.
    void refreshSession(options).catch(() => undefined);
  } else if (!inflight && !cacheIsFresh()) {
    void refreshSession(options).catch(() => undefined);
  }
  if (
    cachedSession &&
    cachedSession.expiresAt > 0 &&
    cachedSession.expiresAt < Date.now()
  ) {
    cachedSession = null;
  }
  // Preserve the cache-first contract while a stale authenticated session is
  // refreshed in the background. First-load probes and explicit retries still
  // expose `loading` because they have no usable session to render.
  if (cachedSession) return { kind: "authenticated", session: cachedSession };
  if (inflight || !initialized) return { kind: "loading" };
  if (cachedError) return sessionStateFromError(cachedError);
  return { kind: "unauthenticated" };
}

/**
 * `writeSession` API: with the HttpOnly cookie model the server
 * is the source of truth, so this just triggers a refresh (the cookie
 * was set by the server's Set-Cookie header before the SPA was
 * navigated here).
 */
export function writeSession(_s: SessionRecord): void {
  // Server is the source of truth; sync our cache from the cookie.
  void refreshSession().catch(() => undefined);
}

/**
 * Clear the local cache and ask the server to revoke the cookie. The
 * server endpoint is responsible for issuing `Set-Cookie: takosumi_session=;
 * Max-Age=0` and removing the session record.
 *
 * Signing out also arms the sign-in auto-start breaker. The upstream IdP
 * session outlives our cookie, so a single-provider deployment would otherwise
 * bounce the just-signed-out user through /sign-in straight back into a new
 * session without a single click.
 *
 * The cached Workspace *list* is dropped (it is the previous session's
 * projection and must not be shown to whoever signs in next in this tab), but
 * the persisted current-Workspace *selection* is kept: it is validated against
 * the next session's own list by `selectAvailableWorkspaceId`, and discarding
 * it dumped returning users into an arbitrary first Workspace — usually the
 * empty auto-created personal one — which reads as "signed in as someone else".
 */
export function clearSession(): void {
  cachedSession = null;
  cachedError = null;
  cachedAt = Date.now();
  initialized = true;
  clearWorkspaceListCache();
  notify(null);
  notifyState({ kind: "unauthenticated" });
  if (typeof fetch !== "undefined") {
    // keepalive: the caller navigates to /sign-in right after this, which
    // would otherwise abort the revocation and leave the cookie valid
    // server-side while the user believes they signed out. Retry once.
    const revoke = () =>
      fetch(SESSION_ME_PATH, {
        method: "DELETE",
        credentials: "include",
        keepalive: true,
      });
    revoke().catch(() => revoke().catch(() => undefined));
  }
}

export function onSessionChange(
  fn: (s: SessionRecord | null) => void,
): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function onSessionStateChange(
  fn: (state: SessionState) => void,
): () => void {
  stateListeners.add(fn);
  return () => stateListeners.delete(fn);
}
