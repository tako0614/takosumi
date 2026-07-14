/**
 * Static dashboard-SPA serving for the Bun + Postgres reference distribution.
 *
 * Parity with the Cloudflare Workers Static Assets profile
 * (`deploy/accounts-cloudflare`): the same dashboard SPA build
 * (`dashboard/dist`) is served from the one composed app, and non-API
 * navigations fall back to `index.html` so the SPA's
 * client router owns deep links. API namespaces are excluded so the accounts /
 * service handler keeps owning them.
 *
 * Bun-first: file reads go through `Bun.file`. Under the Node serve fallback (`Bun`
 * undefined, used by tests / external embedders) static serving is disabled,
 * preserving the prior JSON-404 behavior.
 */

import {
  ACCOUNTS_IDENTITY_PREFIX,
  API_V1_PREFIX,
} from "takosumi-contract/api-surface";

// Mirror of deploy/accounts-cloudflare/src/routes.ts ACCOUNTS_API_PREFIXES.
// Both derive from the same prefix registry (`takosumi-contract/api-surface`)
// and a test asserts they do not drift. Every non-`/dashboard` path the
// accounts/service handler routes must be covered, or the SPA fallback would
// shadow it. `/healthz` is handled by `preHandle` before static serving, so it
// is not repeated here. `/dashboard/*` is
// intentionally absent: the SPA owns the dashboard UI now that the former
// server-HTML dashboard has been removed from accounts-service.
export const ACCOUNTS_API_PREFIXES = [
  API_V1_PREFIX,
  ACCOUNTS_IDENTITY_PREFIX,
  "/oauth",
  "/.well-known",
  "/internal",
];

function isApiPath(pathname: string): boolean {
  const p = pathname === "/" ? "/" : pathname.replace(/\/+$/g, "");
  return ACCOUNTS_API_PREFIXES.some(
    (prefix) => p === prefix || p.startsWith(`${prefix}/`),
  );
}

interface BunFileLike {
  exists(): Promise<boolean>;
  readonly type: string;
  stream(): ReadableStream<Uint8Array>;
}
interface BunGlobal {
  file(path: string): BunFileLike;
}

function bunRuntime(): BunGlobal | undefined {
  return (globalThis as { Bun?: BunGlobal }).Bun;
}

/**
 * Resolve the dashboard SPA build directory. Honors
 * `TAKOSUMI_ACCOUNTS_STATIC_DIR`; otherwise falls back to the in-repo
 * dashboard build output relative to this module. Returns `undefined` when
 * the directory has no `index.html` (e.g. dev / tests with no SPA build) or
 * when not running on Bun, which disables static serving and preserves the
 * prior behavior.
 */
export async function resolveStaticAssetsDir(
  env: Record<string, string | undefined>,
): Promise<string | undefined> {
  const bun = bunRuntime();
  if (!bun) return undefined;
  const override = env.TAKOSUMI_ACCOUNTS_STATIC_DIR?.trim();
  const dir =
    override && override.length > 0
      ? stripTrailingSlash(override)
      : stripTrailingSlash(
          new URL("../../../dashboard/dist", import.meta.url).pathname,
        );
  if (await bun.file(`${dir}/index.html`).exists()) return dir;
  return undefined;
}

export type StaticAssetResponder = (
  req: Request,
) => Promise<Response | undefined>;

/**
 * Build a responder that serves a static file from `dir` for non-API GET/HEAD
 * requests, falling back to `index.html` (SPA) for extensionless navigations.
 * Returns `undefined` to fall through to the API handlers.
 */
export function createStaticAssetResponder(dir: string): StaticAssetResponder {
  const bun = bunRuntime();
  return async (req) => {
    if (!bun) return undefined;
    if (req.method !== "GET" && req.method !== "HEAD") return undefined;
    const url = new URL(req.url);
    if (isApiPath(url.pathname)) return undefined;

    const rel = safeRelativePath(decodeURIComponent(url.pathname));
    if (rel !== undefined) {
      const hit = bun.file(`${dir}/${rel}`);
      if (await hit.exists()) {
        return fileResponse(hit, req.method, "public, max-age=3600");
      }
      // A path that looks like a file (has an extension) but is missing must
      // 404 rather than masking a broken asset request with index.html.
      if (hasFileExtension(rel)) {
        return new Response("not found", { status: 404 });
      }
    }
    // SPA fallback for navigations (root + extensionless deep links).
    const index = bun.file(`${dir}/index.html`);
    if (!(await index.exists())) return undefined;
    return fileResponse(index, req.method, "no-cache");
  };
}

function fileResponse(
  file: BunFileLike,
  method: string,
  cacheControl: string,
): Response {
  const headers = new Headers({
    "content-type": file.type || "application/octet-stream",
    "cache-control": cacheControl,
    "x-content-type-options": "nosniff",
  });
  if (method === "HEAD") return new Response(null, { headers });
  return new Response(file.stream(), { headers });
}

/**
 * Map a request pathname to a directory-relative file path, refusing any
 * traversal (`..`), empty, or backslash segment. Returns `undefined` for the
 * root path (so the caller serves the SPA fallback) and for unsafe input.
 */
function safeRelativePath(pathname: string): string | undefined {
  const trimmed = pathname.replace(/^\/+/, "");
  if (trimmed === "") return undefined;
  const segments = trimmed.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") return undefined;
    if (segment.includes("\\")) return undefined;
  }
  return segments.join("/");
}

function hasFileExtension(rel: string): boolean {
  const last = rel.split("/").pop() ?? "";
  return last.includes(".");
}

function stripTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}
