/**
 * Keeps the local-substrate dynamic Caddy route partition healthy.
 *
 * The old implementation polled the removed legacy deployment route
 * (`/v1/deployments`) for `desired.routes[]`. Takosumi v1's public surface is
 * now the installer API; it intentionally does not expose a deployment list or
 * raw desired-route projection. Until route projection is reintroduced through
 * an operator-internal source, this registrar only preserves Caddyfile-owned
 * static routes and clears stale dynamic `.app.takosumi.test` entries.
 *
 * Static / dynamic partition strategy (no Caddy @id required):
 *
 *   - Static routes (owned by Caddyfile): hosts like accounts.takosumi.test and
 *     kernel.takosumi.test — these do not use the dynamic app suffix.
 *   - Dynamic routes (owned by us): any route whose first matcher's host
 *     ends in `.app.takosumi.test`.
 *
 * Each tick:
 *   1. GET current srv0 routes.
 *   2. Partition into static (untouched) and dynamic (ours to manage).
 *   3. Compute fresh dynamic routes from the operator route source.
 *   4. PATCH srv0 routes to `[...static, ...freshDynamic]`.
 *
 * Idempotent on restart. No bootstrap step needed.
 */

const KERNEL_URL = Deno.env.get("KERNEL_URL") ?? "http://kernel:8788";
const CADDY_ADMIN_URL = Deno.env.get("CADDY_ADMIN_URL") ??
  "http://caddy:2019";
const POLL_INTERVAL_MS = Number(Deno.env.get("POLL_INTERVAL_MS") ?? "5000");
const DYNAMIC_HOST_SUFFIX = Deno.env.get("DYNAMIC_HOST_SUFFIX") ??
  ".app.takosumi.test";

interface KernelDeploymentRoute {
  readonly host?: string;
  readonly upstream?: string;
  readonly upstreamPort?: number;
}

interface KernelDeployment {
  readonly id: string;
  readonly status: string;
  readonly desired?: { readonly routes?: readonly KernelDeploymentRoute[] };
}

interface CaddyMatcher {
  readonly host?: readonly string[];
}

interface CaddyRoute {
  readonly match?: readonly CaddyMatcher[];
  readonly handle?: readonly Record<string, unknown>[];
  readonly terminal?: boolean;
}

function fetchAppliedDeployments(): Promise<readonly KernelDeployment[]> {
  void KERNEL_URL;
  return Promise.resolve([]);
}

async function fetchCaddyRoutes(): Promise<readonly CaddyRoute[]> {
  const res = await fetch(
    `${CADDY_ADMIN_URL}/config/apps/http/servers/srv0/routes`,
  );
  if (!res.ok) {
    console.warn(
      `[route-registrar] Caddy admin returned ${res.status} when fetching routes`,
    );
    return [];
  }
  const body = await res.json() as readonly CaddyRoute[] | null;
  return body ?? [];
}

function isDynamicRoute(route: CaddyRoute): boolean {
  const hosts = route.match?.flatMap((m) => m.host ?? []) ?? [];
  return hosts.some((host) =>
    host.endsWith(DYNAMIC_HOST_SUFFIX) && host !== DYNAMIC_HOST_SUFFIX.slice(1)
  );
}

function caddyRouteFor(route: KernelDeploymentRoute): CaddyRoute | null {
  if (!route.host || !route.upstream) return null;
  if (!route.host.endsWith(DYNAMIC_HOST_SUFFIX)) {
    console.warn(
      `[route-registrar] kernel emitted route for host=${route.host} which does not end in ${DYNAMIC_HOST_SUFFIX}; skipping`,
    );
    return null;
  }
  const port = route.upstreamPort ?? 80;
  return {
    match: [{ host: [route.host] }],
    handle: [{
      handler: "reverse_proxy",
      upstreams: [{ dial: `${route.upstream}:${port}` }],
    }],
    terminal: true,
  };
}

async function tick(): Promise<void> {
  try {
    const [deployments, currentRoutes] = await Promise.all([
      fetchAppliedDeployments(),
      fetchCaddyRoutes(),
    ]);
    const staticRoutes = currentRoutes.filter((r) => !isDynamicRoute(r));
    const dynamicRoutes: CaddyRoute[] = [];
    for (const dep of deployments) {
      if (dep.status !== "applied") continue;
      for (const route of dep.desired?.routes ?? []) {
        const caddyRoute = caddyRouteFor(route);
        if (caddyRoute) dynamicRoutes.push(caddyRoute);
      }
    }
    const merged = [...dynamicRoutes, ...staticRoutes];
    const res = await fetch(
      `${CADDY_ADMIN_URL}/config/apps/http/servers/srv0/routes`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(merged),
      },
    );
    if (!res.ok) {
      const text = await res.text();
      console.warn(
        `[route-registrar] Caddy admin PATCH returned ${res.status}: ${text}`,
      );
      return;
    }
    console.log(
      `[route-registrar] synced ${dynamicRoutes.length} dynamic route(s); ${staticRoutes.length} static route(s) preserved`,
    );
  } catch (error) {
    console.warn(`[route-registrar] tick error: ${(error as Error).message}`);
  }
}

console.log(
  `[route-registrar] watching ${KERNEL_URL} -> ${CADDY_ADMIN_URL} every ${POLL_INTERVAL_MS}ms ` +
    `(dynamic host suffix=${DYNAMIC_HOST_SUFFIX})`,
);

await tick();
setInterval(tick, POLL_INTERVAL_MS);
