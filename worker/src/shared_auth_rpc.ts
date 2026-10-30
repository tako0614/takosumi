/**
 * Optional operator authentication port. The private RP owns opaque sessions,
 * token custody and current issuer checks. No browser-supplied account context
 * enters this port as authority, and the stock OSS composition never enables it.
 */
export type SharedAuthIdentity =
  | { readonly kind: "authenticated"; readonly accountId: string }
  | { readonly kind: "unauthenticated" }
  | { readonly kind: "unavailable" };

export type SharedAuthWorkspace =
  | {
      readonly kind: "authorized";
      readonly accountId: string;
      readonly workspaceId: string;
      readonly role: "owner" | "admin" | "member" | "viewer";
    }
  | { readonly kind: "forbidden" }
  | { readonly kind: "unavailable" };

/**
 * The private RP's answer to a Takosumi Mobile code exchange. `sessionToken`
 * is the opaque secret of an RP session of the browser's kind; `expiresAt` is
 * its absolute expiry in epoch seconds. `refused` covers every verification
 * failure without saying which one.
 */
export type SharedAuthNativeExchange =
  | {
      readonly kind: "established";
      readonly sessionToken: string;
      readonly accountId: string;
      readonly expiresAt: number;
    }
  | { readonly kind: "refused" }
  | { readonly kind: "unavailable" };

export type SharedAuthNativeRevocation =
  | { readonly kind: "revoked" }
  | { readonly kind: "unauthenticated" }
  | { readonly kind: "unavailable" };

export interface SharedAuthRpc {
  fetchSharedAuth(request: Request): Promise<Response | null>;
  authenticateSharedAuth(request: Request): Promise<SharedAuthIdentity>;
  resolveSharedAuthWorkspace(
    request: Request,
    workspaceId: string,
  ): Promise<SharedAuthWorkspace>;
  /**
   * Optional: Takosumi Mobile sign-in. The request is a gateway-built POST
   * whose only content is the JSON `{code, code_verifier, nonce}`. The RP
   * redeems the code at its own issuer as the Takosumi Mobile client, verifies
   * the ID token and creates a session exactly as its browser callback does.
   * See docs/operations/shared-account-authentication.md.
   */
  exchangeSharedAuthNativeSession?(
    request: Request,
  ): Promise<SharedAuthNativeExchange>;
  /** Optional: signs out a session presented in the native session header. */
  revokeSharedAuthNativeSession?(
    request: Request,
  ): Promise<SharedAuthNativeRevocation>;
}

export interface SharedAuthEnvironment {
  readonly TAKOSUMI_SHARED_AUTH_PROFILE?: string;
  readonly TAKOSUMI_SHARED_AUTH_ORIGIN?: string;
  readonly TAKOSUMI_ENVIRONMENT?: string;
  /**
   * The issuer humans sign in with on this host (the one the private RP
   * uses). Advertised to Takosumi Mobile together with its client id; the
   * gateway itself never talks to it.
   */
  readonly TAKOSUMI_SHARED_AUTH_ISSUER?: string;
  /** Takosumi Mobile's client at that issuer. Only the RP holds its secret. */
  readonly TAKOSUMI_SHARED_AUTH_MOBILE_CLIENT_ID?: string;
  readonly HOSTED?: unknown;
}

/**
 * Takosumi Mobile presents its RP session here instead of a cookie. The
 * header is never ambient (a browser never adds it by itself, and setting it
 * cross-origin needs a CORS preflight this host does not grant), so a request
 * carrying it is not exposed to CSRF the way a cookie is.
 */
export const SHARED_AUTH_NATIVE_SESSION_HEADER = "x-takosumi-native-session";
/** Takosumi Mobile exchanges its authorization code here. */
export const SHARED_AUTH_NATIVE_EXCHANGE_PATH = "/api/v1/account/session/mobile-exchange";
/** The HTTPS redirect URI registered at the issuer for Takosumi Mobile. */
export const SHARED_AUTH_NATIVE_CALLBACK_PATH = "/auth/oidc/native/callback";
/** The one place the callback hands the authorization response to. */
export const SHARED_AUTH_NATIVE_APP_REDIRECT = "takosumi://oauth/callback";
/** The identity scopes the RP needs for a refreshable, revocable session. */
export const SHARED_AUTH_NATIVE_SCOPE = "openid email offline_access";

