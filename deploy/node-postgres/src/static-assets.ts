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
  API_V1_PREFIX,
  RETIRED_V1_PREFIX,
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
  RETIRED_V1_PREFIX,
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

// HTML documents name content-hashed assets, so a cached page could keep
// pointing at assets an upgrade removed; they revalidate on every load.
const HTML_CACHE_CONTROL = "no-cache";
const ASSET_CACHE_CONTROL = "public, max-age=3600";

export type StaticAssetResponder = (
  req: Request,
) => Promise<Response | undefined>;

/**
 * Build a responder that serves a static file from `dir` for non-API GET/HEAD
 * requests, falling back to `index.html` (SPA) for extensionless navigations.
 * Returns `undefined` to fall through to the API handlers.
 *
 * HTML pages resolve the way the Cloudflare Static Assets profile's default
 * `auto-trailing-slash` handling does: `/a/b` serves `a/b.html`, `/a/` serves
 * `a/index.html`, and `/a` redirects to `/a/` when only `a/index.html` exists.
 * The docs tree under `dist/docs` (VitePress with `cleanUrls`) depends on this;
 * without it `/docs/` and every `/docs/<page>` fell through to the SPA, which
 * rendered its not-found screen.
 */
export function createStaticAssetResponder(dir: string): StaticAssetResponder {
  const bun = bunRuntime();
  return async (req) => {
    if (!bun) return undefined;
    if (req.method !== "GET" && req.method !== "HEAD") return undefined;
    const url = new URL(req.url);
    if (isApiPath(url.pathname)) return undefined;

    const pathname = decodeURIComponent(url.pathname);
    const directoryRequest = pathname.length > 1 && pathname.endsWith("/");
    const rel = safeRelativePath(
      directoryRequest ? pathname.slice(0, -1) : pathname,
    );
    if (rel !== undefined) {
      if (directoryRequest) {
        const index = bun.file(`${dir}/${rel}/index.html`);
        if (await index.exists()) {
          return fileResponse(index, req.method, HTML_CACHE_CONTROL);
        }
      } else {
        const hit = bun.file(`${dir}/${rel}`);
        if (await hit.exists()) {
          return fileResponse(
            hit,
            req.method,
            rel.endsWith(".html") ? HTML_CACHE_CONTROL : ASSET_CACHE_CONTROL,
          );
        }
        // A path that looks like a file (has an extension) but is missing
        // must 404 rather than masking a broken asset request with index.html.
        if (hasFileExtension(rel)) {
          return new Response("not found", { status: 404 });
        }
        const page = bun.file(`${dir}/${rel}.html`);
        if (await page.exists()) {
          return fileResponse(page, req.method, HTML_CACHE_CONTROL);
        }
        if (await bun.file(`${dir}/${rel}/index.html`).exists()) {
          return new Response(null, {
            status: 307,
            headers: { location: `${url.pathname}/${url.search}` },
          });
        }
      }
    }
    // SPA fallback for navigations (root + extensionless deep links).
    const index = bun.file(`${dir}/index.html`);
    if (!(await index.exists())) return undefined;
    return fileResponse(index, req.method, HTML_CACHE_CONTROL);
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
