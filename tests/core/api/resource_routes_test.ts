import assert from "node:assert/strict";
import { test } from "bun:test";
import { Hono } from "hono";
import { createApiApp } from "../../../core/api/app.ts";
import {
  hasFormAvailabilityReadScope,
  hasInterfaceDeclarationWriteScope,
  registerResourceShapeRoutes,
  type RegisterResourceShapeRoutesOptions,
} from "../../../core/api/resource_routes.ts";
import type { ActorContext } from "takosumi-contract";

const stubOptions = {
  service: {} as never,
} satisfies RegisterResourceShapeRoutesOptions;

test("retired Resource Shape HTTP registrar mounts no legacy routes", () => {
  const app = new Hono();
  registerResourceShapeRoutes(app, stubOptions);
  const paths = app.routes.map((route) => route.path);
  for (const path of [
    "/v1/resources",
    "/v1/resources/:kind/:name",
    "/v1/resources/preview",
    "/v1/target-pools",
    "/v1/target-pools/:name",
    "/v1/space-policies",
    "/v1/space-policies/:name",
  ]) {
    assert.equal(paths.includes(path), false, path);
  }
});

test("retired Resource Shape paths stay 404 even with a bearer", async () => {
  const app = await createApiApp({
    registerResourceShapeRoutes: true,
    resourceShapeRouteOptions: {
      ...stubOptions,
      getResourceShapeBearerToken: () => "resource-token",
    },
  });
  for (const path of [
    "/v1/resources",
    "/v1/resources/EdgeWorker/api",
    "/v1/resources/preview",
    "/v1/target-pools/default",
    "/v1/space-policies/default",
  ]) {
    const response = await app.request(path, {
      headers: { authorization: "Bearer resource-token" },
    });
    assert.equal(response.status, 404, path);
  }
});

function actor(scopes?: readonly string[]): ActorContext {
  return {
    actorAccountId: "actor_1",
    roles: ["owner"],
    ...(scopes ? { scopes } : {}),
  };
}

test("portable host scope helpers remain explicit after Resource Shape HTTP retirement", () => {
  assert.equal(hasFormAvailabilityReadScope(actor()), true);
  assert.equal(hasFormAvailabilityReadScope(actor(["forms:read"])), true);
  assert.equal(hasFormAvailabilityReadScope(actor(["resources:write"])), false);
  assert.equal(hasInterfaceDeclarationWriteScope(actor()), true);
  assert.equal(hasInterfaceDeclarationWriteScope(actor(["interfaces:write"])), true);
  assert.equal(hasInterfaceDeclarationWriteScope(actor(["resources:write"])), false);
});