export interface SharedAuthNativeSignIn {
  readonly issuer: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly sessionExchange: string;
  readonly sessionHeader: typeof SHARED_AUTH_NATIVE_SESSION_HEADER;
  readonly scope: typeof SHARED_AUTH_NATIVE_SCOPE;
}

const NATIVE_SESSION_TOKEN = /^[A-Za-z0-9_-]{32,256}$/u;
const NATIVE_CLIENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const NATIVE_ACCOUNT_ID = /^tsub_[A-Za-z0-9_-]{1,124}$/u;
/**
 * Origins a native app's HTTP stack sends. Tauri's HTTP plugin always adds
 * the webview's origin; other native clients send none. A web origin means a
 * browser, which never holds this credential.
 */
const NATIVE_REQUEST_ORIGINS = new Set([
  "null",
  "tauri://localhost",
  "http://tauri.localhost",
  "https://tauri.localhost",
]);

const SHARED_AUTH_PATHS = new Set([
  "/auth/oidc/login",
  "/auth/oidc/callback",
  "/auth/oidc/logout",
  "/auth/oidc/session",
]);
const SHARED_AUTH_ABSENCE_HEADER = "x-takosumi-shared-auth-absent";
const NOTIFICATION_PUSHER_ROUTE = /^\/api\/v1\/account\/notification-pushers(?:\/[^/]+)?$/u;
const BILLING_TRACE_HEADER = "x-takosumi-internal-billing-trace";
const BILLING_TRACE = /^brpc_[0-9a-f]{32}$/u;

export function sharedAuthConfigured(env: SharedAuthEnvironment): boolean {
  return env.TAKOSUMI_SHARED_AUTH_PROFILE !== undefined ||
    env.TAKOSUMI_SHARED_AUTH_ORIGIN !== undefined;
}

function composition(env: SharedAuthEnvironment): {
  readonly origin: string;
  readonly rpc: SharedAuthRpc;
} | undefined {
  if (!sharedAuthConfigured(env)) return undefined;
  if (
    env.TAKOSUMI_SHARED_AUTH_PROFILE !== "shared-account" ||
    env.TAKOSUMI_ENVIRONMENT !== "staging" ||
    typeof env.TAKOSUMI_SHARED_AUTH_ORIGIN !== "string"
  ) throw new TypeError("shared authentication configuration is invalid");
  const origin = new URL(env.TAKOSUMI_SHARED_AUTH_ORIGIN);
  if (
    origin.protocol !== "https:" ||
    origin.username || origin.password ||
    origin.origin !== env.TAKOSUMI_SHARED_AUTH_ORIGIN
  ) throw new TypeError("shared authentication origin is invalid");
  const rpc = env.HOSTED;
  if (!rpc || typeof rpc !== "object" ||
    typeof (rpc as Partial<SharedAuthRpc>).fetchSharedAuth !== "function" ||
    typeof (rpc as Partial<SharedAuthRpc>).authenticateSharedAuth !== "function" ||
    typeof (rpc as Partial<SharedAuthRpc>).resolveSharedAuthWorkspace !== "function") {
    throw new TypeError("shared authentication service is unavailable");
  }
  return { origin: origin.origin, rpc: rpc as SharedAuthRpc };
}

function safeId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/u.test(value);
}

