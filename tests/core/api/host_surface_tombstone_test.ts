import { expect, test } from "bun:test";
import { createApiApp } from "../../../core/api/app.ts";

test("core API does not mount or advertise the retired Takoform Host lanes", async () => {
  const app = await createApiApp({
    role: "takosumi-api",
    registerOpenApiRoute: true,
    registerReadinessRoutes: false,
    registerInterfaceRoutes: false,
    getOpenApiBearerToken: () => "inventory-token",
  });

  for (const path of [
    "/.well-known/takoform",
    "/.well-known/takoform/v1alpha1",
    "/.well-known/takoform/v1alpha2",
    "/.well-known/takoform/v1alpha3",
    "/apis/forms.takoform.com/v1alpha1",
    "/apis/forms.takoform.com/v1alpha1/forms",
    "/apis/forms.takoform.com/v1alpha1/form-definitions/ObjectBucket",
    "/apis/forms.takoform.com/v1alpha1/interfaces",
    "/apis/forms.takoform.com/v1alpha1/resources/ObjectBucket/assets",
    "/apis/forms.takoform.com/v1alpha1/resources/ObjectBucket/assets/form-transitions",
    "/apis/forms.takoform.com/v1alpha2/resources/ObjectBucket/assets",
    "/apis/forms.takoform.com/v1alpha3/resources/ObjectBucket/assets",
    "/internal/v1/form-packages/install",
    "/internal/v1/form-packages/reverify",
  ]) {
    for (const authorization of [
      undefined,
      "Bearer retired-test-token",
      "Bearer run_credential_retired",
    ]) {
      const response = await app.fetch(
        new Request(`https://api.takosumi.test${path}`, {
          ...(authorization ? { headers: { authorization } } : {}),
        }),
      );
      expect(response.status).toBe(404);
    }
  }

  const capabilities = await app.fetch(
    new Request("https://api.takosumi.test/capabilities", {
      headers: { authorization: "Bearer inventory-token" },
    }),
  );
  const capabilitiesText = await capabilities.text();
  expect(capabilitiesText).not.toContain("forms.takoform.com");
  expect(capabilitiesText).not.toContain("resource-shape");

  const openapi = await app.fetch(
    new Request("https://api.takosumi.test/openapi.json", {
      headers: { authorization: "Bearer inventory-token" },
    }),
  );
  const openapiText = await openapi.text();
  expect(openapiText).not.toContain("forms.takoform.com");
  expect(openapiText).not.toContain("FormActivation");
  expect(openapiText).not.toContain("TargetPool");
  expect(openapiText).not.toContain("SpacePolicy");
});
