import { expect, test } from "bun:test";
import { PUBLIC_SESSION_CONTROL_ENDPOINTS } from "../../../../accounts/service/src/control-route-inventory.ts";
import { createTakosumiOpenApiDocument } from "../../../../core/api/openapi.ts";

test("composed OpenAPI contains every public session route and its exact count", () => {
  const document = createTakosumiOpenApiDocument({ publicSessionControlEndpoints: PUBLIC_SESSION_CONTROL_ENDPOINTS });
  expect(document["x-takos-public-session-endpoint-count"]).toBe(PUBLIC_SESSION_CONTROL_ENDPOINTS.length);
  const ids = new Set<string>();
  for (const endpoint of PUBLIC_SESSION_CONTROL_ENDPOINTS) {
    const method = endpoint.method.toLowerCase() as "get" | "post" | "put" | "patch" | "delete";
    const operation = document.paths[endpoint.path]?.[method];
    expect(operation?.summary).toBe(endpoint.summary);
    expect(operation?.security).toEqual([{ accountSession: [] }, { accountsBearer: [] }]);
    expect(ids.has(operation!.operationId)).toBe(false);
    ids.add(operation!.operationId);
  }
  expect(document.paths["/api/v1/apps"]?.get).toBeDefined();
  expect(document.paths["/api/v1/ownership-transfers/{transferId}/accept"]?.post?.parameters)
    .toContainEqual({ name: "transferId", in: "path", required: true, schema: { type: "string" } });
  expect(document.paths["/internal/v1/workspaces"]).toBeUndefined();
});

test("Core without an Accounts composition does not claim unmounted app routes", () => {
  const document = createTakosumiOpenApiDocument();
  expect(document.paths["/api/v1/apps"]).toBeUndefined();
  expect(document["x-takos-public-session-endpoint-count"]).toBeUndefined();
});


test("app transfer and personal source resolution query contracts reach composed OpenAPI", () => {
  const document = createTakosumiOpenApiDocument({ publicSessionControlEndpoints: PUBLIC_SESSION_CONTROL_ENDPOINTS });
  for (const path of ["/api/v1/capsules/{capsuleId}/ownership-transfers", "/api/v1/ownership-transfers"]) {
    expect(document.paths[path]?.get?.parameters).toContainEqual({ name: "state", in: "query", schema: { type: "string", enum: ["pending"], default: "pending" } });
  }
  expect(document.paths["/api/v1/source-ref-resolutions"]?.get?.parameters).toContainEqual({ name: "url", in: "query", required: true, schema: { type: "string", format: "uri" } });
  expect(document.paths["/api/v1/connections"]?.get?.parameters?.some(parameter => parameter.name === "projection")).toBe(true);
});