async function boundedRpc<T>(call: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      call(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("shared authentication unavailable")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export type SharedAuthNativeLane = "absent" | "accepted" | "refused";

/**
 * Whether a request presents a Takosumi Mobile session and may use it. It is
 * refused when it is malformed, when it comes with another credential
 * (`Authorization`, an issuer-session header), or when the request looks like
 * a browser's (`Sec-Fetch-*`, or a web `Origin`). A Cookie header is not a
 * reason to refuse: native HTTP stacks keep cookie jars, and the gateway never
 * forwards a cookie on this lane, so it cannot become the credential.
 */
export function sharedAuthNativeLane(request: Request): SharedAuthNativeLane {
  const value = request.headers.get(SHARED_AUTH_NATIVE_SESSION_HEADER);
  if (value === null) return "absent";
  // A repeated header arrives joined with ", " and fails the format.
  if (!NATIVE_SESSION_TOKEN.test(value)) return "refused";
  if (request.headers.has("authorization") ||
    request.headers.has("proxy-authorization") ||
    request.headers.has("x-takosumi-account-session")) return "refused";
  for (const name of request.headers.keys()) {
    if (name.startsWith("sec-fetch-")) return "refused";
  }
  const origin = request.headers.get("origin");
  if (origin !== null && !NATIVE_REQUEST_ORIGINS.has(origin)) return "refused";
  return "accepted";
}

/** True when this request authenticates with a usable Takosumi Mobile session. */
export function sharedAuthNativeSessionPresented(request: Request): boolean {
  return sharedAuthNativeLane(request) === "accepted";
}

function requestForRpc(request: Request, includeBody = false, billingTrace?: string): Request {
  // An allowlist prevents present and future public context headers from
  // becoming authenticated assertions at the private service boundary. A
  // native session travels alone: no cookie, Origin or fetch metadata, so the
  // RP cannot fall back from it to a browser session or the reverse.
  const lane = sharedAuthNativeLane(request);
  const headers = new Headers();
  const names = lane === "accepted"
    ? [SHARED_AUTH_NATIVE_SESSION_HEADER, "accept"]
    : lane === "refused"
      ? ["accept"]
      : ["cookie", "origin", "sec-fetch-site", "accept"];
  for (const name of names) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  if (includeBody) {
    const contentType = request.headers.get("content-type");
    if (contentType !== null) headers.set("content-type", contentType);
  }
  // This value is generated by the App billing handler, never copied from a
  // browser header and never interpreted as an authentication assertion.
  if (billingTrace !== undefined && BILLING_TRACE.test(billingTrace)) {
    headers.set(BILLING_TRACE_HEADER, billingTrace);
  }
  return new Request(request.url, {
    method: request.method,
    headers,
    ...(includeBody && request.method !== "GET" && request.method !== "HEAD"
      ? { body: request.body }
      : {}),
    redirect: "manual",
  });
}

export function sharedAuthUnavailableResponse(): Response {
  return Response.json({ error: "authentication_unavailable" }, {
    status: 503,
    headers: { "cache-control": "no-store" },
  });
}

/** Validate the existing operator opt-in before any alternate credential lane.
 * Authentication of an independent actor still belongs to its actual verifier. */
export function sharedAuthRequestFailure(
  request: Request,
  env: SharedAuthEnvironment,
): Response | undefined {
  if (!sharedAuthConfigured(env)) return undefined;
  try {
    composition(env);
  } catch {
    return sharedAuthUnavailableResponse();
  }
  if (/^Bearer\s/iu.test(request.headers.get("authorization") ?? "") &&
    (request.headers.has("cookie") || request.headers.has("x-takosumi-account-session"))) {
    return Response.json({ error: "unauthenticated" }, {
      status: 401, headers: { "cache-control": "no-store" },
    });
  }
  // A native session that is malformed, mixed with another credential or sent
  // by a browser is refused on every path, never ignored.
  if (sharedAuthNativeLane(request) === "refused") {
    return Response.json({ error: "unauthenticated" }, {
      status: 401, headers: { "cache-control": "no-store" },
    });
  }
  return undefined;
}

/**
 * Takosumi Mobile's sign-in on this host, when the operator configured it:
 * the issuer the private RP uses and Takosumi Mobile's client there. Anything
 * partial or malformed is treated as not configured.
 */
export function sharedAuthNativeSignIn(
  env: SharedAuthEnvironment,
): SharedAuthNativeSignIn | undefined {
  if (!sharedAuthConfigured(env)) return undefined;
  if (env.TAKOSUMI_SHARED_AUTH_ISSUER === undefined &&
    env.TAKOSUMI_SHARED_AUTH_MOBILE_CLIENT_ID === undefined) return undefined;
  let selected: ReturnType<typeof composition>;
  try {
    selected = composition(env);
  } catch {
    return undefined;
  }
  if (!selected) return undefined;
  const issuer = env.TAKOSUMI_SHARED_AUTH_ISSUER;
  const clientId = env.TAKOSUMI_SHARED_AUTH_MOBILE_CLIENT_ID;
  if (typeof issuer !== "string" || typeof clientId !== "string" ||
    !NATIVE_CLIENT_ID.test(clientId)) return undefined;
  try {
    const url = new URL(issuer);
    if (url.protocol !== "https:" || url.username || url.password ||
      url.origin !== issuer || url.origin === selected.origin) return undefined;
  } catch {
    return undefined;
  }
  return {
    issuer,
    clientId,
    redirectUri: `${selected.origin}${SHARED_AUTH_NATIVE_CALLBACK_PATH}`,
    sessionExchange: `${selected.origin}${SHARED_AUTH_NATIVE_EXCHANGE_PATH}`,
    sessionHeader: SHARED_AUTH_NATIVE_SESSION_HEADER,
    scope: SHARED_AUTH_NATIVE_SCOPE,
  };
}

/** Product RP boundary only; the dedicated issuer's account routes retain
 * their own standard token/grant handler on the issuer origin. */
export async function handleSharedAuthAccountBoundaryRequest(
  request: Request,
  env: SharedAuthEnvironment,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  const legacyHumanPath = ["/sign-in", "/api/v1/auth", "/api/v1/account",
    "/api/v1/privacy", "/oauth/authorize", "/oauth/upstream"].some(
    (path) => url.pathname === path || url.pathname.startsWith(`${path}/`),
  );
  if (!sharedAuthConfigured(env) || !legacyHumanPath) {
    return undefined;
  }
  const ingressFailure = sharedAuthRequestFailure(request, env);
  if (ingressFailure) return ingressFailure;
  // This exact operation has its own operator-secret verifier in Accounts;
  // it never authenticates a human session. Keep that existing owner lane.
  if (request.method === "POST" &&
    /^\/api\/v1\/privacy\/requests\/prq_[a-z0-9]{20}\/complete$/u.test(url.pathname)) {
    return undefined;
  }
  try {
    const selected = composition(env);
    if (!selected) return sharedAuthUnavailableResponse();
    // Opt-in applies to the deployed product, including workers.dev, previews
    // and alternate routes. An unrecognized URL is never a legacy issuer.
    if (url.origin !== selected.origin) {
      return Response.json({ error: "not found" }, {
        status: 404, headers: { "cache-control": "no-store" },
      });
    }
    if (url.pathname === "/sign-in") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return Response.json({ error: "method_not_allowed" }, {
          status: 405, headers: { allow: "GET, HEAD", "cache-control": "no-store" },
        });
      }
      if ([...url.searchParams.keys()].some((key) =>
        !["return", "return_to"].includes(key) || url.searchParams.getAll(key).length !== 1
      ) || (url.searchParams.has("return") && url.searchParams.has("return_to"))) {
        return Response.json({ error: "invalid_request" }, {
          status: 400, headers: { "cache-control": "no-store" },
        });
      }
      const login = new URL("/auth/oidc/login", selected.origin);
      const destination = sharedAuthLocalReturnPath(
        url.searchParams.get("return") ?? url.searchParams.get("return_to"),
        selected.origin,
      );
      // Unsafe legacy return values keep their existing fixed-login fallback.
      // The private RP validates and retains any accepted local destination.
      if (destination !== undefined) login.searchParams.set("return", destination);
      return new Response(null, { status: 302, headers: {
        location: login.href,
        "cache-control": "no-store",
      } });
    }
    if (url.pathname === "/api/v1/account/session/me") return undefined;
    // Takosumi Mobile's code exchange, served by the platform's own handler.
    if (url.pathname === SHARED_AUTH_NATIVE_EXCHANGE_PATH) return undefined;
    // The account's notification pushers are served on the product host with
    // RP authentication (the platform's own handler): exactly the collection
    // and one item. Anything else under the prefix stays 404 here.
    if (NOTIFICATION_PUSHER_ROUTE.test(url.pathname)) return undefined;
    return Response.json({ error: "not found" }, {
      status: 404, headers: { "cache-control": "no-store" },
    });
  } catch {
    return sharedAuthUnavailableResponse();
  }
}

