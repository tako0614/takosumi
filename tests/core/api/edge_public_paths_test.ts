import assert from "node:assert/strict";
import { test } from "bun:test";
import { Hono } from "hono";
import {
  edgeApiPathExposure,
  edgeExposureForEndpointPath,
} from "../../../core/api/edge_public_paths.ts";
import { registerInterfaceRoutes } from "../../../core/api/interface_routes.ts";
import { mountDeployControlInternalRoutes } from "../../../core/api/deploy_control_internal_routes.ts";
import { registerMetricsRoutes } from "../../../core/api/metrics_routes.ts";
import { registerReadinessRoutes } from "../../../core/api/readiness_routes.ts";

/**
 * The gate the platform worker uses is static, so nothing stops it from
 * disagreeing with the router — that disagreement is the defect this file
 * exists for. Mount the real registrars and require that every path they
 * actually register is covered.
 *
 * All of them, not just Interfaces: mounting one family meant the other four
 * could add an edge-reachable path with no declared exposure. The
 * deploy-control internal seam is the one that matters most here, since its
 * paths are exactly the ones the edge must NOT expose.
 */
function mountedRouterPaths(): readonly string[] {
  const app = new Hono();
  const stub = {} as never;
  registerInterfaceRoutes(app, { service: stub } as never);
  mountDeployControlInternalRoutes(app, {} as never);
  registerMetricsRoutes(app, { observability: stub } as never);
  registerReadinessRoutes(app, { probes: {} as never });
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
    "/.well-known/takoform",
    "/.well-known/takoform/v1alpha1",
    "/apis/forms.takoform.com/v1alpha1/forms",
    "/apis/forms.takoform.com/v1alpha1/form-definitions/ObjectBucket",
    "/apis/forms.takoform.com/v1alpha1/resources/EdgeWorker/site",
    "/apis/forms.takoform.com/v1alpha1/resources/EdgeWorker/site/form-transitions",
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

test("retired Takoform host lanes are absent from edge inventory", () => {
  for (const path of [
    "/.well-known/takoform",
    "/apis/forms.takoform.com/v1alpha1",
    "/apis/forms.takoform.com/v1alpha1/forms",
    "/apis/forms.takoform.com/v1alpha1/resources/ObjectBucket/site/form-transitions",
  ]) {
    assert.equal(edgeApiPathExposure(path), undefined, path);
  }
});
