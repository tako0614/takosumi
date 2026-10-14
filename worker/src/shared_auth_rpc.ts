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

export interface SharedAuthRpc {
  fetchSharedAuth(request: Request): Promise<Response | null>;
  authenticateSharedAuth(request: Request): Promise<SharedAuthIdentity>;
  resolveSharedAuthWorkspace(
    request: Request,
    workspaceId: string,
  ): Promise<SharedAuthWorkspace>;
}

export interface SharedAuthEnvironment {
  readonly TAKOSUMI_SHARED_AUTH_PROFILE?: string;
  readonly TAKOSUMI_SHARED_AUTH_ORIGIN?: string;
  readonly TAKOSUMI_ENVIRONMENT?: string;
  readonly HOSTED?: unknown;
}

const SHARED_AUTH_PATHS = new Set([
  "/auth/oidc/login",
  "/auth/oidc/callback",
  "/auth/oidc/logout",
  "/auth/oidc/session",
]);

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

function requestForRpc(request: Request, includeBody = false): Request {
  // An allowlist prevents present and future public context headers from
  // becoming authenticated assertions at the private service boundary.
  const headers = new Headers();
  for (const name of ["cookie", "origin", "sec-fetch-site", "accept"]) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  if (includeBody) {
    const contentType = request.headers.get("content-type");
    if (contentType !== null) headers.set("content-type", contentType);
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

/** Product RP boundary only; the dedicated issuer's account routes retain
 * their own standard token/grant handler on the issuer origin. */
export async function handleSharedAuthAccountBoundaryRequest(
  request: Request,
  env: SharedAuthEnvironment,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (!sharedAuthConfigured(env) || (url.pathname !== "/sign-in" &&
    url.pathname !== "/api/v1/account" && !url.pathname.startsWith("/api/v1/account/"))) {
    return undefined;
  }
  try {
    const selected = composition(env);
    if (!selected || url.origin !== selected.origin) return undefined;
    if (url.pathname === "/sign-in") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return Response.json({ error: "method_not_allowed" }, {
          status: 405, headers: { allow: "GET, HEAD", "cache-control": "no-store" },
        });
      }
      return new Response(null, { status: 302, headers: {
        location: new URL("/auth/oidc/login", selected.origin).href,
        "cache-control": "no-store",
      } });
    }
    if (url.pathname === "/api/v1/account/session/me") return undefined;
    return Response.json({ error: "not found" }, {
      status: 404, headers: { "cache-control": "no-store" },
    });
  } catch {
    return sharedAuthUnavailableResponse();
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
  if (!SHARED_AUTH_PATHS.has(url.pathname) || !sharedAuthConfigured(env)) {
    return undefined;
  }
  if (request.headers.has("authorization") ||
    request.headers.has("x-takosumi-account-session")) {
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
    headers.set("cache-control", "no-store");
    return new Response(response.body, { status: response.status, headers });
  } catch {
    return sharedAuthUnavailableResponse();
  }
}

export async function authenticateSharedAuthRequest(
  request: Request,
  env: SharedAuthEnvironment,
): Promise<SharedAuthIdentity | undefined> {
  if (!sharedAuthConfigured(env)) return undefined;
  // Explicit credentials have their own verifier; a failed bearer, forged
  // issuer-session header or raw account assertion cannot fall back to cookies.
  if (request.headers.has("authorization") ||
    request.headers.has("x-takosumi-account-session")) {
    return { kind: "unauthenticated" };
  }
  try {
    const selected = composition(env);
    if (!selected) return undefined;
    if (new URL(request.url).origin !== selected.origin) {
      return { kind: "unauthenticated" };
    }
    const identity = await boundedRpc(
      () => selected.rpc.authenticateSharedAuth(requestForRpc(request)), 5_000,
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
