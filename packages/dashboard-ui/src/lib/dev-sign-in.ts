export interface DevSignInContext {
  readonly isDevBuild: boolean;
  readonly flag?: string;
  readonly hostname?: string;
}

export function isLocalDashboardHost(hostname: string | undefined): boolean {
  const normalized = (hostname ?? "").toLowerCase().replace(/^\[(.*)\]$/, "$1");
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".test")
  );
}

export function shouldShowDevSignIn(context: DevSignInContext): boolean {
  const flagEnabled = context.flag === "1" || context.flag === "true";
  if (!context.isDevBuild && !flagEnabled) return false;
  return isLocalDashboardHost(context.hostname);
}

export function shouldShowBrowserDevSignIn(): boolean {
  return shouldShowDevSignIn({
    isDevBuild: import.meta.env.DEV,
    flag: import.meta.env.VITE_TAKOSUMI_DASHBOARD_DEV_SIGN_IN,
    hostname: globalThis.location?.hostname,
  });
}
