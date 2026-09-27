export const DEFAULT_DASHBOARD_BROWSER_PORT = 4179;

type DashboardBrowserEnvironment = {
  [key: string]: string | undefined;
  TAKOSUMI_DASHBOARD_BROWSER_PORT?: string;
};

export type DashboardBrowserMode = "portable" | "live" | "public-live";

export function resolveDashboardBrowserPort(
  environment: DashboardBrowserEnvironment = process.env,
): number {
  const value = environment.TAKOSUMI_DASHBOARD_BROWSER_PORT?.trim();

  if (!value) return DEFAULT_DASHBOARD_BROWSER_PORT;

  if (!/^\d+$/u.test(value)) {
    throw new Error(
      `TAKOSUMI_DASHBOARD_BROWSER_PORT must be an integer between 1 and 65535; received ${JSON.stringify(value)}`,
    );
  }

  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `TAKOSUMI_DASHBOARD_BROWSER_PORT must be an integer between 1 and 65535; received ${JSON.stringify(value)}`,
    );
  }

  return port;
}

export function resolveDashboardBrowserPortForMode(
  mode: DashboardBrowserMode,
  environment: DashboardBrowserEnvironment = process.env,
): number | undefined {
  return mode === "portable"
    ? resolveDashboardBrowserPort(environment)
    : undefined;
}

export function dashboardBrowserOrigin(
  environment: DashboardBrowserEnvironment = process.env,
): string {
  return `http://127.0.0.1:${resolveDashboardBrowserPort(environment)}`;
}
