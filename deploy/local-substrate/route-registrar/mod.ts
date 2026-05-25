/**
 * Keeps the local-substrate dynamic Caddy route partition healthy.
 *
 * The old implementation polled the removed legacy deployment route
 * (`/v1/deployments`) for `desired.routes[]`. Takosumi v1's public surface is
 * now the installer API; it intentionally does not expose a deployment list.
 * The postgres-profile kernel wrapper writes a local operator projection file
 * whenever the selfhost gateway provider applies a gateway component. This
 * process reads that local projection and turns it into Caddy routes.
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
const GATEWAY_ROUTE_PROJECTION_FILE =
  Deno.env.get("GATEWAY_ROUTE_PROJECTION_FILE") ??
    "/local-substrate-runtime/gateway-routes.json";

interface KernelDeploymentRoute {
  readonly host?: string;
  readonly pathPrefix?: string;
  readonly upstreamDial?: string;
}

interface KernelDeployment {
  readonly id: string;
  readonly status: string;
  readonly desired?: { readonly routes?: readonly KernelDeploymentRoute[] };
}

interface CaddyMatcher {
  readonly host?: readonly string[];
  readonly path?: readonly string[];
}

interface CaddyRoute {
  readonly match?: readonly CaddyMatcher[];
  readonly handle?: readonly Record<string, unknown>[];
  readonly terminal?: boolean;
}

async function fetchAppliedDeployments(): Promise<readonly KernelDeployment[]> {
  void KERNEL_URL;
  const records = await readGatewayProjection(GATEWAY_ROUTE_PROJECTION_FILE);
  return records.map((record) => ({
    id: record.recordName,
    status: "applied",
    desired: {
      routes: (record.routes ?? [])
        .map((route) => ({
          host: record.fqdn,
          pathPrefix: route.pathPrefix,
          upstreamDial: upstreamDialFromTarget(route.target),
        }))
        .filter((route) => route.upstreamDial !== undefined),
    },
  }));
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
  if (!route.host || !route.upstreamDial) return null;
  if (!route.host.endsWith(DYNAMIC_HOST_SUFFIX)) {
    console.warn(
      `[route-registrar] kernel emitted route for host=${route.host} which does not end in ${DYNAMIC_HOST_SUFFIX}; skipping`,
    );
    return null;
  }
  const matcher: { host: string[]; path: string[] } = {
    host: [route.host],
    path: [],
  };
  const path = route.pathPrefix ?? "/";
  if (path !== "/") {
    const normalized = path.endsWith("/") ? path.slice(0, -1) : path;
    matcher.path = [normalized, `${normalized}/*`];
  } else {
    matcher.path = ["/*"];
  }
  return {
    match: [matcher],
    handle: [{
      handler: "reverse_proxy",
      upstreams: [{ dial: route.upstreamDial }],
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
    `(dynamic host suffix=${DYNAMIC_HOST_SUFFIX}, projection=${GATEWAY_ROUTE_PROJECTION_FILE})`,
);

await tick();
setInterval(tick, POLL_INTERVAL_MS);

interface GatewayProjection {
  readonly records?: readonly ProjectedGatewayRecord[];
}

interface ProjectedGatewayRecord {
  readonly recordName: string;
  readonly fqdn: string;
  readonly listener?: string;
  readonly routes?: readonly ProjectedGatewayRoute[];
}

interface ProjectedGatewayRoute {
  readonly pathPrefix?: string;
  readonly target?: string;
}

async function readGatewayProjection(
  file: string,
): Promise<readonly ProjectedGatewayRecord[]> {
  let text: string;
  try {
    text = await Deno.readTextFile(file);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
  const parsed = JSON.parse(text) as GatewayProjection;
  if (!Array.isArray(parsed.records)) return [];
  const latestByHostAndListener = new Map<string, ProjectedGatewayRecord>();
  for (const record of parsed.records) {
    if (
      typeof record.recordName !== "string" ||
      typeof record.fqdn !== "string"
    ) {
      continue;
    }
    const listener = typeof record.listener === "string" ? record.listener : "";
    const key = `${record.fqdn}\0${listener}`;
    latestByHostAndListener.delete(key);
    latestByHostAndListener.set(key, record);
  }
  return [...latestByHostAndListener.values()]
    .filter((record) =>
      typeof record.recordName === "string" &&
      typeof record.fqdn === "string"
    )
    .map((record) => ({
      recordName: record.recordName,
      fqdn: record.fqdn,
      listener: typeof record.listener === "string" ? record.listener : "",
      routes: Array.isArray(record.routes)
        ? record.routes.filter((route: ProjectedGatewayRoute) =>
          typeof route.pathPrefix === "string" &&
          typeof route.target === "string"
        )
        : [],
    }));
}

function upstreamDialFromTarget(
  target: string | undefined,
): string | undefined {
  if (!target) return undefined;
  try {
    const url = new URL(target);
    const port = url.port ||
      (url.protocol === "https:"
        ? "443"
        : url.protocol === "http:"
        ? "80"
        : "");
    if (!url.hostname || !port) return undefined;
    return `${url.hostname}:${port}`;
  } catch {
    return target.includes(":") ? target : undefined;
  }
}
