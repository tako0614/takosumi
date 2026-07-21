import assert from "node:assert/strict";
import { test } from "bun:test";
import { Hono } from "hono";
import {
  edgeApiPathExposure,
  edgeExposureForEndpointPath,
} from "../../../core/api/edge_public_paths.ts";
import {
  registerResourceShapeRoutes,
  type RegisterResourceShapeRoutesOptions,
} from "../../../core/api/resource_routes.ts";
import { registerInterfaceRoutes } from "../../../core/api/interface_routes.ts";
import { registerFormActivationRoutes } from "../../../core/api/form_activation_routes.ts";
import { ROUTE_FAMILIES } from "../../../core/api/route_families.ts";
import { TAKOFORM_FORM_HOST_WELL_KNOWN_PATH } from "takosumi-contract";

/**
 * The gate the platform worker uses is static, so nothing stops it from
 * disagreeing with the router — that disagreement is the defect this file
 * exists for. Mount the real registrars and require that every path they
 * actually register is covered.
 */
function mountedRouterPaths(): readonly string[] {
  const app = new Hono();
  const stub = {} as never;
  registerResourceShapeRoutes(app, {
    service: stub,
    interfaceDeclarations: stub,
  } as unknown as RegisterResourceShapeRoutesOptions);
  registerInterfaceRoutes(app, { service: stub } as never);
  registerFormActivationRoutes(app, { service: stub } as never);
  return [...new Set(app.routes.map((route) => route.path))];
}

test("every mounted route path has a declared edge exposure", () => {
  for (const path of mountedRouterPaths()) {
    // Throws when a path belongs to no family inventory.
    edgeExposureForEndpointPath(path);
  }
});

test("every session-exposed route path is routed by the platform gate", () => {
  const concrete = (path: string): string =>
    path
      .split("/")
      .map((segment) => (segment.startsWith(":") ? "sample" : segment))
      .join("/");

  for (const path of mountedRouterPaths()) {
    const exposure = edgeExposureForEndpointPath(path);
    if (exposure === "off") continue;
    assert.equal(
      edgeApiPathExposure(concrete(path)),
      exposure,
      `mounted path ${path} is declared ${exposure} but the gate does not route it`,
    );
  }
});

test("the routes the previous hand-written gate missed are routed", () => {
  // Regression pins for the exact paths that were advertised and 404ing.
  assert.equal(edgeApiPathExposure("/v1/form-availability"), "session");
  assert.equal(
    edgeApiPathExposure(TAKOFORM_FORM_HOST_WELL_KNOWN_PATH),
    "public",
  );
  assert.equal(
    edgeApiPathExposure("/apis/forms.takoform.com/v1alpha1/forms"),
    "session",
  );
  assert.equal(
    edgeApiPathExposure(
      "/apis/forms.takoform.com/v1alpha1/resources/EdgeWorker/site",
    ),
    "session",
  );
  assert.equal(
    edgeApiPathExposure("/apis/forms.takoform.com/v1alpha1/interfaces"),
    "session",
  );
});

test("account-plane and operator-only surfaces stay off the edge gate", () => {
  assert.equal(edgeApiPathExposure("/api/v1/workspaces"), undefined);
  assert.equal(edgeApiPathExposure("/internal/v1/workspaces"), undefined);
  assert.equal(edgeApiPathExposure("/v1/form-activations"), undefined);
  assert.equal(edgeApiPathExposure("/.well-known/takosumi"), undefined);
  assert.equal(edgeApiPathExposure("/metrics"), undefined);
});

test("the portable Form host facade is part of the published route inventory", () => {
  const resourceShape = ROUTE_FAMILIES.find(
    (family) => family.id === "resource-shape",
  );
  assert.notEqual(resourceShape, undefined);
  const paths = resourceShape?.endpoints.map((endpoint) => endpoint.path) ?? [];
  assert.equal(paths.includes(TAKOFORM_FORM_HOST_WELL_KNOWN_PATH), true);
  assert.equal(paths.includes("/v1/form-availability"), true);
});
