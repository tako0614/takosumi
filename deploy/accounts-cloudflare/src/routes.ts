import {
  ACCOUNTS_IDENTITY_PREFIX,
  API_V1_PREFIX,
} from "takosumi-contract/api-surface";

export function isWorkerLocalPath(pathname: string): boolean {
  return normalizePathname(pathname) === "/healthz";
}

// Account-plane / service API namespaces handled by the accounts handler.
// Everything NOT matched here is served as the dashboard SPA from the Worker's
// static assets. `/healthz` and `/__takosumi/exports/*` are handled earlier in
// the Worker, so they are not repeated here. (`/dashboard/*` is intentionally
// NOT in this set: the SPA owns the dashboard UI now that the former
// server-HTML dashboard has been removed from accounts-service.)
//
// Derived from the prefix registry (`takosumi-contract/api-surface`) so this
// hand-maintained classifier cannot drift from the canonical taxonomy:
//   - `API_V1_PREFIX` ("/api/v1") — the edge-public deploy-control surface.
//     NOTE it is NOT under `/v1`, so it needs its own entry or the SPA
//     `not_found_handling = single-page-application` fallback would shadow it.
//   - `ACCOUNTS_IDENTITY_PREFIX` ("/v1") — covers /v1/account, /v1/auth,
//     /v1/billing, /v1/installations, /v1/connections.
//   - the OIDC issuer surfaces (/oauth, /.well-known, /start). `/install` and
//     `/hooks` stay SPA-owned / platform-worker-owned and are intentionally
//     excluded here.
//   - "/internal" — the in-process / container-callback seam (covers the
//     unified `/internal/v1` seam and the workload-platform-services callback).
//
// This set must cover EVERY non-`/dashboard` path the accounts handler routes,
// or the SPA fallback would shadow it with index.html.
export const ACCOUNTS_API_PREFIXES = [
  API_V1_PREFIX,
  ACCOUNTS_IDENTITY_PREFIX,
  "/oauth",
  "/.well-known",
  "/start",
  "/internal",
];

export function isAccountsApiPath(pathname: string): boolean {
  const path = normalizePathname(pathname);
  return ACCOUNTS_API_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
}

function normalizePathname(pathname: string): string {
  const withLeadingSlash = pathname.startsWith("/") ? pathname : `/${pathname}`;
  if (withLeadingSlash === "/") return "/";
  return withLeadingSlash.replace(/\/+$/g, "");
}