function sharedAuthLocalReturnPath(value: string | null, origin: string): string | undefined {
  if (!value || value.length > 4096 || new TextEncoder().encode(value).byteLength > 4096 ||
    !value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u0020\u007f]/u.test(value)) return undefined;
  try {
    const target = new URL(value, origin);
    // Dot-segment normalization must not produce a protocol-relative Location.
    if (target.origin !== origin || target.username || target.password || target.pathname.startsWith("//")) return undefined;
    const destination = `${target.pathname}${target.search}${target.hash}`;
    return new TextEncoder().encode(destination).byteLength <= 4096 ? destination : undefined;
  } catch {
    return undefined;
  }
}

function csrfValid(request: Request, origin: string): boolean {
  return request.method === "GET" || request.method === "HEAD" ||
    request.method === "OPTIONS" || request.headers.get("origin") === origin;
}

export async function handleSharedAuthRouteRequest(
  request: Request,
  env: SharedAuthEnvironment,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (!sharedAuthConfigured(env) && request.method === "GET" &&
    url.pathname === "/auth/oidc/session" && url.search === "") {
    // A browser fetch of an unmounted non-API path would otherwise receive
    // the dashboard SPA's HTML 200 from ASSETS. Reserve this one read as an
    // explicit absence so the ordinary shell can use its original bootstrap.
    return Response.json({ error: "not_found" }, {
      status: 404,
      headers: {
        "cache-control": "no-store",
        [SHARED_AUTH_ABSENCE_HEADER]: "1",
      },
    });
  }
  if (!SHARED_AUTH_PATHS.has(url.pathname) || !sharedAuthConfigured(env)) {
    return undefined;
  }
  // These are the browser's cookie routes; a native session has its own
  // exchange and sign-out and never drives a browser login or logout.
  if (request.headers.has("authorization") ||
    request.headers.has("x-takosumi-account-session") ||
    request.headers.has(SHARED_AUTH_NATIVE_SESSION_HEADER)) {
    return Response.json({ error: "unauthenticated" }, {
      status: 401, headers: { "cache-control": "no-store" },
    });
  }
  try {
    const selected = composition(env);
    if (!selected) return undefined;
    if (url.origin !== selected.origin) {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    if (!csrfValid(request, selected.origin)) {
      return Response.json({ error: "csrf_failed" }, {
        status: 403, headers: { "cache-control": "no-store" },
      });
    }
    const response = await boundedRpc(
      () => selected.rpc.fetchSharedAuth(requestForRpc(request, true)), 40_000,
    );
    if (!(response instanceof Response)) return sharedAuthUnavailableResponse();
    const headers = new Headers(response.headers);
    // Only the gateway's profile-OFF branch may mark route absence. A bound RP
    // cannot forge that provenance through the forwarded response headers.
    headers.delete(SHARED_AUTH_ABSENCE_HEADER);
    headers.set("cache-control", "no-store");
    return new Response(response.body, { status: response.status, headers });
  } catch {
    return sharedAuthUnavailableResponse();
  }
}

export async function authenticateSharedAuthRequest(
  request: Request,
  env: SharedAuthEnvironment,
  billingTrace?: string,
): Promise<SharedAuthIdentity | undefined> {
  if (!sharedAuthConfigured(env)) return undefined;
  // Explicit credentials have their own verifier; a failed bearer, forged
  // issuer-session header or raw account assertion cannot fall back to cookies.
  if (request.headers.has("authorization") ||
    request.headers.has("x-takosumi-account-session") ||
    sharedAuthNativeLane(request) === "refused") {
    return { kind: "unauthenticated" };
  }
  try {
    const selected = composition(env);
    if (!selected) return undefined;
    if (new URL(request.url).origin !== selected.origin) {
      return { kind: "unauthenticated" };
    }
    const identity = await boundedRpc(
      () => selected.rpc.authenticateSharedAuth(requestForRpc(request, false, billingTrace)), 5_000,
    );
    if (identity?.kind === "unauthenticated") return { kind: "unauthenticated" };
    if (identity?.kind === "authenticated" && safeId(identity.accountId)) {
      return { kind: "authenticated", accountId: identity.accountId };
    }
    return { kind: "unavailable" };
  } catch {
    return { kind: "unavailable" };
  }
}

export async function resolveSharedAuthWorkspace(
  request: Request,
  env: SharedAuthEnvironment,
  accountId: string,
  workspaceId: string,
): Promise<SharedAuthWorkspace> {
  if (!safeId(accountId) || !safeId(workspaceId)) return { kind: "forbidden" };
  try {
    const selected = composition(env);
    if (!selected || new URL(request.url).origin !== selected.origin) {
      return { kind: "forbidden" };
    }
    const result = await boundedRpc(
      () => selected.rpc.resolveSharedAuthWorkspace(requestForRpc(request), workspaceId),
      5_000,
    );
    if (result?.kind === "forbidden") return { kind: "forbidden" };
    if (result?.kind === "authorized" &&
      result.accountId === accountId && result.workspaceId === workspaceId &&
      ["owner", "admin", "member", "viewer"].includes(result.role)) {
      return {
        kind: "authorized", accountId, workspaceId, role: result.role,
      };
    }
    return { kind: "unavailable" };
  } catch {
    return { kind: "unavailable" };
  }
}

const NO_STORE = { "cache-control": "no-store" } as const;
const CALLBACK_PARAMS = ["code", "state", "iss", "error", "error_description"] as const;
const CALLBACK_TOKEN = /^[\x21-\x7e]{1,2048}$/u;
const CALLBACK_TEXT = /^[\x20-\x7e]{1,512}$/u;
const NATIVE_CODE = /^[\x21-\x7e]{1,2048}$/u;
// RFC 7636 code_verifier; the issuer requires 43..128 for this profile.
const NATIVE_CODE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/u;
// At least 192 bits of a URL-safe random value.
const NATIVE_NONCE = /^[A-Za-z0-9._~-]{32,128}$/u;
const NATIVE_EXCHANGE_BODY_LIMIT = 8 * 1024;
const NATIVE_EXCHANGE_TIMEOUT_MS = 20_000;
const NATIVE_SESSION_MAX_SECONDS = 8 * 24 * 60 * 60;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char]!));
}

