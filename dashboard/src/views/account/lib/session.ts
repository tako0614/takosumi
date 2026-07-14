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
import { setCurrentWorkspaceId } from "../../../lib/workspace-state.ts";
import { primeWorkspaceListCache } from "../../../lib/workspace-list.ts";
import {
  fetchDashboardBootstrap,
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

const SESSION_ME_PATH = "/v1/account/session/me";
const CACHE_TTL_MS = 30_000;

const listeners = new Set<(s: SessionRecord | null) => void>();
let cachedSession: SessionRecord | null = null;
let cachedAt = 0;
let initialized = false;
let inflight: Promise<SessionRecord | null> | null = null;

function notify(s: SessionRecord | null): void {
  for (const l of listeners) l(s);
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

async function fetchSessionMe(): Promise<SessionRecord | null> {
  if (typeof fetch === "undefined") return null;
  try {
    const data = await fetchDashboardBootstrap();
    if (!data) throw new Error("dashboard bootstrap unavailable");
    if (Array.isArray(data.workspaces)) {
      primeWorkspaceListCache(data.workspaces);
    }
    return pickResponseRecord(data);
  } catch {
    // Fall back to the account-plane session mirror below. The bootstrap route
    // is an optimization, not the canonical cookie proof.
  }
  try {
    const res = await fetch(SESSION_ME_PATH, {
      method: "GET",
      headers: { accept: "application/json" },
      credentials: "include",
    });
    if (res.status === 401 || res.status === 404) return null;
    if (!res.ok) return null;
    const data = (await res.json()) as SessionMeResponse;
    return pickResponseRecord(data);
  } catch {
    return null;
  }
}

/**
 * Trigger a server roundtrip to refresh the cached session. Resolves
 * with the latest known session record (or null). Subsequent calls
 * while a refresh is inflight return the same promise.
 */
export function refreshSession(): Promise<SessionRecord | null> {
  if (inflight) return inflight;
  inflight = fetchSessionMe().then((s) => {
    cachedSession = s;
    cachedAt = Date.now();
    initialized = true;
    notify(s);
    inflight = null;
    return s;
  });
  return inflight;
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
export function readSession(): SessionRecord | null {
  if (!initialized && !inflight) {
    // Fire-and-forget; listeners will get notified when it resolves.
    void refreshSession();
  } else if (!inflight && !cacheIsFresh()) {
    void refreshSession();
  }
  if (
    cachedSession &&
    cachedSession.expiresAt > 0 &&
    cachedSession.expiresAt < Date.now()
  ) {
    cachedSession = null;
  }
  return cachedSession;
}

/**
 * `writeSession` API: with the HttpOnly cookie model the server
 * is the source of truth, so this just triggers a refresh (the cookie
 * was set by the server's Set-Cookie header before the SPA was
 * navigated here).
 */
export function writeSession(_s: SessionRecord): void {
  // Server is the source of truth; sync our cache from the cookie.
  void refreshSession();
}

/**
 * Clear the local cache and ask the server to revoke the cookie. The
 * server endpoint is responsible for issuing `Set-Cookie: takosumi_session=;
 * Max-Age=0` and removing the session record.
 */
export function clearSession(): void {
  cachedSession = null;
  cachedAt = Date.now();
  initialized = true;
  setCurrentWorkspaceId("");
  notify(null);
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
