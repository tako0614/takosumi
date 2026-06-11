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
// This set must cover EVERY non-`/dashboard` path the accounts handler routes,
// or `not_found_handling = single-page-application` would shadow it with
// index.html. The complete handler surface (see
// `packages/accounts-service/src/mod.ts` dispatch + contract path constants) is:
//   /.well-known/openid-configuration, /oauth/*, /start,
//   /v1/account/*, /v1/billing/*, /v1/auth/* (passkeys + upstream OAuth
//   authorize/callback), /v1/installations*, and
//   /internal/workload-platform-services/resolve.
export const ACCOUNTS_API_PREFIXES = [
  // The edge-public deploy-control surface. Must be matched here or the SPA
  // `not_found_handling = single-page-application` fallback would shadow it
  // with index.html. NOTE `/api/v1` is NOT under `/v1`, so it needs its own entry.
  "/api/v1",
  "/v1",
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