/**
 * The HTTPS redirect URI registered at the issuer for Takosumi Mobile. It
 * hands the authorization response (code or error, with state and issuer) to
 * the one fixed app URI and to nothing else, so it is never an open redirect.
 * It answers with a page rather than a redirect: the issuer's consent form
 * restricts where its submission may redirect (CSP form-action), which a
 * second hop to the app's scheme would break. The code is single-use, expires
 * within a minute, and only the RP (holding the client secret) together with
 * the app (holding the PKCE verifier) can redeem it.
 */
export function handleSharedAuthNativeCallbackRequest(
  request: Request,
  env: SharedAuthEnvironment,
): Response | undefined {
  const url = new URL(request.url);
  if (!sharedAuthConfigured(env) || url.pathname !== SHARED_AUTH_NATIVE_CALLBACK_PATH) return undefined;
  let selected: ReturnType<typeof composition>;
  try {
    selected = composition(env);
  } catch {
    return sharedAuthUnavailableResponse();
  }
  const signIn = sharedAuthNativeSignIn(env);
  if (!selected || url.origin !== selected.origin || !signIn) {
    return Response.json({ error: "not found" }, { status: 404, headers: NO_STORE });
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return Response.json({ error: "method_not_allowed" }, {
      status: 405, headers: { allow: "GET, HEAD", ...NO_STORE },
    });
  }
  const keys = [...url.searchParams.keys()];
  const invalid = () => Response.json({ error: "invalid_request" }, { status: 400, headers: NO_STORE });
  if (keys.some((key) => !(CALLBACK_PARAMS as readonly string[]).includes(key) ||
    url.searchParams.getAll(key).length !== 1)) return invalid();
  const value = (key: (typeof CALLBACK_PARAMS)[number]) => url.searchParams.get(key) ?? undefined;
  const code = value("code");
  const state = value("state");
  const issuer = value("iss");
  const error = value("error");
  const description = value("error_description");
  if (state === undefined || !CALLBACK_TOKEN.test(state)) return invalid();
  // RFC 9207: a response that names its issuer must name this host's.
  if (issuer !== undefined && issuer !== signIn.issuer) return invalid();
  if (code !== undefined) {
    if (error !== undefined || description !== undefined || !CALLBACK_TOKEN.test(code)) return invalid();
  } else if (error === undefined || !CALLBACK_TOKEN.test(error) ||
    (description !== undefined && !CALLBACK_TEXT.test(description))) {
    return invalid();
  }
  const target = new URL(SHARED_AUTH_NATIVE_APP_REDIRECT);
  for (const [key, entry] of [
    ["code", code], ["error", error], ["error_description", description],
    ["state", state], ["iss", issuer],
  ] as const) {
    if (entry !== undefined) target.searchParams.set(key, entry);
  }
  const href = escapeHtml(target.href);
  const body = `<!doctype html><html lang="ja"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta http-equiv="refresh" content="0;url=${href}">` +
    `<title>Takosumi Mobile に戻る</title></head><body><main>` +
    `<h1>Takosumi Mobile に戻ります</h1>` +
    `<p>自動で戻らないときは、下のリンクを押してください。</p>` +
    `<p><a href="${href}">Takosumi Mobile を開く</a></p>` +
    `</main></body></html>`;
  return new Response(request.method === "HEAD" ? null : body, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'none'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      ...NO_STORE,
    },
  });
}

