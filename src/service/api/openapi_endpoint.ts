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
      "Returns the OpenAPI 3.1 document describing the current service surface (this document).",
    auth: "none",
    operationId: "getOpenApi",
    tag: "openapi",
    openapi: {
      okSchema: "EmptyResponse",
      customOperation: {
        tags: ["openapi"],
        responses: {
          "200": {
            description: "OpenAPI 3.1 document.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  description:
                    "OpenAPI 3.1 document; clients should treat its shape as opaque except for the standard OpenAPI fields.",
                  additionalProperties: true,
                },
              },
            },
          },
        },
        "x-takos-auth": "none",
        "x-takos-mounted-path": "/openapi.json",
      },
    },
  },
] as const;
