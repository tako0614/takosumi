import assert from "node:assert/strict";
import { test } from "bun:test";

import { createApiApp } from "../../../core/api/app.ts";
import {
  ALWAYS_MOUNTED_ENDPOINTS,
  ROUTE_FAMILIES,
} from "../../../core/api/route_families.ts";

/**
 * The descriptor table and the mount calls are two statements about which
 * routes exist, and only one of the five families was ever compared with the
 * router: `edge_public_paths_test.ts` mounted `registerInterfaceRoutes` alone.
 * A route added to any other family's registrar — or a descriptor added with
 * no registrar behind it — could not be caught, and the capabilities inventory
 * and the OpenAPI document both derive from that table.
 *
 * So this builds the REAL app with every family mounted and diffs what the
 * router actually dispatches against what the table declares, in both
 * directions. `app.ts` keeps its explicit mount calls on purpose — ordering and
 * per-family option validation are behaviourally sensitive — but they can no
 * longer disagree with the table without failing here.
 */
async function mountedRoutes(): Promise<ReadonlySet<string>> {
  const stub = {} as never;
  const app = await createApiApp({
    role: "takosumi-api",
    registerOpenApiRoute: true,
    registerReadinessRoutes: true,
    registerDeployControlInternalRoutes: true,
    deployControlInternalRouteOptions: {} as never,
    registerMetricsRoutes: true,
    metricsRouteOptions: { observability: stub } as never,
    registerInterfaceRoutes: true,
    interfaceRouteOptions: { service: stub } as never,
  });
  const routes = (app as unknown as {
    readonly routes: readonly { readonly path: string; readonly method: string }[];
  }).routes;
  return new Set(
    routes
      // `ALL /*` is middleware, not a dispatchable endpoint.
      .filter((route) => route.method !== "ALL")
      .map((route) => `${route.method} ${route.path}`),
  );
}

function declaredRoutes(): ReadonlySet<string> {
  return new Set(
    [
      ...ALWAYS_MOUNTED_ENDPOINTS,
      ...ROUTE_FAMILIES.flatMap((family) => family.endpoints),
    ].map((endpoint) => `${endpoint.method} ${endpoint.path}`),
  );
}

test("every dispatched route is declared by a route family", async () => {
  const mounted = await mountedRoutes();
  const declared = declaredRoutes();
  assert.deepEqual(
    [...mounted].filter((route) => !declared.has(route)).sort(),
    [],
    "a registrar mounts a route no descriptor declares; capabilities and OpenAPI would both omit it",
  );
});

test("every declared route is actually dispatched", async () => {
  const mounted = await mountedRoutes();
  const declared = declaredRoutes();
  assert.deepEqual(
    [...declared].filter((route) => !mounted.has(route)).sort(),
    [],
    "a descriptor declares a route no registrar mounts; capabilities and OpenAPI would both publish a 404",
  );
});

test("the comparison covers every family, not one of them", async () => {
  // The previous check mounted `registerInterfaceRoutes` alone. Assert the
  // coverage relation rather than a count: every family with endpoints must
  // contribute at least one route the real router dispatches.
  const mounted = await mountedRoutes();
  for (const family of ROUTE_FAMILIES) {
    if (family.endpoints.length === 0) continue;
    const contributed = family.endpoints.some((endpoint) =>
      mounted.has(`${endpoint.method} ${endpoint.path}`),
    );
    assert.equal(contributed, true, `family ${family.id} dispatches nothing`);
  }
  for (const endpoint of ALWAYS_MOUNTED_ENDPOINTS) {
    assert.equal(
      mounted.has(`${endpoint.method} ${endpoint.path}`),
      true,
      `always-mounted ${endpoint.method} ${endpoint.path} is not dispatched`,
    );
  }
});