/** A per-source limiter; the platform passes the Accounts in-isolate one. */
export interface SharedAuthNativeExchangeLimiter {
  consume(request: Request): Response | undefined;
}

// The native methods are optional on the port, so an RP that predates them
// keeps the browser lane. Each is called as a method of the binding itself.
function hasNativeRpc(
  rpc: SharedAuthRpc,
  name: "exchangeSharedAuthNativeSession" | "revokeSharedAuthNativeSession",
): boolean {
  return typeof (rpc as Partial<SharedAuthRpc>)[name] === "function";
}

async function readNativeExchangeBody(request: Request): Promise<
  { readonly code: string; readonly code_verifier: string; readonly nonce: string } | undefined
> {
  const type = request.headers.get("content-type") ?? "";
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(type.trim())) return undefined;
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > NATIVE_EXCHANGE_BODY_LIMIT)) {
    return undefined;
  }
  if (!request.body) return undefined;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > NATIVE_EXCHANGE_BODY_LIMIT) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  let parsed: unknown;
  try {
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).sort().join() !== "code,code_verifier,nonce") return undefined;
  const { code, code_verifier: verifier, nonce } = record;
  if (typeof code !== "string" || !NATIVE_CODE.test(code) ||
    typeof verifier !== "string" || !NATIVE_CODE_VERIFIER.test(verifier) ||
    typeof nonce !== "string" || !NATIVE_NONCE.test(nonce)) return undefined;
  return { code, code_verifier: verifier, nonce };
}

