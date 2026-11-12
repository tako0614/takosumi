import { apiError, requestIdFromRequest } from "./errors.ts";

/** The disabled inventory envelope, also usable before Core is composed. */
export function disabledInventoryResponse(
  request: Request,
  surface: "capabilities" | "openapi",
): Response {
  const response = Response.json(
    apiError("not_found", `${surface} inventory disabled`, undefined, requestIdFromRequest(request)),
    { status: 404 },
  );
  return request.method === "HEAD" ? new Response(null, response) : response;
}
