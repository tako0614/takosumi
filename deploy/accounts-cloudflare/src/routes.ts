export function isWorkerLocalPath(pathname: string): boolean {
  return normalizePathname(pathname) === "/healthz";
}

function normalizePathname(pathname: string): string {
  const withLeadingSlash = pathname.startsWith("/") ? pathname : `/${pathname}`;
  if (withLeadingSlash === "/") return "/";
  return withLeadingSlash.replace(/\/+$/g, "");
}
