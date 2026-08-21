import { expect, test } from "bun:test";
import { createApiApp } from "../../../core/api/app.ts";

test("FormActivation HTTP family is not mounted by the service app", async () => {
  const app = await createApiApp({
    role: "takosumi-api",
    registerOpenApiRoute: false,
    registerReadinessRoutes: false,
    registerDeployControlInternalRoutes: false,
    registerResourceShapeRoutes: false,
    registerOfferingCatalogRoutes: false,
    registerInterfaceRoutes: false,
  });

  for (const path of [
    "/v1/form-activations",
    "/v1/form-activations/activation_1",
  ]) {
    const response = await app.request(path, {
      headers: { authorization: "Bearer retired-form-token" },
    });
    expect(response.status).toBe(404);
  }
});
