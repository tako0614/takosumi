import type { ApiEndpoint } from "./route_families.ts";

/**
 * Endpoint inventory for the `openapi` family (the self-describing
 * `/openapi.json` document route). Kept in its own module so `route_families.ts`
 * can import the descriptor without importing the heavy `openapi.ts` document
 * builder (which itself imports back from `route_families.ts`). The response is
 * an opaque OpenAPI document, so the operation is supplied verbatim via
 * `customOperation`. The concrete `app.get("/openapi.json", ...)` mount lives in
 * `app.ts`.
 */
export const OPENAPI_ENDPOINTS: readonly ApiEndpoint[] = [
  {
    method: "GET",
    path: "/openapi.json",
    summary:
      "Returns the operator-gated process OpenAPI 3.1 inventory for the currently mounted route families.",
    auth: "inventory-bearer",
    operationId: "getOpenApi",
    tag: "openapi",
    openapi: {
      okSchema: "EmptyResponse",
      customOperation: {
        tags: ["openapi"],
        security: [{ inventoryBearer: [] }],
        responses: {
          "200": {
            description:
              "Process OpenAPI 3.1 inventory for the mounted service route families.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  description:
                    "Customer-safe process OpenAPI 3.1 inventory. Host-internal /internal/v1 route families are mounted separately and intentionally omitted.",
                  additionalProperties: true,
                },
              },
            },
          },
          "401": {
            description: "JSON response",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorResponse" },
              },
            },
          },
        },
        "x-takos-auth": "inventory-bearer",
        "x-takos-mounted-path": "/openapi.json",
      },
    },
  },
] as const;
