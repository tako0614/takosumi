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
import { ROUTE_FAMILIES } from "../../../core/api/route_families.ts";
import {
  TAKOFORM_FORM_HOST_FORM_DEFINITIONS_PATH,
  TAKOFORM_FORM_HOST_WELL_KNOWN_PATH,
} from "takosumi-contract";

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

test("legacy Flow-B paths stay off the default edge gate", () => {
  for (const path of [
    "/v1/form-availability",
    TAKOFORM_FORM_HOST_WELL_KNOWN_PATH,
    "/apis/forms.takoform.com/v1alpha1/forms",
    `${TAKOFORM_FORM_HOST_FORM_DEFINITIONS_PATH}/ObjectBucket`,
    "/apis/forms.takoform.com/v1alpha1/resources/EdgeWorker/site",
    "/v1/resources/ObjectBucket/site",
    "/v1/target-pools/default",
    "/v1/space-policies/default",
    "/v1/form-activations",
  ]) {
    assert.equal(edgeApiPathExposure(path), undefined, path);
  }
  // The generic Interface API is not part of Flow-B and remains session-routed.
  assert.equal(edgeApiPathExposure("/api/v1/interfaces"), "session");
  assert.equal(edgeApiPathExposure("/v1/interfaces"), undefined);
  assert.equal(
    edgeApiPathExposure("/api/v1/interfaces/if_1/bindings"),
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

test("the retained portable Form host facade stays out of edge discovery", () => {
  const resourceShape = ROUTE_FAMILIES.find(
    (family) => family.id === "resource-shape",
  );
  assert.notEqual(resourceShape, undefined);
  const paths = resourceShape?.endpoints.map((endpoint) => endpoint.path) ?? [];
  assert.equal(paths.includes(TAKOFORM_FORM_HOST_WELL_KNOWN_PATH), true);
  assert.equal(
    paths.includes(`${TAKOFORM_FORM_HOST_FORM_DEFINITIONS_PATH}/:kind`),
    true,
  );
  assert.equal(paths.includes("/v1/form-availability"), false);
  assert.equal(
    edgeExposureForEndpointPath(TAKOFORM_FORM_HOST_WELL_KNOWN_PATH),
    "off",
  );
  assert.equal(edgeApiPathExposure("/v1/form-availability"), undefined);
});