/**
 * `POST /api/v1/account/session/mobile-exchange`: Takosumi Mobile's sign-in on
 * the shared-account product host. The app ran an authorization-code flow with
 * PKCE and a nonce at the RP's issuer as the Takosumi Mobile client and sends
 * `{code, code_verifier, nonce}`. The private RP redeems the code with the
 * client secret only it holds, verifies the ID token (signature through the
 * issuer's JWKS, `iss`, `aud`/`azp` = the Takosumi Mobile client, `exp`/`iat`,
 * `nonce`), resolves the canonical account as its browser callback does and
 * creates an RP session of the browser's kind. This handler only checks the
 * shape, limits the rate and relays; it never sees a token, never logs the
 * request and never mints an identity of its own.
 */
export async function handleSharedAuthNativeExchangeRequest(
  request: Request,
  env: SharedAuthEnvironment,
  options: { readonly limiter?: SharedAuthNativeExchangeLimiter } = {},
): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (!sharedAuthConfigured(env) || url.pathname !== SHARED_AUTH_NATIVE_EXCHANGE_PATH) return undefined;
  let selected: ReturnType<typeof composition>;
  try {
    selected = composition(env);
  } catch {
    return sharedAuthUnavailableResponse();
  }
  if (!selected || url.origin !== selected.origin || !sharedAuthNativeSignIn(env)) {
    return Response.json({ error: "not found" }, { status: 404, headers: NO_STORE });
  }
  if (request.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, {
      status: 405, headers: { allow: "POST", ...NO_STORE },
    });
  }
  // Signing in presents no credential. One that is present here is a client
  // bug or a probe, and is refused rather than ignored.
  if (request.headers.has("authorization") || request.headers.has("proxy-authorization") ||
    request.headers.has("x-takosumi-account-session") ||
    request.headers.has(SHARED_AUTH_NATIVE_SESSION_HEADER)) {
    return Response.json({ error: "unauthenticated" }, { status: 401, headers: NO_STORE });
  }
  // A browser never holds this flow's PKCE verifier; keep the lane native.
  const origin = request.headers.get("origin");
  if ([...request.headers.keys()].some((name) => name.startsWith("sec-fetch-")) ||
    (origin !== null && !NATIVE_REQUEST_ORIGINS.has(origin))) {
    return Response.json({ error: "native_client_required" }, { status: 403, headers: NO_STORE });
  }
  const limited = options.limiter?.consume(request);
  if (limited) {
    const headers = new Headers(limited.headers);
    headers.set("cache-control", "no-store");
    return new Response(limited.body, { status: limited.status, headers });
  }
  const body = await readNativeExchangeBody(request);
  if (!body) return Response.json({ error: "invalid_request" }, { status: 400, headers: NO_STORE });
  if (!hasNativeRpc(selected.rpc, "exchangeSharedAuthNativeSession")) return sharedAuthUnavailableResponse();
  const rpc = selected.rpc;
  let result: SharedAuthNativeExchange;
  try {
    result = await boundedRpc(() => rpc.exchangeSharedAuthNativeSession!(new Request(url.href, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(body),
      redirect: "manual",
    })), NATIVE_EXCHANGE_TIMEOUT_MS);
  } catch {
    return sharedAuthUnavailableResponse();
  }
  if (result?.kind === "refused") {
    // One answer for a wrong issuer, audience, signature, nonce, an expired or
    // replayed code: the app starts a new sign-in either way.
    return Response.json({ error: "sign_in_refused" }, { status: 401, headers: NO_STORE });
  }
  const now = Math.floor(Date.now() / 1000);
  if (result?.kind !== "established" ||
    typeof result.sessionToken !== "string" || !NATIVE_SESSION_TOKEN.test(result.sessionToken) ||
    typeof result.accountId !== "string" || !NATIVE_ACCOUNT_ID.test(result.accountId) ||
    !Number.isSafeInteger(result.expiresAt) || result.expiresAt <= now ||
    result.expiresAt > now + NATIVE_SESSION_MAX_SECONDS) {
    return sharedAuthUnavailableResponse();
  }
  return Response.json({
    token_type: "takosumi-native-session",
    session_token: result.sessionToken,
    session_header: SHARED_AUTH_NATIVE_SESSION_HEADER,
    account_id: result.accountId,
    expires_at: result.expiresAt,
  }, { status: 200, headers: { ...NO_STORE, pragma: "no-cache" } });
}

/** Signs out the native session this request presents, at the private RP. */
export async function revokeSharedAuthNativeSession(
  request: Request,
  env: SharedAuthEnvironment,
): Promise<SharedAuthNativeRevocation> {
  if (sharedAuthNativeLane(request) !== "accepted") return { kind: "unauthenticated" };
  try {
    const selected = composition(env);
    if (!selected || new URL(request.url).origin !== selected.origin) {
      return { kind: "unauthenticated" };
    }
    if (!hasNativeRpc(selected.rpc, "revokeSharedAuthNativeSession")) return { kind: "unavailable" };
    const rpc = selected.rpc;
    const result = await boundedRpc(() => rpc.revokeSharedAuthNativeSession!(requestForRpc(request)), 5_000);
    if (result?.kind === "revoked" || result?.kind === "unauthenticated") return { kind: result.kind };
    return { kind: "unavailable" };
  } catch {
    return { kind: "unavailable" };
  }
}
