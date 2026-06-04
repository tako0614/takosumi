import { test } from "bun:test";
import assert from "node:assert/strict";
import { createApiCapabilitiesDescription } from "./capabilities.ts";
import { createTakosumiOpenApiDocument } from "./openapi.ts";
import {
  ALWAYS_MOUNTED_ENDPOINTS,
  type ApiEndpoint,
  mountedEndpoints,
  ROUTE_FAMILIES,
  type RouteFamilyMountedFlags,
} from "./route_families.ts";

const ALL_MOUNTED: RouteFamilyMountedFlags = {
  runtimeAgentRoutesMounted: true,
  openApiRouteMounted: true,
  readinessRoutesMounted: true,
  artifactRoutesMounted: true,
  deployControlPublicRoutesMounted: true,
  metricsRoutesMounted: true,
};

function toOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, "{$1}");
}

/**
 * The /capabilities inventory and the /openapi.json paths must be derived from
 * the SAME route-family endpoint descriptors. Before item [17] these were three
 * hand-maintained enumerations that had drifted (deployment-outputs and
 * /v1/artifacts/kinds were missing from one or both; the runtime-agent gateway
 * manifest was missing from capabilities; capabilities invented a
 * `metrics-token` auth value). This locks the two surfaces together.
 */
test("capabilities and openapi cover the same (method, path) endpoint set", () => {
  const capabilities = createApiCapabilitiesDescription(
    "takosumi-api",
    ALL_MOUNTED,
  );
  const openapi = createTakosumiOpenApiDocument(ALL_MOUNTED);

  const capabilityKeys = new Set(
    capabilities.endpoints.map((e) => `${e.method} ${toOpenApiPath(e.path)}`),
  );
  const openapiKeys = new Set<string>();
  for (const [path, item] of Object.entries(openapi.paths)) {
    for (const method of Object.keys(item)) {
      openapiKeys.add(`${method.toUpperCase()} ${path}`);
    }
  }

  assert.deepEqual(
    [...capabilityKeys].sort(),
    [...openapiKeys].sort(),
    "capabilities and openapi must enumerate the identical endpoint set",
  );
});

test("previously-drifted endpoints are present in both surfaces", () => {
  const capabilities = createApiCapabilitiesDescription(
    "takosumi-api",
    ALL_MOUNTED,
  );
  const openapi = createTakosumiOpenApiDocument(ALL_MOUNTED);
  const capPaths = capabilities.endpoints.map((e) => e.path);

  // BUG FIX: deployment-outputs was in openapi but missing from capabilities.
  assert.ok(
    capPaths.includes("/v1/installations/:installationId/deployment-outputs"),
  );
  assert.ok(
    openapi.paths["/v1/installations/{installationId}/deployment-outputs"]?.get,
  );

  // BUG FIX: GET /v1/artifacts/kinds appeared in neither surface.
  assert.ok(capPaths.includes("/v1/artifacts/kinds"));
  assert.ok(openapi.paths["/v1/artifacts/kinds"]?.get);

  // BUG FIX: the runtime-agent gateway manifest was missing from capabilities.
  assert.ok(
    capPaths.includes(
      "/api/internal/v1/runtime/agents/:agentId/gateway-manifest",
    ),
  );
});

test("capabilities and openapi agree on summary and auth per endpoint", () => {
  const capabilities = createApiCapabilitiesDescription(
    "takosumi-api",
    ALL_MOUNTED,
  );
  const openapi = createTakosumiOpenApiDocument(ALL_MOUNTED);

  for (const endpoint of capabilities.endpoints) {
    const path = toOpenApiPath(endpoint.path);
    const item = openapi.paths[path] as Record<string, { summary?: string }>;
    const op = item[endpoint.method.toLowerCase()];
    assert.ok(op, `openapi missing ${endpoint.method} ${path}`);
    assert.equal(
      op.summary,
      endpoint.summary,
      `summary drift for ${endpoint.method} ${path}`,
    );
  }

  // BUG FIX: the metrics endpoint must use the unified `metrics-scrape` auth,
  // not the invented capabilities-only `metrics-token` value.
  const metrics = capabilities.endpoints.find((e) => e.path === "/metrics");
  assert.equal(metrics?.auth, "metrics-scrape");
});

test("mountedEndpoints gates families and always includes process endpoints", () => {
  const none = mountedEndpoints({});
  assert.deepEqual(
    none.map((e) => e.path),
    ALWAYS_MOUNTED_ENDPOINTS.map((e) => e.path),
  );

  const onlyRuntimeAgent = mountedEndpoints({
    runtimeAgentRoutesMounted: true,
  });
  assert.ok(onlyRuntimeAgent.some((e) => e.path.startsWith("/api/internal")));
  assert.ok(!onlyRuntimeAgent.some((e) => e.path === "/metrics"));
});

test("every endpoint descriptor has a unique operationId", () => {
  const all: ApiEndpoint[] = [
    ...ALWAYS_MOUNTED_ENDPOINTS,
    ...ROUTE_FAMILIES.flatMap((f) => f.endpoints),
  ];
  const ids = all.map((e) => e.operationId);
  assert.equal(
    new Set(ids).size,
    ids.length,
    "operationIds must be unique across all families",
  );
});
